// @ts-check

import { canonicalHash } from '../../canonicalHash.mjs'
import {
  resolveAgentModelContextPolicy,
  validateAgentModelContextPolicySnapshot,
} from './agentModelContextPolicy.mjs'
import { createAgentModelContextRuntime } from './agentModelContextRuntime.mjs'
import { sanitizeAgentModelContextCheckpoint } from './agentModelContextSurface.mjs'
import { renderThreadSummary } from '../thread/agentThreadSummary.mjs'

export class AgentModelContextBindingError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentModelContextBindingError'
    this.code = code
    this.statusCode = 409
  }
}

function failure(code, message) {
  throw new AgentModelContextBindingError(code, message)
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function frozenPolicy(value, expectedModel) {
  try {
    return validateAgentModelContextPolicySnapshot(value, { model: expectedModel })
  } catch {
    failure('AGENT_CONTEXT_POLICY_INVALID', 'Agent Context Snapshot 的冻结模型策略无效。')
  }
}

function primaryModel(input, runtimeConfig) {
  return text(input?.plannerModel) ?? text(runtimeConfig?.flockTextModel)
}

function assertRuntimeIdentity(input, runtimeIdentity) {
  const projectId = text(input?.projectId)
  const sessionId = text(input?.sessionId)
  if (!projectId || !sessionId
    || runtimeIdentity?.projectId !== projectId
    || runtimeIdentity?.sessionId !== sessionId) {
    failure('AGENT_CONTEXT_RUNTIME_IDENTITY_MISMATCH', 'Agent Context Snapshot 与 Runtime 身份不匹配。')
  }
}

/**
 * 把持久化 Snapshot V2 投影成 Turn 可消费的不可变 Provider 消息。
 * Message id/revision 与其它 ledger 字段不进入 Provider payload。
 */
export function projectAgentThreadContextSnapshotV2(snapshot, model) {
  if (snapshot?.version !== 2) return undefined
  if (!Array.isArray(snapshot.messages)) {
    failure('AGENT_CONTEXT_SNAPSHOT_INVALID', 'Agent Context Snapshot V2 缺少消息窗口。')
  }
  const modelPolicy = frozenPolicy(snapshot.modelPolicy, model)
  const messages = snapshot.messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || !['user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string') {
      failure('AGENT_CONTEXT_SNAPSHOT_INVALID', 'Agent Context Snapshot V2 包含无效消息。')
    }
    return { role: message.role, content: message.content }
  })
  if (snapshot.checkpoint !== undefined) {
    const checkpoint = snapshot.checkpoint
    if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)
      || checkpoint.role !== 'user' || typeof checkpoint.content !== 'string'
      || !checkpoint.content.trim()
      || (typeof checkpoint.contentHash === 'string'
        && canonicalHash(checkpoint.content) !== checkpoint.contentHash)) {
      failure('AGENT_CONTEXT_SNAPSHOT_INVALID', 'Agent Context Snapshot V2 的 checkpoint 无效。')
    }
    // Durable Snapshot 是已接受 Turn 的不可变请求身份。旧版 checkpoint
    // 如果不符合当前脱敏策略，必须拒绝恢复，不能在这里修改正文和 hash。
    if (sanitizeAgentModelContextCheckpoint(checkpoint.content) !== checkpoint.content) {
      failure('AGENT_CONTEXT_SNAPSHOT_UNSAFE', 'Agent Context Snapshot V2 的 checkpoint 不符合当前安全策略。')
    }
    messages.unshift({ role: 'user', content: checkpoint.content })
  }
  return Object.freeze({
    modelPolicy: Object.freeze(modelPolicy),
    contextPolicyHash: modelPolicy.hash,
    messages: Object.freeze(messages.map((message) => Object.freeze(message))),
  })
}

/**
 * 每个实际模型 attempt 独立解析 Context Runtime。factory 返回空值时才回退通用 seam；
 * Snapshot V2 的 primary model 必须拿到同一冻结策略，不能静默退回 legacy。
 */
