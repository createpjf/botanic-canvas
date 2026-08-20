const h3Durations = [5, 10, 15]

function unique(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function labelForModel(model) {
  if (model === 'gpt-image-2') return 'GPT Image 2'
  if (model === 'image-01') return 'MiniMax Image 01'
  if (model === 'image-01-live') return 'MiniMax Image 01 Live'
  if (model === 'MiniMax-H3') return 'MiniMax H3'
  return model
}

/** 服务端模型目录是 Provider、校验和 UI 的共同权威来源。 */
export function createGenerationModelCatalog({
  openAIApiKey,
  openAIModels = [],
  miniMaxApiKey,
  miniMaxImageModels = [],
  miniMaxVideoModels = [],
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
  return catalog
}

export function providerForModel(catalog, modelId) {
  return catalog.find((model) => model.id === modelId)
}

export function generationTimeoutForModel(catalog, modelId, { imageTimeoutMs, videoTimeoutMs }) {
  return providerForModel(catalog, modelId)?.mediaKind === 'video'
    ? videoTimeoutMs
    : imageTimeoutMs
}
