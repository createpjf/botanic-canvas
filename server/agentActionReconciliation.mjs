// @ts-check
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { agentActionIntentHash } from './agentActionExecution.mjs'
import { canonicalHash } from './canonicalHash.mjs'
import { generationIdempotencyKey, generationJobIdForIdempotency } from './generation/generationIdempotency.mjs'
export {
  agentActionManualRetryConsumptionDecision,
  agentActionReceiptResolutionDecision,
} from './store/productStoreContract.mjs'

const DEFAULT_MANUAL_RETRY_TTL_MS = 15 * 60_000
const decisions = new Set(['confirmed_applied', 'confirmed_not_applied'])

function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new TypeError(`Agent Action 调和缺少有效${label}。`)
  }
  return value.trim()
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('base64url')
}

function boundedError(error) {
  if (!error || typeof error !== 'object') return undefined
  const code = typeof error.code === 'string' ? error.code.trim().slice(0, 120) : ''
  const message = typeof error.message === 'string' ? error.message.trim().slice(0, 500) : ''
  if (!code && !message) return undefined
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...(Number.isFinite(Number(error.statusCode)) ? { statusCode: Number(error.statusCode) } : {}),
  }
}

export class AgentActionReconciliationError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message)
    this.name = 'AgentActionReconciliationError'
    this.code = code
    this.statusCode = statusCode
  }
}

/** 把 Adapter/RPC 的受控失败收敛成统一 HTTP 可识别的业务错误。 */
export function agentActionReconciliationStoreError(caught) {
  if (caught instanceof AgentActionReconciliationError) return caught
  const code = typeof caught?.code === 'string' ? caught.code : ''
  if (['PROJECT_WRITE_FORBIDDEN', 'PROJECT_READ_FORBIDDEN'].includes(code)) {
    return new AgentActionReconciliationError(code, '你没有调和该 Agent 行动的权限。', 403)
  }
  if (['AGENT_ACTION_RECONCILIATION_REQUIRED', 'AGENT_ACTION_ATOMIC_CLAIM_REQUIRED'].includes(code)) {
    return new AgentActionReconciliationError(
      'AGENT_ACTION_RECONCILIATION_REQUIRED',
      'Agent 行动调和存储尚未就绪，请稍后重试。',
      503,
    )
  }
  if (code === 'AGENT_ACTION_RECEIPT_NOT_FOUND') return reconciliationError('not_found')
  if (['AGENT_ACTION_RECONCILIATION_INVALID', 'AGENT_ACTION_RECEIPT_INVALID'].includes(code)) {
    return new AgentActionReconciliationError(
      'AGENT_ACTION_RECONCILIATION_INVALID',
      'Agent 行动调和请求与存储契约不匹配。',
      422,
    )
  }
  if (code === 'AGENT_ACTION_MANUAL_RETRY_INVALID') {
    return new AgentActionReconciliationError(code, '手动重试授权无效。', 403)
  }
  return new AgentActionReconciliationError(
    'AGENT_ACTION_RECONCILIATION_UNAVAILABLE',
    'Agent 行动调和存储暂时不可用，请稍后重试。',
    503,
  )
}

/**
 * 从服务端读出的原始 Action 派生调和身份。
 *
 * `receiptId` 与 `intentHash` 保持既有 Agent Action Execution 兼容；新增的
 * `actionBindingHash` 再绑定 Session、Message、Action 与幂等键。客户端即使传入
 * receiptId / intentHash 也会被忽略，调用方必须把持久化 Action 的权威字段传进来。
 */
