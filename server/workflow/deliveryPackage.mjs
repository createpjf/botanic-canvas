// @ts-check
import { buildDeliveryManifest } from './deliveryManifest.mjs'
import { writeZipArchive } from '../media/zipArchive.mjs'

/**
 * 交付包打包（Epic 7 最后一项）。
 *
 * 装哪些文件、叫什么名字**完全由 `buildDeliveryManifest` 决定**，这里不再判断一次。
 * 重新判断一遍等于出现第二套「谁进交付包」的规则，而那一套迟早会与清单不一致 ——
 * 表现是「清单里有 12 张，包里只有 10 张」，且两边都说自己是对的。
 *
 * 三条边界：
 *
 * - **取不到字节就让整个包失败**，不跳过。少了几张的包比报错糟得多：报错能重试，
 *   而收到包的人不会去数够不够。
 * - **清单本身进包**（`manifest.json`）。交付出去的文件要能自证血缘与审批，
 *   否则对方拿到的只是一堆图片。
 * - **逐个文件流式写出**，不整包缓冲。一次 Campaign 交付几个 GB 是正常量级。
 */

/** 从同源媒体地址取出媒体标识。非同源地址返回 `undefined`，由调用方按取不到处理。 */
export function mediaIdFromUrl(value) {
  if (typeof value !== 'string') return undefined
  const match = /^\/api\/media\/([^/?#]+)$/.exec(value.trim())
  return match ? decodeURIComponent(match[1]) : undefined
}

export class DeliveryPackageError extends Error {
  /** @param {string} code @param {string} message @param {number} [statusCode] */
  constructor(code, message, statusCode = 409) {
    super(message)
    this.name = 'DeliveryPackageError'
    this.code = code
    this.statusCode = statusCode
  }
}

/**
 * 逐个产出交付包里的条目。
 *
 * @param {{
 *   manifest: any,
 *   jobs?: any[],
 *   readMedia: (mediaId: string) => Promise<{ buffer?: Buffer } | undefined>,
 * }} input
 */
export async function* deliveryPackageEntries({ manifest, jobs = [], readMedia }) {
  const jobById = new Map(jobs.filter(Boolean).map((job) => [job.id, job]))
  for (const file of manifest.files ?? []) {
    const job = jobById.get(file.jobId)
    const output = (job?.outputs ?? []).find((entry) => entry?.id === file.outputId)
    const mediaId = mediaIdFromUrl(output?.image)
    if (!mediaId) {
      throw new DeliveryPackageError(
        'DELIVERY_MEDIA_UNAVAILABLE',
        `交付文件「${file.fileName}」没有可读取的媒体记录，无法打包。`,
      )
    }
    const media = await readMedia(mediaId)
    if (!media?.buffer?.length) {
      // 跳过它会产出一个静默少了几张的包，而收到包的人不会去数够不够。
      throw new DeliveryPackageError(
        'DELIVERY_MEDIA_UNAVAILABLE',
        `交付文件「${file.fileName}」的媒体已不可读取，无法打包。`,
      )
    }
    yield { name: file.fileName, data: media.buffer, modifiedAt: manifest.generatedAt }
  }
  // 清单最后进包：交付出去的文件要能自证血缘与审批。
  yield {
    name: 'manifest.json',
    data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    modifiedAt: manifest.generatedAt,
  }
}

/**
 * 交付包文件名。用运行标识而不是工作流名 —— 工作流可以改名，而运行标识是唯一的，
 * 收到两个同名包却对应不同批次是最难查的一类问题。
 */
export function deliveryPackageFileName(manifest) {
  return `delivery-${String(manifest?.runId ?? 'run').replace(/[^\w.-]+/g, '-')}.zip`
}

/**
 * 打一个交付包并流式写出。
 *
 * @param {{
 *   run: any, jobs?: any[], reviewTasks?: any[], nameTemplate?: string,
 *   readMedia: (mediaId: string) => Promise<{ buffer?: Buffer } | undefined>,
 *   now?: number,
 * }} input
 */
export function createDeliveryPackage({ run, jobs = [], reviewTasks = [], nameTemplate, readMedia, now = Date.now() }) {
  // 清单先算出来：文件名冲突等问题要在开始写字节**之前**暴露，而不是写到一半。
  const manifest = buildDeliveryManifest({ run, jobs, reviewTasks, nameTemplate, now })
  if (!manifest.files.length) {
    throw new DeliveryPackageError(
      'DELIVERY_PACKAGE_EMPTY',
      `没有经人工批准的候选可交付${manifest.excluded.length ? `（${manifest.excluded.length} 个候选未获批准）` : ''}。`,
    )
  }
  return {
    manifest,
    fileName: deliveryPackageFileName(manifest),
    stream: () => writeZipArchive(deliveryPackageEntries({ manifest, jobs, readMedia }), { now }),
  }
}
