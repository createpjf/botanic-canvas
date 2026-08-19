import { Fragment, useState } from 'react'
import { parseAgentMarkdown, type AgentMarkdownBlock } from '../../domain/agentMarkdown'
import { CopyIcon } from '../../components/BotanicIcons'

const inlinePattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s<]+)/g

function renderInline(text: string) {
  const parts = text.split(inlinePattern)
  return parts.map((part, index) => {
    if (!part) return null
    if (/^\*\*.*\*\*$|^__.*__$/.test(part)) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (/^`.*`$/.test(part)) return <code key={index}>{part.slice(1, -1)}</code>
    if (/^\*.*\*$|^_.*_$/.test(part)) return <em key={index}>{part.slice(1, -1)}</em>
    if (/^https?:\/\//.test(part)) return <a key={index} href={part} target="_blank" rel="noreferrer">{part}</a>
    return <Fragment key={index}>{part.split('\n').map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex ? <br /> : null}{line}</Fragment>)}</Fragment>
  })
}

function CopyableCode({ language, text }: { language?: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const label = language || '代码'

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
      <button type="button" className="agent-prompt-output__copy" onClick={() => void copyText()} aria-label={`复制${label}`} title={`复制${label}`}>
        <CopyIcon />
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
    </header>
    <pre data-language={language}><code>{text}</code></pre>
  </div>
}

function renderBlock(block: AgentMarkdownBlock, index: number) {
  if (block.kind === 'heading') {
    const Heading = `h${block.level}` as 'h1' | 'h2' | 'h3'
    return <Heading key={index}>{renderInline(block.text)}</Heading>
  }
  if (block.kind === 'unordered-list') return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>
  if (block.kind === 'ordered-list') return <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ol>
  if (block.kind === 'code') return <CopyableCode key={index} language={block.language} text={block.text} />
  if (block.kind === 'table') {
    return <div key={index} className="agent-markdown__table-wrap">
      <table>
        <thead>
          <tr>{block.headers.map((header, headerIndex) => <th key={headerIndex}>{renderInline(header)}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => <tr key={rowIndex}>
            {row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell)}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
  }
  if (block.kind === 'rule') return <hr key={index} />
  return <p key={index}>{renderInline(block.text)}</p>
}

export function AgentMarkdown({ content }: { content: string }) {
  return <div className="agent-markdown">{parseAgentMarkdown(content).map(renderBlock)}</div>
}
