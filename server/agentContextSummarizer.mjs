// @ts-check

import { canonicalHash } from './canonicalHash.mjs'
import { sanitizeAgentModelContextCheckpoint } from './agentModelContextSurface.mjs'
import { redactSummaryText } from './agentThreadSummary.mjs'

const SUMMARY_TIMEOUT_MS = 8_000
const NARRATIVE_CODE_POINT_LIMIT = 1_200
const PREVIEW_MESSAGE_LIMIT = 6
const PREVIEW_TEXT_LIMIT = 400
const ENRICH_CACHE_LIMIT = 32

const NARRATIVE_HEADER = Object.freeze({
  'zh-CN': '补充叙述（非权威，以以上结构化事实为准）：',
  en: 'Narrative supplement (non-authoritative; structured facts above win):',
})

/**
 * Context LLM summarizer 总闸门。默认关闭：开了才会在 Runtime 压缩时多一次短调用。
 * 不进入 Coordinator CAS / Shadow / 手动压缩 —— 那些路径必须保持确定性可重放。
 */
export function agentContextLlmSummaryEnabled(env = process.env) {
  return String(env?.AGENT_CONTEXT_LLM_SUMMARY ?? '').trim().toLowerCase() === 'true'
}

function localeOf(value) {
  return value === 'en' ? 'en' : 'zh-CN'
}

function codePoints(text) {
  return [...String(text ?? '')]
}

function clipNarrative(text) {
  const redacted = redactSummaryText(text)
  const points = codePoints(redacted)
  if (points.length <= NARRATIVE_CODE_POINT_LIMIT) return redacted
  return `${points.slice(0, NARRATIVE_CODE_POINT_LIMIT).join('')}…`
}

function previewMessages(messages, locale) {
  const list = Array.isArray(messages) ? messages : []
  return list
    .filter((message) => message && ['user', 'assistant'].includes(message.role))
    .slice(-PREVIEW_MESSAGE_LIMIT)
    .map((message) => {
      const raw = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.flatMap((part) => typeof part?.text === 'string' ? [part.text] : []).join('\n')
          : ''
      const content = redactSummaryText(raw).slice(0, PREVIEW_TEXT_LIMIT)
      return content ? { role: message.role, content } : undefined
    })
    .filter(Boolean)
}

/**
 * 确定性摘要永远是前缀；模型只允许追加一段标明非权威的叙述。
 * 这样 settings / pendingActions / runId 不会被散文冲掉。
 *
 * @param {{ deterministicContent: string, narrative?: string, locale?: string }} input
 */
export function composeEnrichedCheckpoint(input) {
  const { deterministicContent, narrative, locale = 'zh-CN' } = input ?? {}
  const base = sanitizeAgentModelContextCheckpoint(deterministicContent)
  const note = clipNarrative(narrative)
  if (!note) return base
  const header = NARRATIVE_HEADER[localeOf(locale)]
  return sanitizeAgentModelContextCheckpoint(`${base}\n\n${header}\n${note}`)
}

function summarizerSystemPrompt(locale) {
  return localeOf(locale) === 'en'
    ? [
      'You enrich a compacted agent context checkpoint for a brand visual workbench.',
      'Write 2-5 short sentences covering only soft context missing from the structured facts:',
      'tone preferences, rejected ideas, and working hypotheses.',
      'Do not invent decisions, models, aspect ratios, run ids, URLs, media ids, or secrets.',
      'Do not repeat the structured fact block. Plain text only. No markdown headings.',
    ].join(' ')
    : [
      '你在为品牌视觉工作台的压缩上下文补充叙述。',
      '只用 2–5 句短句写出结构化事实里没有的软上下文：语气偏好、被否掉的方向、工作假设。',
      '不得编造决策、模型、比例、runId、URL、媒体标识或凭据。',
      '不要复述结构化事实块。纯文本，不要标题。',
    ].join('')
}

function summarizerUserPrompt({ deterministicContent, replacedPreview, locale, trigger }) {
  const en = localeOf(locale) === 'en'
  const lines = [
    en ? `Trigger: ${trigger ?? 'pre_step'}` : `触发：${trigger ?? 'pre_step'}`,
    en ? 'Structured facts (authoritative, already kept):' : '结构化事实（权威，已保留）：',
    deterministicContent,
  ]
  if (replacedPreview?.length) {
    lines.push(en ? 'Replaced early turns (redacted preview):' : '被替换的早期回合（已脱敏预览）：')
    for (const message of replacedPreview) {
      lines.push(`${message.role}: ${message.content}`)
    }
  }
  lines.push(en
    ? 'Return only the narrative supplement.'
    : '只返回补充叙述正文。')
  return lines.join('\n')
}

/**
 * @param {{
 *   deterministicContent: string,
 *   locale?: string,
 *   trigger?: string,
 *   enabled?: boolean,
 *   invokeChat?: (command: { messages: any[], maxTokens: number }) => Promise<string>,
 *   replacedMessages?: any[],
 * }} [input]
 */
