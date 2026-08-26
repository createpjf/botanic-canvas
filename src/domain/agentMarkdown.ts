import { botanicAgentLooksLikePlannerNarration } from './agent.ts'

export type AgentMarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'unordered-list'; items: string[] }
  | { kind: 'ordered-list'; items: string[] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
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
const promptFenceOpen = /^\s*```\s*(prompt|提示词)\s*$/i
const agentChatPromptLength = 600

function cleanPromptText(lines: string[]) {
  return unwrapPromptFence(lines
    .map((line) => line.replace(/^\s*>\s?/, '').trimEnd())
    .join('\n')
    .trim())
}

function cleanNarrative(lines: string[]) {
  return lines.join('\n').trim()
}

function unwrapPromptFence(text: string) {
  const match = text.match(/^```(?:prompt|提示词)?\s*\n([\s\S]*?)\n```$/)
  return match ? match[1].trim() : text
}

function splitTableRow(line: string) {
  const trimmed = line.trim()
  const withoutLead = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const withoutTail = withoutLead.endsWith('|') ? withoutLead.slice(0, -1) : withoutLead
  return withoutTail.split('|').map((cell) => cell.trim())
}

function isTableSeparator(line: string) {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function isTableRow(line: string) {
  return line.includes('|') && !isTableSeparator(line) && !isRule(line)
}

function padTableRow(cells: string[], columns: number) {
  return Array.from({ length: columns }, (_, index) => cells[index] ?? '')
}

function startsTable(lines: string[], index: number) {
  return isTableRow(lines[index]) && Boolean(lines[index + 1] && isTableSeparator(lines[index + 1]))
}

function findPromptFence(lines: string[]) {
  for (let start = 0; start < lines.length; start += 1) {
    if (!promptFenceOpen.test(lines[start])) continue
    const body: string[] = []
    let end = start + 1
    while (end < lines.length && !/^\s*```\s*$/.test(lines[end])) {
      body.push(lines[end])
      end += 1
    }
    if (end >= lines.length) return undefined
    const prompt = body.join('\n').trim()
    if (!prompt) return undefined
    return { start, end, prompt }
  }
  return undefined
}

function dropTrailingPromptHeading(lines: string[]) {
  const next = [...lines]
  while (next.length && !next[next.length - 1].trim()) next.pop()
  if (next.length && promptHeading.test(next[next.length - 1])) next.pop()
  return next
}

/**
 * Detects the prompt format commonly returned by the agent and separates it
 * from explanatory text so the UI can present a copyable prompt card.
 */
export function parseAgentPromptSections(source: string): AgentPromptSections | null {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const fence = findPromptFence(lines)
  if (fence) {
    return {
      before: cleanNarrative(dropTrailingPromptHeading(lines.slice(0, fence.start))),
      prompt: fence.prompt,
      promptLabel: 'Prompt',
      after: cleanNarrative(lines.slice(fence.end + 1)),
    }
  }

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

/** 展示层切片：正文结构优先，缺标题时用消息上已存的 Prompt。 */
export function resolveAgentPromptSections(content: string, storedPrompt = ''): AgentPromptSections | null {
  const parsed = parseAgentPromptSections(content)
  if (parsed) return parsed
  const prompt = storedPrompt.trim()
  if (!prompt) return null
  // 规划旁白被 chat/prompt 模式整段存进 prompt 时，不能再塞进 <pre> 卡片，否则表格会变成生竖线。
  if (botanicAgentLooksLikePlannerNarration(prompt) || botanicAgentLooksLikePlannerNarration(content)) return null
  const text = content.replace(/\r\n?/g, '\n').trim()
  if (text === prompt) {
    return { before: '', prompt, promptLabel: 'Prompt', after: '' }
  }
  const index = text.indexOf(prompt)
  if (index < 0) {
    return { before: text, prompt, promptLabel: 'Prompt', after: '' }
  }
  return {
    before: text.slice(0, index).trim(),
    prompt,
    promptLabel: 'Prompt',
    after: text.slice(index + prompt.length).trim(),
  }
}

/**
 * 对话回答与可执行提示词是两个通道：只有模型显式给出的 Prompt 区块，或整段就是一句画面描述时，
 * 才能成为提示词。带标题、表格、多段解释的说明文永远留在对话里，不进生图参数。
 */
export function resolveAgentChatPrompt(answer: string): string {
  const explicit = parseAgentPromptSections(answer)?.prompt.trim()
  if (explicit) return botanicAgentLooksLikePlannerNarration(explicit) ? '' : explicit
  const text = answer.replace(/\r\n?/g, '\n').trim()
  if (!text || text.length > agentChatPromptLength || botanicAgentLooksLikePlannerNarration(text)) return ''
  const blocks = parseAgentMarkdown(text)
  return blocks.length === 1 && blocks[0].kind === 'paragraph' ? text : ''
}

/** 气泡只渲染 h1–h3；更深标题在解析时压到 3，不在界面露出 #。 */
function clampHeadingLevel(hashCount: number): 1 | 2 | 3 {
  if (hashCount <= 1) return 1
  if (hashCount === 2) return 2
  return 3
}

/**
 * 剥掉行首残留的 #（含无空格的脏输出），保证展示层永不出现 markdown 井号。
 * 代码块内容不走这里。
 */
export function stripAgentMarkdownHashes(text: string) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}(?:\s+|(?=\S))/u, '').replace(/^\s*#+\s*$/u, ''))
    .join('\n')
}

