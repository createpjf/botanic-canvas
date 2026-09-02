// @ts-check

import { canonicalHash } from '../../canonicalHash.mjs'
import {
  agentModelContextProviderMessages,
  compactAgentModelContextSurface,
  createAgentModelContextSurface,
  sanitizeAgentModelContextCheckpoint,
} from '../../agentModelContextSurface.mjs'
import { measureAgentModelContextSurface } from '../../agentTokenMeter.mjs'
import { buildThreadSummaryCheckpoint, renderThreadSummary } from '../../agentThreadSummary.mjs'
import { agentMentionOnlyInstruction, agentMentionReferenceLine } from '../../agentMentionModelText.mjs'

const triggers = new Set(['pre_step', 'overflow', 'manual'])
const MESSAGE_TEXT_LIMIT = 4_000

export class AgentContextCompactionError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message)
    this.name = 'AgentContextCompactionError'
    this.code = code
    this.statusCode = statusCode
  }
}

/** @returns {never} */
function invalid(code, message, statusCode = 409) {
  throw new AgentContextCompactionError(code, message, statusCode)
}

function stableMessagePayload(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    invalid('AGENT_CONTEXT_MESSAGE_INVALID', 'Agent Context Message 无效。', 422)
  }
  if (typeof message.id !== 'string' || !message.id.trim()) {
    invalid('AGENT_CONTEXT_MESSAGE_INVALID', 'Agent Context Message 缺少稳定标识。', 422)
  }
  if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
    invalid('AGENT_CONTEXT_MESSAGE_INVALID', 'Agent Context 只接受权威用户与助手消息。', 422)
  }
  // revision 需要覆盖所有可能改变摘要事实或模型表面的字段。只把 hash 落入 ledger，
  // 原始 Message、Prompt、URL 和媒体都仍留在权威 agent_messages。
  return structuredClone(message)
}

export function agentContextMessageRevision(message) {
  return canonicalHash(stableMessagePayload(message))
}

export function agentContextMessageEntries(messages, options) {
  const { locale = 'zh-CN', currentMessageId } = options ?? {}
  const seen = new Set()
  return (messages ?? []).map((message) => {
    const payload = stableMessagePayload(message)
    const id = payload.id.trim()
    if (seen.has(id)) invalid('AGENT_CONTEXT_MESSAGE_DUPLICATE', 'Agent Context Message 标识重复。', 409)
    seen.add(id)
    const rawContent = payload.content.trim() || agentMentionOnlyInstruction(payload.mentions, locale)
    const extra = payload.content.trim() ? agentMentionReferenceLine(payload.mentions, locale) : ''
    const combined = extra ? `${rawContent}\n${extra}` : rawContent
    return {
      id,
      revision: agentContextMessageRevision(payload),
      role: payload.role,
      content: id === currentMessageId ? combined : combined.slice(0, MESSAGE_TEXT_LIMIT),
    }
  }).filter((entry) => entry.content)
}

function prefixMatches(entries, compaction) {
  const replaced = compaction?.replacedMessageRevisions
  if (!Array.isArray(replaced) || !replaced.length || replaced.length >= entries.length) return false
  return replaced.every((revision, index) => (
    revision?.messageId === entries[index]?.id
    && revision?.revision === entries[index]?.revision
  ))
}

function checkpointFromCompaction(compaction) {
  const checkpoint = compaction?.checkpoint
  if (checkpoint?.role !== 'user' || typeof checkpoint.content !== 'string' || !checkpoint.content.trim()) return undefined
  if (canonicalHash(checkpoint.content) !== checkpoint.contentHash) return undefined
  // 旧版或外部写入的 checkpoint 即使自带一致 hash，也不得绕过当前脱敏策略复用。
  if (sanitizeAgentModelContextCheckpoint(checkpoint.content) !== checkpoint.content) return undefined
  return {
    role: 'user',
    content: checkpoint.content,
    contentHash: checkpoint.contentHash,
    ...(typeof checkpoint.threadSummaryHash === 'string'
      ? { threadSummaryHash: checkpoint.threadSummaryHash }
      : {}),
  }
}

export function validAgentContextCompaction(entries, compaction, policy) {
  if (!compaction || compaction.version !== 2) return false
  if (compaction.policy?.hash !== policy?.hash || compaction.policy?.model !== policy?.model) return false
  return Boolean(checkpointFromCompaction(compaction) && prefixMatches(entries, compaction))
}

