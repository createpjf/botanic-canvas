import { presentationWebSources } from '../tools/agentWebResearch.mjs'
import { safeAgentToolDisplayValue } from '../tools/agentToolDisplay.mjs'

function safeDisplayText(value, maximumLength = 120) {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (!clean) return undefined
  return clean.length > maximumLength ? `${clean.slice(0, maximumLength - 1)}…` : clean
}

function safePresentation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const kind = safeDisplayText(value.kind, 40)
  const title = safeDisplayText(value.title, 120)
  const count = Number.isInteger(value.count) && value.count >= 0 && value.count <= 10_000
    ? value.count
    : undefined
  if (!kind || !title) return undefined
  const sources = presentationWebSources({ hits: value.sources }, 5)
  return {
    kind,
    title,
    ...(count !== undefined ? { count } : {}),
    ...(sources.length ? { sources } : {}),
  }
}

/** Durable Turn 只保存可重新挂载的 Tool Activity 投影。 */
export function agentTurnToolEventPayload(event) {
  if (event?.type !== 'tool') return undefined
  const toolCall = event.toolCall ?? {}
  const summary = safeDisplayText(toolCall.summary ?? toolCall.why, 120)
  const label = safeDisplayText(toolCall.label, 120)
  const presentation = safePresentation(event.presentation)
  const input = safeAgentToolDisplayValue(toolCall.input)
  const output = safeAgentToolDisplayValue(toolCall.output)
  const recovery = ['reexecute', 'receipt', 'never', 'journal'].includes(toolCall.recovery)
    ? toolCall.recovery
    : undefined
  const receiptId = safeDisplayText(toolCall.receiptId, 160)
  return {
    step: Number.isInteger(event.step) ? event.step : undefined,
    toolName: typeof toolCall.name === 'string' ? toolCall.name.slice(0, 120) : undefined,
    toolCallId: typeof toolCall.id === 'string' ? toolCall.id.slice(0, 160) : undefined,
    status: typeof toolCall.status === 'string' ? toolCall.status : undefined,
    ...(label ? { label } : {}),
    ...(summary ? { summary } : {}),
    ...(presentation ? { presentation } : {}),
    ...(input !== undefined ? { inputPreview: input } : {}),
    ...(output !== undefined ? { outputPreview: output } : {}),
    ...(recovery ? { recovery } : {}),
    ...(receiptId ? { receiptId } : {}),
    ...(toolCall.recovered === true ? { recovered: true } : {}),
    risk: typeof toolCall.risk === 'string' ? toolCall.risk : undefined,
  }
}
