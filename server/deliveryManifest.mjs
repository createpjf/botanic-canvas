// @ts-check
import { createHash } from 'node:crypto'

/**
 * 交付清单（Epic 7）。
 *
 * 交付包要能回答四件事：**这是什么文件、按什么规格生成、从哪来、谁批准的**。
 * 前三件靠实测规格与血缘，第四件靠人工决定 —— 没有批准记录的候选不进清单，
 * 而不是「先打包再说」：一个混入未批准结果的交付包，比没有交付包更糟。
 *
 * 清单只含标识、规格与血缘，不含媒体字节；下载地址由调用方按受控媒体接口现取。
 */

/** 命名模板里允许的变量。声明式：模板写了未声明的变量会原样保留而不是静默变空。 */
export const DELIVERY_NAME_VARIABLES = Object.freeze([
  'sku', 'channel', 'language', 'aspectRatio', 'index', 'itemId', 'runId',
])

const extensionByMimeType = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
})

function fileExtension(spec, kind) {
  return extensionByMimeType[spec?.mimeType] ?? (kind === 'video' ? 'mp4' : 'png')
}

function safeSegment(value) {
  return String(value ?? '').trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60)
}

/**
 * 按模板生成文件名。未声明的变量原样保留 —— 静默替换成空串会产出 `--1.png`
 * 这种看不出哪里错了的名字。
 */
export function deliveryFileName(template, variables, { extension }) {
  const base = typeof template === 'string' && template.trim() ? template.trim() : '{{itemId}}-{{index}}'
  const rendered = base.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) => (
    DELIVERY_NAME_VARIABLES.includes(key) && variables[key] !== undefined && variables[key] !== ''
      ? safeSegment(variables[key])
      : match
  ))
  return `${rendered || 'delivery'}.${extension}`
}

/**
 * 一个候选是否已获批准。
 *
 * 「自动评审通过」不算批准：ADR 0006 明确自动评审不得把结果标记为品牌批准。
 * 只有人工 `accepted` 才进交付包。
 */
export function isApprovedForDelivery(artifactId, reviewTasks = []) {
  for (const task of reviewTasks) {
    const decision = (task?.decisions ?? [])
      .filter((entry) => entry?.artifactId === artifactId)
      // 同一候选可被多次决定，以最后一次为准。
      .sort((left, right) => Number(left.decidedAt ?? 0) - Number(right.decidedAt ?? 0))
      .at(-1)
    if (decision) return decision.decision === 'accepted'
  }
  return false
}

/**
 * 生成交付清单。
 *
 * @param {{
 *   run: any,
 *   jobs?: any[],
 *   reviewTasks?: any[],
 *   nameTemplate?: string,
 *   now?: number,
 * }} input
 */
export function buildDeliveryManifest({ run, jobs = [], reviewTasks = [], nameTemplate, now = Date.now() }) {
  if (!run?.id) throw new TypeError('交付清单缺少工作流运行。')
  const jobById = new Map(jobs.filter(Boolean).map((job) => [job.id, job]))
  const files = []
  const excluded = []
  for (const item of run.items ?? []) {
    const job = item?.jobId ? jobById.get(item.jobId) : undefined
    const outputs = job?.outputs ?? []
    outputs.forEach((output, index) => {
      const artifactId = `generation:${job.id}:${output.id}`
      const approved = isApprovedForDelivery(artifactId, reviewTasks)
      if (!approved) {
        // 未批准的候选照实列出来，而不是从清单里消失 —— 用户要能看出「少的那几张
        // 是没批准，不是漏了」。
        excluded.push({ artifactId, itemId: item.id, reason: 'not_approved' })
        return
      }
      const spec = output.spec ?? {}
      const variables = {
        sku: item.input?.sku,
        channel: item.input?.channel,
        language: item.input?.language,
        aspectRatio: item.input?.aspectRatio ?? run.definition?.output?.aspectRatio,
        index: String(index + 1),
        itemId: item.id,
        runId: run.id,
      }
      files.push({
        artifactId,
        itemId: item.id,
        jobId: job.id,
        outputId: output.id,
        fileName: deliveryFileName(nameTemplate ?? run.definition?.output?.nameTemplate, variables, {
          extension: fileExtension(spec, output.mediaKind),
        }),
        mediaKind: output.mediaKind ?? 'image',
        // 规格是实测值，不是请求参数的回声。
        spec: {
          ...(spec.mimeType ? { mimeType: spec.mimeType } : {}),
          ...(spec.byteSize ? { byteSize: spec.byteSize } : {}),
          ...(spec.width ? { width: spec.width } : {}),
          ...(spec.height ? { height: spec.height } : {}),
          ...(spec.durationSeconds ? { durationSeconds: spec.durationSeconds } : {}),
        },
        lineage: {
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          runId: run.id,
          ...(run.definition?.planFingerprint ? { planFingerprint: run.definition.planFingerprint } : {}),
          ...(job.branchFingerprint ? { branchFingerprint: job.branchFingerprint } : {}),
          model: job.effectiveModel ?? job.settings?.model,
        },
      })
    })
  }
  const duplicates = files
    .map((file) => file.fileName)
    .filter((name, index, all) => all.indexOf(name) !== index)
  if (duplicates.length) {
    // 同名文件在打包时会互相覆盖，交付出去就是少了几张。宁可拒绝生成清单。
    throw new Error(`交付文件名重复：${[...new Set(duplicates)].join('、')}`)
  }
  return {
    version: 1,
    runId: run.id,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    projectId: run.projectId,
    generatedAt: now,
    fileCount: files.length,
    files,
    // 被排除的候选与原因一起给出：静默少几张比报错更难查。
    excluded,
    approvals: reviewTasks.flatMap((task) => (task?.decisions ?? []).map((decision) => ({
      artifactId: decision.artifactId,
      decision: decision.decision,
      decidedAt: decision.decidedAt,
      taskId: task.id,
      qualityPolicyFingerprint: task.qualityPolicyFingerprint,
    }))),
    checksum: createHash('sha256')
      .update(JSON.stringify(files.map((file) => [file.artifactId, file.fileName, file.spec.byteSize ?? 0])))
      .digest('base64url'),
  }
}