function safeMeter(meter) {
  return {
    version: meter.version,
    source: meter.source,
    surfaceHash: meter.surfaceHash,
    staticHash: meter.staticHash,
    inputTokens: meter.inputTokens,
    heuristicInputTokens: meter.heuristicInputTokens,
    outputReserveTokens: meter.outputReserveTokens,
    safetyMarginTokens: meter.safetyMarginTokens,
    projectedContextTokens: meter.projectedContextTokens,
    contextWindowTokens: meter.contextWindowTokens,
    utilizationRatio: meter.utilizationRatio,
    shouldCompact: meter.shouldCompact,
    overLimit: meter.overLimit,
    breakdown: structuredClone(meter.breakdown),
  }
}

function surfaceFor(entries, policy) {
  return createAgentModelContextSurface({
    model: policy.model,
    policyHash: policy.hash,
    outputReserveTokens: policy.outputReserveTokens,
    messages: entries,
    tools: [],
  })
}

function checkpointText(messages, locale) {
  const summary = buildThreadSummaryCheckpoint({
    messages,
    fullHistory: true,
    // wall-clock 不属于 compaction 身份；固定值让相同消息得到相同 checkpoint。
    now: 0,
  })
  const rendered = renderThreadSummary(summary, { locale })
  if (rendered) return { content: rendered, summary }
  return {
    content: locale === 'en'
      ? 'Earlier conversation history was compacted. Re-read stable project facts and artifacts with the available read tools before relying on them.'
      : '更早的对话历史已压缩；需要依赖项目事实或产出时，请先用可用的只读工具回读权威记录。',
    summary,
  }
}

function providerEntries(surface) {
  return agentModelContextProviderMessages(surface).map((message, index) => ({
    id: `surface-message-${index + 1}`,
    revision: canonicalHash(message),
    role: message.role,
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null),
  }))
}

/**
 * 把权威 Message 历史解析成下一次 Turn 的不可变 Context V2 投影。
 * raw Message 永不删除；ledger 只替换一个连续旧前缀。
 */
