import { useEffect, useState } from 'react'
import type { BotanicAgentMessage, BotanicAgentRun } from '../../domain/agent'
import type { GenerationModelOption } from '../../domain/canvas'
import { botanicAgentClarificationProgress, botanicAgentClarificationTurnIds, type AgentClarificationTurnState } from '../../domain/agentMessageUtilities'
import { listPersistentBotanicAgentSessionMessages, readPersistentBotanicAgentTurnEvents } from '../../lib/agentApi'
import { serverPersistenceEnabled } from '../../lib/productSession'
import { localizeProductError } from '../../i18n/core'
import { useProductI18n } from '../../i18n/react'
import { AgentClarificationCard } from './AgentWorkspaceParts'
import { findAgentClarificationSource } from './agentClarificationSubmission'
import { resolveAgentPersistedExecutionSnapshot } from './agentComposerState'

type Progress = ReturnType<typeof botanicAgentClarificationProgress>
const readCurrentTurn = async (id: string, projectId: string, signal: AbortSignal) => (await readPersistentBotanicAgentTurnEvents(id, projectId, { maximumPages: 1, signal })).turn

/** 首次展示与提交复用同一身份判定；只读失败不解锁旧卡，也不修改历史 Message。 */
export function AgentClarificationMessage({ message, sourceMessage, runs, projectId, sessionId, generationModels, busy, onShowTask, onRestart, onSubmit, onLoadEarlierMessages,
  readTurn = serverPersistenceEnabled ? readCurrentTurn : undefined,
}: {
  message: BotanicAgentMessage; sourceMessage?: BotanicAgentMessage; runs: BotanicAgentRun[]; projectId?: string; sessionId?: string
  generationModels: GenerationModelOption[]; busy: boolean
  onShowTask: (runId: string) => void; onRestart: () => void; onSubmit: (answers: Record<string, string>) => Promise<void>
  onLoadEarlierMessages?: () => void
  readTurn?: (id: string, projectId: string, signal: AbortSignal) => Promise<AgentClarificationTurnState | undefined>
}) {
  const { locale } = useProductI18n()
  const base = botanicAgentClarificationProgress(message, runs)
  const ids = botanicAgentClarificationTurnIds(message)
  const sourceTurnId = message.turnId ?? message.question?.resolvedGeneration?.turnId
  const sourceReady = Boolean(resolveAgentPersistedExecutionSnapshot({ sourceMessage, contextOptions: [] }))
    && (!sourceTurnId || !sourceMessage?.turnId || sourceMessage.turnId === sourceTurnId)
  const canReadSource = Boolean(serverPersistenceEnabled && projectId && sessionId)
  const needsRead = base.state !== 'continued' && Boolean(readTurn && projectId && ids.length || !sourceReady && canReadSource)
  const scope = JSON.stringify([projectId, sessionId, message.id, message.status, message.question, ids, sourceMessage?.id, sourceMessage?.turnRequestSnapshot])
  const [read, setRead] = useState<{ scope: string; progress?: Progress; error?: string; sourceUnavailable?: boolean }>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!needsRead || !projectId) return
    const controller = new AbortController()
    setRead(undefined)
    void (async () => {
      let progress = base
      let sourceUnavailable = false
      for (const id of readTurn ? ids : []) {
        const turn = await readTurn!(id, projectId, controller.signal)
        if (controller.signal.aborted) return
        progress = botanicAgentClarificationProgress(message, runs, turn?.id === id ? turn : null)
        if (progress.state === 'continued' || progress.state === 'unavailable') break
      }
      if ((progress.state === 'pending' || progress.state === 'answered') && !sourceReady) {
        const source = await findAgentClarificationSource(message, sourceMessage ? [sourceMessage] : [], canReadSource
          ? (before) => listPersistentBotanicAgentSessionMessages(projectId, sessionId!, { limit: 200, before, signal: controller.signal }) : undefined, () => !controller.signal.aborted)
        if (!resolveAgentPersistedExecutionSnapshot({ sourceMessage: source, contextOptions: [] })
          || sourceTurnId && source?.turnId && source.turnId !== sourceTurnId) { progress = { state: 'unavailable' }; sourceUnavailable = true }
      }
      if (controller.signal.aborted) return
      setRead({ scope, progress, sourceUnavailable })
    })().catch((caught) => {
      if (!controller.signal.aborted) setRead({ scope, error: localizeProductError(caught, locale, { 'zh-CN': '确认状态读取失败，请重试。', en: 'Could not check this confirmation. Try again.' }) })
    })
    return () => controller.abort()
    // scope 包含原问题/身份；不因无关任务更新或每次组件渲染重新读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, needsRead, retry, readTurn])
  const current = read?.scope === scope ? read : undefined
  const progress = needsRead ? current?.progress : !sourceReady && (base.state === 'pending' || base.state === 'answered') ? { state: 'unavailable' as const } : base
  const sourceUnavailable = progress?.state === 'unavailable' && (current?.sourceUnavailable || !needsRead && !sourceReady && (base.state === 'pending' || base.state === 'answered'))
  return <>
    {needsRead && !progress || sourceUnavailable ? <div className="agent-run-message__result-state" role={current?.error ? 'alert' : 'status'}>
      <span>{current?.error ?? (sourceUnavailable ? locale === 'en' ? 'Original request settings are unavailable.' : '原请求设置未载入或不完整。' : locale === 'en' ? 'Checking confirmation…' : '正在核对确认…')}</span>
      {current?.error ? <button type="button" onClick={() => setRetry((value) => value + 1)}>{locale === 'en' ? 'Retry' : '重试'}</button> : null}
      {sourceUnavailable && onLoadEarlierMessages ? <button type="button" disabled={busy} onClick={onLoadEarlierMessages}>{locale === 'en' ? 'Load earlier messages' : '加载更早消息'}</button> : null}
    </div> : null}
    <div hidden={needsRead && !progress}><AgentClarificationCard key={message.question!.id} clarification={message.question!} generationModels={generationModels}
      state={progress?.state === 'continued' ? 'historical' : progress?.state === 'unavailable' ? 'unavailable' : progress?.state === 'answered' ? 'completed' : 'idle'}
      busy={busy || !progress} onShowTask={progress?.runId ? () => onShowTask(progress.runId!) : undefined}
      onRestart={onRestart} onSubmit={onSubmit} /></div>
  </>
}
