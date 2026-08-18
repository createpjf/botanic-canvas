import {
  botanicAgentContextSnapshotNodeIds,
  creativeDimensionLabel,
  type BotanicAgentActionProposal,
  type BotanicAgentArtifact,
  type BotanicAgentMessage,
  type BotanicAgentRun,
} from '../../domain/agent'
import type { GenerationModelOption } from '../../domain/canvas'
import { CopyIcon, EditIcon, FocusIcon, SparkleIcon, ThumbDownIcon, ThumbUpIcon } from '../../components/BotanicIcons'
import { agentPlannerModelLabel, modelDisplayLabel } from '../../components/generationModelPresentation'
import { AgentClarificationCard, AgentPromptDiff, agentToolStatusLabel } from './AgentWorkspaceParts'
import { AgentPromptResponse } from './AgentPromptResponse'

type AgentConversationMessageProps = {
  message: BotanicAgentMessage
  sessionId?: string
  runs: BotanicAgentRun[]
  artifacts: BotanicAgentArtifact[]
  contextOptionIds: string[]
  generationModels: GenerationModelOption[]
  planning: boolean
  promptUsePending: boolean
  plannerModel: string
  executingActionId: string
  submittingMessageId: string
  promptDraft?: string
  onContinueResultContext: (nodeIds: string[], outputCount: number) => void
  onShowResults: () => void
  onShowTask: (runId: string) => void
  onFocusNodes: (nodeIds: string[]) => void
  onAnswerClarification: (message: BotanicAgentMessage, answers: Record<string, string>) => void
  onLocateNode: (nodeId: string) => void
  onConfirmAction: (message: BotanicAgentMessage, action: BotanicAgentActionProposal) => void
  onDismissAction: (message: BotanicAgentMessage, action: BotanicAgentActionProposal) => void
  onPromptDraftChange: (messageId: string, prompt: string) => void
  onCommitPlanPrompt: (message: BotanicAgentMessage, prompt: string) => void
  onConfirmPlan: (message: BotanicAgentMessage) => void
  onUsePrompt: (message: BotanicAgentMessage) => void
  onEdit: (content: string) => void
  onRetryDelivery: (messageId: string) => void
  onFeedback: (message: BotanicAgentMessage, feedback: BotanicAgentMessage['feedback']) => void
}

