import type { BotanicAgentContextSnapshot, BotanicAgentMessage, BotanicAgentPlan } from './agent.ts'
import type { GenerationSettings } from './canvas.ts'
import type { ProductLocale } from '../i18n/core'

/**
 * MCoT 式创意分解：复杂创意简报（一套多资产交付，如「1 张主视觉 + 3 张细节 + 1 条视频」）
 * 先分解为结构化方案，再逐项进入生成。方案是会话消息（kind: composition），
 * 不是独立 ProductStore 实体，也不是 Run 或画布节点。
 */

export type BotanicAgentCompositionItem = {
  /** 方案内序号（1 起）。 */
  index: number
  title: string
  /** 该资产在整套交付里的用途，一句话。 */
  purpose?: string
  mediaKind: 'image' | 'video'
  prompt: string
  count: number
  /** 仅视频：时长（秒）。 */
  duration?: number
}

export type BotanicAgentComposition = {
  theme: string
  items: BotanicAgentCompositionItem[]
}

export const botanicAgentCompositionItemLimit = 8
export const botanicAgentCompositionItemCountLimit = 4

type RawCompositionItem = {
  title?: unknown
  purpose?: unknown
  mediaKind?: unknown
  prompt?: unknown
  count?: unknown
  duration?: unknown
}

/**
 * 归一化模型产出的分解方案：裁掉空项与超限项，数量与时长夹取到目录内。
 * 少于 2 个有效项时返回 null——单项请求不该走分解，直接生成即可。
 */
export function normalizeBotanicAgentComposition(raw: {
  theme?: unknown
  items?: unknown
}, options?: { videoDurations?: number[] }): BotanicAgentComposition | null {
  const theme = typeof raw.theme === 'string' ? raw.theme.trim().slice(0, 200) : ''
  const rawItems = Array.isArray(raw.items) ? raw.items as RawCompositionItem[] : []
  const durations = options?.videoDurations?.length ? options.videoDurations : [5, 10, 15]
  const items: BotanicAgentCompositionItem[] = []
  for (const item of rawItems) {
    if (items.length >= botanicAgentCompositionItemLimit) break
    if (!item || typeof item !== 'object') continue
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    if (!prompt) continue
    const mediaKind = item.mediaKind === 'video' ? 'video' : 'image'
    const parsedCount = Number(item.count)
    const count = mediaKind === 'video'
      ? 1
      : Number.isFinite(parsedCount)
        ? Math.min(botanicAgentCompositionItemCountLimit, Math.max(1, Math.floor(parsedCount)))
        : 1
    const parsedDuration = Number(item.duration)
    items.push({
      index: items.length + 1,
      title: (typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `第 ${items.length + 1} 项`).slice(0, 80),
      ...(typeof item.purpose === 'string' && item.purpose.trim() ? { purpose: item.purpose.trim().slice(0, 200) } : {}),
      mediaKind,
      prompt: prompt.slice(0, 6000),
      count,
      ...(mediaKind === 'video'
        ? { duration: durations.includes(parsedDuration) ? parsedDuration : durations[0] }
        : {}),
    })
  }
  if (!theme || items.length < 2) return null
  return { theme, items }
}

export function botanicAgentCompositionItemSpecLabel(
  item: Pick<BotanicAgentCompositionItem, 'mediaKind' | 'count' | 'duration'>,
  locale: ProductLocale = 'zh-CN',
) {
  if (locale === 'en') {
    return item.mediaKind === 'video'
      ? `${item.duration ?? 5}-second video`
      : `${item.count} ${item.count === 1 ? 'image' : 'images'}`
  }
  return item.mediaKind === 'video'
    ? `视频 ${item.duration ?? 5} 秒`
    : `图片 ${item.count} 张`
}

export function formatBotanicAgentCompositionSummary(
  composition: BotanicAgentComposition,
  locale: ProductLocale = 'zh-CN',
) {
  if (locale === 'en') {
    return `This request is organized into a creative composition with ${composition.items.length} items: ${composition.theme}`
  }
  return `已把这次需求分解为一套 ${composition.items.length} 项的创意方案：${composition.theme}`
}

/**
 * 方案卡可读副本：复制/检索仍用这段文本；交互按钮由消息上的 composition 字段驱动。
 */
