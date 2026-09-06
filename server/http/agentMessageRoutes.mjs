// @ts-check

import { validateAgentEntityReferences } from '../agentEntityReferences.mjs'
import { createAgentTargetBinding } from '../agentTargetBinding.mjs'
import { requireProjectPermission } from '../auth/projectAuthorization.mjs'

/** Agent Message 写入边界：客户端字段只能由 durable Turn 权威投影覆盖。 */
export function createAgentMessageRouteHandler(input) {
  const {
    productStore, json, error, readJson, requireUser, methodNotAllowed,
    resolveMedia, recordCollaborationActivity,
  } = input
  return async function handleAgentMessageRoute(request, response, match) {
    if (request.method !== 'PUT') return methodNotAllowed(response, 'Agent 消息资源只接受写入。', 'PUT')
    const user = await requireUser(request)
    const projectId = decodeURIComponent(match[1])
    const sessionId = decodeURIComponent(match[2])
    const messageId = decodeURIComponent(match[3])
    await requireProjectPermission(productStore, user.id, projectId, 'edit')
    // content 允许 64k Unicode 字符；按 UTF-8 计最坏约 256KiB，需为结构字段留余量。
    const body = await readJson(request, 512 * 1024, 'Agent 消息请求过大。')
    if (body?.id !== messageId) return error(response, 400, 'INVALID_AGENT_ENTITY', 'Agent 消息标识不一致。')
    const messagePage = typeof productStore.listAgentSessionMessages === 'function'
      ? await productStore.listAgentSessionMessages(user.id, projectId, sessionId, { limit: 200 })
      : undefined
    const existingMessage = (messagePage?.messages ?? (Array.isArray(messagePage) ? messagePage : []))
      .find((candidate) => candidate.id === messageId)
    if (body.kind === 'question' && !body.runId && typeof body.question?.id === 'string'
      && body.question.id.startsWith('plan-clarification:') && !existingMessage?.plan && !existingMessage?.runId) {
      const planTurnId = body.question.id.slice('plan-clarification:'.length)
      const planTurn = await productStore.readAgentTurn(user.id, planTurnId)
      if (!planTurn || planTurn.projectId !== projectId || planTurn.status !== 'waiting_user'
        || planTurn.result?.runtimeOperation !== 'plan' || planTurn.result.kind !== 'clarification'
        || planTurn.result.clarification?.id !== body.question.id
        || planTurn.result.clarification.originalInstruction !== body.question.originalInstruction) {
        return error(response, 409, 'AGENT_MESSAGE_ANSWER_CONFLICT', '原规划已变化，请重新加载对话。')
      }
    }
    if (existingMessage?.turnId && body.turnId && existingMessage.turnId !== body.turnId) {
      return error(response, 409, 'AGENT_MESSAGE_TURN_CONFLICT', '当前消息已绑定另一 Agent Turn。')
    }
    let linkedTurn
    if (body.turnId && !existingMessage?.turnId) {
      linkedTurn = await productStore.readAgentTurn(user.id, body.turnId)
      if (!linkedTurn || linkedTurn.projectId !== projectId || linkedTurn.sessionId !== sessionId) {
        return error(response, 409, 'AGENT_MESSAGE_TURN_INVALID', '消息关联的 Agent Turn 不属于当前会话。')
      }
    }
    const linkedTurnId = existingMessage?.turnId ?? body.turnId
    const stableTurnProjection = Boolean(
      linkedTurnId && body.role === 'assistant' && messageId === `agent-turn-result-${linkedTurnId}`
    )
    if ((stableTurnProjection || body.kind === 'question') && linkedTurnId && !linkedTurn) {
      linkedTurn = await productStore.readAgentTurn(user.id, linkedTurnId)
      if (!linkedTurn || linkedTurn.projectId !== projectId || linkedTurn.sessionId !== sessionId) {
        return error(response, 409, 'AGENT_MESSAGE_TURN_INVALID', '消息关联的 Agent Turn 不属于当前会话。')
      }
    }
    if (body.kind === 'question' && linkedTurn && !body.runId && !existingMessage?.plan && !existingMessage?.runId) {
      const question = body.question
      const result = linkedTurn.result
      const samePlan = linkedTurn.status === 'waiting_user' && result?.runtimeOperation === 'plan'
        && result.kind === 'clarification' && result.clarification?.id === question?.id
        && result.clarification.originalInstruction === question?.originalInstruction
      const generation = question?.resolvedGeneration
      const sameGeneration = linkedTurn.status === 'completed' && result?.kind === 'generation'
        && generation?.turnId === linkedTurn.id && generation.prompt === result.prompt && generation.mediaKind === result.mediaKind
      const plannerQuestion = typeof question?.id === 'string' && question.id.startsWith('plan-clarification:')
      const valid = plannerQuestion && question.id !== `plan-clarification:${linkedTurn.id}`
        ? linkedTurn.status === 'completed' : samePlan || (!plannerQuestion && sameGeneration)
      if (!valid) return error(response, 409, 'AGENT_MESSAGE_ANSWER_CONFLICT', '原确认已失效，请重新填写。')
    }
    const entityReferences = stableTurnProjection && linkedTurn?.result?.entityReferences !== undefined
      ? validateAgentEntityReferences(linkedTurn.result.entityReferences)
      : undefined
    const sourceMessageId = linkedTurn?.request?.inputMessage?.id
    const provenance = stableTurnProjection && typeof sourceMessageId === 'string' ? {
      sourceMessageId,
      ...(Array.isArray(linkedTurn.request.contextNodeIds) ? { sourceNodeIds: linkedTurn.request.contextNodeIds } : {}),
      ...(typeof linkedTurn.request.targetBinding?.versionId === 'string'
        ? { targetArtifactVersionId: linkedTurn.request.targetBinding.versionId } : {}),
      ...(typeof linkedTurn.result?.planFingerprint === 'string'
        ? { planFingerprint: linkedTurn.result.planFingerprint } : {}),
    } : undefined
    const {
      entityReferences: _clientEntityReferences, sourceMessageId: _clientSourceMessageId,
      sourceNodeIds: _clientSourceNodeIds, targetArtifactVersionId: _clientTargetArtifactVersionId,
      planFingerprint: _clientPlanFingerprint, turnRequestSnapshot: rawTurnRequestSnapshot,
      ...clientBody
    } = body
    let turnRequestSnapshot
    if (rawTurnRequestSnapshot && typeof rawTurnRequestSnapshot === 'object' && !Array.isArray(rawTurnRequestSnapshot)) {
      const { targetBinding: _clientTargetBinding, ...clientSnapshot } = rawTurnRequestSnapshot
      let targetBinding = existingMessage?.turnRequestSnapshot?.targetBinding
      if (clientSnapshot.hasTarget && !targetBinding) {
        const project = await productStore.readProject(user.id, projectId)
        targetBinding = await createAgentTargetBinding(project?.document, clientSnapshot, {
          resolveMedia: resolveMedia(user.id, projectId),
        })
      }
      turnRequestSnapshot = {
        ...clientSnapshot,
        ...(clientSnapshot.hasTarget && targetBinding ? { targetBinding } : {}),
      }
    }
    const messageInput = {
      ...clientBody,
      ...(existingMessage?.createdAt === undefined ? {} : { createdAt: existingMessage.createdAt }),
      ...(existingMessage?.turnId && body.turnId === undefined ? { turnId: existingMessage.turnId } : {}),
      ...(existingMessage?.turnCancellationRequestedAt !== undefined && body.turnCancellationRequestedAt === undefined
        ? { turnCancellationRequestedAt: existingMessage.turnCancellationRequestedAt } : {}),
      ...(entityReferences === undefined ? {} : { entityReferences }),
      ...provenance,
      ...(turnRequestSnapshot === undefined ? {} : { turnRequestSnapshot }),
    }
    const message = await productStore.putAgentMessage(user.id, projectId, sessionId, messageInput)
    let sessionTitle = '新建对话'
    try {
      const state = await productStore.readAgentState(user.id, projectId, { includeMessages: false })
      sessionTitle = state?.sessions?.find((candidate) => candidate.id === sessionId)?.title || sessionTitle
    } catch { /* 标题只用于协作历史，不得阻断权威写入。 */ }
    await recordCollaborationActivity(user, projectId, {
      id: `agent-message-${message.id}`,
      kind: 'conversation',
      summary: `更新了对话「${sessionTitle}」`,
      target: { kind: 'message', sessionId, messageId: message.id },
    })
    return json(response, 200, { message })
  }
}