const sourceLinePattern = /^(?:来源|Sources)\s*[:：]\s*(.+)\s*$/iu

const sourceLabelCopy: Record<string, { 'zh-CN': string; en: string }> = {
  互联网: { 'zh-CN': '互联网', en: 'Internet' },
  网页: { 'zh-CN': '网页', en: 'Web' },
  项目本体: { 'zh-CN': '项目本体', en: 'Project ontology' },
  项目记忆: { 'zh-CN': '项目记忆', en: 'Project memory' },
  素材组: { 'zh-CN': '素材组', en: 'Asset groups' },
  '项目 Skill': { 'zh-CN': '项目 Skill', en: 'Project Skill' },
  画布: { 'zh-CN': '画布', en: 'Canvas' },
}

/** 服务端来源标签是中文稳定值；展示层按界面语言翻译，不改落库正文。 */
export function localizeAgentSourceLabel(source: string, locale: 'zh-CN' | 'en' = 'zh-CN') {
  return sourceLabelCopy[source]?.[locale] ?? source
}

/**
 * 从正文末段抽出「来源 / Sources」行，供展示层收成 chips。
 * 不改已落库字符串；刷新后仍能认出同一段文案。
 */
export function splitAgentMessageSources(source: string): { body: string; sources: string[] } {
  const text = source.replace(/\r\n?/g, '\n').trimEnd()
  if (!text) return { body: '', sources: [] }
  const lines = text.split('\n')
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end -= 1
  const last = lines[end - 1]?.trim() ?? ''
  const match = sourceLinePattern.exec(last)
  if (!match) return { body: text, sources: [] }
  const sources = match[1]
    .split(/[,，、]/u)
    .map((item) => item.trim())
    .filter(Boolean)
  if (!sources.length) return { body: text, sources: [] }
  const body = lines.slice(0, end - 1).join('\n').trimEnd()
  return { body, sources }
}

/** 超过这个体量的助手回复默认折叠；阈值只影响展示，不改变消息内容。 */
export const AGENT_MESSAGE_COLLAPSE = {
  maxLength: 1_600,
  maxLines: 28,
} as const

/** 按抽出「来源」后的正文判断是否折叠；来源行本身不触发裁切。 */
export function agentMessageNeedsCollapse(content: string) {
  const { body } = splitAgentMessageSources(content)
  if (body.length > AGENT_MESSAGE_COLLAPSE.maxLength) return true
  return body.split('\n').length > AGENT_MESSAGE_COLLAPSE.maxLines
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

    const fence = /^\s*```\s*([\w-]+|提示词)?\s*$/.exec(line)
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

    // 接受 #{1,6}：模型常写 ####；展示层 clamp 到 h1–h3，文本不含 #。
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: clampHeadingLevel(heading[1].length), text: heading[2] })
      index += 1
      continue
    }
    if (isRule(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    if (startsTable(lines, index)) {
      const headers = splitTableRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(padTableRow(splitTableRow(lines[index]), headers.length))
        index += 1
      }
      blocks.push({ kind: 'table', headers, rows })
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

    const paragraph: string[] = [stripAgentMarkdownHashes(line.trimEnd())]
    index += 1
    while (index < lines.length && lines[index].trim()) {
      const next = lines[index]
      if (
        /^\s*```/.test(next)
        || /^(#{1,6})\s+/.test(next)
        || isRule(next)
        || startsTable(lines, index)
        || isUnorderedItem(next)
        || isOrderedItem(next)
      ) break
      paragraph.push(stripAgentMarkdownHashes(next.trimEnd()))
      index += 1
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
  }

  return blocks
}