export function agentActionReconciliationIdentity(input) {
  const userId = text(input?.userId, '用户', 160)
  const projectId = text(input?.projectId, '项目', 160)
  const sessionId = text(input?.sessionId, '会话', 160)
  const messageId = text(input?.messageId, '消息', 160)
  const actionId = text(input?.actionId ?? input?.toolCallId, '行动', 160)
  const toolCallId = text(input?.toolCallId ?? input?.actionId, '工具调用', 160)
  const actionName = text(input?.name ?? input?.toolName, '工具名称', 80)
  const idempotencyKey = text(input?.idempotencyKey, '幂等键', 160)
  const argumentsValue = input?.arguments ?? {}
  let argumentsHash
  try {
    argumentsHash = canonicalHash(argumentsValue)
  } catch {
    throw new TypeError('Agent Action 调和参数必须是可序列化的结构化值。')
  }
  const receiptId = `agent_action_${generationJobIdForIdempotency(userId, `${projectId}:${idempotencyKey}`).slice(4)}`
  const intentHash = agentActionIntentHash({
    userId,
    projectId,
    name: actionName,
    toolCallId,
    arguments: argumentsValue,
  })
  const actionBindingHash = canonicalHash({
    version: 1,
    userId,
    projectId,
    sessionId,
    messageId,
    actionId,
    toolCallId,
    actionName,
    argumentsHash,
    idempotencyKey,
  })
  return Object.freeze({
    receiptId,
    intentHash,
    actionBindingHash,
    argumentsHash,
    userId,
    projectId,
    sessionId,
    messageId,
    actionId,
    toolCallId,
    actionName,
    idempotencyKey,
  })
}

function receiptMatches(receipt, identity) {
  return Boolean(receipt
    && receipt.id === identity.receiptId
    && receipt.ownerId === identity.userId
    && receipt.projectId === identity.projectId
    && receipt.toolCallId === identity.toolCallId
    && receipt.actionName === identity.actionName
    && receipt.intentHash === identity.intentHash
    && receipt.actionBindingHash === identity.actionBindingHash)
}

function publicStatus(receipt, identity, observedAt) {
  const authorization = receipt?.manualRetryAuthorization
  const available = Boolean(authorization
    && !authorization.consumedAt
    && Number(authorization.expiresAt) >= observedAt)
  return {
    action: {
      sessionId: identity.sessionId,
      messageId: identity.messageId,
      actionId: identity.actionId,
      toolCallId: identity.toolCallId,
      name: identity.actionName,
    },
    status: receipt.status,
    canResolve: receipt.status === 'uncertain' && !receipt.resolution,
    ...(boundedError(receipt.error) ? { error: boundedError(receipt.error) } : {}),
    ...(receipt.resolution ? {
      resolution: {
        decision: receipt.resolution.decision,
        resolvedAt: receipt.resolution.resolvedAt,
      },
    } : {}),
    ...(authorization ? {
      manualRetry: {
        available,
        expiresAt: authorization.expiresAt,
        ...(authorization.consumedAt ? { consumedAt: authorization.consumedAt } : {}),
      },
    } : {}),
    updatedAt: receipt.updatedAt,
  }
}

function reconciliationError(kind) {
  if (kind === 'not_found') {
    return new AgentActionReconciliationError('AGENT_ACTION_RECONCILIATION_NOT_FOUND', '未找到需要调和的 Agent 行动。', 404)
  }
  if (kind === 'not_uncertain') {
    return new AgentActionReconciliationError('AGENT_ACTION_RECONCILIATION_NOT_UNCERTAIN', '只有结果未知的行动可以人工调和。', 409)
  }
  if (kind === 'invalid') {
    return new AgentActionReconciliationError('AGENT_ACTION_RECONCILIATION_INVALID', 'Agent 行动调和决议无效。', 422)
  }
  return new AgentActionReconciliationError('AGENT_ACTION_RECONCILIATION_CONFLICT', '该行动已由其他决议处理，不能覆盖。', 409)
}

function consumptionError(kind) {
  if (kind === 'not_found') {
    return new AgentActionReconciliationError('AGENT_ACTION_RECONCILIATION_NOT_FOUND', '未找到需要重试的 Agent 行动。', 404)
  }
  if (kind === 'expired') {
    return new AgentActionReconciliationError('AGENT_ACTION_MANUAL_RETRY_EXPIRED', '手动重试授权已过期，请重新确认。', 409)
  }
  if (kind === 'already_consumed') {
    return new AgentActionReconciliationError('AGENT_ACTION_MANUAL_RETRY_ALREADY_CONSUMED', '手动重试授权已经使用，不能重复执行。', 409)
  }
  if (kind === 'conflict') {
    return new AgentActionReconciliationError('AGENT_ACTION_RECONCILIATION_SCOPE_MISMATCH', '手动重试授权与当前行动不匹配。', 409)
  }
  if (kind === 'unavailable') {
    return new AgentActionReconciliationError('AGENT_ACTION_MANUAL_RETRY_UNAVAILABLE', '该行动没有可用的手动重试授权。', 409)
  }
  return new AgentActionReconciliationError('AGENT_ACTION_MANUAL_RETRY_INVALID', '手动重试授权无效。', 403)
}

