// @ts-check

export const AGENT_TURN_OUTPUT_PREVIEW_MAX_CHARS = 12_288
export const AGENT_TURN_OUTPUT_PREVIEW_FLUSH_MS = 500
export const AGENT_TURN_OUTPUT_PREVIEW_FLUSH_CHARS = 1_024
const MAX_PREVIEW_REVISION = 1_000_000
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u

export function sanitizeAgentTurnOutputPreviewText(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
}

export function normalizeAgentTurnOutputPreview(value, updatedAt) {
  if (!Number.isFinite(Number(updatedAt)) || Number(updatedAt) < 0
    || !value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1
    || typeof value.attemptId !== 'string' || !ATTEMPT_ID.test(value.attemptId)
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision > MAX_PREVIEW_REVISION
    || !Number.isInteger(value.step) || value.step < 0 || value.step > 64
    || typeof value.text !== 'string' || value.text.length > AGENT_TURN_OUTPUT_PREVIEW_MAX_CHARS
    || (value.truncated !== undefined && typeof value.truncated !== 'boolean')) return undefined
  const text = sanitizeAgentTurnOutputPreviewText(value.text)
  if (text !== value.text) return undefined
  return {
    version: 1,
    attemptId: value.attemptId,
    revision: value.revision,
    step: value.step,
    text,
    ...(value.truncated === true ? { truncated: true } : {}),
    updatedAt: Number(updatedAt),
  }
}

export function agentTurnOutputPreviewEventPayload(preview) {
  return {
    revision: preview.revision,
    attemptId: preview.attemptId,
    step: preview.step,
    charCount: preview.text.length,
    ...(preview.truncated === true ? { truncated: true } : {}),
  }
}

export function agentTurnOutputPreviewCommitDecision(current, requested, updatedAt) {
  const next = normalizeAgentTurnOutputPreview(requested, updatedAt)
  if (!next) return { kind: 'conflict' }
  const previous = current === undefined ? undefined : normalizeAgentTurnOutputPreview(current, current?.updatedAt)
  if (current !== undefined && !previous) return { kind: 'conflict' }
  if (!previous) return next.revision === 1 ? { kind: 'committed', preview: next } : { kind: 'conflict' }
  if (next.revision === previous.revision) {
    const same = next.attemptId === previous.attemptId
      && next.step === previous.step
      && next.text === previous.text
      && Boolean(next.truncated) === Boolean(previous.truncated)
    return same ? { kind: 'replay', preview: previous } : { kind: 'conflict' }
  }
  return next.revision === previous.revision + 1
    ? { kind: 'committed', preview: next }
    : { kind: next.revision < previous.revision ? 'stale' : 'conflict' }
}

export function createAgentTurnOutputPreview(input) {
  const now = input.now ?? Date.now
  const schedule = input.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const unschedule = input.unschedule ?? ((timer) => clearTimeout(timer))
  const flushMs = Number.isFinite(input.flushMs) ? Math.max(0, Number(input.flushMs)) : AGENT_TURN_OUTPUT_PREVIEW_FLUSH_MS
  const flushChars = Number.isInteger(input.flushChars) ? Math.max(1, input.flushChars) : AGENT_TURN_OUTPUT_PREVIEW_FLUSH_CHARS
  let revision = Number.isSafeInteger(input.initialPreview?.revision) ? input.initialPreview.revision : 0
  let attemptId = ''
  let step = 0
  let text = ''
  let truncated = false
  let maxCharCount = typeof input.initialPreview?.text === 'string' ? input.initialPreview.text.length : 0
  let persistedLength = 0
  let dirty = false
  let timer

  const clearTimer = () => {
    if (timer === undefined) return
    unschedule(timer)
    timer = undefined
  }
  const flush = () => {
    clearTimer()
    if (!dirty || !attemptId) return Promise.resolve(undefined)
    revision += 1
    dirty = false
    persistedLength = text.length
    const preview = {
      version: 1,
      attemptId,
      revision,
      step,
      text,
      ...(truncated ? { truncated: true } : {}),
      updatedAt: now(),
    }
    try { return Promise.resolve(input.persist(preview)) } catch (caught) { return Promise.reject(caught) }
  }
  const scheduleFlush = () => {
    if (timer !== undefined) return
    timer = schedule(() => { timer = undefined; void flush().catch(() => undefined) }, flushMs)
    timer?.unref?.()
  }
  const observe = (event) => {
    if (event?.type === 'attempt' && event.action === 'start' && typeof event.attemptId === 'string' && ATTEMPT_ID.test(event.attemptId)) {
      attemptId = event.attemptId
      step = 0
      text = ''
      truncated = false
      persistedLength = 0
      dirty = true
      return flush()
    }
    if (event?.type === 'answer') {
      if (!attemptId || (event.attemptId && event.attemptId !== attemptId)) return Promise.resolve(undefined)
      step = Number.isInteger(event.step) ? Math.max(0, Math.min(64, event.step)) : step
      const delta = sanitizeAgentTurnOutputPreviewText(event.delta)
      if (!delta || truncated) return Promise.resolve(undefined)
      const available = AGENT_TURN_OUTPUT_PREVIEW_MAX_CHARS - text.length
      text += delta.slice(0, available)
      maxCharCount = Math.max(maxCharCount, text.length)
      if (delta.length > available) truncated = true
      dirty = true
      if (text.length - persistedLength >= flushChars || truncated) return flush()
      scheduleFlush()
      return Promise.resolve(undefined)
    }
    if (event?.type === 'tool') return flush()
    return Promise.resolve(undefined)
  }
  const discard = () => {
    clearTimer()
    dirty = false
  }
  return Object.freeze({
    observe, flush, discard,
    snapshot: () => ({ revision, writeCount: revision, attemptId, step, text, maxCharCount, truncated, dirty }),
  })
}
