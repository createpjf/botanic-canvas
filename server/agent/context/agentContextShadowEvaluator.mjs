// @ts-check

import { resolveAgentContextCompaction } from './agentContextCompaction.mjs'
import { resolveAgentModelContextPolicy } from '../../agentModelContextPolicy.mjs'

/**
 * 只读影子评估器。它只运行 Context 的纯选择算法，不持久化 checkpoint、不调用
 * Provider（含 LLM summarizer），也不把消息内容带进结果；因此 control 请求的返回值
 * 和副作用保持不变。`AGENT_CONTEXT_LLM_SUMMARY` 不得影响本评估器。
 */
export function evaluateAgentContextShadow(input = {}) {
  const policy = resolveAgentModelContextPolicy(input.model, input.policies)
  const projection = resolveAgentContextCompaction({
    sessionId: input.sessionId,
    messages: input.messages,
    currentMessageId: input.currentMessageId,
    locale: input.locale,
    policy,
    threadSummary: input.threadSummary,
    trigger: 'pre_step',
  })
  const beforeInputTokenCount = Number(
    projection.compaction?.meterBefore?.inputTokens
      ?? projection.meter?.inputTokens
      ?? 0,
  )
  const candidateInputTokenCount = Number(
    projection.compaction?.meterAfter?.inputTokens
      ?? projection.meter?.inputTokens
      ?? beforeInputTokenCount,
  )
  return Object.freeze({
    kind: projection.kind,
    wouldCompact: projection.kind === 'candidate',
    messageCount: Array.isArray(input.messages) ? input.messages.length : 0,
    retainedMessageCount: projection.kind === 'candidate'
      ? projection.retainedEntries.length
      : projection.entries?.length ?? 0,
    replacedMessageCount: projection.compaction?.replacedMessageRevisions?.length ?? 0,
    controlInputTokenCount: Math.max(0, Number(input.controlInputTokenCount) || 0),
    candidateInputTokenCount: Math.max(0, candidateInputTokenCount),
    beforeInputTokenCount: Math.max(0, beforeInputTokenCount),
    afterInputTokenCount: Math.max(0, candidateInputTokenCount),
    operationCount: projection.kind === 'candidate' ? 1 : 0,
    policyHash: policy.hash,
  })
}
