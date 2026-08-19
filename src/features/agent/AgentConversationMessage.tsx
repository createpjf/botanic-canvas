import { useEffect, useState } from 'react'
import {
  botanicAgentAppliedSkillName,
  botanicAgentContextSnapshotNodeIds,
  botanicAgentPendingConfirmationCount,
  botanicAgentMessageOffersVisualPrompt,
  creativeDimensionLabel,
  type BotanicAgentActionProposal,
  type BotanicAgentArtifact,
  type BotanicAgentExecutionMode,
  type BotanicAgentMessage,
  type BotanicAgentRun,
} from '../../domain/agent'
import type { AgentTimelineState, TimelineStepKind } from '../../domain/agentTimeline'
import type { GenerationModelOption } from '../../domain/canvas'
import { AlertIcon, BookIcon, ChecklistIcon, ClockIcon, CopyIcon, EditIcon, FocusIcon, GlobeIcon, SearchIcon, SparkleIcon, ThumbDownIcon, ThumbUpIcon } from '../../components/BotanicIcons'
import { agentPlannerModelLabel, modelDisplayLabel } from '../../components/generationModelPresentation'
import { AgentClarificationCard, AgentPromptDiff, agentToolStatusLabel } from './AgentWorkspaceParts'
import { AgentPromptResponse } from './AgentPromptResponse'
import { botanicAgentPlanBranchPrompts, botanicAgentPlanOutputLabel } from '../../domain/agentVariations'

/** 超过这个体量的助手回复默认折叠；阈值只影响展示，不改变消息内容。 */
const collapsibleContentLength = 600
const collapsibleContentLines = 14
/** 单条任务消息内联展示的结果上限；更多结果去结果面板看，避免对话被结果流冲垮。 */
const inlineRunResultLimit = 4

function timelineElapsedLabel(startedAt: number, endedAt: number) {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes ? `思考了 ${minutes}m ${remainder}s` : `思考了 ${seconds}s`
}

function TimelineStepIcon({ kind }: { kind: TimelineStepKind }) {
  if (kind === 'search') return <SearchIcon />
  if (kind === 'read_skill' || kind === 'read') return <BookIcon />
  if (kind === 'connect_runtime') return <GlobeIcon />
  if (kind === 'write') return <EditIcon />
  return <ChecklistIcon />
}

function AgentMessageTimeline({ timeline }: { timeline: AgentTimelineState }) {
  const running = timeline.blocks.some((block) => block.type === 'thinking' && block.status === 'running')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running])

  return <div className="agent-timeline" aria-label="Agent 实时进度">
    {timeline.blocks.map((block) => {
      if (block.type === 'thinking') {
        const label = timelineElapsedLabel(block.startedAt, block.endedAt ?? now)
        const summary = <><ClockIcon /><span>{label}</span></>
        return block.text ? <details key={block.id} className={`agent-timeline__thinking is-${block.status}`}>
          <summary>{summary}</summary>
          <p>{block.text}</p>
        </details> : <div key={block.id} className={`agent-timeline__thinking is-${block.status}`} aria-label={label}>{summary}</div>
      }
      if (block.type === 'narration') return <p key={block.id} className="agent-timeline__narration">{block.text}</p>
      if (block.type === 'step') {
        const statusLabel = block.status === 'running' ? '进行中' : block.status === 'succeeded' ? '已完成' : '失败'
        return <div key={block.id} className={`agent-timeline__step is-${block.status}`} aria-label={`${block.title}，${statusLabel}`}>
          <span className="agent-timeline__step-icon" aria-hidden="true">{block.status === 'failed' ? <AlertIcon /> : <TimelineStepIcon kind={block.kind} />}</span>
          <strong>{block.title}</strong>
          <small>{statusLabel}</small>
        </div>
      }
      return <details key={block.id} className="agent-timeline__raw" open={block.open || undefined}>
        <summary><span>{block.summary}</span><small>{block.items.length} 项</small></summary>
        <div className="agent-timeline__raw-list">
          {block.items.map((item) => <div key={item.id} className={`is-${item.status}`}>
            <span><strong>{item.label}</strong><code>{item.name}</code></span>
            <small>{agentToolStatusLabel(item.status)}</small>
            {item.summary ? <p>{item.summary}</p> : null}
            {item.error ? <p className="is-error">{item.error}</p> : null}
          </div>)}
        </div>
      </details>
    })}
  </div>
}