export function resolveAgentContextCompaction(input) {
  const {
    messages = [], locale = 'zh-CN', currentMessageId, policy, usageAnchor,
    existingCompaction, force = false, trigger = 'pre_step', threadSummary,
  } = input ?? {}
  if (!triggers.has(trigger)) invalid('AGENT_CONTEXT_TRIGGER_INVALID', 'Agent Context Compaction trigger 无效。', 422)
  if (!policy || typeof policy !== 'object') invalid('AGENT_CONTEXT_POLICY_INVALID', 'Agent Context Policy 无效。', 422)
  const entries = agentContextMessageEntries(messages, { locale, currentMessageId })
  if (!entries.length) return { kind: 'no_change', entries: [], policy, meter: undefined }
  const baseSurface = surfaceFor(entries, policy)
  const baseMeter = measureAgentModelContextSurface(baseSurface, { policy, usageAnchor })

  let activeCompaction
  let activeSurface = baseSurface
  let activeEntries = entries
  if (validAgentContextCompaction(entries, existingCompaction, policy)) {
    activeCompaction = existingCompaction
    const replacedCount = existingCompaction.replacedMessageRevisions.length
    const checkpoint = checkpointFromCompaction(existingCompaction)
    if (!checkpoint) invalid('AGENT_CONTEXT_CHECKPOINT_INVALID', 'Agent Context Checkpoint 无效。', 409)
    activeEntries = [
      {
        id: `compaction:${checkpoint.contentHash}`,
        revision: checkpoint.contentHash,
        role: 'user',
        content: checkpoint.content,
      },
      ...entries.slice(replacedCount),
    ]
    activeSurface = surfaceFor(activeEntries, policy)
  }
  const activeMeter = measureAgentModelContextSurface(activeSurface, { policy, usageAnchor })
  const shouldCompact = force || activeMeter.shouldCompact
  if (!shouldCompact) {
    return {
      kind: activeCompaction ? 'reused' : 'no_change',
      entries: activeEntries,
      policy,
      meter: safeMeter(activeMeter),
      ...(activeCompaction ? {
        checkpoint: checkpointFromCompaction(activeCompaction),
        compaction: structuredClone(activeCompaction),
      } : {}),
    }
  }

  // 先用固定占位 checkpoint 取得要替换的原始连续前缀，再以该前缀的确定性事实
  // 生成最终 checkpoint。选择范围只取决于 unit 和 retainRecentTokens，不受正文影响。
  const probe = compactAgentModelContextSurface(baseSurface, {
    checkpoint: 'Agent context checkpoint probe.',
    policy,
    trigger: trigger === 'pre_step' ? 'auto' : trigger,
  })
  if (probe.kind !== 'compacted') {
    return {
      kind: activeCompaction ? 'reused' : 'no_change',
      reason: probe.reason,
      entries: activeEntries,
      policy,
      meter: safeMeter(activeMeter),
      ...(activeCompaction ? {
        checkpoint: checkpointFromCompaction(activeCompaction),
        compaction: structuredClone(activeCompaction),
      } : {}),
    }
  }
  const replacedCount = probe.operation.replacedMessageRevisions.length
  const replacedMessages = messages.slice(0, replacedCount)
  const derived = checkpointText(replacedMessages, locale)
  // Surface 会在送往 Provider 前脱敏；持久化 checkpoint 必须使用同一份实际内容，
  // 否则首轮安全、恢复轮又会把原始 secret/URL 重新注入模型。
  const checkpointContent = sanitizeAgentModelContextCheckpoint(derived.content)
  const threadSummaryHash = threadSummary ? canonicalHash(threadSummary) : undefined
  const compacted = compactAgentModelContextSurface(baseSurface, {
    checkpoint: {
      content: checkpointContent,
      ...(threadSummaryHash ? { threadSummaryHash } : {}),
    },
    policy,
    trigger: trigger === 'pre_step' ? 'auto' : trigger,
  })
  if (compacted.kind !== 'compacted') {
    return {
      kind: activeCompaction ? 'reused' : 'no_change',
      reason: compacted.reason,
      entries: activeEntries,
      policy,
      meter: safeMeter(activeMeter),
      ...(activeCompaction ? {
        checkpoint: checkpointFromCompaction(activeCompaction),
        compaction: structuredClone(activeCompaction),
      } : {}),
    }
  }
  const afterMeter = measureAgentModelContextSurface(compacted.surface, { policy })
  if (afterMeter.inputTokens >= baseMeter.inputTokens) {
    invalid('AGENT_CONTEXT_COMPACTION_NOT_SMALLER', 'Agent Context Compaction 未降低上下文压力。', 409)
  }
  const replacedMessageRevisions = entries.slice(0, replacedCount).map((entry) => ({
    messageId: entry.id,
    revision: entry.revision,
  }))
  const checkpoint = {
    role: 'user',
    content: checkpointContent,
    contentHash: canonicalHash(checkpointContent),
    ...(threadSummaryHash ? { threadSummaryHash } : {}),
  }
  const identity = {
    version: 2,
    sessionId: input?.sessionId,
    policyHash: policy.hash,
    trigger,
    replacedMessageRevisions,
    checkpointHash: checkpoint.contentHash,
    sourceSurfaceHash: compacted.operation.sourceSurfaceHash,
  }
  const id = `agent_context_compaction_${canonicalHash(identity).slice(0, 32)}`
  const compaction = {
    id,
    version: 2,
    trigger,
    sourceSurfaceHash: compacted.operation.sourceSurfaceHash,
    resultSurfaceHash: compacted.operation.resultSurfaceHash,
    replacedMessageRevisions,
    checkpoint,
    policy: { id: policy.id, hash: policy.hash, model: policy.model },
    meterBefore: safeMeter(baseMeter),
    meterAfter: safeMeter(afterMeter),
  }
  if (activeCompaction?.id === compaction.id) {
    return {
      kind: 'reused',
      reason: 'same_compaction',
      entries: activeEntries,
      policy,
      meter: safeMeter(activeMeter),
      checkpoint: checkpointFromCompaction(activeCompaction),
      compaction: structuredClone(activeCompaction),
    }
  }
  return {
    kind: 'candidate',
    entries: providerEntries(compacted.surface),
    // Snapshot 需要原始稳定身份；providerEntries 的 synthetic id 只适合纯 Surface。
    retainedEntries: entries.slice(replacedCount),
    policy,
    meter: safeMeter(afterMeter),
    checkpoint,
    compaction,
    idempotencyKey: id,
  }
}

export function agentContextMessageCursorHash(entries) {
  return canonicalHash((entries ?? []).map((entry) => ({ id: entry.id, revision: entry.revision })))
}
