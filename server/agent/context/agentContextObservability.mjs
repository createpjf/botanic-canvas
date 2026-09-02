// @ts-check

import { activeBotanicTraceFields } from '../../executionTelemetry.mjs'
import {
  AGENT_SEMANTIC_EVENT_NAMES,
  writeAgentSemanticEvent,
} from '../../agentSemanticEvent.mjs'

function identifiers(event) {
  return { ...(event?.ids ?? {}), ...(event?.identity ?? {}) }
}

function errorOf(event) {
  const code = event?.error?.code ?? event?.code
  return typeof code === 'string'
    ? { error: { code, ...(typeof event?.error?.retryable === 'boolean' ? { retryable: event.error.retryable } : {}) } }
    : {}
}

/** 把各 Context 深模块的内部 observation 收敛成唯一安全 schema。 */
export function createAgentContextObserver({ logger = console } = {}) {
  return (event) => {
    try {
      const trace = activeBotanicTraceFields()
      const ids = identifiers(event)
      if (event?.name === 'agent.context.rollout') {
        const runtimeMode = event.rollout?.mode
        const cohort = runtimeMode === 'active'
          ? 'treatment'
          : runtimeMode === 'shadow' ? 'shadow' : runtimeMode === 'killed' ? 'killed' : 'control'
        return writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.ROLLOUT_EVALUATED, {
          ...trace,
          feature: 'AGENT_CONTEXT_COMPACTION_V2',
          decision: ['active', 'shadow'].includes(runtimeMode) ? 'enabled' : 'disabled',
          cohort,
          mode: ['off', 'all', 'scoped'].includes(event.rollout?.rolloutMode)
            ? event.rollout.rolloutMode
            : 'off',
        }, logger)
      }

      if (event?.name === 'agent.context.projection') {
        const counts = event.counts ?? {}
        return writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_SHADOW_EVALUATED, {
          ...trace,
          projectId: ids.projectId,
          sessionId: ids.sessionId,
          turnId: ids.turnId,
          trigger: 'pre_step',
          outcome: event.status === 'failed'
            ? 'failed'
            : Number(counts.operationCount) > 0 ? 'would_compact' : 'no_change',
          controlInputTokens: counts.controlInputTokenCount,
          candidateInputTokens: counts.candidateInputTokenCount,
          ...errorOf(event),
        }, logger)
      }

      if (event?.name === 'agent.context.compaction') {
        return writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_COMPACTION_RESULT, {
          ...trace,
          projectId: ids.projectId,
          sessionId: ids.sessionId,
          turnId: ids.turnId,
          compactionId: ids.compactionId,
          trigger: event.trigger ?? 'pre_step',
          outcome: event.outcome,
          inputTokensBefore: event.inputTokensBefore,
          inputTokensAfter: event.inputTokensAfter,
          replacedMessageCount: event.replacedMessageCount,
          durationMs: event.durationMs,
          ...errorOf(event),
        }, logger)
      }

      if (event?.name === 'agent.context.overflow') {
        return writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_OVERFLOW_RESULT, {
          ...trace,
          projectId: ids.projectId,
          sessionId: ids.sessionId,
          turnId: ids.turnId,
          outcome: event.outcome,
          retryCount: event.retryCount,
          durationMs: event.durationMs,
          ...errorOf(event),
        }, logger)
      }

      if (event?.name === 'agent.context.usage_anchor') {
        return writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_USAGE_ANCHOR_RESULT, {
          ...trace,
          projectId: ids.projectId,
          sessionId: ids.sessionId,
          turnId: ids.turnId,
          outcome: event.outcome,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          heuristicInputTokens: event.heuristicInputTokens,
          durationMs: event.durationMs,
          ...errorOf(event),
        }, logger)
      }
    } catch {
      // 观察旁路永不影响 Context 决策。
    }
    return undefined
  }
}
