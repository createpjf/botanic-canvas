// @ts-check

import { isDeepStrictEqual } from 'node:util'

function messageMergeError(message, code) {
  return Object.assign(new Error(message), { code })
}

function finiteTimestamp(value, fallback = 0) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : fallback
}

function validCancellation(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function stableTurnProjection(current, incoming, turnId) {
  if (!turnId) return false
  const id = incoming?.id ?? current?.id
  const currentRole = current?.role ?? incoming?.role
  const incomingRole = incoming?.role ?? current?.role
  return id === `agent-turn-result-${turnId}`
    && currentRole === 'assistant'
    && incomingRole === 'assistant'
}

/**
 * Message 的跨 Adapter 单一合并规则。
 *
 * 普通正文仍按 updatedAt LWW；稳定 Turn 投影的 failed 是权威终态，不能被
 * answered/submitted 的客户端时钟反转。Turn 绑定、请求快照和取消意图独立于正文
 * 版本合并，因此旧 writer 遗漏字段不会清空已提交的恢复身份。
 */
export function mergeAgentMessageForWrite(current, incoming, input = {}) {
  if (!incoming || typeof incoming !== 'object') {
    throw messageMergeError('Agent 消息写入无效。', 'AGENT_MESSAGE_INVALID')
  }

  const currentTurnId = typeof current?.turnId === 'string' ? current.turnId : undefined
  const incomingTurnId = typeof incoming.turnId === 'string' ? incoming.turnId : undefined
  if (currentTurnId !== undefined && incomingTurnId !== undefined && currentTurnId !== incomingTurnId) {
    throw messageMergeError('Agent 消息已绑定其他 Turn。', 'AGENT_MESSAGE_TURN_ID_CONFLICT')
  }

  const currentRole = current?.role
  const incomingRole = incoming.role
  if (currentRole !== undefined && incomingRole !== undefined && currentRole !== incomingRole) {
    throw messageMergeError('Agent 消息作者角色不可改绑。', 'AGENT_MESSAGE_ROLE_CONFLICT')
  }

  const currentSnapshot = current?.turnRequestSnapshot
  const incomingSnapshot = incoming.turnRequestSnapshot
  const currentTargetBinding = currentSnapshot?.targetBinding
  const incomingTargetBinding = incomingSnapshot?.targetBinding
  const withoutTargetBinding = (snapshot) => {
    if (snapshot === undefined) return undefined
    const copy = structuredClone(snapshot)
    delete copy.targetBinding
    return copy
  }
  if (currentSnapshot !== undefined && incomingSnapshot !== undefined
    && !isDeepStrictEqual(withoutTargetBinding(currentSnapshot), withoutTargetBinding(incomingSnapshot))) {
    throw messageMergeError('Agent 消息已绑定其他 Turn 请求快照。', 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT')
  }
  if (currentTargetBinding !== undefined && incomingTargetBinding !== undefined
    && !isDeepStrictEqual(currentTargetBinding, incomingTargetBinding)) {
    throw messageMergeError('Agent 消息已绑定其他目标版本。', 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT')
  }
  if (current && (currentSnapshot !== undefined || incomingSnapshot !== undefined) && (
    current.kind !== incoming.kind
    || current.content !== incoming.content
    || current.createdAt !== incoming.createdAt
    || !isDeepStrictEqual(current.mentions, incoming.mentions)
  )) {
    throw messageMergeError('Agent 消息的 Turn 请求身份不可变更。', 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT')
  }

  const currentUpdatedAt = finiteTimestamp(input.currentUpdatedAt, finiteTimestamp(current?.updatedAt))
  const incomingUpdatedAt = finiteTimestamp(input.incomingUpdatedAt, finiteTimestamp(incoming.updatedAt))
  const storedUpdatedAt = current
    ? Math.max(currentUpdatedAt, incomingUpdatedAt, finiteTimestamp(current.updatedAt), finiteTimestamp(incoming.updatedAt))
    : Math.max(incomingUpdatedAt, finiteTimestamp(incoming.updatedAt))

  let applyIncomingBody = !current || incomingUpdatedAt > currentUpdatedAt
  const turnId = currentTurnId ?? incomingTurnId
  if (current && stableTurnProjection(current, incoming, turnId)) {
    const currentFailed = current.status === 'failed'
    const incomingFailed = incoming.status === 'failed'
    if (incomingFailed && !currentFailed) applyIncomingBody = true
    else if (currentFailed && !incomingFailed) applyIncomingBody = false
  }

  const message = structuredClone(applyIncomingBody || !current ? incoming : current)
  delete message.role
  const role = currentRole ?? incomingRole
  if (role !== undefined) message.role = role

  delete message.createdAt
  const createdAt = current?.createdAt ?? incoming.createdAt
  if (createdAt !== undefined) message.createdAt = createdAt

  delete message.turnId
  if (turnId !== undefined) message.turnId = turnId

  delete message.turnRequestSnapshot
  const turnRequestSnapshot = currentSnapshot ?? incomingSnapshot
  if (turnRequestSnapshot !== undefined) {
    message.turnRequestSnapshot = structuredClone(turnRequestSnapshot)
    const targetBinding = currentTargetBinding ?? incomingTargetBinding
    if (targetBinding !== undefined) message.turnRequestSnapshot.targetBinding = structuredClone(targetBinding)
  }

  delete message.turnCancellationRequestedAt
  const currentCancellation = validCancellation(current?.turnCancellationRequestedAt)
  const incomingCancellation = validCancellation(incoming.turnCancellationRequestedAt)
  const earliestCancellation = currentCancellation === undefined
    ? incomingCancellation
    : incomingCancellation === undefined
      ? currentCancellation
      : Math.min(currentCancellation, incomingCancellation)
  if (earliestCancellation !== undefined) message.turnCancellationRequestedAt = earliestCancellation

  // Entity References 是 Turn 结果的服务端派生投影，不属于客户端 LWW 正文。
  // 旧 writer 不认识该字段时必须保留；同一 immutable Turn 若给出不同引用，说明
  // 权威链路发生漂移，不能按设备时钟任选一边。
  if (stableTurnProjection(current, incoming, turnId)) {
    const currentReferences = current?.entityReferences
    const incomingReferences = incoming.entityReferences
    if (
      currentReferences !== undefined
      && incomingReferences !== undefined
      && !isDeepStrictEqual(currentReferences, incomingReferences)
    ) {
      throw messageMergeError('Agent Turn 结果业务引用发生冲突。', 'AGENT_MESSAGE_ENTITY_REFERENCES_CONFLICT')
    }
    const references = currentReferences ?? incomingReferences
    delete message.entityReferences
    if (references !== undefined) message.entityReferences = structuredClone(references)

    for (const field of ['sourceMessageId', 'sourceNodeIds', 'targetArtifactVersionId', 'planFingerprint']) {
      const currentValue = current?.[field]
      const incomingValue = incoming[field]
      if (currentValue !== undefined && incomingValue !== undefined
        && !isDeepStrictEqual(currentValue, incomingValue)) {
        throw messageMergeError('Agent Turn 结果来源发生冲突。', 'AGENT_MESSAGE_PROVENANCE_CONFLICT')
      }
      delete message[field]
      const value = currentValue ?? incomingValue
      if (value !== undefined) message[field] = structuredClone(value)
    }
  }

  message.updatedAt = storedUpdatedAt
  return { message, updatedAt: storedUpdatedAt, appliedIncomingBody: applyIncomingBody }
}
