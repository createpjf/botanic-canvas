// @ts-check

import {
  agentModelContextProviderMessages,
  agentModelContextTools,
  compactAgentModelContextSurface,
  createAgentModelContextSurface,
  pruneAgentModelContextSurface,
  sanitizeAgentModelContextCheckpoint,
} from './agentModelContextSurface.mjs'
import { createAgentTokenUsageAnchor, measureAgentModelContextSurface } from '../../agentTokenMeter.mjs'
import { buildThreadSummaryCheckpoint, renderThreadSummary } from '../../agentThreadSummary.mjs'

function checkpointFromMessages(messages, locale) {
  const candidates = messages.flatMap((message, index) => {
    if (!['user', 'assistant'].includes(message?.role)) return []
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.flatMap((part) => typeof part?.text === 'string' ? [part.text] : []).join('\n')
        : ''
    if (!content.trim()) return []
    return [{
      id: `surface-${index + 1}`,
      role: message.role,
      kind: 'text',
      content,
      createdAt: index + 1,
      updatedAt: index + 1,
    }]
  })
  const summary = buildThreadSummaryCheckpoint({ messages: candidates, fullHistory: true, now: 0 })
  return renderThreadSummary(summary, { locale }) || (locale === 'en'
    ? 'Earlier model context was compacted. Re-read stable project facts, artifacts, and external results with the available read tools before relying on them.'
    : '更早的模型上下文已压缩；需要依赖项目事实、产出或外部结果时，请先用可用的只读工具回读权威记录。')
}

/** Coordinator 已渲染的 threadSummary 优先；surface 正文重抽只作无摘要时的回退。 */
function resolveCompactionCheckpoint(threadSummaryText, messages, locale) {
  const rendered = typeof threadSummaryText === 'string' ? threadSummaryText.trim() : ''
  if (rendered) {
    try {
      return sanitizeAgentModelContextCheckpoint(rendered)
    } catch { /* 空/无效摘要回退到 surface 抽取 */ }
  }
  return checkpointFromMessages(messages, locale)
}

function preparedRecord(surface, meter, policy, trigger, operations) {
  return Object.freeze({
    version: 1,
    surface,
    meter,
    policy,
    trigger,
    operations: Object.freeze(operations.map((operation) => structuredClone(operation))),
  })
}

/**
 * 所有 Planner / Chat / Turn model step 的统一 Context 深模块。
 * 完整 Provider payload 仅存在 Surface WeakMap；prepared 可持有 surface 实例，但序列化
 * 时只能得到公开哈希/计数，不会把 Prompt、媒体、工具结果或 reasoning 带进日志。
 */
