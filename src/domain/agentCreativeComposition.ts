/**
 * MCoT 式创意分解：复杂创意简报（一套多资产交付，如「1 张主视觉 + 3 张细节 + 1 条视频」）
 * 先分解为结构化方案，再逐项进入生成。方案是对话层实体：以格式化文本随消息持久化，
 * 结构化数据用于逐项执行；它不是 Run，也不是画布节点。
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

/** 方案卡正文：随消息持久化的格式化文本，逐项可读、可被后续指令引用（“生成第 2 项”）。 */
export function formatBotanicAgentCompositionMessage(composition: BotanicAgentComposition): string {
  const lines = [
    `已把这次需求分解为一套 ${composition.items.length} 项的创意方案：${composition.theme}`,
    '',
    ...composition.items.map((item) => {
      const spec = item.mediaKind === 'video'
        ? `视频 ${item.duration} 秒`
        : `图片 ${item.count} 张`
      return [
        `${item.index}. ${item.title}（${spec}）${item.purpose ? ` — ${item.purpose}` : ''}`,
        `   ${item.prompt}`,
      ].join('\n')
    }),
    '',
    '回复「生成第 N 项」逐项推进，或继续调整方案。',
  ]
  return lines.join('\n')
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
