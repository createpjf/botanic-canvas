import { SparkleIcon } from '../../components/BotanicIcons'
import {
  botanicAgentMentionReferencePreview,
  botanicAgentMessageRichView,
  parseBotanicAgentRichText,
  type BotanicAgentMentionCatalog,
  type BotanicAgentMessageMention,
  type BotanicAgentRichSpan,
} from '../../domain/agentMentions'
import { useProductI18n } from '../../i18n/react'

function mentionKindLabel(kind: 'skill' | 'reference' | 'mention', locale: 'zh-CN' | 'en') {
  if (kind === 'skill') return locale === 'en' ? 'Skill' : 'Skill'
  if (kind === 'reference') return locale === 'en' ? 'Asset' : '素材'
  return locale === 'en' ? 'Mention' : '引用'
}

export function AgentMentionChip({
  mention,
  catalogs,
}: {
  mention: BotanicAgentMessageMention | Extract<BotanicAgentRichSpan, { kind: 'skill' | 'reference' | 'mention' }>
  catalogs?: BotanicAgentMentionCatalog
}) {
  const { locale } = useProductI18n()
  if (mention.kind === 'mention') {
    return <span className="agent-mention agent-mention--unknown" title={mentionKindLabel('mention', locale)}>@{mention.label}</span>
  }
  if (mention.kind === 'skill') {
    return <span className="agent-mention agent-mention--skill" title={mentionKindLabel('skill', locale)}>
      <SparkleIcon />
      <b>{mention.name}</b>
    </span>
  }
  const preview = botanicAgentMentionReferencePreview(
    mention.kind === 'reference' ? { kind: 'reference', id: mention.id, label: mention.label } : mention,
    catalogs,
  )
  const image = 'image' in mention ? mention.image : preview.image
  return <span className="agent-mention agent-mention--reference" title={`${mentionKindLabel('reference', locale)} ${preview.label}`}>
    {image ? <img src={image} alt="" /> : <i aria-hidden="true">{preview.label.slice(0, 1)}</i>}
    <b>{preview.label}</b>
  </span>
}

export function AgentRichText({
  text,
  spans,
  catalogs,
}: {
  text?: string
  spans?: readonly BotanicAgentRichSpan[]
  catalogs?: BotanicAgentMentionCatalog
}) {
  const resolved = spans ?? parseBotanicAgentRichText(text ?? '', catalogs)
  if (!resolved.length) return null
  const onlyPlain = resolved.length === 1 && resolved[0].kind === 'text' ? resolved[0] : undefined
  if (onlyPlain) return <>{onlyPlain.text}</>
  return <>{resolved.map((span, index) => {
    if (span.kind === 'text') return <span key={`text-${index}`}>{span.text}</span>
    return <AgentMentionChip key={`${span.kind}-${'id' in span ? span.id : span.label}-${index}`} mention={span} catalogs={catalogs} />
  })}</>
}

export function AgentMessageMentions({
  mentions,
  catalogs,
}: {
  mentions: readonly BotanicAgentMessageMention[]
  catalogs?: BotanicAgentMentionCatalog
}) {
  const { locale } = useProductI18n()
  if (!mentions.length) return null
  return <div className="agent-message__mentions" aria-label={locale === 'en' ? 'Referenced Skills and assets' : '已引用 Skill 与素材'}>
    {mentions.map((mention) => <AgentMentionChip key={`${mention.kind}-${mention.id}`} mention={mention} catalogs={catalogs} />)}
  </div>
}

export function AgentMessageRichContent({
  content,
  mentions,
  catalogs,
}: {
  content: string
  mentions?: readonly BotanicAgentMessageMention[]
  catalogs?: BotanicAgentMentionCatalog
}) {
  const view = botanicAgentMessageRichView({ content, mentions, catalogs })
  const hasText = view.spans.some((span) => span.kind === 'text' ? Boolean(span.text) : true)
  return <>
    <AgentMessageMentions mentions={view.mentions} catalogs={catalogs} />
    {hasText ? <p><AgentRichText spans={view.spans} catalogs={catalogs} /></p> : null}
  </>
}