export function createAgentModelContextRuntime(input) {
  const { policy } = input ?? {}
  if (!policy || typeof policy !== 'object' || typeof policy.hash !== 'string') {
    throw new TypeError('Agent Model Context Runtime 缺少冻结策略。')
  }
  let usageAnchor = input?.usageAnchor ? structuredClone(input.usageAnchor) : undefined
  const locale = input?.locale === 'en' ? 'en' : 'zh-CN'
  const threadSummaryText = typeof input?.threadSummary === 'string' && input.threadSummary.trim()
    ? input.threadSummary.trim()
    : undefined
  const enrichCheckpoint = typeof input?.enrichCheckpoint === 'function'
    ? input.enrichCheckpoint
    : undefined
  const provider = typeof input?.provider === 'string' && input.provider.trim()
    ? input.provider.trim()
    : 'unknown-provider'
  const runtimeIdentity = input?.runtimeIdentity
  const persistUsageAnchor = input?.persistUsageAnchor
  const observeContext = typeof input?.observe === 'function' ? input.observe : undefined
  const emit = (event) => {
    if (!observeContext) return
    try {
      observeContext({
        ...event,
        identity: {
          projectId: runtimeIdentity?.projectId,
          sessionId: runtimeIdentity?.sessionId,
          turnId: runtimeIdentity?.turnId,
          ...(event?.identity ?? {}),
        },
      })
    } catch { /* 可观测性不得改变 Context Runtime */ }
  }

  return Object.freeze({
    policy,
    async prepare(command) {
      const requestedOutput = Number(command?.maxOutputTokens)
      if (Number.isFinite(requestedOutput) && requestedOutput > policy.outputReserveTokens) {
        throw Object.assign(new Error('模型输出上限超过冻结的 Context 输出预留。'), {
          code: 'AGENT_CONTEXT_OUTPUT_RESERVE_EXCEEDED',
          statusCode: 409,
        })
      }
      const source = createAgentModelContextSurface({
        model: policy.model,
        policyHash: policy.hash,
        outputReserveTokens: policy.outputReserveTokens,
        messages: command?.messages ?? [],
        tools: command?.tools ?? [],
      })
      let surface = source
      let meter = measureAgentModelContextSurface(surface, { policy, usageAnchor })
      const meterBefore = meter
      const operations = []

      const pruned = pruneAgentModelContextSurface(surface, policy)
      if (pruned.kind === 'pruned') {
        surface = pruned.surface
        operations.push(pruned.operation)
        meter = measureAgentModelContextSurface(surface, { policy, usageAnchor })
      }

      if (command?.force === true || meter.shouldCompact) {
        const overflow = command?.trigger === 'overflow'
        const deterministicCheckpoint = resolveCompactionCheckpoint(
          threadSummaryText,
          agentModelContextProviderMessages(surface),
          locale,
        )
        let checkpoint = deterministicCheckpoint
        if (enrichCheckpoint) {
          try {
            const enriched = await enrichCheckpoint({
              deterministicContent: deterministicCheckpoint,
              locale,
              trigger: command?.trigger ?? 'pre_step',
            })
            if (typeof enriched?.content === 'string' && enriched.content.trim()) {
              checkpoint = enriched.content
            }
          } catch { /* enrich 失败不得阻断确定性压缩 */ }
        }
        const compacted = compactAgentModelContextSurface(surface, {
          checkpoint,
          policy,
          trigger: overflow || command?.trigger === 'manual'
            ? command.trigger
            : 'auto',
          // Provider 已证明放不下：绕过日常 16% 尾巴，只保住当前用户 unit 及之后。
          ...(overflow ? { retainRecentTokens: 0 } : {}),
        })
        if (compacted.kind === 'compacted') {
          surface = compacted.surface
          operations.push(compacted.operation)
          meter = measureAgentModelContextSurface(surface, { policy })
        }
      }

      const compactionOperation = operations.find((operation) => operation.type === 'checkpoint_replace')
      emit({
        name: 'agent.context.compaction',
        outcome: compactionOperation ? 'compacted' : 'no_change',
        trigger: command?.trigger === 'overflow' || command?.trigger === 'manual'
          ? command.trigger
          : 'pre_step',
        inputTokensBefore: meterBefore.inputTokens,
        inputTokensAfter: meter.inputTokens,
        ...(compactionOperation
          ? { replacedMessageCount: compactionOperation.replacedMessageRevisions?.length ?? 0 }
          : {}),
      })

      return {
        messages: agentModelContextProviderMessages(surface),
        tools: agentModelContextTools(surface),
        changed: surface.surfaceHash !== source.surfaceHash,
        prepared: preparedRecord(
          surface,
          meter,
          policy,
          command?.trigger ?? 'pre_step',
          operations,
        ),
      }
    },

    async observe(command) {
      const prepared = command?.prepared
      if (!prepared?.surface || prepared.policy?.hash !== policy.hash) {
        throw new TypeError('Agent Model Context observe 缺少匹配的 prepared surface。')
      }
      const anchor = createAgentTokenUsageAnchor({
        surface: prepared.surface,
        meter: prepared.meter,
        usage: command?.responseUsage,
        provider,
        observedAt: Date.now(),
        ...(runtimeIdentity?.turnId ? { turnId: runtimeIdentity.turnId } : {}),
        ...(Number.isSafeInteger(command?.step) ? { step: command.step } : {}),
      })
      if (!anchor) return undefined
      usageAnchor = structuredClone(anchor)
      if (typeof persistUsageAnchor === 'function') {
        // Usage 只是压力计锚点，不是执行正确性的边界。持久化失败不应把一个已经完成
        // 的 Provider 调用改写为 Turn 失败；下一步会安全回退 heuristic。
        try {
          const outcome = await persistUsageAnchor(structuredClone(anchor))
          emit({
            name: 'agent.context.usage_anchor',
            outcome: outcome?.kind === 'updated'
              ? 'persisted'
              : ['replay', 'unchanged'].includes(outcome?.kind) ? 'reused'
                : outcome?.kind === 'conflict' ? 'cas_conflict'
                  : outcome?.kind === 'not_found' ? 'not_found' : 'failed',
            inputTokens: anchor.inputTokens,
            outputTokens: anchor.outputTokens,
            totalTokens: anchor.totalTokens,
            heuristicInputTokens: anchor.heuristicInputTokens,
          })
        } catch (caught) {
          const code = caught && typeof caught === 'object' && 'code' in caught
            && typeof caught.code === 'string' ? caught.code : 'AGENT_CONTEXT_USAGE_PERSIST_FAILED'
          emit({
            name: 'agent.context.usage_anchor', outcome: 'failed',
            inputTokens: anchor.inputTokens,
            outputTokens: anchor.outputTokens,
            totalTokens: anchor.totalTokens,
            heuristicInputTokens: anchor.heuristicInputTokens,
            error: { code, retryable: true },
          })
        }
      }
      return structuredClone(anchor)
    },

    observeOverflow(command = {}) {
      emit({
        name: 'agent.context.overflow',
        outcome: command.outcome,
        retryCount: command.retryCount,
        ...(command.error ? { error: command.error } : {}),
      })
    },
  })
}
