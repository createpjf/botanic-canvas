import { useState } from 'react'
import { parseAgentPromptSections, type AgentPromptSections } from '../../domain/agentMarkdown'
import { CopyIcon } from '../../components/BotanicIcons'
import { AgentMarkdown } from './AgentMarkdown'

type PromptSectionKind = 'prompt' | 'negative'

function PromptSection({
  label,
  text,
  kind,
  copied,
  onCopy,
}: {
  label: string
  text: string
  kind: PromptSectionKind
  copied: PromptSectionKind | null
  onCopy: (kind: PromptSectionKind, text: string) => void
}) {
  const isCopied = copied === kind

  return <section className="agent-prompt-output__section" aria-label={label}>
    <header>
      <div>
        <strong>{label}</strong>
        <small>可直接复制</small>
      </div>
      <button type="button" className="agent-prompt-output__copy" onClick={() => onCopy(kind, text)} aria-label={`复制${label}`} title={`复制${label}`}>
        <CopyIcon />
        <span>{isCopied ? '已复制' : '复制'}</span>
      </button>
    </header>
    <pre>{text}</pre>
  </section>
}

function PromptOutput({ sections }: { sections: AgentPromptSections }) {
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
    {sections.before ? <AgentMarkdown content={sections.before} /> : null}
    <PromptSection label={sections.promptLabel || 'Prompt'} text={sections.prompt} kind="prompt" copied={copied} onCopy={copyText} />
    {sections.negativePrompt ? <PromptSection label={sections.negativePromptLabel || 'Negative prompt'} text={sections.negativePrompt} kind="negative" copied={copied} onCopy={copyText} /> : null}
    {sections.after ? <AgentMarkdown content={sections.after} /> : null}
  </div>
}

export function AgentPromptResponse({ content }: { content: string }) {
  const sections = parseAgentPromptSections(content)
  return sections ? <PromptOutput sections={sections} /> : <AgentMarkdown content={content} />
}
