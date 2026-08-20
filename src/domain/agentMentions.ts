export type BotanicAgentMentionSkill = {
  id: string
  name: string
}

export type BotanicAgentMentionReference = {
  id: string
  label: string
  image?: string
}

export type BotanicAgentMentionCatalog = {
  skills?: readonly BotanicAgentMentionSkill[]
  references?: readonly BotanicAgentMentionReference[]
}

export type BotanicAgentMessageMention =
  | { kind: 'skill'; id: string; name: string }
  | { kind: 'reference'; id: string; label: string }

export type BotanicAgentRichSpan =
  | { kind: 'text'; text: string }
  | { kind: 'skill'; id: string; name: string }
  | { kind: 'reference'; id: string; label: string; image?: string }
  | { kind: 'mention'; label: string }

export type BotanicAgentComposerSubmission = {
  /** 用户气泡正文：已去掉已解析的 @ 引用，只留自然语言。 */
  content: string
  /** 交给 Agent 的可执行指令：没有正文时用引用字段生成一句兜底。 */
  instruction: string
  mentions: BotanicAgentMessageMention[]
}

type MentionLabelHit =
  | { kind: 'skill'; token: string; id: string; name: string }
  | { kind: 'reference'; token: string; id: string; label: string; image?: string }

const tokenBoundary = /[\s@.,;:!?，。；：！？]/u

function mentionLabelHits(catalogs: BotanicAgentMentionCatalog): MentionLabelHit[] {
  const hits: MentionLabelHit[] = []
  for (const skill of catalogs.skills ?? []) {
    if (skill.id.trim()) hits.push({ kind: 'skill', token: skill.id.trim(), id: skill.id, name: skill.name })
    if (skill.name.trim()) hits.push({ kind: 'skill', token: skill.name.trim(), id: skill.id, name: skill.name })
  }
  for (const reference of catalogs.references ?? []) {
    if (reference.id.trim()) {
      hits.push({
        kind: 'reference',
        token: reference.id.trim(),
        id: reference.id,
        label: reference.label,
        ...(reference.image ? { image: reference.image } : {}),
      })
    }
    if (reference.label.trim()) {
      hits.push({
        kind: 'reference',
        token: reference.label.trim(),
        id: reference.id,
        label: reference.label,
        ...(reference.image ? { image: reference.image } : {}),
      })
    }
  }
  return hits.sort((left, right) => right.token.length - left.token.length || left.token.localeCompare(right.token))
}

function matchMentionToken(rest: string, hits: readonly MentionLabelHit[]): MentionLabelHit | { kind: 'mention'; token: string } | undefined {
  const matched = hits.find((hit) => (
    rest.startsWith(hit.token)
    && (rest.length === hit.token.length || tokenBoundary.test(rest[hit.token.length] ?? ''))
  ))
  if (matched) return matched
  const fallback = rest.match(/^[^\s@]+/u)?.[0]
  return fallback ? { kind: 'mention', token: fallback } : undefined
}

/** 把正文里的 @Skill / @素材 拆成可独立渲染的片段；未登记的 @token 仍标成 mention。 */
export function parseBotanicAgentRichText(
  text: string,
  catalogs: BotanicAgentMentionCatalog = {},
): BotanicAgentRichSpan[] {
  if (!text) return []
  const hits = mentionLabelHits(catalogs)
  const spans: BotanicAgentRichSpan[] = []
  let cursor = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@') continue
    const matched = matchMentionToken(text.slice(index + 1), hits)
    if (!matched) continue
    if (index > cursor) spans.push({ kind: 'text', text: text.slice(cursor, index) })
    if (matched.kind === 'skill') spans.push({ kind: 'skill', id: matched.id, name: matched.name })
    else if (matched.kind === 'reference') {
      spans.push({
        kind: 'reference',
        id: matched.id,
        label: matched.label,
        ...(matched.image ? { image: matched.image } : {}),
      })
    } else spans.push({ kind: 'mention', label: matched.token })
    const end = index + 1 + matched.token.length
    cursor = end
    index = end - 1
  }
  if (cursor < text.length) spans.push({ kind: 'text', text: text.slice(cursor) })
  return spans
}

function collapseMentionGaps(text: string) {
  return text
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .trim()
}

/** 从可执行 Prompt 中去掉已登记的 @ 引用，未登记 token 原样保留。 */
export function stripBotanicAgentResolvedMentions(
  text: string,
  catalogs: BotanicAgentMentionCatalog = {},
): string {
  return collapseMentionGaps(parseBotanicAgentRichText(text, catalogs).map((span) => {
    if (span.kind === 'text') return span.text
    if (span.kind === 'mention') return `@${span.label}`
    return ''
  }).join(''))
}

