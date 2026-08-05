import { Fragment } from 'react'
import { parseAgentMarkdown, type AgentMarkdownBlock } from '../../domain/agentMarkdown'

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

function renderBlock(block: AgentMarkdownBlock, index: number) {
  if (block.kind === 'heading') {
    const Heading = `h${block.level}` as 'h1' | 'h2' | 'h3'
    return <Heading key={index}>{renderInline(block.text)}</Heading>
  }
  if (block.kind === 'unordered-list') return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>
  if (block.kind === 'ordered-list') return <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ol>
  if (block.kind === 'code') return <pre key={index} data-language={block.language}><code>{block.text}</code></pre>
  if (block.kind === 'rule') return <hr key={index} />
  return <p key={index}>{renderInline(block.text)}</p>
}

export function AgentMarkdown({ content }: { content: string }) {
  return <div className="agent-markdown">{parseAgentMarkdown(content).map(renderBlock)}</div>
}
