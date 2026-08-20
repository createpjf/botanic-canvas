import { createHash } from 'node:crypto'

/**
 * 受控看图：用网关上的视觉模型（默认 Gemini Flash）识别用户引用的画布图片，
 * 把画面描述注入规划上下文。这是 Agent 第一次拿到画面信息——此前它对图片的
 * 全部认知只有节点名与角色标签，出过「猜测素材在别的项目」这类幻觉。
 *
 * 边界：
 * - 图片字节只在服务端解析并发给已配置的模型网关（与生图 Provider 同一授权语义），
 *   不进入消息记录、计划或任何持久化实体；主轮文本模型的请求里也没有它。
 * - 只读当前项目内的媒体（readGenerationInput 校验归属）；data URL 直接使用；
 *   blob:、外链等一律跳过。
 * - 每轮最多看 4 张；识别失败逐张跳过，绝不让看图失败弄坏整轮对话。
 */

const VISION_IMAGE_LIMIT = 4
const VISION_TIMEOUT_MS = 20_000
const VISION_CACHE_LIMIT = 256
const VISION_DESCRIPTION_LIMIT = 600

const VISION_INSTRUCTIONS = '你是品牌视觉工作台的看图助手。客观描述这张参考图的画面：'
  + '主体与外观特征、构图与景别、光线与色调、材质与质感、显著细节。'
  + '描述用于后续生图与生视频规划，只写画面可见内容，不臆测品牌、人名或拍摄意图。'
  + '输出一段不超过 180 字的中文，不要列表、不要开场白。'

const descriptionCache = new Map()

function cacheKey(model, image) {
  // data URL 本身就是内容；媒体路径在项目内稳定。哈希后做键，避免把整段 base64 当 Map 键。
  return createHash('sha256').update(`${model}\u0000${image}`).digest('hex')
}

function rememberDescription(cache, key, description) {
  if (cache.size >= VISION_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, description)
}

const MEDIA_PATH_PATTERN = /^\/api\/media\/([^/?#]+)$/

/**
 * 从引用节点解析出可看的图片。只认当前画布上 mediaKind 为 image 且有图的素材/结果节点。
 */
export function botanicAgentVisionCandidates(document, contextNodeIds = []) {
  const nodesById = new Map((document?.nodes ?? []).map((node) => [node.id, node]))
  const seen = new Set()
  const candidates = []
  for (const rawId of Array.isArray(contextNodeIds) ? contextNodeIds : []) {
    const nodeId = typeof rawId === 'string' ? rawId.trim() : ''
    if (!nodeId || seen.has(nodeId)) continue
    seen.add(nodeId)
    const node = nodesById.get(nodeId)
    if (node?.type !== 'asset' && node?.type !== 'result') continue
    const mediaKind = node.data?.mediaKind ?? 'image'
    const image = node.data?.image
    if (mediaKind !== 'image' || typeof image !== 'string' || !image) continue
    if (!image.startsWith('data:image/') && !MEDIA_PATH_PATTERN.test(image)) continue
    candidates.push({
      nodeId,
      label: node.data?.name ?? node.data?.label ?? '引用图片',
      ...(node.data?.role ? { role: node.data.role } : {}),
      image,
    })
    if (candidates.length >= VISION_IMAGE_LIMIT) break
  }
  return candidates
}

/** 把画布节点的图片引用解析为可发给视觉模型的 data URL；解析不了返回空。 */
export async function resolveBotanicAgentImageDataUrl(image, resolveMedia) {
  if (typeof image !== 'string' || !image) return undefined
  if (image.startsWith('data:image/')) return image
  const mediaId = decodeURIComponent(MEDIA_PATH_PATTERN.exec(image)?.[1] ?? '')
  if (!mediaId || typeof resolveMedia !== 'function') return undefined
  const resolved = await resolveMedia(mediaId)
  if (!resolved?.buffer?.length) return undefined
  const mimeType = typeof resolved.mimeType === 'string' && resolved.mimeType.startsWith('image/')
    ? resolved.mimeType
    : 'image/png'
  return `data:${mimeType};base64,${Buffer.from(resolved.buffer).toString('base64')}`
}

function providerText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim()
  }
  return ''
}

/**
 * 识别引用图片并返回 [{ nodeId, label, role?, description }]。
 * 任何一张失败都只影响它自己；模型未配置或没有候选时返回空数组。
 */
export async function describeBotanicAgentContextImages({
  document,
  contextNodeIds,
  runtimeConfig,
  resolveMedia,
  fetchImpl = fetch,
  signal,
  cache = descriptionCache,
} = {}) {
  const model = typeof runtimeConfig?.agentVisionModel === 'string' ? runtimeConfig.agentVisionModel.trim() : ''
  const apiKey = typeof runtimeConfig?.flockApiKey === 'string' ? runtimeConfig.flockApiKey.trim() : ''
  if (!model || !apiKey) return []
  const baseUrl = typeof runtimeConfig?.flockApiBaseUrl === 'string' && runtimeConfig.flockApiBaseUrl.trim()
    ? runtimeConfig.flockApiBaseUrl.trim().replace(/\/+$/, '')
    : 'https://api.flock.io/v1'
  const candidates = botanicAgentVisionCandidates(document, contextNodeIds)
  if (!candidates.length) return []

  const describeOne = async (candidate) => {
    const key = cacheKey(model, candidate.image)
    const cached = cache.get(key)
    if (cached) return { ...candidate, description: cached }
    const dataUrl = await resolveBotanicAgentImageDataUrl(candidate.image, resolveMedia)
    if (!dataUrl) return undefined
    const timeoutSignal = AbortSignal.timeout(VISION_TIMEOUT_MS)
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-litellm-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: VISION_INSTRUCTIONS },
          {
            role: 'user',
            content: [
              { type: 'text', text: `图片名称：${candidate.label}${candidate.role ? `（角色：${candidate.role}）` : ''}` },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 400,
        temperature: 0.2,
      }),
      signal: requestSignal,
    })
    if (!response.ok) return undefined
    const description = providerText(await response.json().catch(() => null)).slice(0, VISION_DESCRIPTION_LIMIT)
    if (!description) return undefined
    rememberDescription(cache, key, description)
    return { ...candidate, description }
  }

  const settled = await Promise.allSettled(candidates.map(describeOne))
  return settled.flatMap((entry) => (entry.status === 'fulfilled' && entry.value
    ? [{
      nodeId: entry.value.nodeId,
      label: entry.value.label,
      ...(entry.value.role ? { role: entry.value.role } : {}),
      description: entry.value.description,
    }]
    : []))
}

/** 视觉描述的系统提示段；空描述返回空串，调用方据此决定 briefing 措辞。 */
export function botanicAgentVisionBriefing(descriptions) {
  if (!Array.isArray(descriptions) || !descriptions.length) return ''
  return [
    '视觉模型已识别下列引用图片的画面内容，可据此综合 Prompt 与回答：',
    ...descriptions.map((item) => `- ${item.label}：${item.description}`),
    '这些描述是对画面的客观识别，不要声称看到了描述之外的细节。',
  ].join('\n')
}