export async function enrichAgentContextCheckpoint(input) {
  const command = input ?? { deterministicContent: '' }
  const locale = localeOf(command.locale)
  const deterministic = sanitizeAgentModelContextCheckpoint(command.deterministicContent)
  if (command.enabled !== true || typeof command.invokeChat !== 'function') {
    return { content: deterministic, source: 'deterministic' }
  }
  try {
    const narrative = await command.invokeChat({
      maxTokens: 400,
      messages: [
        { role: 'system', content: summarizerSystemPrompt(locale) },
        {
          role: 'user',
          content: summarizerUserPrompt({
            deterministicContent: deterministic,
            replacedPreview: previewMessages(command.replacedMessages, locale),
            locale,
            trigger: command.trigger,
          }),
        },
      ],
    })
    if (typeof narrative !== 'string' || !narrative.trim()) {
      return { content: deterministic, source: 'deterministic_fallback' }
    }
    const content = composeEnrichedCheckpoint({
      deterministicContent: deterministic,
      narrative,
      locale,
    })
    // 权威前缀必须仍在；模型若回了整段覆盖式摘要则丢弃。
    if (!content.startsWith(deterministic)) {
      return { content: deterministic, source: 'deterministic_fallback' }
    }
    return {
      content,
      source: content === deterministic ? 'deterministic_fallback' : 'llm_augmented',
    }
  } catch {
    return { content: deterministic, source: 'deterministic_fallback' }
  }
}

/**
 * Runtime 注入的 enrich seam。关闭 Flag 或缺少 invoker 时退化为恒等。
 *
 * @param {{
 *   enabled?: boolean,
 *   invokeChat?: (command: { messages: any[], maxTokens: number }) => Promise<string>,
 *   observe?: (event: any) => void,
 * }} [options]
 */
export function createAgentContextCheckpointEnricher(options) {
  const config = options ?? {}
  const enabled = config.enabled === true
  const invokeChat = typeof config.invokeChat === 'function' ? config.invokeChat : undefined
  const observe = typeof config.observe === 'function' ? config.observe : undefined
  // ponytail: 进程内缓存——长工具环里同一摘要基底反复压缩不重复计费；多实例各自
  // 最多多付一次。放量后若要跨实例共享，再挂 usage anchor 同源的持久层。
  const cache = new Map()
  return async (command = {}) => {
    const startedAt = Date.now()
    const deterministicContent = command.deterministicContent ?? ''
    const cacheKey = canonicalHash({
      deterministicContent,
      trigger: command.trigger ?? 'pre_step',
      locale: command.locale ?? 'zh-CN',
    })
    const cached = cache.get(cacheKey)
    const result = cached ?? await enrichAgentContextCheckpoint({
      ...command,
      deterministicContent,
      enabled,
      invokeChat,
    })
    // 只缓存增强成功的结果：fallback 说明 Provider 暂时不可用，恢复后应重试。
    if (!cached && result.source === 'llm_augmented') {
      if (cache.size >= ENRICH_CACHE_LIMIT) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(cacheKey, result)
    }
    if (observe) {
      try {
        observe({
          name: 'agent.context.llm_summary',
          outcome: cached ? 'llm_augmented_cached' : result.source,
          trigger: command.trigger ?? 'pre_step',
          durationMs: Math.max(0, Date.now() - startedAt),
        })
      } catch { /* 可观测性不得改变压缩 */ }
    }
    return result
  }
}

/**
 * Flock chat/completions 的短调用适配。只返回助手文本；超时与非 2xx 抛错由 enrich 吞掉回退。
 *
 * @param {any} runtimeConfig
 * @param {typeof fetch} [fetchImpl]
 */
export function createFlockContextSummaryInvoker(runtimeConfig, fetchImpl = fetch) {
  const apiKey = typeof runtimeConfig?.flockApiKey === 'string' ? runtimeConfig.flockApiKey.trim() : ''
  const model = typeof runtimeConfig?.flockTextModel === 'string' ? runtimeConfig.flockTextModel.trim() : ''
  const baseUrl = typeof runtimeConfig?.flockApiBaseUrl === 'string' && runtimeConfig.flockApiBaseUrl.trim()
    ? runtimeConfig.flockApiBaseUrl.trim().replace(/\/+$/, '')
    : 'https://api.flock.io/v1'
  if (!apiKey || !model) {
    return async () => {
      throw new Error('Agent Context LLM summary invoker 未配置。')
    }
  }
  return async (request) => {
    const { messages, maxTokens = 400 } = request ?? {}
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-litellm-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Agent Context LLM summary HTTP ${response.status}`)
    }
    /** @type {any} */
    const payload = await response.json()
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.flatMap((part) => typeof part?.text === 'string' ? [part.text] : []).join('\n')
    }
    throw new Error('Agent Context LLM summary 响应缺少文本。')
  }
}