export function resolveAgentModelContextBinding(options, model, expectedPolicy) {
  if (options?.modelContextForModel !== undefined && typeof options.modelContextForModel !== 'function') {
    failure('AGENT_CONTEXT_RUNTIME_INVALID', 'Agent Model Context factory 无效。')
  }
  const fromFactory = options?.modelContextForModel?.(model, options?.runtimeIdentity)
  if (fromFactory && typeof fromFactory.then === 'function') {
    failure('AGENT_CONTEXT_RUNTIME_INVALID', 'Agent Model Context factory 必须同步返回 runtime。')
  }
  const modelContext = fromFactory ?? options?.modelContext
  if (modelContext === undefined) {
    if (expectedPolicy !== undefined) {
      failure('AGENT_CONTEXT_RUNTIME_REQUIRED', 'Agent Context Snapshot V2 缺少匹配的模型 Runtime。')
    }
    return Object.freeze({ modelContext: undefined, contextPolicyHash: undefined })
  }
  if (!modelContext || typeof modelContext.prepare !== 'function' || typeof modelContext.observe !== 'function') {
    failure('AGENT_CONTEXT_RUNTIME_INVALID', 'Agent Model Context Runtime 无效。')
  }
  const runtimeModel = text(modelContext.policy?.model)
  const contextPolicyHash = text(modelContext.policy?.hash)
  if (!runtimeModel || !contextPolicyHash) {
    failure('AGENT_CONTEXT_POLICY_INVALID', 'Agent Model Context Runtime 缺少冻结策略。')
  }
  if (runtimeModel !== model) {
    failure('AGENT_CONTEXT_POLICY_MISMATCH', 'Agent Model Context Runtime 与实际模型不匹配。')
  }
  if (expectedPolicy !== undefined) {
    const expected = frozenPolicy(expectedPolicy, model)
    if (expected.hash !== contextPolicyHash) {
      failure('AGENT_CONTEXT_POLICY_MISMATCH', 'Agent Model Context Runtime 与不可变 Snapshot 策略不匹配。')
    }
  }
  return Object.freeze({ modelContext, contextPolicyHash })
}

/**
 * Runtime request 的 Context V2 组合根。主模型必须复用 durable request 冻结的策略；
 * Vision 等次级模型按当前受控目录解析自己的策略，并按模型缓存独立 runtime。
 * v1 直接返回原 options 引用，确保未放量路径没有额外对象或调用。
 */
export function bindAgentModelContextOptions(input, runtimeConfig, options = {}) {
  const snapshot = input?.threadContextSnapshot
  if (snapshot?.version !== 2) return options
  const model = primaryModel(input, runtimeConfig)
  if (!model) failure('AGENT_CONTEXT_POLICY_INVALID', 'Agent Context Snapshot V2 缺少主模型。')
  assertRuntimeIdentity(input, options.runtimeIdentity)
  const snapshotPolicy = frozenPolicy(snapshot.modelPolicy, model)
  if (options.persistAgentContextUsageAnchor !== undefined
    && typeof options.persistAgentContextUsageAnchor !== 'function') {
    failure('AGENT_CONTEXT_RUNTIME_INVALID', 'Agent Context usage anchor 持久化 seam 无效。')
  }
  const existingFactory = options.modelContextForModel
  if (existingFactory !== undefined && typeof existingFactory !== 'function') {
    failure('AGENT_CONTEXT_RUNTIME_INVALID', 'Agent Model Context factory 无效。')
  }
  if (options.enrichAgentContextCheckpoint !== undefined
    && typeof options.enrichAgentContextCheckpoint !== 'function') {
    failure('AGENT_CONTEXT_RUNTIME_INVALID', 'Agent Context checkpoint enricher 无效。')
  }
  const locale = input?.locale === 'en' ? 'en' : 'zh-CN'
  const threadSummary = text(snapshot.threadSummaryText)
    || renderThreadSummary(snapshot.threadSummary, { locale })
    || undefined
  const runtimes = new Map()
  const modelContextForModel = (requestedModel, runtimeIdentity) => {
    assertRuntimeIdentity(input, runtimeIdentity)
    const existing = existingFactory?.(requestedModel, runtimeIdentity)
    if (existing !== undefined && existing !== null) return existing
    if (runtimes.has(requestedModel)) return runtimes.get(requestedModel)
    const policy = requestedModel === model
      ? snapshotPolicy
      : resolveAgentModelContextPolicy(requestedModel, runtimeConfig?.agentModelContextPolicies)
    const runtime = createAgentModelContextRuntime({
      policy,
      locale: input?.locale,
      provider: 'flock-chat-completions',
      runtimeIdentity,
      ...(threadSummary ? { threadSummary } : {}),
      ...(typeof options.enrichAgentContextCheckpoint === 'function'
        ? { enrichCheckpoint: options.enrichAgentContextCheckpoint }
        : {}),
      ...(requestedModel === model && snapshot.usageAnchor
        ? { usageAnchor: snapshot.usageAnchor }
        : {}),
      ...(options.persistAgentContextUsageAnchor
        ? { persistUsageAnchor: options.persistAgentContextUsageAnchor }
        : {}),
      ...(typeof options.observeAgentContext === 'function'
        ? { observe: options.observeAgentContext }
        : {}),
    })
    runtimes.set(requestedModel, runtime)
    return runtime
  }
  return { ...options, modelContextForModel }
}
