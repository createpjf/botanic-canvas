// @ts-check
import {
  agentTurnIdForIdempotency,
  createAgentTurnRecord,
} from './botanicAgentTurnRuntime.mjs'
import {
  agentTurnRequestHash,
  agentTurnRequestHashVersion,
  storedAgentTurnRequestBinding,
} from './agentTurnRequestIdentity.mjs'
import { validateBotanicAgentTurnInput } from './botanicAgentTurn.mjs'
import { resolveBotanicAgentRuntimeRequest } from './agentRuntimeRequest.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'
import { projectPermissionDecision } from './authorization.mjs'
import { createAgentOperationalReaders } from './agentOperationalReaders.mjs'
import { assertAgentTargetBinding, createAgentTargetBinding } from './agentTargetBinding.mjs'

export function configuredAgentGenerationModels(config) {
  return (config?.modelOptions ?? []).map((model) => ({
    id: model.id,
    label: model.label,
    mediaKind: model.mediaKind,
    aspectRatios: [...(model.aspectRatios ?? [])],
    resolutions: [...(model.resolutions ?? [])],
    ...(model.durations?.length ? { durations: [...model.durations] } : {}),
    ...(Number.isFinite(Number(model.defaultDuration)) ? { defaultDuration: Number(model.defaultDuration) } : {}),
  }))
}

function plannerSkillInput(skill) {
  return {
    id: skill.id,
    name: skill.name,
    instructions: skill.instructions,
    status: skill.status,
    ...(Number.isInteger(skill.version) ? { version: skill.version } : {}),
    ...(typeof skill.contentHash === 'string' ? { contentHash: skill.contentHash } : {}),
    ...(Array.isArray(skill.capabilities) ? { capabilities: skill.capabilities } : {}),
    ...(typeof skill.lifecycle === 'string' ? { lifecycle: skill.lifecycle } : {}),
    ...(skill.manifest ? { manifest: structuredClone(skill.manifest) } : {}),
    ...(Array.isArray(skill.versions) ? { versions: structuredClone(skill.versions) } : {}),
  }
}

function recoverableStoredRequest(stored, identity) {
  if (!stored
    || stored.id !== identity.id
    || stored.ownerId !== identity.ownerId
    || stored.projectId !== identity.projectId
    || stored.sessionId !== identity.sessionId
    || stored.idempotencyKey !== identity.idempotencyKey
    || agentTurnRequestHashVersion(stored) !== 2
    || !stored.request
    || typeof stored.request !== 'object'
    || Array.isArray(stored.request)) return undefined
  const binding = storedAgentTurnRequestBinding(stored)
  if (!binding
    || binding.requestHashVersion !== 2
    || typeof stored.requestHash !== 'string'
    || stored.requestHash !== binding.requestHash) return undefined
  const request = stored.request
  if (request.projectId !== identity.projectId
    || request.sessionId !== identity.sessionId
    || !request.inputMessage
    || typeof request.inputMessage !== 'object'
    || Array.isArray(request.inputMessage)
    || request.inputMessage.id !== identity.inputMessageId) return undefined
  return structuredClone(request)
}

function canonicalInputFromMessage(validatedInput, message, messages) {
  const snapshot = message?.turnRequestSnapshot
  if (!snapshot || !validatedInput.sessionId) return { ...validatedInput, messages }
  const { selectedResultNodeId, targetBinding, ...stableFields } = snapshot
  const canonical = validateBotanicAgentTurnInput({
    projectId: validatedInput.projectId,
    sessionId: validatedInput.sessionId,
    inputMessage: {
      id: message.id,
      content: message.content,
      ...(message.mentions?.length ? { mentions: structuredClone(message.mentions) } : {}),
    },
    ...structuredClone(stableFields),
    ...(stableFields.hasTarget ? { selectedResultNodeId } : {}),
    messages,
  })
  return targetBinding ? { ...canonical, targetBinding: structuredClone(targetBinding) } : canonical
}