export function snapshotBotanicAgentComposerMentions(input: {
  skills?: readonly BotanicAgentMentionSkill[]
  references?: readonly BotanicAgentMentionReference[]
}): BotanicAgentMessageMention[] {
  const mentions: BotanicAgentMessageMention[] = []
  const seen = new Set<string>()
  for (const skill of input.skills ?? []) {
    const id = skill.id.trim()
    const name = skill.name.trim()
    const key = `skill:${id}`
    if (!id || !name || seen.has(key)) continue
    seen.add(key)
    mentions.push({ kind: 'skill', id, name })
  }
  for (const reference of input.references ?? []) {
    const id = reference.id.trim()
    const label = reference.label.trim()
    const key = `reference:${id}`
    if (!id || !label || seen.has(key)) continue
    seen.add(key)
    mentions.push({ kind: 'reference', id, label })
  }
  return mentions
}

export function botanicAgentMentionOnlyInstruction(
  mentions: readonly BotanicAgentMessageMention[],
  locale: 'zh-CN' | 'en' = 'zh-CN',
): string {
  const hasSkill = mentions.some((mention) => mention.kind === 'skill')
  const hasReference = mentions.some((mention) => mention.kind === 'reference')
  if (locale === 'en') {
    if (hasSkill && hasReference) return 'Follow the mounted Skills and referenced assets.'
    if (hasSkill) return 'Follow the mounted Skills.'
    return 'Use the referenced assets.'
  }
  if (hasSkill && hasReference) return '按已挂载 Skill 与已引用素材处理。'
  if (hasSkill) return '按已挂载 Skill 执行。'
  return '按已引用素材处理。'
}

/**
 * Composer 提交：芯片是引用字段，textarea 只留自然语言。
 * 已挂载 Skill / 已引用素材写入 mentions，不把 @名称 当作画面描述。
 */
export function prepareBotanicAgentComposerSubmission(input: {
  instruction: string
  mountedSkills?: readonly BotanicAgentMentionSkill[]
  contextItems?: readonly BotanicAgentMentionReference[]
  locale?: 'zh-CN' | 'en'
}): BotanicAgentComposerSubmission | undefined {
  const catalogs: BotanicAgentMentionCatalog = {
    skills: input.mountedSkills ?? [],
    references: input.contextItems ?? [],
  }
  const content = stripBotanicAgentResolvedMentions(input.instruction.replace(/\u00a0/g, ' '), catalogs)
  const mentions = snapshotBotanicAgentComposerMentions({
    skills: input.mountedSkills,
    references: input.contextItems,
  })
  if (!content && !mentions.length) return undefined
  return {
    content,
    instruction: content || botanicAgentMentionOnlyInstruction(mentions, input.locale ?? 'zh-CN'),
    mentions,
  }
}

export function hydrateBotanicAgentMentions(
  mentions: readonly BotanicAgentMessageMention[] | undefined,
  catalogs: BotanicAgentMentionCatalog = {},
): BotanicAgentMessageMention[] {
  if (!mentions?.length) return []
  const skills = new Map((catalogs.skills ?? []).map((item) => [item.id, item]))
  const references = new Map((catalogs.references ?? []).map((item) => [item.id, item]))
  return mentions.map((mention) => {
    if (mention.kind === 'skill') {
      return { kind: 'skill', id: mention.id, name: skills.get(mention.id)?.name ?? mention.name }
    }
    return { kind: 'reference', id: mention.id, label: references.get(mention.id)?.label ?? mention.label }
  })
}

export function botanicAgentMentionReferencePreview(
  mention: Extract<BotanicAgentMessageMention, { kind: 'reference' }>,
  catalogs: BotanicAgentMentionCatalog = {},
): BotanicAgentMentionReference {
  const hit = catalogs.references?.find((item) => item.id === mention.id)
  return {
    id: mention.id,
    label: hit?.label ?? mention.label,
    ...(hit?.image ? { image: hit.image } : {}),
  }
}

/**
 * 有持久化引用时：芯片走 mentions，正文当普通 Prompt。
 * 旧消息没有 mentions 时：从正文解析 @token，兼容历史气泡。
 */
export function botanicAgentMessageRichView(input: {
  content: string
  mentions?: readonly BotanicAgentMessageMention[]
  catalogs?: BotanicAgentMentionCatalog
}): { mentions: BotanicAgentMessageMention[]; spans: BotanicAgentRichSpan[] } {
  const catalogs = input.catalogs ?? {}
  const persisted = hydrateBotanicAgentMentions(input.mentions, catalogs)
  if (persisted.length) {
    return {
      mentions: persisted,
      spans: input.content ? [{ kind: 'text', text: input.content }] : [],
    }
  }
  return {
    mentions: [],
    spans: parseBotanicAgentRichText(input.content, catalogs),
  }
}
