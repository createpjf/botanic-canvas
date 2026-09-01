import { createHash } from 'node:crypto'
import { createBotanicAgentModelProvider } from './botanicAgentModelProvider.mjs'

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
 * - 每轮最多看 4 张；普通对话可跳过失败项，定向编辑由 Turn Runtime fail closed。
 */

const VISION_IMAGE_LIMIT = 4
const VISION_TOTAL_BYTES_LIMIT = 16 * 1024 * 1024
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
export async function resolveBotanicAgentImageDataUrl(image, resolveMedia, signal) {
  signal?.throwIfAborted()
  if (typeof image !== 'string' || !image) return undefined
  if (image.startsWith('data:image/')) return image
  const mediaId = decodeURIComponent(MEDIA_PATH_PATTERN.exec(image)?.[1] ?? '')
  if (!mediaId || typeof resolveMedia !== 'function') return undefined
  const resolved = await resolveMedia(mediaId, { signal })
  signal?.throwIfAborted()
  if (!resolved?.buffer?.length) return undefined
  const mimeType = typeof resolved.mimeType === 'string' && resolved.mimeType.startsWith('image/')
    ? resolved.mimeType
    : 'image/png'
  return `data:${mimeType};base64,${Buffer.from(resolved.buffer).toString('base64')}`
}

function visionImageBytes(dataUrl) {
  const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1
  if (comma < 0) return 0
  const metadata = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  return metadata.endsWith(';base64')
    ? Buffer.byteLength(payload, 'base64')
    : Buffer.byteLength(decodeURIComponent(payload), 'utf8')
}

async function resolveVisionCandidateDataUrls(candidates, resolveMedia, signal) {
  const resolved = new Array(candidates.length)
  let totalBytes = 0
  let nextIndex = 1
  let overflow
  const resolveAt = async (index) => {
    const candidate = candidates[index]
    const dataUrl = await resolveBotanicAgentImageDataUrl(candidate.image, resolveMedia, signal)
      .catch((caught) => {
        if (signal?.aborted) throw caught
        return undefined
      })
    if (!dataUrl) return
    totalBytes += visionImageBytes(dataUrl)
    if (totalBytes > VISION_TOTAL_BYTES_LIMIT) {
      overflow = Object.assign(new Error('本轮引用图片总大小超过视觉上下文上限。'), {
        code: 'AGENT_VISION_BYTES_EXCEEDED',
        statusCode: 413,
      })
      return
    }
    resolved[index] = { candidate, dataUrl }
  }
  const resolveNext = async () => {
    while (nextIndex < candidates.length && !overflow) {
      const index = nextIndex
      nextIndex += 1
      await resolveAt(index)
    }
  }
  // 先解析主目标，再以最多 2 路处理辅助图，既保序也避免 4 张大图同时驻留。
  if (candidates.length) await resolveAt(0)
  await Promise.all(Array.from({ length: Math.min(2, Math.max(0, candidates.length - 1)) }, resolveNext))
  if (overflow) throw overflow
  return resolved.flatMap((entry) => {
    if (!entry) return []
    const { candidate, dataUrl } = entry
    if (!dataUrl) return []
    return [{ candidate, dataUrl }]
  })
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
  // 传输差异由 Model Provider 拥有;单图失败继续 fail-open,只影响它自己。
  const provider = createBotanicAgentModelProvider(runtimeConfig, { fetchImpl })
  const candidates = botanicAgentVisionCandidates(document, contextNodeIds)
  if (!candidates.length) return []
  const resolvedCandidates = await resolveVisionCandidateDataUrls(candidates, resolveMedia, signal)

  const describeOne = async ({ candidate, dataUrl }) => {
    const key = cacheKey(model, candidate.image)
    const cached = cache.get(key)
    if (cached) return { ...candidate, description: cached }
    let payload
    try {
      payload = await provider.sample({
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
        maxOutputTokens: 400,
        temperature: 0.2,
        timeoutMs: VISION_TIMEOUT_MS,
        signal,
      })
    } catch {
      return undefined
    }
    const description = providerText(payload).slice(0, VISION_DESCRIPTION_LIMIT)
    if (!description) return undefined
    rememberDescription(cache, key, description)
    return { ...candidate, description }
  }

  const settled = await Promise.allSettled(resolvedCandidates.map(describeOne))
  return settled.flatMap((entry) => (entry.status === 'fulfilled' && entry.value
    ? [{
      nodeId: entry.value.nodeId,
      label: entry.value.label,
      ...(entry.value.role ? { role: entry.value.role } : {}),
      description: entry.value.description,
    }]
    : []))
}

/**
 * 原生多模态：把引用图片解析成可直接放进消息的 image_url parts。
 * 与 caption 通道二选一——parts 可用时模型直接看图推理，caption 只作降级。
 */
export async function resolveBotanicAgentVisionParts({ document, contextNodeIds, resolveMedia, signal } = {}) {
  const candidates = botanicAgentVisionCandidates(document, contextNodeIds)
  return (await resolveVisionCandidateDataUrls(candidates, resolveMedia, signal)).map(({ candidate, dataUrl }) => ({
      nodeId: candidate.nodeId,
      label: candidate.label,
      ...(candidate.role ? { role: candidate.role } : {}),
      part: { type: 'image_url', image_url: { url: dataUrl } },
    }))
}

/** 把最后一条用户消息升级为多模态：正文 + 图片名对照 + 图片 parts。 */
export function botanicAgentMultimodalMessages(messages, visionParts) {
  if (!visionParts.length) return messages
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user')
  if (lastUserIndex < 0) return messages
  const legend = visionParts
    .map((item, index) => `图${index + 1}＝${item.label}${item.role ? `（${item.role}）` : ''}`)
    .join('；')
  return messages.map((message, index) => (index === lastUserIndex
    ? {
      role: 'user',
      content: [
        { type: 'text', text: `${message.content}\n\n（引用图片已随消息附上：${legend}）` },
        ...visionParts.map((item) => item.part),
      ],
    }
    : message))
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
