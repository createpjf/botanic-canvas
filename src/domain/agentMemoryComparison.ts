import type { BotanicAgentMemoryItem } from './agent'
import type { ProductLocale } from '../i18n/core'

/**
 * 记忆对比（Epic 6 的「Memory 对比、确认、停用、替代」入口里唯一还缺的那一件）。
 *
 * 确认/停用/替代/删除都能经现有的 PUT / DELETE 完成，界面缺的是**看见冲突**：
 * 服务端选择器会在冲突时丢掉排序靠后的一条并记录下来，但用户如果看不到「这两条互相
 * 矛盾」，他就永远不知道该去停用哪一条 —— 冲突会一直累积，每次生成都少一条规则生效。
 *
 * 这里是纯规则：判断哪些记忆彼此矛盾、哪一条当前生效、以及替代关系。
 */

export type MemoryComparisonRow = {
  id: string
  content: string
  status: 'proposed' | 'active' | 'superseded' | 'deleted'
  /** 当前是否真的会进入生成。未激活或被冲突压住的都不会。 */
  effective: boolean
  /** 与它互相矛盾的记忆标识。对称：任一侧声明即成立。 */
  conflictsWith: string[]
  /** 被谁替代（如果有）。 */
  supersededBy?: string
  updatedAt: number
}

function memoryStatus(item: BotanicAgentMemoryItem): MemoryComparisonRow['status'] {
  if (item.status) return item.status
  // 状态字段上线前的历史记忆只有 confidence。
  return item.confidence === 'provisional' ? 'proposed' : 'active'
}

/** 冲突是对称的：任一侧声明即成立，否则单方面声明会被另一侧忽略。 */
export function memoryConflictPairs(memory: BotanicAgentMemoryItem[]): Array<[string, string]> {
  const pairs = new Set<string>()
  for (const item of memory) {
    for (const other of item.conflictsWith ?? []) {
      if (!memory.some((candidate) => candidate.id === other)) continue
      pairs.add([item.id, other].sort().join(' '))
    }
  }
  return [...pairs].map((key) => key.split(' ') as [string, string])
}

/**
 * 摊平成可对比的行，并标出**当前真正生效**的那一条。
 *
 * 生效判定与服务端选择器同构：激活态 + 冲突中排序靠前者胜出。排序口径取
 * 「人工来源优先、其次更新时间新的优先」—— 与选择器分档里对应的那部分一致。
 */
export function memoryComparisonRows(memory: BotanicAgentMemoryItem[]): MemoryComparisonRow[] {
  const ranked = [...memory].sort((left, right) => {
    const humanDelta = Number(right.source === 'human') - Number(left.source === 'human')
    if (humanDelta) return humanDelta
    return Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)
  })
  const kept: BotanicAgentMemoryItem[] = []
  for (const item of ranked) {
    if (memoryStatus(item) !== 'active') continue
    const blocked = kept.some((candidate) => (
      candidate.conflictsWith?.includes(item.id) || item.conflictsWith?.includes(candidate.id)
    ))
    if (!blocked) kept.push(item)
  }
  const effective = new Set(kept.map((item) => item.id))
  return memory.map((item) => ({
    id: item.id,
    content: item.content,
    status: memoryStatus(item),
    effective: effective.has(item.id),
    conflictsWith: [...new Set([
      ...(item.conflictsWith ?? []),
      ...memory.filter((other) => other.conflictsWith?.includes(item.id)).map((other) => other.id),
    ])].filter((id) => id !== item.id),
    ...(item.supersededBy ? { supersededBy: item.supersededBy } : {}),
    updatedAt: Number(item.updatedAt ?? 0),
  }))
}

/**
 * 一条记忆当前为什么不生效。返回空串表示它生效。
 *
 * 「被另一条压住」必须与「你把它停用了」分开说：前者是用户没意识到的冲突，
 * 后者是他自己的决定。
 */
export function memoryIneffectiveReason(
  row: MemoryComparisonRow,
  rows: MemoryComparisonRow[],
  locale: ProductLocale = 'zh-CN',
) {
  if (row.effective) return ''
  if (row.status === 'proposed') {
    return locale === 'en' ? 'Proposed — not active until you confirm it.' : '仅为建议，确认后才会生效。'
  }
  if (row.status === 'superseded') {
    return locale === 'en'
      ? `Superseded by ${row.supersededBy ?? 'another rule'}.`
      : `已被${row.supersededBy ? `「${row.supersededBy}」` : '另一条规则'}替代。`
  }
  if (row.status === 'deleted') {
    return locale === 'en' ? 'Deleted.' : '已删除。'
  }
  const winner = row.conflictsWith.find((id) => rows.some((entry) => entry.id === id && entry.effective))
  if (winner) {
    return locale === 'en'
      ? `Conflicts with ${winner}, which takes effect instead. Retire one of them so the intent is unambiguous.`
      : `与「${winner}」冲突，当前生效的是那一条。停用其中一条，规则才不会互相打架。`
  }
  return locale === 'en' ? 'Not active.' : '当前未生效。'
}

/** 适用主体的展示标签。顺序与服务端 `MEMORY_SUBJECTS` 一致。 */
const subjectLabels: Record<string, Record<ProductLocale, string>> = {
  project: { 'zh-CN': '全项目', en: 'Whole project' },
  brand: { 'zh-CN': '品牌', en: 'Brand' },
  product: { 'zh-CN': '产品', en: 'Product' },
  channel: { 'zh-CN': '渠道', en: 'Channel' },
  user: { 'zh-CN': '仅我', en: 'Just me' },
}

export const MEMORY_SUBJECT_OPTIONS = ['project', 'brand', 'product', 'channel', 'user'] as const

export function memorySubjectLabel(subject: string | undefined, locale: ProductLocale = 'zh-CN') {
  return subjectLabels[subject ?? 'project']?.[locale] ?? subject ?? ''
}

/**
 * 一条规则的适用范围说明。
 *
 * 「全项目」与「限定了范围」必须一眼分得开：限定范围的规则**不会**进入每一次生成，
 * 用户如果以为它总是生效，就会在别的渠道下疑惑「我明明写了这条规则」。
 */
export function memorySubjectDescription(
  item: Pick<BotanicAgentMemoryItem, 'subject' | 'subjectValue'>,
  locale: ProductLocale = 'zh-CN',
) {
  const subject = item.subject ?? 'project'
  if (subject === 'project') {
    return locale === 'en' ? 'Applies to every generation in this project.' : '本项目每一次生成都适用。'
  }
  const label = memorySubjectLabel(subject, locale)
  const value = item.subjectValue ?? ''
  return locale === 'en'
    ? `Only applies when ${label.toLowerCase()} is “${value}”. It does not take part in other generations.`
    : `只在${label}为「${value}」时适用，其余生成不会带上它。`
}