function matchingRequest(stored, candidate) {
  if (!stored || !candidate
    || stored.id !== candidate.id
    || stored.ownerId !== candidate.ownerId
    || stored.projectId !== candidate.projectId
    || stored.idempotencyKey !== candidate.idempotencyKey) return false
  if (typeof stored.requestHash === 'string' && stored.requestHash.trim()) {
    return Boolean(agentTurnRequestHashVersion(stored)) && stored.requestHash === candidate.requestHash
  }
  const storedBinding = storedAgentTurnRequestBinding(stored)
  const candidateBinding = storedAgentTurnRequestBinding(candidate)
  return Boolean(storedBinding && candidateBinding
    && candidateBinding.requestHash === candidate.requestHash
    && agentTurnRequestHash(candidate.request, storedBinding.requestHashVersion) === storedBinding.requestHash)
}

function intentConflict() {
  return Object.assign(new Error('同一回合提交标识已绑定到不同请求。'), {
    code: 'AGENT_TURN_INTENT_CONFLICT',
    statusCode: 409,
  })
}

/** HTTP observer 的本地等待上限（H3B）：不接 HTTP disconnect signal，也不传给 Runtime execution。 */
const DURABLE_TURN_WAIT_LIMIT_MS = 5_000
const DURABLE_TURN_POLL_BACKOFF_MS = [5, 25, 100]

export async function awaitDurableTurn(productStore, userId, candidate, execution, { waitLimitMs = DURABLE_TURN_WAIT_LIMIT_MS, setTimeoutImpl = setTimeout } = {}) {
  let polling = true
  // 独立本地 waitSignal：observer 等待有界，但 Runtime execution 不受它影响。
  const waitSignal = AbortSignal.timeout(waitLimitMs)
  const executionOutcome = execution.then(
    (value) => ({ kind: 'resolved', value }),
    (caught) => ({ kind: 'rejected', caught }),
  )
  const durableObservation = (async () => {
    let attempt = 0
    while (polling && !waitSignal.aborted) {
      const stored = await productStore.readAgentTurn(userId, candidate.id)
      if (stored) return matchingRequest(stored, candidate)
        ? { kind: 'durable', turn: stored }
        : { kind: 'conflict' }
      if (waitSignal.aborted) break
      // 5ms → 25ms → 100ms 退避,最大保持 100ms;不再无限 5ms 空转。
      const delay = DURABLE_TURN_POLL_BACKOFF_MS[Math.min(attempt, DURABLE_TURN_POLL_BACKOFF_MS.length - 1)]
      attempt += 1
      await new Promise((resolve) => setTimeoutImpl(resolve, delay))
    }
    return { kind: 'stopped' }
  })()
  const ready = await Promise.race([durableObservation, executionOutcome])
  polling = false
  if (ready.kind === 'durable') return ready.turn
  if (ready.kind === 'conflict') throw intentConflict()
  if (ready.kind === 'resolved') {
    const stored = await productStore.readAgentTurn(userId, candidate.id)
    if (matchingRequest(stored, candidate)) return stored
    throw intentConflict()
  }
  if (ready.kind === 'rejected') {
    // Resolver 可能在 claim 后立刻失败；相同绑定已 durable 时仍可安全交付 observer。
    const stored = await productStore.readAgentTurn(userId, candidate.id)
    if (matchingRequest(stored, candidate)) return stored
    throw ready.caught
  }
  throw Object.assign(new Error('Agent Turn 尚未持久化。'), {
    code: 'AGENT_TURN_DURABILITY_UNAVAILABLE', statusCode: 503,
  })
}

/**
 * 唯一 Turn 提交 seam：启动 Runtime、验证 durable request binding，再建立可选 Message link。
 * HTTP Adapter 只决定响应形状；兼容入口与正式入口共用这一实现。
 */
