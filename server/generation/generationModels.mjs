import {
  NANO_BANANA_ASPECT_RATIOS,
  NANO_BANANA_MODEL_ID,
  NANO_BANANA_RESOLUTIONS,
} from './generationVocabulary.mjs'

const h3Durations = [5, 10, 15]

function unique(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function labelForModel(model) {
  if (model === 'gpt-image-2') return 'GPT Image 2'
  if (model === 'image-01') return 'MiniMax Image 01'
  if (model === 'image-01-live') return 'MiniMax Image 01 Live'
  if (model === 'MiniMax-H3') return 'MiniMax H3'
  if (model === NANO_BANANA_MODEL_ID) return 'Nano Banana 2'
  return model
}

function nanoBananaModelOption(extra = {}) {
  return {
    id: NANO_BANANA_MODEL_ID,
    label: labelForModel(NANO_BANANA_MODEL_ID),
    provider: 'flock',
    mediaKind: 'image',
    aspectRatios: [...NANO_BANANA_ASPECT_RATIOS],
    resolutions: [...NANO_BANANA_RESOLUTIONS],
    supportsMask: false,
    supportsCustomSize: false,
    supportsSearchGrounding: true,
    thinkingLevels: ['minimal', 'high'],
    maximumReferences: 14,
    ...extra,
  }
}

/** 服务端模型目录是 Provider、校验和 UI 的共同权威来源。 */
export function createGenerationModelCatalog({
  openAIApiKey,
  openAIModels = [],
  miniMaxApiKey,
  miniMaxImageModels = [],
  miniMaxVideoModels = [],
  flockApiKey,
  flockImageModels = [],
  includeUnavailable = false,
  // Vertex 路由未恢复前默认不可执行。目录仍可标成下线，避免用户再点出 502。
  flockNanoBananaEnabled = false,
}) {
  const catalog = []
  if (openAIApiKey) {
    catalog.push(...unique(openAIModels).map((id) => {
      const gptImage2 = id === 'gpt-image-2' || id.startsWith('gpt-image-2')
      return {
        id,
        label: labelForModel(id),
        provider: 'openai',
        mediaKind: 'image',
        aspectRatios: gptImage2
          ? ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16']
          : ['1:1', '3:4', '4:5', '9:16'],
        resolutions: ['1K', '2K'],
        ...(gptImage2 ? { supportsCustomSize: true } : {}),
        // OpenAI 图片模型统一走 images/edits，天然支持局部重绘蒙版。
        supportsMask: true,
      }
    }))
  }
  if (miniMaxApiKey) {
    catalog.push(...unique(miniMaxImageModels).map((id) => ({
      id,
      label: labelForModel(id),
      provider: 'minimax',
      mediaKind: 'image',
      maximumPromptLength: 1500,
      aspectRatios: ['1:1', '16:9', '4:3', '3:4', '9:16'],
      resolutions: ['1K'],
    })))
    catalog.push(...unique(miniMaxVideoModels).map((id) => ({
      id,
      label: labelForModel(id),
      provider: 'minimax',
      mediaKind: 'video',
      aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
      resolutions: ['2K'],
      durations: h3Durations,
      defaultDuration: 5,
    })))
  }
  const configuredFlockModels = unique(flockImageModels).filter((id) => id === NANO_BANANA_MODEL_ID)
  if (flockApiKey && flockNanoBananaEnabled) {
    // 环境变量只负责启用已实现的 Adapter 型号，不能让一个陌生 ID 继承 Nano
    // Banana 的 4K / 14 参考 / Search / Thinking 能力后进入可执行目录。
    catalog.push(...configuredFlockModels.map(() => nanoBananaModelOption()))
  }
  if (includeUnavailable && !catalog.some((model) => model.id === NANO_BANANA_MODEL_ID) && (flockApiKey || configuredFlockModels.length)) {
    catalog.push(nanoBananaModelOption({
      available: false,
      unavailableReason: flockApiKey
        ? '该模型上游暂不可用，已临时下线。'
        : 'Flock 图像服务尚未配置，暂不可用。',
    }))
  }
  return catalog
}

export function providerForModel(catalog, modelId) {
  return catalog.find((model) => model.id === modelId && model.available !== false)
}

export function generationTimeoutForModel(catalog, modelId, { imageTimeoutMs, videoTimeoutMs }) {
  return providerForModel(catalog, modelId)?.mediaKind === 'video'
    ? videoTimeoutMs
    : imageTimeoutMs
}

/**
 * 读时超时收口：一个仍在排队/执行、但已经超过模型等待时限的任务，应当被判为失败。
 *
 * 抽成纯函数是因为**同一条超时消息有两个产生点**：Worker 侧的 `PROVIDER_TIMEOUT`
 * 和这条读时收口。此前只有前者带错误码，后者只写了 error 文案 —— 于是走到这条路径的
 * 任务 `errorCode` 是 `undefined`，`agentBranchRetryPolicy` 返回 `error_code_unknown`
 * 停在待人工，**永远不会自动重试**。而 `PROVIDER_TIMEOUT` 恰恰在可重试白名单里。
 *
 * 端到端冒烟实测到了这一条：任务在 300 秒后收口为 failed，errorCode 却是空的。
 *
 * @param {{ status?: string, createdAt?: number }} job
 * @param {{ maximumTaskDurationMs: number, now?: number }} input
 */
export function generationJobTimedOut(job, { maximumTaskDurationMs, now = Date.now() }) {
  if (job?.status !== 'queued' && job?.status !== 'running') return false
  if (!Number.isFinite(Number(maximumTaskDurationMs))) return false
  return now - Number(job.createdAt ?? 0) >= Number(maximumTaskDurationMs)
}

/** 超时收口后的任务补丁。错误码与 Worker 侧同一个值，重试策略据此判定。 */
export function timedOutGenerationJobPatch({ now = Date.now() } = {}) {
  return {
    status: 'failed',
    errorCode: 'PROVIDER_TIMEOUT',
    error: '生成任务超过模型等待时限，已停止，请稍后重试。',
    updatedAt: now,
  }
}