export function formatBotanicAgentCompositionMessage(
  composition: BotanicAgentComposition,
  locale: ProductLocale = 'zh-CN',
): string {
  if (locale === 'en') {
    const lines = [
      formatBotanicAgentCompositionSummary(composition, locale),
      '',
      ...composition.items.map((item) => {
        const spec = botanicAgentCompositionItemSpecLabel(item, locale)
        const title = /^第\s*\d+\s*项$/u.test(item.title) ? `Item ${item.index}` : item.title
        return [
          `${item.index}. ${title} (${spec})${item.purpose ? ` — ${item.purpose}` : ''}`,
          `   ${item.prompt}`,
        ].join('\n')
      }),
      '',
      'Select “Generate item” to continue one item at a time, or “Run full set” to generate the composition together.',
    ]
    return lines.join('\n')
  }
  const lines = [
    formatBotanicAgentCompositionSummary(composition, locale),
    '',
    ...composition.items.map((item) => {
      const spec = botanicAgentCompositionItemSpecLabel(item)
      return [
        `${item.index}. ${item.title}（${spec}）${item.purpose ? ` — ${item.purpose}` : ''}`,
        `   ${item.prompt}`,
      ].join('\n')
    }),
    '',
    '点方案卡「生成此项」或回复「生成第 N 项」逐项推进，也可「执行方案」一次整套生成。',
  ]
  return lines.join('\n')
}

/** 从一条消息取出可用方案；纯文本旧消息没有结构化字段，返回 null。 */
export function botanicAgentMessageComposition(
  message: Pick<BotanicAgentMessage, 'role' | 'composition'>,
): BotanicAgentComposition | null {
  if (message.role !== 'assistant' || !message.composition) return null
  return normalizeBotanicAgentComposition(message.composition)
}

/** 刷新后从会话消息恢复最近一份结构化方案；旧卡仍用自己消息上的 composition。 */
export function latestBotanicAgentComposition(
  messages: ReadonlyArray<Pick<BotanicAgentMessage, 'role' | 'composition'>>,
): BotanicAgentComposition | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const composition = botanicAgentMessageComposition(messages[index])
    if (composition) return composition
  }
  return null
}

/** 一键整套执行语：「执行方案」「整套生成」「全部生成」。 */
export function instructionRequestsCompositionRun(instruction: string) {
  return /(?:执行|生成|做)(?:这个|该)?(?:整套)?方案|整套(?:生成|执行|做)|全部生成|一键(?:生成|执行)/u.test(instruction.trim())
}

/**
 * 成套方案 → 待确认计划：分支按条目展开（见 botanicAgentConfirmBranchDrafts），
 * 各条目自带媒体类型与定稿 Prompt。整套生成基于引用图片素材，与首次生成同一约束。
 */
export function buildBotanicAgentCompositionPlan(input: {
  instruction: string
  composition: BotanicAgentComposition
  contextSnapshot: BotanicAgentContextSnapshot[]
  settings: GenerationSettings
  locale?: ProductLocale
}): BotanicAgentPlan {
  const locale = input.locale ?? 'zh-CN'
  const imageContext = input.contextSnapshot.filter((item) =>
    item.mediaKind === 'image' && (item.kind === '素材' || item.kind === '结果'))
  if (!imageContext.length) {
    throw new Error(locale === 'en'
      ? 'A full-set generation needs at least one image asset or result as a visual anchor. Reference an image first.'
      : '整套生成需要至少一项图片素材或图片结果作为基准，请先引用素材。')
  }
  const videoCount = input.composition.items.filter((item) => item.mediaKind === 'video').length
  return {
    intent: 'initial_generation',
    instruction: input.instruction,
    summary: locale === 'en'
      ? `Run the full “${input.composition.theme}” composition: ${input.composition.items.length} items${videoCount ? `, including ${videoCount} video${videoCount === 1 ? '' : 's'}` : ''}.`
      : `成套生成「${input.composition.theme}」，共 ${input.composition.items.length} 项${videoCount ? `（含 ${videoCount} 条视频）` : ''}。`,
    contextSnapshot: input.contextSnapshot,
    references: imageContext.map((item) => ({
      source: 'context_node' as const,
      id: item.nodeId,
      label: item.label,
      ...(item.role ? { role: item.role } : {}),
    })),
    constraints: [],
    // plan.prompt 是分支缺省兜底；每个分支实际使用条目自己的定稿 Prompt。
    prompt: input.composition.items[0].prompt,
    settings: input.settings,
    output: { mode: 'single', count: input.composition.items.length, candidatesPerItem: 1 },
    composition: structuredClone(input.composition),
  }
}

/** 从用户指令解析「生成第 N 项」；返回目标项，不匹配或越界返回 null。 */
export function resolveBotanicAgentCompositionItem(
  composition: BotanicAgentComposition,
  instruction: string,
): BotanicAgentCompositionItem | null {
  const match = instruction.match(/(?:生成|执行|先做|做)\s*第\s*(\d+|[一二三四五六七八])\s*[项张条个]/u)
  if (!match) return null
  const numerals: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 }
  const index = numerals[match[1]] ?? Number(match[1])
  return composition.items.find((item) => item.index === index) ?? null
}
