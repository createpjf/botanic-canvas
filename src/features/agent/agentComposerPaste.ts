export const AGENT_COMPOSER_LARGE_PASTE_THRESHOLD = 1_000
export type AgentComposerPendingPastes = Record<string, string>

function pasteLabel(length: number, locale: 'zh-CN' | 'en') {
  return locale === 'en' ? `[Pasted Content ${length} chars]` : `[已粘贴 ${length} 字]`
}

function escapedRegExp(value: string) {
  return value.replace(/[\^$.*+?()[\]{}|]/gu, '\\$&')
}

export function insertAgentComposerLargePaste(input: {
  instruction: string
  start: number
  end: number
  pasted: string
  pendingPastes: AgentComposerPendingPastes
  locale: 'zh-CN' | 'en'
}) {
  if (input.pasted.length < AGENT_COMPOSER_LARGE_PASTE_THRESHOLD) return undefined
  const base = pasteLabel(input.pasted.length, input.locale)
  const occupied = new Set([
    ...Object.keys(input.pendingPastes),
    ...[...input.instruction.matchAll(new RegExp(escapedRegExp(base) + '(?: #\\d+)?', 'gu'))].map((match) => match[0]),
  ])
  let placeholder = base
  let suffix = 2
  while (occupied.has(placeholder)) {
    placeholder = `${base} #${suffix}`; suffix += 1
  }
  const start = Math.max(0, Math.min(input.instruction.length, input.start))
  const end = Math.max(start, Math.min(input.instruction.length, input.end))
  const instruction = input.instruction.slice(0, start) + placeholder + input.instruction.slice(end)
  return {
    instruction,
    caret: start + placeholder.length,
    pendingPastes: { ...input.pendingPastes, [placeholder]: input.pasted },
  }
}

export function pruneAgentComposerPendingPastes(instruction: string, pendingPastes: AgentComposerPendingPastes) {
  return Object.fromEntries(Object.entries(pendingPastes).filter(([placeholder]) => instruction.includes(placeholder)))
}

export function expandAgentComposerPastes(instruction: string, pendingPastes: AgentComposerPendingPastes) {
  return Object.entries(pendingPastes).sort(([left], [right]) => right.length - left.length).reduce(
    (expanded, [placeholder, content]) => expanded.split(placeholder).join(content),
    instruction,
  )
}


export function expandAgentComposerPasteCaret(
  instruction: string,
  caret: number,
  pendingPastes: AgentComposerPendingPastes,
) {
  let expandedCaret = Math.max(0, Math.min(instruction.length, caret))
  for (const [placeholder, content] of Object.entries(pendingPastes)) {
    let index = instruction.indexOf(placeholder)
    while (index >= 0) {
      if (index >= caret) break
      expandedCaret += content.length - placeholder.length
      index = instruction.indexOf(placeholder, index + placeholder.length)
    }
  }
  return Math.max(0, expandedCaret)
}
