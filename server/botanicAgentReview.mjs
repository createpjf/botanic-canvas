import { resolveBotanicAgentImageDataUrl } from './botanicAgentVision.mjs'
import { normalizeBotanicAgentLocale } from './agentInstructions.mjs'

/**
 * 结果自评：Run 到终态、结果回填画布后，用视觉模型对照创作诉求逐张评价生成结果，
 * 并推荐最佳一张。这是「生成 → 看 → 评 → 改」闭环的后半程——此前 Agent 交付完就退场，
 * 结果好坏只能靠用户自己看。
 *
 * 评审是派生数据：一次调用评整批，结构化结论回给客户端展示为会话消息；
 * 不写入 Run、计划或 Artifact，重评只会改变展示，不影响任何执行语义。
 */

const REVIEW_IMAGE_LIMIT = 4
const REVIEW_TIMEOUT_MS = 30_000
const REVIEW_NOTE_LIMIT = 160
const REVIEW_SUMMARY_LIMIT = 200

function containsHan(value) {
  return /\p{Script=Han}/u.test(value)
}

function reviewInstructions(locale) {
  if (locale === 'en') {
    return 'You are a creative reviewer for a brand visual workspace. Compare the creative brief and execution prompt, then evaluate each generated image: subject and identity consistency, composition and lighting, finish, and stylistic fit. Return JSON only, in this exact shape: {"summary":"one-sentence overall review in concise natural English","best":best image number,"items":[{"index":image number,"verdict":"pass" or "adjust","note":"a concise review in English, max 40 words"}]}. Number images from 1. Judge only what is visible; do not infer intent. Keep summary and note values in English unless quoting a proper name or source label. Do not output anything outside the JSON.'
  }
  return '你是品牌视觉工作台的创意评审。对照创作诉求与执行提示词逐张评价生成结果：主体与身份是否保持、构图与光线是否达标、质感与风格是否符合诉求。只输出 JSON，格式：{"summary":"一句话总评","best":最佳图片编号,"items":[{"index":图片编号,"verdict":"pass"或"adjust","note":"不超过40字的评价"}]}。编号从 1 开始；评价基于画面可见内容，不臆测拍摄意图；不要输出 JSON 之外的任何文字。'
}

function parseProviderJson(content) {
  if (typeof content !== 'string' || !content.trim()) return undefined
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function providerText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
  return ''
}

/** Run 的结果图按分支顺序收集；结果尚未回填（无 image）时对应分支跳过。 */
export function botanicAgentReviewCandidates(run, document) {
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  const byBranch = new Map()
  for (const node of nodes) {
    if (node.type !== 'result') continue
    const data = node.data ?? {}
    if (data.agentRun?.runId !== run.id || !data.image || (data.mediaKind ?? 'image') !== 'image') continue
    if (!byBranch.has(data.agentRun.branchId)) {
      byBranch.set(data.agentRun.branchId, { nodeId: node.id, image: data.image, label: data.label ?? '生成结果' })
    }
  }
  const candidates = []
  for (const branch of run.branches ?? []) {
    const found = byBranch.get(branch.id)
    if (found) candidates.push({ ...found, branchLabel: branch.label ?? found.label })
    if (candidates.length >= REVIEW_IMAGE_LIMIT) break
  }
  return candidates
}

/**
 * 评审整批结果。视觉模型未配置、没有可评结果或模型输出不可解析时返回 undefined；
 * 评审失败绝不影响 Run 本身的状态与结果。
 */
export async function reviewBotanicAgentRunResults({
  run,
  document,
  runtimeConfig,
  resolveMedia,
  fetchImpl = fetch,
  signal,
  locale: localeValue = 'zh-CN',
} = {}) {
  const locale = normalizeBotanicAgentLocale(localeValue)
  if (!run || (run.status !== 'completed' && run.status !== 'partial')) return undefined
  const model = typeof runtimeConfig?.agentVisionModel === 'string' ? runtimeConfig.agentVisionModel.trim() : ''
  const apiKey = typeof runtimeConfig?.flockApiKey === 'string' ? runtimeConfig.flockApiKey.trim() : ''
  if (!model || !apiKey) return undefined
  const baseUrl = typeof runtimeConfig?.flockApiBaseUrl === 'string' && runtimeConfig.flockApiBaseUrl.trim()
    ? runtimeConfig.flockApiBaseUrl.trim().replace(/\/+$/, '')
    : 'https://api.flock.io/v1'

  const candidates = botanicAgentReviewCandidates(run, document)
  if (!candidates.length) return undefined
  const resolved = []
  for (const candidate of candidates) {
    const dataUrl = await resolveBotanicAgentImageDataUrl(candidate.image, resolveMedia)
    if (dataUrl) resolved.push({ ...candidate, dataUrl })
  }
  if (!resolved.length) return undefined

  const instruction = typeof run.plan?.instruction === 'string' ? run.plan.instruction.slice(0, 1000) : ''
  const prompt = typeof run.plan?.prompt === 'string' ? run.plan.prompt.slice(0, 2000) : ''
  const legend = resolved.map((item, index) => `${index + 1}=「${item.branchLabel}」`).join(' ')
  const timeoutSignal = AbortSignal.timeout(REVIEW_TIMEOUT_MS)
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
        { role: 'system', content: reviewInstructions(locale) },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: locale === 'en'
                ? `Creative brief: ${instruction}\nExecution prompt: ${prompt}\nThere are ${resolved.length} results, numbered as follows: ${legend}`
                : `创作诉求：${instruction}\n执行提示词：${prompt}\n共 ${resolved.length} 张结果，编号对应：${legend}`,
            },
            ...resolved.map((item) => ({ type: 'image_url', image_url: { url: item.dataUrl } })),
          ],
        },
      ],
      max_tokens: 800,
      temperature: 0.2,
    }),
    signal: requestSignal,
  })
  if (!response.ok) return undefined
  const parsed = parseProviderJson(providerText(await response.json().catch(() => null)))
  if (!parsed) return undefined

  const items = (Array.isArray(parsed.items) ? parsed.items : []).flatMap((item) => {
    const index = Number(item?.index)
    const target = Number.isInteger(index) ? resolved[index - 1] : undefined
    if (!target) return []
    const rawNote = typeof item?.note === 'string' ? item.note.trim().slice(0, REVIEW_NOTE_LIMIT) : ''
    const note = locale === 'en' && containsHan(rawNote) ? '' : rawNote
    return [{
      nodeId: target.nodeId,
      branchLabel: target.branchLabel,
      verdict: item?.verdict === 'adjust' ? 'adjust' : 'pass',
      note,
    }]
  })
  if (!items.length) return undefined
  const bestIndex = Number(parsed.best)
  const rawSummary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, REVIEW_SUMMARY_LIMIT) : ''
  const summary = locale === 'en' && containsHan(rawSummary) ? '' : rawSummary
  return {
    summary: summary || (locale === 'en' ? 'Reviewed this round of results.' : '已看完这轮结果。'),
    ...(Number.isInteger(bestIndex) && resolved[bestIndex - 1] ? { bestNodeId: resolved[bestIndex - 1].nodeId } : {}),
    items,
  }
}
