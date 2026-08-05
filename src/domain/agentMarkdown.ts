export type AgentMarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'unordered-list'; items: string[] }
  | { kind: 'ordered-list'; items: string[] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'rule' }

const isRule = (line: string) => /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
const isUnorderedItem = (line: string) => /^\s*[-*+]\s+(.+)$/.exec(line)?.[1]
const isOrderedItem = (line: string) => /^\s*\d+[.)]\s+(.+)$/.exec(line)?.[1]

/**
 * A deliberately small, safe Markdown subset for assistant messages.
 * It keeps the UI deterministic and never interprets arbitrary HTML.
 */
export function parseAgentMarkdown(source: string): AgentMarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: AgentMarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = /^\s*```\s*([\w-]+)?\s*$/.exec(line)
    if (fence) {
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ kind: 'code', language: fence[1], text: codeLines.join('\n') })
      continue
    }

    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: heading[2] })
      index += 1
      continue
    }
    if (isRule(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    const unordered = isUnorderedItem(line)
    if (unordered) {
      const items: string[] = []
      while (index < lines.length) {
        const item = isUnorderedItem(lines[index])
        if (!item) break
        items.push(item.trim())
        index += 1
      }
      blocks.push({ kind: 'unordered-list', items })
      continue
    }

    const ordered = isOrderedItem(line)
    if (ordered) {
      const items: string[] = []
      while (index < lines.length) {
        const item = isOrderedItem(lines[index])
        if (!item) break
        items.push(item.trim())
        index += 1
      }
      blocks.push({ kind: 'ordered-list', items })
      continue
    }

    const paragraph: string[] = [line.trimEnd()]
    index += 1
    while (index < lines.length && lines[index].trim()) {
      const next = lines[index]
      if (/^\s*```/.test(next) || /^(#{1,3})\s+/.test(next) || isRule(next) || isUnorderedItem(next) || isOrderedItem(next)) break
      paragraph.push(next.trimEnd())
      index += 1
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
  }

  return blocks
}