function retryIdentityFor(originalAction, retryIdempotencyKey) {
  const normalized = generationIdempotencyKey(retryIdempotencyKey)
  if (!normalized) {
    throw new AgentActionReconciliationError(
      'AGENT_ACTION_MANUAL_RETRY_IDEMPOTENCY_INVALID',
      '手动重试提交标识无效。',
      400,
    )
  }
  return agentActionReconciliationIdentity({ ...originalAction, idempotencyKey: normalized })
}

/**
 * ProductStore-agnostic 人工调和服务。Adapter 必须把 resolve / consume 放在自己的
 * 原子锁或事务内；服务端预读只用于权限投影与稳定错误，不能替代原子判定。
 */
export function createAgentActionReconciliation(dependencies) {
  const productStore = dependencies?.productStore
  if (typeof productStore?.readAgentActionReceipt !== 'function'
    || typeof productStore?.resolveAgentActionReceipt !== 'function'
    || typeof productStore?.consumeAgentActionManualRetryAuthorization !== 'function') {
    throw new AgentActionReconciliationError(
      'AGENT_ACTION_RECONCILIATION_REQUIRED',
      'Agent Action 调和缺少 ProductStore read/resolve/consume 原子 Interface。',
      503,
    )
  }
  const now = typeof dependencies?.now === 'function' ? dependencies.now : () => Date.now()
  const ttl = Math.max(1, Number(dependencies?.manualRetryTtlMs) || DEFAULT_MANUAL_RETRY_TTL_MS)
  const createToken = typeof dependencies?.createToken === 'function'
    ? dependencies.createToken
    : () => `agent_action_retry_${randomBytes(32).toString('base64url')}`
  const createAuthorizationId = typeof dependencies?.createAuthorizationId === 'function'
    ? dependencies.createAuthorizationId
    : () => `agent_action_manual_retry_${randomUUID()}`

  async function readReceipt(action) {
    const identity = agentActionReconciliationIdentity(action)
    let receipt
    try {
      receipt = await productStore.readAgentActionReceipt(identity.userId, identity.receiptId)
    } catch (caught) {
      throw agentActionReconciliationStoreError(caught)
    }
    if (!receipt) throw reconciliationError('not_found')
    if (!receiptMatches(receipt, identity)) {
      throw new AgentActionReconciliationError(
        'AGENT_ACTION_RECONCILIATION_SCOPE_MISMATCH',
        '原始行动与持久化回执不匹配，已拒绝调和。',
        409,
      )
    }
    return { identity, receipt }
  }

  async function assertAuthorizedManualRetry(identity, originalAction) {
    const { identity: original, receipt } = await readReceipt(originalAction)
    const sameAction = [
      'userId', 'projectId', 'sessionId', 'messageId', 'actionId', 'toolCallId', 'actionName', 'argumentsHash',
    ].every((field) => identity[field] === original[field])
    const authorization = receipt.manualRetryAuthorization
    const authorized = sameAction
      && identity.receiptId !== original.receiptId
      && receipt.status === 'failed'
      && receipt.actionBindingHash === original.actionBindingHash
      && receipt.resolution?.decision === 'confirmed_not_applied'
      && receipt.resolution?.actionBindingHash === original.actionBindingHash
      && authorization?.receiptId === original.receiptId
      && authorization?.intentHash === original.intentHash
      && authorization?.actionBindingHash === original.actionBindingHash
      && authorization?.userId === original.userId
      && authorization?.projectId === original.projectId
      && authorization?.actionId === original.actionId
      && (authorization?.version !== 2 || authorization?.boundRetryReceiptId === identity.receiptId)
      && Number.isFinite(Number(authorization?.consumedAt))
      && authorization?.consumedByReceiptId === identity.receiptId
    if (!authorized) {
      throw new AgentActionReconciliationError(
        'AGENT_ACTION_MANUAL_RETRY_UNAVAILABLE',
        '当前回执不是原行动已授权的一次性手动重试。',
        409,
      )
    }
    return { original, receipt }
  }

  return Object.freeze({
    async readStatus(action, options = {}) {
      const identity = agentActionReconciliationIdentity(action)
      if (options?.manualRetryOf) await assertAuthorizedManualRetry(identity, options.manualRetryOf)
      let receipt
      try {
        const current = await readReceipt(action)
        receipt = current.receipt
      } catch (caught) {
        if (options?.manualRetryOf
          && caught instanceof AgentActionReconciliationError
          && caught.code === 'AGENT_ACTION_RECONCILIATION_NOT_FOUND') {
          // consume 已落库、retry receipt 还没 claim 时进程可能退出。
          // 状态查询绝不代替执行，只给客户端一个稳定的恢复信号。
          throw new AgentActionReconciliationError(
            'AGENT_ACTION_MANUAL_RETRY_RECEIPT_PENDING',
            '一次性手动重试已授权，但执行回执尚未建立；请用同一提交标识恢复。',
            409,
          )
        }
        throw caught
      }
      return publicStatus(receipt, identity, Number(now()) || Date.now())
    },

    async authorizeConsumedManualRetry(input) {
      const identity = agentActionReconciliationIdentity(input?.action)
      try {
        await assertAuthorizedManualRetry(identity, input?.manualRetryOf)
      } catch (caught) {
        if (caught instanceof AgentActionReconciliationError
          && ['AGENT_ACTION_RECONCILIATION_NOT_FOUND', 'AGENT_ACTION_MANUAL_RETRY_UNAVAILABLE'].includes(caught.code)) {
          throw new AgentActionReconciliationError(
            'AGENT_ACTION_MANUAL_RETRY_REQUIRED',
            '新的行动提交标识必须携带未消费的一次性授权。',
            409,
          )
        }
        throw caught
      }
      return Object.freeze({ kind: 'authorized', retryReceiptId: identity.receiptId })
    },

    async resolve(input) {
      const decision = input?.decision
      if (!decisions.has(decision)) throw reconciliationError('invalid')
      const { identity, receipt } = await readReceipt(input?.action)
      const manualRetryExhausted = Boolean(input?.manualRetryOf)
      const preparedRetryIdempotencyKey = input?.preparedRetryIdempotencyKey === undefined
        ? undefined
        : generationIdempotencyKey(input.preparedRetryIdempotencyKey)
      if (input?.preparedRetryIdempotencyKey !== undefined && !preparedRetryIdempotencyKey) {
        throw new AgentActionReconciliationError(
          'AGENT_ACTION_MANUAL_RETRY_IDEMPOTENCY_INVALID',
          '预留的手动重试提交标识无效。',
          400,
        )
      }
      if (preparedRetryIdempotencyKey
        && (decision !== 'confirmed_not_applied' || manualRetryExhausted)) {
        throw reconciliationError('invalid')
      }
      const preparedRetryIdentity = preparedRetryIdempotencyKey
        ? retryIdentityFor(input.action, preparedRetryIdempotencyKey)
        : undefined
      if (preparedRetryIdentity?.receiptId === identity.receiptId) {
        throw new AgentActionReconciliationError(
          'AGENT_ACTION_MANUAL_RETRY_IDEMPOTENCY_REUSED',
          '手动重试必须预留新的提交标识。',
          409,
        )
      }
      if (manualRetryExhausted) await assertAuthorizedManualRetry(identity, input.manualRetryOf)
      if (receipt.resolution) {
        if (receipt.resolution.decision !== decision
          || receipt.resolution.actionBindingHash !== identity.actionBindingHash
          || Boolean(receipt.resolution.manualRetryExhausted) !== (manualRetryExhausted && decision === 'confirmed_not_applied')) {
          throw reconciliationError('conflict')
        }
        if (decision === 'confirmed_not_applied' && !manualRetryExhausted) {
          const storedAuthorization = receipt.manualRetryAuthorization
          const reservationMatches = preparedRetryIdentity
            ? storedAuthorization?.version === 2
              && storedAuthorization.boundRetryReceiptId === preparedRetryIdentity.receiptId
            : storedAuthorization?.version !== 2
          if (!reservationMatches) throw reconciliationError('conflict')
        }
      } else if (receipt.status !== 'uncertain') {
        throw reconciliationError('not_uncertain')
      }

      const resolvedAt = Number(now()) || Date.now()
      let rawToken
      let manualRetryAuthorization
      if (decision === 'confirmed_not_applied' && !receipt.resolution && !manualRetryExhausted) {
        if (preparedRetryIdentity) {
          manualRetryAuthorization = {
            version: 2,
            id: text(createAuthorizationId(), '手动重试授权标识', 200),
            receiptId: identity.receiptId,
            intentHash: identity.intentHash,
            actionBindingHash: identity.actionBindingHash,
            userId: identity.userId,
            projectId: identity.projectId,
            actionId: identity.actionId,
            boundRetryReceiptId: preparedRetryIdentity.receiptId,
            reservedAt: resolvedAt,
            expiresAt: resolvedAt + ttl,
          }
        } else {
          rawToken = text(createToken(), '手动重试授权', 512)
          manualRetryAuthorization = {
            version: 1,
            id: text(createAuthorizationId(), '手动重试授权标识', 200),
            receiptId: identity.receiptId,
            intentHash: identity.intentHash,
            actionBindingHash: identity.actionBindingHash,
            userId: identity.userId,
            projectId: identity.projectId,
            actionId: identity.actionId,
            tokenHash: tokenHash(rawToken),
            tokenHint: tokenHash(rawToken).slice(0, 12),
            issuedAt: resolvedAt,
            expiresAt: resolvedAt + ttl,
          }
        }
      }
      const resolution = {
        id: identity.receiptId,
        projectId: identity.projectId,
        toolCallId: identity.toolCallId,
        actionName: identity.actionName,
        intentHash: identity.intentHash,
        actionBindingHash: identity.actionBindingHash,
        actorId: identity.userId,
        decision,
        resolvedAt,
        ...(manualRetryExhausted && decision === 'confirmed_not_applied' ? { manualRetryExhausted: true } : {}),
        ...(manualRetryAuthorization ? { manualRetryAuthorization } : {}),
        audit: {
          action: 'agent-action.reconciled',
          detail: {
            result: decision,
            status: decision === 'confirmed_applied' ? 'succeeded' : 'failed',
            toolCallId: identity.toolCallId,
            toolName: identity.actionName,
          },
        },
      }
      let outcome
      try {
        outcome = await productStore.resolveAgentActionReceipt(identity.userId, resolution)
      } catch (caught) {
        throw agentActionReconciliationStoreError(caught)
      }
      if (outcome?.kind !== 'resolved' && outcome?.kind !== 'replay') {
        throw reconciliationError(outcome?.kind)
      }
      if (decision === 'confirmed_not_applied' && !manualRetryExhausted) {
        // 两个不同 prepared key 可能同时预读到 unresolved。Adapter 的原子胜者才是
        // 权威预留；败者即使拿到 replay，也绝不能把自己未绑定的 key 回显给客户端。
        const storedAuthorization = outcome.receipt?.manualRetryAuthorization
        const reservationMatches = preparedRetryIdentity
          ? storedAuthorization?.version === 2
            && storedAuthorization.boundRetryReceiptId === preparedRetryIdentity.receiptId
          : storedAuthorization?.version !== 2
        if (!reservationMatches) throw reconciliationError('conflict')
      }
      return {
        status: publicStatus(outcome.receipt, identity, resolvedAt),
        ...(outcome.kind === 'replay' ? { replayed: true } : {}),
        // 只有赢得原子决议的请求能看见原 token；幂等重放永远不重签、不回显。
        ...(outcome.kind === 'resolved' && rawToken ? {
          manualRetryAuthorization: {
            token: rawToken,
            expiresAt: Number(outcome.receipt?.manualRetryAuthorization?.expiresAt),
          },
        } : {}),
        ...(preparedRetryIdempotencyKey && outcome.receipt?.manualRetryAuthorization?.version === 2 ? {
          manualRetryReservation: {
            retryIdempotencyKey: preparedRetryIdempotencyKey,
            expiresAt: Number(outcome.receipt.manualRetryAuthorization.expiresAt),
          },
        } : {}),
      }
    },

    async consumeManualRetryAuthorization(input) {
      const suppliedToken = typeof input?.token === 'string' ? input.token.trim() : ''
      let original
      try {
        original = await readReceipt(input?.action)
      } catch (caught) {
        if (!suppliedToken
          && caught instanceof AgentActionReconciliationError
          && caught.code === 'AGENT_ACTION_RECONCILIATION_NOT_FOUND') {
          throw new AgentActionReconciliationError(
            'AGENT_ACTION_MANUAL_RETRY_REQUIRED',
            '新的行动提交标识必须携带未消费的一次性授权。',
            409,
          )
        }
        throw caught
      }
      const { identity, receipt } = original
      const retryIdentity = retryIdentityFor(input?.action, input?.retryIdempotencyKey)
      const retryReceiptId = retryIdentity.receiptId
      if (retryReceiptId === identity.receiptId) {
        throw new AgentActionReconciliationError(
          'AGENT_ACTION_MANUAL_RETRY_IDEMPOTENCY_REUSED',
          '手动重试必须使用新的提交标识。',
          409,
        )
      }
      const authorization = receipt.manualRetryAuthorization
      const v2Reservation = authorization?.version === 2
      const rawToken = suppliedToken
      if (!v2Reservation && !rawToken) {
        // v1 兼容：raw token 已被消费后不会再持久化到客户端。
        // 同 retry receipt 的传输恢复可直接依赖权威 consumedBy 指针。
        if (authorization?.consumedAt
          && authorization?.consumedByReceiptId === retryReceiptId) {
          return Object.freeze({
            kind: 'authorized',
            receiptId: identity.receiptId,
            intentHash: identity.intentHash,
            actionBindingHash: identity.actionBindingHash,
            retryReceiptId,
            authorizationId: authorization.id,
            consumedAt: authorization.consumedAt,
            replayPolicy: 'manual_once',
            replayed: true,
          })
        }
        throw new AgentActionReconciliationError(
          'AGENT_ACTION_MANUAL_RETRY_REQUIRED',
          '新的行动提交标识必须携带未消费的一次性授权。',
          409,
        )
      }
      const consumedAt = Number(now()) || Date.now()
      let outcome
      try {
        outcome = await productStore.consumeAgentActionManualRetryAuthorization(identity.userId, {
          id: identity.receiptId,
          projectId: identity.projectId,
          actionId: identity.actionId,
          toolCallId: identity.toolCallId,
          actionName: identity.actionName,
          intentHash: identity.intentHash,
          actionBindingHash: identity.actionBindingHash,
          ...(!v2Reservation ? { tokenHash: tokenHash(text(rawToken, '手动重试授权', 512)) } : {}),
          retryReceiptId,
          consumedAt,
          audit: {
            action: 'agent-action.manual-retry-authorized',
            detail: {
              result: 'consumed',
              status: 'authorized',
              toolCallId: identity.toolCallId,
              toolName: identity.actionName,
            },
          },
        })
      } catch (caught) {
        throw agentActionReconciliationStoreError(caught)
      }
      if (outcome?.kind !== 'consumed' && outcome?.kind !== 'replay') throw consumptionError(outcome?.kind)
      return Object.freeze({
        kind: 'authorized',
        receiptId: identity.receiptId,
        intentHash: identity.intentHash,
        actionBindingHash: identity.actionBindingHash,
        retryReceiptId,
        authorizationId: outcome.authorization?.id
          ?? outcome.receipt?.manualRetryAuthorization?.id,
        consumedAt: outcome.authorization?.consumedAt
          ?? outcome.receipt?.manualRetryAuthorization?.consumedAt
          ?? consumedAt,
        replayPolicy: 'manual_once',
        ...(outcome.kind === 'replay' ? { replayed: true } : {}),
      })
    },
  })
}
