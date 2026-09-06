import { useEffect, useRef, useState } from 'react'
import { agentReferenceUsageLabel, type AgentReferenceUsage, type AgentReferenceUsageItem } from '../../domain/agentReferenceUsage'
import type { BotanicAgentMentionCatalog } from '../../domain/agentMentions'
import { useProductI18n } from '../../i18n/react'

type Preparation = { scope: string; pendingId?: string; errorId?: string; items: Record<string, AgentReferenceUsageItem> }

export function AgentReferenceUsageDetails({ usage, catalog, nodeIds, onLocateNode, projectId, sessionId, plannerModel, onPrepareReference, disabled = false }: {
  usage?: AgentReferenceUsage
  catalog?: BotanicAgentMentionCatalog
  nodeIds: string[]
  onLocateNode: (id: string) => void
  projectId?: string
  sessionId?: string
  plannerModel?: string
  onPrepareReference?: (nodeId: string, signal: AbortSignal) => Promise<AgentReferenceUsageItem>
  disabled?: boolean
}) {
  const { locale } = useProductI18n()
  const scope = JSON.stringify([projectId, sessionId, usage?.attemptId, plannerModel])
  const activeScope = useRef(scope); activeScope.current = scope
  const controller = useRef<AbortController | null>(null)
  const [preparation, setPreparation] = useState<Preparation>()
  const current = preparation?.scope === scope ? preparation : undefined
  useEffect(() => () => { controller.current?.abort(); controller.current = null }, [scope])
  const retry = async (nodeId: string) => {
    if (!onPrepareReference || disabled || controller.current) return
    const pending = new AbortController()
    controller.current = pending
    setPreparation({ scope, items: current?.items ?? {}, pendingId: nodeId })
    try {
      const item = await onPrepareReference(nodeId, pending.signal)
      if (pending.signal.aborted || activeScope.current !== scope) return
      setPreparation((previous) => ({ scope, items: { ...previous?.items, [nodeId]: item } }))
    } catch {
      if (!pending.signal.aborted && activeScope.current === scope) {
        setPreparation((previous) => ({ scope, items: previous?.items ?? {}, errorId: nodeId }))
      }
    } finally { if (controller.current === pending) controller.current = null }
  }
  if (!usage?.items.length) return null
  const omitted = usage.items.filter((item) => item.stage === 'failed' || item.stage === 'omitted').length
  return <details className="agent-reference-usage">
    <summary><span role="status">{locale === 'en' ? 'References' : '引用'} {usage.items.length}
      {omitted ? locale === 'en' ? ` · ${omitted} not included` : ` · ${omitted} 项未采用` : ''}
    </span></summary>
    <ul>{usage.items.map((item, index) => {
      const label = catalog?.references?.find((reference) => reference.id === item.nodeId)?.label
        ?? (locale === 'en' ? `Reference ${index + 1}` : `引用 ${index + 1}`)
      const available = nodeIds.includes(item.nodeId)
      const prepared = current?.items[item.nodeId]
      const retryable = onPrepareReference && item.stage === 'failed'
      return <li key={item.nodeId}>
        <button type="button" disabled={!available} onClick={() => onLocateNode(item.nodeId)}
          title={available ? label : locale === 'en' ? 'Not on this canvas' : '已不在当前画布'}
          aria-label={locale === 'en' ? `Locate on canvas: ${label}` : `定位画布：${label}`}>{label}</button>
        <span role={prepared?.stage === 'failed' ? 'alert' : undefined}>{agentReferenceUsageLabel(prepared && prepared.stage !== 'prepared' ? prepared : item, locale)}</span>
        {prepared?.stage === 'prepared' ? <span role="status">{locale === 'en' ? 'Prepared again · not sent' : '已重新准备 · 未发送'}</span> : null}
        {current?.errorId === item.nodeId ? <span role="alert">{locale === 'en' ? 'Retry failed' : '重试失败'}</span> : null}
        {retryable && prepared?.stage !== 'prepared' ? <button type="button" disabled={disabled || Boolean(current?.pendingId)}
          onClick={() => void retry(item.nodeId)} title={locale === 'en' ? `Prepare again: ${label}` : `重新准备：${label}`}
          aria-label={locale === 'en' ? `Prepare again: ${label}` : `重新准备：${label}`}>
          {current?.pendingId === item.nodeId ? locale === 'en' ? 'Preparing…' : '正在准备…' : locale === 'en' ? 'Retry' : '重试'}
        </button> : null}
      </li>
    })}</ul>
  </details>
}
