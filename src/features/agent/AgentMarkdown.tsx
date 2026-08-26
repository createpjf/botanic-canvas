import { Fragment, useState } from 'react'
import type { BotanicAgentMentionCatalog } from '../../domain/agentMentions'
import {
  localizeAgentSourceLabel,
  parseAgentMarkdown,
  splitAgentMessageSources,
  stripAgentMarkdownHashes,
  type AgentMarkdownBlock,
} from '../../domain/agentMarkdown'
import { CopyIcon } from '../../components/BotanicIcons'
import { AgentRichText } from './AgentMentionText'
import { useProductI18n } from '../../i18n/react'

const inlinePattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s<]+)/g

function renderInline(text: string, catalogs?: BotanicAgentMentionCatalog) {
  const safe = stripAgentMarkdownHashes(text)
  const parts = safe.split(inlinePattern)
  return parts.map((part, index) => {
    if (!part) return null
    if (/^\*\*.*\*\*$|^__.*__$/.test(part)) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (/^`.*`$/.test(part)) return <code key={index}>{part.slice(1, -1)}</code>
    if (/^\*.*\*$|^_.*_$/.test(part)) return <em key={index}>{part.slice(1, -1)}</em>
    if (/^https?:\/\//.test(part)) return <a key={index} href={part} target="_blank" rel="noreferrer">{part}</a>
    return <Fragment key={index}>{part.split('\n').map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex ? <br /> : null}{catalogs ? <AgentRichText text={line} catalogs={catalogs} /> : line}</Fragment>)}</Fragment>
  })
}

function CopyableCode({ language, text }: { language?: string; text: string }) {
  const { locale } = useProductI18n()
  const [copied, setCopied] = useState(false)
  const label = language || (locale === 'en' ? 'Code' : '代码')
  const copyLabel = locale === 'en' ? 'Copy' : '复制'

  const copyText = async () => {
    if (!navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return <div className="agent-markdown__code">
    <header>
      <small>{label}</small>
      <button type="button" className="agent-prompt-output__copy" onClick={() => void copyText()} aria-label={`${copyLabel} ${label}`} title={`${copyLabel} ${label}`}>
        <CopyIcon />
        <span>{copied ? (locale === 'en' ? 'Copied' : '已复制') : copyLabel}</span>
      </button>
    </header>
    <pre data-language={language}><code>{text}</code></pre>
  </div>
}

function renderBlock(block: AgentMarkdownBlock, index: number, catalogs?: BotanicAgentMentionCatalog) {
  if (block.kind === 'heading') {
    // 解析已把 #{4–6} 压到 3；这里再 clamp，避免脏数据落到非法标签。
    const level = Math.min(3, Math.max(1, block.level)) as 1 | 2 | 3
    const Heading = `h${level}` as 'h1' | 'h2' | 'h3'
    return <Heading key={index}>{renderInline(block.text, catalogs)}</Heading>
  }
  if (block.kind === 'unordered-list') return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, catalogs)}</li>)}</ul>
  if (block.kind === 'ordered-list') return <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, catalogs)}</li>)}</ol>
  if (block.kind === 'code') return <CopyableCode key={index} language={block.language} text={block.text} />
  if (block.kind === 'table') {
    return <div key={index} className="agent-markdown__table-wrap">
      <table>
        <thead>
          <tr>{block.headers.map((header, headerIndex) => <th key={headerIndex}>{renderInline(header, catalogs)}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => <tr key={rowIndex}>
            {row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell, catalogs)}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
  }
  if (block.kind === 'rule') return <hr key={index} />
  return <p key={index}>{renderInline(block.text, catalogs)}</p>
}

export function AgentMarkdownSources({ sources }: { sources: string[] }) {
  const { locale } = useProductI18n()
  if (!sources.length) return null
  return <div className="agent-markdown__sources" aria-label={locale === 'en' ? 'Sources' : '来源'}>
    <span>{locale === 'en' ? 'Sources' : '来源'}</span>
    {sources.map((source) => <small key={source}>{localizeAgentSourceLabel(source, locale)}</small>)}
  </div>
}

export function AgentMarkdown({
  content,
  catalogs,
  showSources = true,
}: {
  content: string
  catalogs?: BotanicAgentMentionCatalog
  showSources?: boolean
}) {
  const { body, sources } = splitAgentMessageSources(content)
  return <div className="agent-markdown">
    {parseAgentMarkdown(body).map((block, index) => renderBlock(block, index, catalogs))}
    {showSources ? <AgentMarkdownSources sources={sources} /> : null}
  </div>
}
