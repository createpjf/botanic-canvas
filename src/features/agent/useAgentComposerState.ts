import { useCallback, useEffect, useMemo, useReducer, useRef, type RefObject } from 'react'
import {
  agentComposerDraftStorageKey,
  createAgentComposerState,
  dismissAgentComposerMention,
  readAgentComposerDraft,
  reduceAgentComposerStates,
  resolveAgentComposerMention,
  writeAgentComposerDraft,
  type AgentComposerState,
} from './agentComposerState.ts'
import { expandAgentComposerPasteCaret, expandAgentComposerPastes, insertAgentComposerLargePaste, pruneAgentComposerPendingPastes } from './agentComposerPaste.ts'

function browserSessionStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage } catch { return undefined }
}

/**
 * Agent Composer 状态 owner:完整 transient state 按 project/session 隔离;
 * 只有 instruction+caret 进入 sessionStorage(刷新恢复,关闭 tab 自动失效)。
 */
export function useAgentComposerState(
  projectId: string,
  sessionId: string | undefined,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
) {
  const stateKey = `${projectId}:${sessionId ?? '__none__'}`
  const storageKey = sessionId ? agentComposerDraftStorageKey(projectId, sessionId) : ''
  const hydrated = useMemo(() => readAgentComposerDraft(browserSessionStorage(), storageKey), [storageKey])
  const base = useMemo(() => createAgentComposerState(hydrated), [hydrated])
  const [states, dispatch] = useReducer(reduceAgentComposerStates, {})
  const state = states[stateKey] ?? base
  const latestDraftsRef = useRef(new Map<string, { instruction: string; caret: number }>())
  const expandedDraft = expandAgentComposerPastes(state.instruction, state.pendingPastes)
  const expandedCaret = expandAgentComposerPasteCaret(state.instruction, state.caret, state.pendingPastes)
  latestDraftsRef.current.set(storageKey, { instruction: expandedDraft, caret: Math.min(expandedDraft.length, expandedCaret) })

  const update = useCallback((patch: Partial<AgentComposerState>) => {
    dispatch({ key: stateKey, base, patch })
  }, [base, stateKey])
  const setInstruction = useCallback((value: string) => update({ instruction: value, caret: value.length, pendingPastes: {} }), [update])
  const setInstructionAt = useCallback((value: string, caret: number) => update({ instruction: value, caret }), [update])
  const changeInstruction = useCallback((value: string, caret: number) => {
    const mention = resolveAgentComposerMention(value, caret, state.dismissedMention)
    update({
      instruction: value,
      caret,
      mentionQuery: mention.mentionQuery,
      dismissedMention: mention.dismissedMention,
      pendingPastes: pruneAgentComposerPendingPastes(value, state.pendingPastes),
      error: '',
      lastFailedInstruction: '',
      lastFailedCommand: undefined,
      lastFailedPlanMessageId: '',
    })
  }, [state.dismissedMention, state.pendingPastes, update])
  const clickInstruction = useCallback((value: string, caret: number) => {
    const mention = resolveAgentComposerMention(value, caret, state.dismissedMention)
    update({ caret, mentionQuery: mention.mentionQuery, dismissedMention: mention.dismissedMention })
  }, [state.dismissedMention, update])
  const dismissMention = useCallback((value: string) => update({
    mentionQuery: undefined,
    dismissedMention: dismissAgentComposerMention(value, state.mentionQuery),
  }), [state.mentionQuery, update])
  const pasteLargeText = useCallback((pasted: string, start: number, end: number, locale: 'zh-CN' | 'en') => {
    const next = insertAgentComposerLargePaste({
      instruction: state.instruction, start, end, pasted, pendingPastes: state.pendingPastes, locale,
    })
    if (!next) return false
    update({ ...next, mentionQuery: undefined, dismissedMention: undefined })
    return true
  }, [state.instruction, state.pendingPastes, update])

  // Debounced refresh recovery; state/error/mentions/context/recovery snapshots never enter storage.
  useEffect(() => {
    if (!storageKey) return
    const timer = window.setTimeout(() => {
      writeAgentComposerDraft(browserSessionStorage(), storageKey, {
        instruction: expandedDraft,
        caret: Math.min(expandedDraft.length, expandedCaret),
      })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [expandedCaret, expandedDraft, storageKey])

  // Session switch/unmount can happen inside the debounce window; flush that session's latest draft.
  useEffect(() => {
    if (!storageKey) return
    const key = storageKey
    return () => {
      const draft = latestDraftsRef.current.get(key)
      if (draft) writeAgentComposerDraft(browserSessionStorage(), key, draft)
    }
  }, [storageKey])

  // session 切换/刷新恢复后把光标放回该草稿位置;不抢焦点。
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      const caret = Math.max(0, Math.min(textarea.value.length, state.caret))
      textarea.setSelectionRange(caret, caret)
    })
    return () => cancelAnimationFrame(frame)
  }, [state.caret, stateKey, textareaRef])

  return {
    state,
    update,
    setInstruction,
    setInstructionAt,
    changeInstruction,
    clickInstruction,
    dismissMention,
    pasteLargeText,
  }
}
