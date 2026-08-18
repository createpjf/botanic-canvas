export type AgentMarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'unordered-list'; items: string[] }
  | { kind: 'ordered-list'; items: string[] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'rule' }

export type AgentPromptSections = {
  before: string
  prompt: string
  promptLabel: string
  negativePrompt?: string
  negativePromptLabel?: string
  after: string
}

const isRule = (line: string) => /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
const isUnorderedItem = (line: string) => /^\s*[-*+]\s+(.+)$/.exec(line)?.[1]
const isOrderedItem = (line: string) => /^\s*\d+[.)]\s+(.+)$/.exec(line)?.[1]
const promptHeading = /^\s*(Prompt(?:\s*\([A-Za-z]{2,8}\))?|提示词)\s*[:：]\s*(.*)$/i
const negativePromptHeading = /^\s*(Negative\s+prompt|反向提示词|负面提示词)\s*[:：]\s*(.*)$/i
const promptNote = /^\s*(?:changes?\b|two\s+reminders?\b|note\b|reminders?\b|说明|修改|改动|变化|备注|提醒)/i

function cleanPromptText(lines: string[]) {
  return lines
    .map((line) => line.replace(/^\s*>\s?/, '').trimEnd())
    .join('\n')
    .trim()
}

function cleanNarrative(lines: string[]) {
  return lines.join('\n').trim()
}

/**
 * Detects the prompt format commonly returned by the agent and separates it
 * from explanatory text so the UI can present a copyable prompt card.
 */
export function parseAgentPromptSections(source: string): AgentPromptSections | null {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const promptMatch = lines.map((line, index) => ({ line, index, match: promptHeading.exec(line) })).find((item) => item.match)
  if (!promptMatch?.match) return null

  const negativeMatch = lines
    .map((line, index) => ({ line, index, match: negativePromptHeading.exec(line) }))
    .find((item) => item.match && item.index > promptMatch.index)
  const noteStart = lines.findIndex((line, index) => index > (negativeMatch?.index ?? promptMatch.index) && promptNote.test(line))
  const promptEnd = negativeMatch?.index ?? (noteStart >= 0 ? noteStart : lines.length)
  const promptLines = [promptMatch.match[2], ...lines.slice(promptMatch.index + 1, promptEnd)]
  const prompt = cleanPromptText(promptLines)
  if (!prompt) return null

  const negativePrompt = negativeMatch
    ? cleanPromptText([negativeMatch.match![2], ...lines.slice(negativeMatch.index + 1, noteStart >= 0 ? noteStart : lines.length)])
    : undefined
  const after = noteStart >= 0 ? cleanNarrative(lines.slice(noteStart)) : ''

  return {
    before: cleanNarrative(lines.slice(0, promptMatch.index)),
    prompt,
    promptLabel: promptMatch.match[1].trim(),
    ...(negativePrompt ? { negativePrompt, negativePromptLabel: negativeMatch?.match?.[1].trim() } : {}),
    after,
  }
}

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