export function AgentConversationMessage({
  message,
  sessionId,
  runs,
  artifacts,
  contextOptionIds,
  generationModels,
  planning,
  promptUsePending,
  plannerModel,
  executingActionId,
  submittingMessageId,
  promptDraft,
  onContinueResultContext,
  onShowResults,
  onShowTask,
  onFocusNodes,
  onAnswerClarification,
  onLocateNode,
  onConfirmAction,
  onDismissAction,
  onPromptDraftChange,
  onCommitPlanPrompt,
  onConfirmPlan,
  onUsePrompt,
  onEdit,
  onRetryDelivery,
  onFeedback,
}: AgentConversationMessageProps) {
  const linkedRun = message.runId ? runs.find((run) => run.id === message.runId) : undefined
  const outputNodeIds = message.runId
    ? artifacts.filter((artifact) => artifact.provenance.runId === message.runId).flatMap((artifact) => artifact.provenance.sourceNodeIds ?? [])
    : []
  const lockedContextIds = botanicAgentContextSnapshotNodeIds(linkedRun?.plan.contextSnapshot, contextOptionIds)
  const continueNodeIds = [...new Set(outputNodeIds.length ? outputNodeIds : lockedContextIds)]
  const planPrompt = message.plan ? promptDraft ?? message.plan.prompt : ''

  const isLiveRunMessage = message.role === 'assistant' && Boolean(message.runId) && (message.kind === 'run' || message.kind === 'notice')

  return <article className={`agent-message is-${message.role} is-${message.kind}`} role={isLiveRunMessage ? 'status' : undefined} aria-live={isLiveRunMessage ? 'polite' : undefined}>
    <div className="agent-message__role">{message.role === 'assistant' ? <SparkleIcon /> : <span>你</span>}</div>
    <div className="agent-message__body">
      {!message.question ? (message.role === 'assistant' ? <AgentPromptResponse content={message.content} /> : <p>{message.content}</p>) : null}
      {message.role === 'user' && message.deliveryStatus === 'waiting_network' ? <small className="agent-message__delivery-status" role="status">等待联网</small> : null}
      {message.role === 'user' && message.deliveryStatus === 'queued' ? <small className="agent-message__delivery-status" role="status">等待同步</small> : null}
      {message.role === 'user' && message.deliveryStatus === 'syncing' ? <small className="agent-message__delivery-status" role="status">正在同步</small> : null}
      {message.role === 'user' && message.deliveryStatus === 'synced' ? <small className="agent-message__delivery-status is-synced" role="status">已同步</small> : null}
      {message.role === 'user' && message.deliveryStatus === 'failed' ? <small className="agent-message__delivery-status is-failed" role="alert">同步失败 <button type="button" onClick={() => onRetryDelivery(message.id)}>重试</button></small> : null}
      {message.role === 'assistant' && message.prompt && !message.plan && !message.question ? <div className="agent-run-message__actions" aria-label="Prompt 操作">
        <button type="button" disabled={planning || promptUsePending} onClick={() => onUsePrompt(message)}>{promptUsePending ? '等待确认' : '用这段 Prompt 生成'}</button>
      </div> : null}
      {message.runId ? <div className="agent-run-message__actions" aria-label="任务与结果操作">
        <button type="button" onClick={() => onShowTask(message.runId!)}>查看任务</button>
        {message.kind === 'run' && continueNodeIds.length ? <button type="button" onClick={() => onContinueResultContext(continueNodeIds, outputNodeIds.length)}>继续修改</button> : null}
        {outputNodeIds.length ? <button type="button" onClick={onShowResults}>查看结果</button> : null}
        {outputNodeIds.length ? <button type="button" onClick={() => onFocusNodes(outputNodeIds)}>定位画布</button> : null}
      </div> : null}
      {message.question ? message.status === 'answered' ? <AgentClarificationCard
        clarification={message.question}
        generationModels={generationModels}
        state="completed"
        onSubmit={(answers) => onAnswerClarification(message, answers)}
      /> : <AgentClarificationCard
        clarification={message.question}
        generationModels={generationModels}
        state={planning ? 'submitting' : 'idle'}
        onSubmit={(answers) => onAnswerClarification(message, answers)}
      /> : null}
      {message.plan ? <div className="agent-message__plan">
        {message.plan.toolCalls?.length ? <div className="agent-message__tools" aria-label="Agent 工具调用">
          {message.plan.toolCalls.map((call) => <div key={call.id} className={`agent-message__tool is-${call.status}`}>
            <span aria-hidden="true">↳</span><strong>{call.label}</strong><small>{agentToolStatusLabel(call.status)}</small>
          </div>)}
        </div> : null}
        {message.plan.actions?.length ? <div className="agent-message__actions" aria-label="待确认行动">
          {message.plan.actions.map((action) => <article key={action.id} className={`agent-action-card is-${action.status}`}>
            <header><span>{action.kind === 'skill' ? 'SKILL' : 'MCP'}</span><small>{action.risk === 'external' ? '外部调用' : action.toolName === 'skill_create' ? '写入项目' : '写入画布'}</small></header>
            <strong>{action.label}</strong>
            <p>{action.summary}</p>
            <div className="agent-action-card__impact"><span>输入</span><b>{action.toolName === 'mcp_call' ? `${String(action.arguments.server)}.${String(action.arguments.tool)}` : action.toolName === 'skill_create' ? '新项目 Skill' : '当前项目 Skill'}</b><span>输出</span><b>{action.toolName === 'mcp_call' ? '文件 / 画布节点' : action.toolName === 'skill_create' ? '可复用 Skill' : '工作流规则节点'}</b></div>
            <details className="agent-action-card__details"><summary>查看执行内容</summary><pre>{JSON.stringify(action.arguments, null, 2)}</pre></details>
            {action.error ? <small className="agent-action-card__error">{action.error}</small> : null}
            {action.status === 'succeeded' ? <div className="agent-action-card__result"><span>已执行</span>{action.result?.canvasNodeIds?.length ? <small>已创建 {action.result.canvasNodeIds.length} 个画布节点</small> : action.result?.artifacts?.length ? <small>已产出 {action.result.artifacts.length} 项</small> : null}{action.result?.canvasNodeId ? <button type="button" className="agent-icon-button" aria-label="在画布定位结果" title="在画布定位" onClick={() => onLocateNode(action.result!.canvasNodeId!)}><FocusIcon /></button> : null}</div> : null}
            {action.status === 'dismissed' ? <span className="agent-action-card__dismissed">已跳过</span> : null}
            {action.status === 'running' ? <div className="agent-action-card__running"><span>执行状态待确认</span><button type="button" disabled={executingActionId === action.id} onClick={() => onConfirmAction(message, action)}>{executingActionId === action.id ? '确认中…' : '确认状态'}</button></div> : null}
            {action.status === 'awaiting_confirmation' || action.status === 'failed' ? <div className="agent-action-card__buttons">
              {action.status === 'awaiting_confirmation' ? <button type="button" className="is-secondary" onClick={() => onDismissAction(message, action)}>跳过</button> : null}
              <button type="button" disabled={executingActionId === action.id} onClick={() => onConfirmAction(message, action)}>{executingActionId === action.id ? '执行中…' : action.status === 'failed' ? '重试' : '确认执行'}</button>
            </div> : null}
          </article>)}
        </div> : null}
        <section className="agent-prompt-review" aria-label="润色后的提示词">
          <header><span><strong>生成前确认</strong><small>已按 Botanic 结构整理</small></span><b>可编辑</b></header>
          <div className="agent-prompt-review__original"><small>原始要求</small><p>{message.plan.instruction}</p></div>
          <label><span>润色后提示词</span><textarea value={planPrompt} onChange={(event) => onPromptDraftChange(message.id, event.target.value)} onBlur={(event) => onCommitPlanPrompt(message, event.currentTarget.value)} maxLength={6000} aria-label="润色后提示词" /></label>
          <AgentPromptDiff original={message.plan.instruction} revised={planPrompt} />
          <div className="agent-prompt-review__actions">
            <button type="button" className="is-secondary" onClick={() => { onPromptDraftChange(message.id, message.plan!.instruction); onCommitPlanPrompt(message, message.plan!.instruction) }}>用原文</button>
            <button type="button" className="is-secondary" onClick={() => { onPromptDraftChange(message.id, message.plan!.prompt); onCommitPlanPrompt(message, message.plan!.prompt) }}>恢复润色</button>
          </div>
        </section>
        <div className="agent-message__constraints">
          {message.plan.constraints.map((constraint) => <span key={constraint.dimension} className={constraint.mode === 'preserve' ? 'is-locked' : 'is-variable'}>{constraint.mode === 'preserve' ? '锁定' : '变化'} · {creativeDimensionLabel(constraint.dimension)}</span>)}
        </div>
        <div className="agent-plan-settings" aria-label="本次生成设置">
          <span><small>模型</small><b>{modelDisplayLabel(generationModels.find((model) => model.id === message.plan!.settings.model)) || message.plan.settings.model}</b></span>
          <span><small>比例</small><b>{message.plan.settings.aspectRatio}</b></span>
          <span><small>清晰度</small><b>{message.plan.settings.resolution}</b></span>
          <span><small>输出</small><b>{message.plan.output.mode === 'batch_by_asset' ? `${message.plan.output.count} 个分支` : '1 个版本'}</b></span>
        </div>
        <small>{message.plan.references.length} 个输入 · {message.plan.output.mode === 'batch_by_asset' ? `${message.plan.output.count} 个分支` : '1 个新版本'}</small>
        {message.plan.contextSnapshot?.length ? <small className="agent-plan__context-lock">已锁定上下文 · {message.plan.contextSnapshot.slice(0, 3).map((item) => item.label).join('、')}{message.plan.contextSnapshot.length > 3 ? ` 等 ${message.plan.contextSnapshot.length} 项` : ''}</small> : null}
        <details className="agent-message__route"><summary>执行路由</summary><div><span>规划</span><b>{agentPlannerModelLabel(message.plan.plannerModel ?? plannerModel)}</b><span>生成</span><b>{message.plan.settings.model}</b><span>外部行动</span><b>{message.plan.actions?.length ? `${message.plan.actions.length} 项，确认后执行` : '无'}</b></div></details>
        {message.status !== 'submitted' ? <><small className="agent-plan__confirm-hint">确认后才会提交生成任务，当前设置仍可在上方编辑。</small><button type="button" disabled={submittingMessageId === message.id || message.plan.actions?.some((action) => action.status === 'awaiting_confirmation' || action.status === 'running')} onClick={() => onConfirmPlan(message)}>{submittingMessageId === message.id ? '正在提交…' : message.plan.actions?.some((action) => action.status === 'awaiting_confirmation' || action.status === 'running') ? '先处理行动卡' : message.status === 'failed' ? '重新提交计划' : '确认并生成'}</button></> : <span className="agent-message__submitted">已提交</span>}
      </div> : null}
    </div>
    <div className="agent-message__utilities">
      {message.role === 'user' ? <button type="button" aria-label="编辑消息" title="编辑消息" onClick={() => onEdit(message.content)}><EditIcon /></button> : null}
      {message.role === 'assistant' && sessionId ? <>
        <button type="button" className={message.feedback === 'positive' ? 'is-selected' : ''} aria-label="这个回答有帮助" title="有帮助" onClick={() => onFeedback(message, message.feedback === 'positive' ? undefined : 'positive')}><ThumbUpIcon /></button>
        <button type="button" className={message.feedback === 'negative' ? 'is-selected' : ''} aria-label="这个回答需要改进" title="需改进" onClick={() => onFeedback(message, message.feedback === 'negative' ? undefined : 'negative')}><ThumbDownIcon /></button>
      </> : null}
      <button type="button" aria-label="复制消息" title="复制消息" onClick={() => void navigator.clipboard.writeText(message.content)}><CopyIcon /></button>
    </div>
  </article>
}