export function createAgentTurnSubmission({
  productStore,
  runtime,
  config,
  resolveThreadContext,
  resolveLegacyThreadSummary,
  resolveVisionMedia,
  durableSubagentRunner,
  observeAgentContext,
  enrichAgentContextCheckpoint,
  persistUsageAnchor,
  consumeWebResearchQuota,
}) {
  if (!productStore || typeof runtime?.execute !== 'function') {
    throw new TypeError('Agent Turn 提交模块缺少 Store 或 Runtime。')
  }
  const submit = (command) => {
      const turnId = agentTurnIdForIdempotency(
        command.userId,
        command.projectId,
        command.idempotencyKey,
      )
      const execution = runtime.execute({
        userId: command.userId,
        projectId: command.projectId,
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        requestId: command.requestId,
        id: turnId,
        idempotencyKey: command.idempotencyKey,
        request: command.request,
        resolve: command.resolve,
        resolveOptions: command.resolveOptions,
        onEvent: command.onEvent,
      })
      // HTTP 观察者可能在 accepted 前断开；Runtime rejection 仍必须被消费。
      void execution.catch(() => undefined)
      const candidate = createAgentTurnRecord({
        id: turnId,
        ownerId: command.userId,
        projectId: command.projectId,
        sessionId: command.sessionId,
        requestId: command.requestId,
        idempotencyKey: command.idempotencyKey,
        request: command.request,
      })
      const accepted = awaitDurableTurn(productStore, command.userId, candidate, execution)
        .then(async (turn) => {
          await command.linkMessage?.(turnId)
          return turn
        })
      return { turnId, execution, accepted }
  }

  return {
    submit,
    async submitCanonical(command) {
      const { userId, validatedInput } = command
      const access = await requireProjectPermission(productStore, userId, validatedInput.projectId, 'read')
      const [project, projectSkills] = await Promise.all([
        productStore.readProject(userId, validatedInput.projectId),
        productStore.listAgentSkills(userId, validatedInput.projectId).then((value) => value ?? []),
      ])
      if (!project?.document) {
        throw Object.assign(new Error('未找到项目或你没有访问权限。'), {
          code: 'PROJECT_NOT_FOUND', statusCode: 404,
        })
      }
      let canonicalInput = validatedInput
      let recoveredStoredRequest = false
      let threadSummary
      let authoritativeInputMessage
      if (validatedInput.sessionId && validatedInput.inputMessage) {
        const threadContext = await resolveThreadContext({
          userId,
          projectId: validatedInput.projectId,
          sessionId: validatedInput.sessionId,
          locale: validatedInput.locale,
          model: validatedInput.plannerModel || config?.flockTextModel,
          inputMessage: { ...validatedInput.inputMessage, role: 'user' },
        })
        canonicalInput = canonicalInputFromMessage(
          validatedInput,
          threadContext.inputMessage,
          threadContext.messages,
        )
        canonicalInput = {
          ...canonicalInput,
          threadContextSnapshot: structuredClone(threadContext.threadContextSnapshot),
        }
        threadSummary = threadContext.threadSummary
        authoritativeInputMessage = threadContext.inputMessage
      } else {
        threadSummary = await resolveLegacyThreadSummary?.(
          userId,
          validatedInput.projectId,
          command.legacySessionId,
        )
        canonicalInput = {
          ...canonicalInput,
          threadContextSnapshot: {
            version: 1,
            messages: structuredClone(canonicalInput.messages ?? []),
            ...(threadSummary ? { threadSummary: structuredClone(threadSummary) } : {}),
          },
        }
      }
      const turnId = agentTurnIdForIdempotency(userId, validatedInput.projectId, command.idempotencyKey)
      if (validatedInput.sessionId && authoritativeInputMessage) {
        if (authoritativeInputMessage.turnId && authoritativeInputMessage.turnId !== turnId) {
          throw Object.assign(new Error('当前消息已绑定另一 Agent Turn，不能重新执行。'), {
            code: 'AGENT_MESSAGE_TURN_CONFLICT', statusCode: 409,
          })
        }
        const existingTurn = await productStore.readAgentTurn(userId, turnId)
        if (authoritativeInputMessage.turnId && !existingTurn) {
          throw Object.assign(new Error('当前消息关联的 Agent Turn 不存在，不能安全重建。'), {
            code: 'AGENT_MESSAGE_TURN_ORPHANED', statusCode: 409,
          })
        }
        if (existingTurn) {
          const storedRequest = recoverableStoredRequest(existingTurn, {
            id: turnId,
            ownerId: userId,
            projectId: validatedInput.projectId,
            sessionId: validatedInput.sessionId,
            inputMessageId: authoritativeInputMessage.id,
            idempotencyKey: command.idempotencyKey,
          })
          if (!storedRequest) throw intentConflict()
          canonicalInput = storedRequest
          recoveredStoredRequest = true
        }
      }
      if (!recoveredStoredRequest) {
        canonicalInput = { ...canonicalInput, generationModels: configuredAgentGenerationModels(config) }
      }
      const mediaResolver = resolveVisionMedia?.(userId, validatedInput.projectId)
      if (canonicalInput.hasTarget && !canonicalInput.targetBinding) {
        if (recoveredStoredRequest) {
          throw Object.assign(new Error('原 Agent 回合没有可验证的目标版本，请重新选择图片。'), {
            code: 'AGENT_TARGET_BINDING_MISSING', statusCode: 409,
          })
        }
        canonicalInput = {
          ...canonicalInput,
          targetBinding: await createAgentTargetBinding(project.document, canonicalInput, {
            resolveMedia: mediaResolver,
            projectRevision: project.revision,
          }),
        }
      }
      await assertAgentTargetBinding(project.document, canonicalInput, {
        resolveMedia: mediaResolver,
        projectRevision: project.revision,
      })
      const sessionId = validatedInput.sessionId ?? command.legacySessionId
      const input = {
        ...canonicalInput,
        projectSkills: projectSkills.map(plannerSkillInput),
      }
      return submit({
        userId,
        projectId: validatedInput.projectId,
        ...(sessionId ? { sessionId } : {}),
        requestId: command.requestId,
        idempotencyKey: command.idempotencyKey,
        request: canonicalInput,
        resolve: (options) => resolveBotanicAgentRuntimeRequest(input, config, options),
        resolveOptions: {
          subagentRunner: durableSubagentRunner,
          observeAgentContext,
          ...(typeof enrichAgentContextCheckpoint === 'function'
            ? { enrichAgentContextCheckpoint }
            : {}),
          role: access.role,
          requireTargetVision: true,
          allowWebResearch: projectPermissionDecision(access.role, 'execute-external-tool') === 'allow',
          document: project.document,
          projectSkills,
          ...(sessionId ? {
            persistAgentContextUsageAnchor: persistUsageAnchor?.({
              userId, projectId: validatedInput.projectId, sessionId,
            }),
          } : {}),
          ...(threadSummary ? { threadSummary } : {}),
          operations: createAgentOperationalReaders({
            productStore,
            userId,
            projectId: validatedInput.projectId,
            document: project.document,
          }),
          resolveVisionMedia: mediaResolver,
          consumeWebResearchQuota: async () => {
            await requireProjectPermission(
              productStore,
              userId,
              validatedInput.projectId,
              'execute-external-tool',
            )
            return consumeWebResearchQuota?.(
              userId,
              validatedInput.projectId,
              'execute-external-tool',
            )
          },
        },
        onEvent: command.onEvent,
        ...(validatedInput.sessionId && authoritativeInputMessage && !authoritativeInputMessage.turnId ? {
          linkMessage: async (durableTurnId) => {
            const linkedAt = Date.now()
            await productStore.putAgentMessage(userId, validatedInput.projectId, validatedInput.sessionId, {
              ...authoritativeInputMessage,
              role: 'user',
              kind: 'text',
              createdAt: Number(authoritativeInputMessage.createdAt) || linkedAt,
              updatedAt: Math.max(Number(authoritativeInputMessage.updatedAt) || 0, linkedAt),
              turnId: durableTurnId,
            })
          },
        } : {}),
      })
    },
  }
}
