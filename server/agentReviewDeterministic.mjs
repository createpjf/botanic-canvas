// @ts-check
import { aspectRatioLabel } from './mediaSpec.mjs'

/**
 * 评审第 1 层：确定性硬规格检查，**不调用模型**（ADR 0006）。
 *
 * 存在的理由是「硬规格不得交给模型判断」：格式、尺寸、比例、时长、文件完整性能被
 * 证明，用视觉模型判断既贵又不可靠。第 1 层失败直接给 `fail`，不进第 2 层 ——
 * 一张比例错误的图不需要再问模型好不好看。
 *
 * 缺字段判「无法验证」而不是默认通过：默认通过会让「没记规格」看起来像「规格正确」。
 */

/** 判定档。`unverifiable` 是独立结论，不能被折叠进 pass 或 fail。 */
export const REVIEW_VERDICTS = Object.freeze(['pass', 'fail', 'unverifiable'])

/** 第 1 层的检查项。声明式：新增检查必须同时给出它读哪个规格字段。 */
export const DETERMINISTIC_CRITERIA = Object.freeze([
  'media_kind',
  'file_integrity',
  'aspect_ratio',
  'resolution',
  'duration',
])

function criterion(id, verdict, evidence) {
  return { id, layer: 'deterministic', verdict, ...(evidence ? { evidence } : {}) }
}

const imageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])

function expectedMediaKind(settings) {
  return settings?.duration === undefined ? 'image' : 'video'
}

/**
 * 分辨率档位到最短边像素数的下限。
 *
 * 只校验下限而不是精确等值：Provider 会在保持比例的前提下给出接近而非等于档位的
 * 尺寸，用等值判定会把正常输出判成失败。
 */
const resolutionFloor = Object.freeze({ '1K': 768, '2K': 1536, '4K': 3072, '1080P': 1080, '720P': 720 })

/**
 * 对一个候选做第 1 层检查。
 *
 * @param {{
 *   output: { id?: string, mediaKind?: string, spec?: { mimeType?: string, declaredMimeType?: string, byteSize?: number, width?: number, height?: number, durationSeconds?: number } },
 *   settings?: { aspectRatio?: string, resolution?: string, duration?: number },
 * }} input
 * @returns {{ verdict: string, criteria: Array<{ id: string, layer: string, verdict: string, evidence?: string }> }}
 */
export function reviewDeterministicLayer({ output, settings } = /** @type {any} */ ({})) {
  const spec = output?.spec
  const criteria = []
  const wantedKind = expectedMediaKind(settings)

  if (!spec || !spec.byteSize) {
    // 没有实测规格 = 无法验证。这一条必须显式存在，否则读者会以为第 1 层通过了。
    criteria.push(criterion('file_integrity', 'unverifiable', '输出没有记录实测规格。'))
    return { verdict: 'unverifiable', criteria }
  }
  criteria.push(criterion('file_integrity', 'pass', `${spec.byteSize} 字节`))

  const actualMimeType = spec.mimeType
  if (!actualMimeType) {
    criteria.push(criterion('media_kind', 'unverifiable', `无法从文件头判定类型（声明 ${spec.declaredMimeType ?? '未知'}）。`))
  } else {
    const actualKind = actualMimeType === 'video/mp4' ? 'video' : imageMimeTypes.has(actualMimeType) ? 'image' : 'unknown'
    const mismatchedDeclaration = spec.declaredMimeType && spec.declaredMimeType !== actualMimeType
    criteria.push(actualKind === wantedKind && !mismatchedDeclaration
      ? criterion('media_kind', 'pass', actualMimeType)
      : criterion('media_kind', 'fail', mismatchedDeclaration
        ? `声明 ${spec.declaredMimeType} 但文件头是 ${actualMimeType}。`
        : `期望 ${wantedKind}，实际 ${actualMimeType}。`))
  }

  if (wantedKind === 'image') {
    const actualRatio = aspectRatioLabel(spec.width ?? 0, spec.height ?? 0)
    if (!settings?.aspectRatio) {
      criteria.push(criterion('aspect_ratio', 'unverifiable', '计划没有声明比例。'))
    } else if (!actualRatio) {
      criteria.push(criterion('aspect_ratio', 'unverifiable', '输出没有记录尺寸。'))
    } else {
      criteria.push(actualRatio === settings.aspectRatio
        ? criterion('aspect_ratio', 'pass', actualRatio)
        : criterion('aspect_ratio', 'fail', `期望 ${settings.aspectRatio}，实际 ${actualRatio}。`))
    }

    const resolution = settings?.resolution
    const floor = resolution ? resolutionFloor[resolution] : undefined
    const shortestEdge = Math.min(spec.width ?? 0, spec.height ?? 0)
    if (!floor) {
      criteria.push(criterion('resolution', 'unverifiable', resolution
        ? `未知分辨率档位 ${resolution}。`
        : '计划没有声明分辨率。'))
    } else if (!shortestEdge) {
      criteria.push(criterion('resolution', 'unverifiable', '输出没有记录尺寸。'))
    } else {
      criteria.push(shortestEdge >= floor
        ? criterion('resolution', 'pass', `最短边 ${shortestEdge}px`)
        : criterion('resolution', 'fail', `${resolution} 要求最短边不低于 ${floor}px，实际 ${shortestEdge}px。`))
    }
  }

  if (wantedKind === 'video') {
    // 视频的时长与容器恰恰属于第 1 层，不得因为「是视频」就整体跳过评审。
    if (spec.durationSeconds === undefined) {
      criteria.push(criterion('duration', 'unverifiable', '输出没有记录时长。'))
    } else {
      // 容一秒：编码器按帧率取整，精确等值会把正常输出判成失败。
      const drift = Math.abs(spec.durationSeconds - Number(settings?.duration ?? 0))
      criteria.push(drift <= 1
        ? criterion('duration', 'pass', `${spec.durationSeconds.toFixed(2)} 秒`)
        : criterion('duration', 'fail', `期望 ${settings?.duration ?? '未声明'} 秒，实际 ${spec.durationSeconds.toFixed(2)} 秒。`))
    }
  }

  if (criteria.some((item) => item.verdict === 'fail')) return { verdict: 'fail', criteria }
  if (criteria.some((item) => item.verdict === 'unverifiable')) return { verdict: 'unverifiable', criteria }
  return { verdict: 'pass', criteria }
}

/**
 * 第 1 层失败是否应阻止第 2 层。
 *
 * `unverifiable` 不阻止：规格没记下来不代表画面不对，仍值得让模型看一眼；
 * `fail` 阻止 —— 已经能证明不符合硬规格，再问模型是浪费。
 */
export function shouldRunModelLayer(deterministic) {
  return deterministic?.verdict !== 'fail'
}