function AgentCollapsibleContent({ content, prompt }: { content: string; prompt?: string }) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = content.length > collapsibleContentLength
    || content.split('\n').length > collapsibleContentLines
  if (!collapsible) return <AgentPromptResponse content={content} prompt={prompt} />
  return <div className={`agent-message__collapsible${expanded ? ' is-expanded' : ''}`}>
    <div className="agent-message__collapsible-body"><AgentPromptResponse content={content} prompt={prompt} /></div>
    <button type="button" className="agent-message__collapsible-toggle" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
      {expanded ? '收起' : '展开全文'}
    </button>
  </div>
}

type AgentConversationMessageProps = {
  message: BotanicAgentMessage
  timeline?: AgentTimelineState
  streaming?: boolean
  sessionId?: string
  runs: BotanicAgentRun[]
  artifacts: BotanicAgentArtifact[]
  contextOptionIds: string[]
  generationModels: GenerationModelOption[]
  executionMode: BotanicAgentExecutionMode
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
  timeline,
  streaming = false,
  sessionId,
  runs,
  artifacts,
  contextOptionIds,
  generationModels,
  executionMode,
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
  const runArtifacts = message.runId
    ? artifacts.filter((artifact) => artifact.provenance.runId === message.runId)
    : []
  const outputNodeIds = runArtifacts.flatMap((artifact) => artifact.provenance.sourceNodeIds ?? [])
  const lockedContextIds = botanicAgentContextSnapshotNodeIds(linkedRun?.plan.contextSnapshot, contextOptionIds)
  const continueNodeIds = [...new Set(outputNodeIds.length ? outputNodeIds : lockedContextIds)]
  const planPrompt = message.plan ? promptDraft ?? message.plan.prompt : ''

  const isLiveRunMessage = message.role === 'assistant' && Boolean(message.runId) && (message.kind === 'run' || message.kind === 'notice')
  const planSubmitted = message.status === 'submitted'
  const runMediaArtifacts = runArtifacts.filter((artifact) => artifact.url && (artifact.kind === 'image' || artifact.kind === 'video'))
  const inlineRunResults = runMediaArtifacts.slice(0, inlineRunResultLimit)

  const liveStatus = isLiveRunMessage || streaming

  return <article className={`agent-message is-${message.role} is-${message.kind}${timeline ? ' has-timeline' : ''}`} role={liveStatus ? 'status' : undefined} aria-live={liveStatus ? 'polite' : undefined} aria-busy={streaming || undefined}>
    <div className="agent-message__role">{message.role === 'assistant' ? <SparkleIcon /> : <span>你</span>}</div>
    <div className="agent-message__body">
      {timeline ? <AgentMessageTimeline timeline={timeline} /> : null}
      {!message.question && message.content ? (message.role === 'assistant'
        ? streaming
          ? <AgentPromptResponse content={message.content} prompt={message.prompt} />
          : <AgentCollapsibleContent content={message.content} prompt={message.prompt} />
        : <p>{message.content}</p>) : null}
      {message.kind === 'run' && inlineRunResults.length ? <div className="agent-run-message__results" aria-label="本次任务结果">
        {inlineRunResults.map((artifact) => artifact.kind === 'image'
          ? <img key={artifact.id} src={artifact.url} alt={artifact.label} />
          : <video key={artifact.id} src={artifact.url} muted playsInline aria-label={artifact.label} />)}
        {runMediaArtifacts.length > inlineRunResults.length ? <button type="button" className="agent-run-message__more" onClick={onShowResults}>
          查看全部 {runMediaArtifacts.length} 项
        </button> : null}
      </div> : null}
      {message.role === 'assistant' && botanicAgentMessageOffersVisualPrompt(message) ? <div className="agent-run-message__actions" aria-label="Prompt 操作">
        <button type="button" disabled={planning || promptUsePending} onClick={() => onUsePrompt(message)}>{promptUsePending ? '等待确认' : '用这段 Prompt 生成'}</button>
      </div> : null}
      {message.runId ? <div className="agent-run-message__actions" aria-label="任务与结果操作">
        <button type="button" onClick={() => onShowTask(message.runId!)}>查看任务</button>
        {message.kind === 'run' && continueNodeIds.length ? <button type="button" onClick={() => onContinueResultContext(continueNodeIds, outputNodeIds.length)}>继续修改</button> : null}
        {runArtifacts.length ? <button type="button" onClick={onShowResults}>查看结果</button> : null}
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
      {message.plan ? (() => {
        const plan = message.plan
        const pendingActionCount = botanicAgentPendingConfirmationCount(plan.actions)
        const blockedByActions = pendingActionCount > 0
        const autoPaused = executionMode === 'auto' && pendingActionCount > 0
        const appliedSkills = plan.actions?.filter((action) => action.toolName === 'skill_apply') ?? []
        const confirmableActions = plan.actions?.filter((action) => action.toolName !== 'skill_apply') ?? []
        const lockedConstraints = plan.constraints.filter((constraint) => constraint.mode === 'preserve')
        const variedConstraints = plan.constraints.filter((constraint) => constraint.mode === 'vary')
        const branchPrompts = botanicAgentPlanBranchPrompts({
          ...plan,
          prompt: planSubmitted ? plan.prompt : planPrompt,
        })
        const contextLabel = plan.contextSnapshot?.[0]?.label
        const detail = <>
          {plan.toolCalls?.length ? <details
            className="agent-message__tools"
            aria-label="Agent 工具调用"
            open={plan.toolCalls.some((call) => call.status !== 'succeeded') || undefined}
          >
            <summary><span>执行步骤</span><small>{plan.toolCalls.filter((call) => call.status === 'succeeded').length}/{plan.toolCalls.length} 已完成</small></summary>
            <div>{plan.toolCalls.map((call) => <div key={call.id} className={`agent-message__tool is-${call.status}`}>
              <span aria-hidden="true">↳</span>
              {/* summary 是模型自述的一句话调用目的，比工具名更能说明这一步在做什么。 */}
              <strong title={call.summary ?? call.label}>{call.label}{call.summary ? <em> · {call.summary}</em> : null}</strong>
              <small>{agentToolStatusLabel(call.status)}</small>
            </div>)}</div>
          </details> : null}
          {appliedSkills.length ? <div className="agent-plan__skills" aria-label="已应用 Skill">
            {appliedSkills.map((action) => <span key={action.id}>Skill · {botanicAgentAppliedSkillName(action)}</span>)}
          </div> : null}
          {confirmableActions.length ? <div className="agent-message__actions" aria-label="待确认行动">
            {confirmableActions.map((action) => {
              // 已执行或已跳过的行动卡收成一行，只有仍需处理的卡片保持展开。
              const settled = action.status === 'succeeded' || action.status === 'dismissed'
              const body = <>
                <div className="agent-action-card__impact"><span>输入</span><b>{action.toolName === 'mcp_call' ? `${String(action.arguments.server)}.${String(action.arguments.tool)}` : '新项目 Skill'}</b><span>输出</span><b>{action.toolName === 'mcp_call' ? '文件 / 结果面板' : '可复用 Skill'}</b></div>
                <details className="agent-action-card__details"><summary>查看执行内容</summary><pre>{JSON.stringify(action.arguments, null, 2)}</pre></details>
                {action.error ? <small className="agent-action-card__error">{action.error}</small> : null}
                {action.status === 'succeeded' ? <div className="agent-action-card__result"><span>已执行</span>{action.result?.canvasNodeIds?.length ? <small>已创建 {action.result.canvasNodeIds.length} 个画布节点</small> : action.result?.artifacts?.length ? <small>已产出 {action.result.artifacts.length} 项</small> : null}{action.result?.canvasNodeId ? <button type="button" className="agent-icon-button" aria-label="在画布定位结果" title="在画布定位" onClick={() => onLocateNode(action.result!.canvasNodeId!)}><FocusIcon /></button> : null}</div> : null}
                {action.status === 'running' ? <div className="agent-action-card__running"><span>执行状态待确认</span><button type="button" disabled={executingActionId === action.id} onClick={() => onConfirmAction(message, action)}>{executingActionId === action.id ? '确认中…' : '确认状态'}</button></div> : null}
                {action.status === 'awaiting_confirmation' || action.status === 'failed' ? <div className="agent-action-card__buttons">
                  {action.status === 'awaiting_confirmation' ? <button type="button" className="is-secondary" onClick={() => onDismissAction(message, action)}>跳过</button> : null}
                  <button type="button" disabled={executingActionId === action.id} onClick={() => onConfirmAction(message, action)}>{executingActionId === action.id ? '执行中…' : action.status === 'failed' ? '重试' : '确认执行'}</button>
                </div> : null}
              </>
              if (settled) return <details key={action.id} className={`agent-action-card is-settled is-${action.status}`}>
                <summary><span>{action.kind === 'skill' ? 'SKILL' : 'MCP'}</span><strong>{action.label}</strong><small>{action.status === 'succeeded' ? '已执行' : '已跳过'}</small></summary>
                <p>{action.summary}</p>
                {body}
              </details>
              return <article key={action.id} className={`agent-action-card is-${action.status}`}>
                <header><span>{action.kind === 'skill' ? 'SKILL' : 'MCP'}</span><small>{action.risk === 'external' ? '外部调用' : '写入项目'}</small></header>
                <strong>{action.label}</strong>
                <p>{action.summary}</p>
                {body}
              </article>
            })}
          </div> : null}
          <div className="agent-message__constraints">
            {lockedConstraints.length ? <div className="agent-message__constraint-group is-locked"><span>锁定</span>{lockedConstraints.map((constraint) => <b key={constraint.dimension}>{creativeDimensionLabel(constraint.dimension)}</b>)}</div> : null}
            {variedConstraints.length ? <div className="agent-message__constraint-group is-variable"><span>变化</span>{variedConstraints.map((constraint) => <b key={constraint.dimension}>{creativeDimensionLabel(constraint.dimension)}</b>)}</div> : null}
          </div>
          <div className="agent-plan-settings" aria-label="本次生成设置">
            <span><small>模型</small><b>{modelDisplayLabel(generationModels.find((model) => model.id === plan.settings.model)) || plan.settings.model}</b></span>
            <span><small>比例</small><b>{plan.settings.aspectRatio}</b></span>
            <span><small>清晰度</small><b>{plan.settings.resolution}</b></span>
            <span><small>输出</small><b>{botanicAgentPlanOutputLabel(plan)}</b></span>
          </div>
          {contextLabel ? <small className="agent-plan__context-lock">基于 {contextLabel}{plan.contextSnapshot && plan.contextSnapshot.length > 1 ? ` 等 ${plan.contextSnapshot.length} 项` : ''}</small> : null}
          <section className="agent-prompt-review" aria-label="润色后的提示词">
            <header><span><strong>{planSubmitted ? '本次提示词' : '提示词'}</strong></span><b>{planSubmitted ? '只读' : '可改'}</b></header>
            {plan.instruction.trim() && plan.instruction.trim() !== (planSubmitted ? plan.prompt : planPrompt).trim() ? <details className="agent-prompt-review__original"><summary>对照原文</summary><p>{plan.instruction}</p></details> : null}
            {planSubmitted
              // 任务已按这份提示词提交，再编辑只会让记录与事实不符，因此提交后转为只读。
              ? <div className="agent-prompt-review__submitted"><pre>{plan.prompt}</pre></div>
              : <textarea value={planPrompt} onChange={(event) => onPromptDraftChange(message.id, event.target.value)} onBlur={(event) => onCommitPlanPrompt(message, event.currentTarget.value)} maxLength={6000} aria-label="润色后提示词" />}
            <AgentPromptDiff original={plan.instruction} revised={planSubmitted ? plan.prompt : planPrompt} />
            {planSubmitted ? null : <div className="agent-prompt-review__actions">
              <button type="button" className="is-secondary" onClick={() => { onPromptDraftChange(message.id, plan.instruction); onCommitPlanPrompt(message, plan.instruction) }}>用原文</button>
              <button type="button" className="is-secondary" onClick={() => { onPromptDraftChange(message.id, plan.prompt); onCommitPlanPrompt(message, plan.prompt) }}>恢复润色</button>
            </div>}
          </section>
          {/* 批量变体一个取值就是一个分支节点：这里逐条列出，用户确认前就能核对数量与各自的提示词。 */}
          {branchPrompts.length ? <section className="agent-plan-branches" aria-label="每个变体的独立提示词">
            <header><strong>{branchPrompts.length} 个分支节点</strong><small>原参考图保留，各分支单独出图</small></header>
            <ol>{branchPrompts.map((branch, index) => <li key={`${branch.label}-${index}`}>
              <b>{branch.label}</b>
              <pre>{branch.prompt}</pre>
            </li>)}</ol>
          </section> : null}
          {pendingActionCount ? <details className="agent-message__route"><summary>执行路由</summary><div><span>规划</span><b>{agentPlannerModelLabel(plan.plannerModel ?? plannerModel)}</b><span>生成</span><b>{plan.settings.model}</b><span>外部行动</span><b>{pendingActionCount} 项，确认后执行</b></div></details> : null}
          {planSubmitted ? null : <>
            {/* 自动模式下停在这里一定有原因，必须说清楚，否则用户只会觉得“自动模式没生效”。 */}
            {autoPaused ? <small className="agent-plan__auto-paused">自动模式已暂停：本次包含 {pendingActionCount} 个需要你确认的外部行动，处理完才会开始生成。</small> : null}
            <small className="agent-plan__confirm-hint">确认后开始生成</small>
            <button type="button" disabled={submittingMessageId === message.id || blockedByActions} onClick={() => onConfirmPlan(message)}>{submittingMessageId === message.id ? '正在提交…' : blockedByActions ? '先处理行动卡' : message.status === 'failed' ? '重新生成' : '生成'}</button>
          </>}
        </>
        // 已提交的计划折叠成一行摘要：任务状态由下方的任务消息承载，细节按需展开。
        if (planSubmitted) return <details className="agent-message__plan is-submitted">
          <summary>
            <span><strong>{plan.summary}</strong><small>{modelDisplayLabel(generationModels.find((model) => model.id === plan.settings.model)) || plan.settings.model} · {plan.settings.aspectRatio} · {botanicAgentPlanOutputLabel(plan)}</small></span>
            <em className="agent-message__submitted">{executionMode === 'auto' ? '已自动提交' : '已提交'}</em>
          </summary>
          {detail}
        </details>
        return <div className="agent-message__plan">{detail}</div>
      })() : null}
    </div>
    {message.role === 'user' && message.deliveryStatus === 'waiting_network' ? <small className="agent-message__delivery-status" role="status">等待联网</small> : null}
    {message.role === 'user' && message.deliveryStatus === 'queued' ? <small className="agent-message__delivery-status" role="status">等待同步</small> : null}
    {message.role === 'user' && message.deliveryStatus === 'syncing' ? <small className="agent-message__delivery-status" role="status">正在同步</small> : null}
    {message.role === 'user' && message.deliveryStatus === 'synced' ? <small className="agent-message__delivery-status is-synced" role="status">已同步</small> : null}
    {message.role === 'user' && message.deliveryStatus === 'failed' ? <small className="agent-message__delivery-status is-failed" role="alert">同步失败 <button type="button" onClick={() => onRetryDelivery(message.id)}>重试</button></small> : null}
    {timeline ? null : <div className="agent-message__utilities">
      {message.role === 'user' ? <button type="button" aria-label="编辑消息" title="编辑消息" onClick={() => onEdit(message.content)}><EditIcon /></button> : null}
      {message.role === 'assistant' && sessionId ? <>
        <button type="button" className={message.feedback === 'positive' ? 'is-selected' : ''} aria-label="这个回答有帮助" title="有帮助" onClick={() => onFeedback(message, message.feedback === 'positive' ? undefined : 'positive')}><ThumbUpIcon /></button>
        <button type="button" className={message.feedback === 'negative' ? 'is-selected' : ''} aria-label="这个回答需要改进" title="需改进" onClick={() => onFeedback(message, message.feedback === 'negative' ? undefined : 'negative')}><ThumbDownIcon /></button>
      </> : null}
      <button type="button" aria-label="复制消息" title="复制消息" onClick={() => void navigator.clipboard.writeText(message.content)}><CopyIcon /></button>
    </div>}
  </article>
}
