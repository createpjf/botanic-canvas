import { useState } from 'react'
import type { BotanicAgentMentionCatalog } from '../../domain/agentMentions'
import { resolveAgentPromptSections, type AgentPromptSections } from '../../domain/agentMarkdown'
import { CopyIcon } from '../../components/BotanicIcons'
import { AgentMarkdown } from './AgentMarkdown'
import { AgentRichText } from './AgentMentionText'
import { useProductMessages } from '../../i18n/react'

type PromptSectionKind = 'prompt' | 'negative'

function PromptSection({
  label,
  text,
  kind,
  copied,
  catalogs,
  onCopy,
}: {
  label: string
  text: string
  kind: PromptSectionKind
  copied: PromptSectionKind | null
  catalogs?: BotanicAgentMentionCatalog
  onCopy: (kind: PromptSectionKind, text: string) => void
}) {
  const copy = useProductMessages({
    'zh-CN': { ready: '可直接复制', copy: '复制', copied: '已复制' },
    en: { ready: 'Ready to copy', copy: 'Copy', copied: 'Copied' },
  })
  const isCopied = copied === kind

  return <section className="agent-prompt-output__section" aria-label={label}>
    <header>
      <div>
        <strong>{label}</strong>
        <small>{copy.ready}</small>
      </div>
      <button type="button" className="agent-prompt-output__copy" onClick={() => onCopy(kind, text)} aria-label={`${copy.copy} ${label}`} title={`${copy.copy} ${label}`}>
        <CopyIcon />
        <span>{isCopied ? copy.copied : copy.copy}</span>
      </button>
    </header>
    <pre className="agent-prompt-output__text"><AgentRichText text={text} catalogs={catalogs} /></pre>
  </section>
}

function PromptOutput({ sections, catalogs }: { sections: AgentPromptSections; catalogs?: BotanicAgentMentionCatalog }) {
  const [copied, setCopied] = useState<PromptSectionKind | null>(null)

  const copyText = async (kind: PromptSectionKind, text: string) => {
    if (!navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
    } catch {
      setCopied(null)
    }
  }

  return <div className="agent-prompt-output">
    {sections.before ? <AgentMarkdown content={sections.before} catalogs={catalogs} /> : null}
    <PromptSection label={sections.promptLabel || 'Prompt'} text={sections.prompt} kind="prompt" copied={copied} catalogs={catalogs} onCopy={copyText} />
    {sections.negativePrompt ? <PromptSection label={sections.negativePromptLabel || 'Negative prompt'} text={sections.negativePrompt} kind="negative" copied={copied} catalogs={catalogs} onCopy={copyText} /> : null}
    {sections.after ? <AgentMarkdown content={sections.after} catalogs={catalogs} /> : null}
  </div>
}

export function AgentPromptResponse({ content, prompt, mentionCatalog }: { content: string; prompt?: string; mentionCatalog?: BotanicAgentMentionCatalog }) {
  const sections = resolveAgentPromptSections(content, prompt)
  return sections ? <PromptOutput sections={sections} catalogs={mentionCatalog} /> : <AgentMarkdown content={content} catalogs={mentionCatalog} />
}
