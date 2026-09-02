import { AgentToolRuntimeError, executeConfirmedAgentAction } from '../agent/tools/agentToolRuntime.mjs'
import {
  botanicAgentBuiltInSkill,
  botanicAgentSkillToolRisk,
  botanicAgentSystemSkills,
  createBotanicAgentActionToolRegistry,
} from '../agent/tools/botanicAgentTools.mjs'
import { createAgentSkill, isUsableAgentSkill, publicAgentSkill, validateAgentSkillCreation } from '../agent/action/botanicAgentSkill.mjs'
import { createCanvasAgentEditExecutors } from '../canvas/canvasAgentEditing.mjs'
import { generationIdempotencyKey, generationJobIdForIdempotency } from '../generation/generationIdempotency.mjs'
import { agentToolPermission, assertFreshActionApproval, createActionApprovalToken } from '../agent/action/agentActionGovernance.mjs'
import {
  agentActionReconciliationIdentity,
  agentActionReconciliationStoreError,
} from '../agent/action/agentActionReconciliation.mjs'
import { requireProjectPermission } from '../auth/projectAuthorization.mjs'

// 需要短期审批 Token 的行动：会花钱或触达外部系统的那些。运维写工具里
// 重试分支与重试工作流失败项都会真的调用 Provider，因此同样进这个集合。
const approvalRequired = new Set([
  'generation_submit', 'mcp_call', 'agent_branch_retry', 'review_retry', 'workflow_run_retry_failed',
])
// 这些动作有稳定自有身份且重放无新增副作用；其余（MCP、创建 Skill、
// 发布 Workflow、提交/重试计费任务）出现未知结果时一律停下，不自动再执行。
const safelyReplayableAgentActions = new Set([
  'workflow_create', 'skill_apply', 'agent_run_cancel', 'artifact_promote',
  'review_decide', 'review_retry', 'workflow_run_retry_failed',
])
// 这三条路径在存量客户端中本来就不属于 Message Proposal：
// Run 确认的工作流/生成提交，以及 Skill Registry 直接创建。
// 其他 HTTP Action 即使省略 context，也必须反查到唯一权威 Proposal。
const standaloneAgentActions = new Set(['workflow_create', 'generation_submit', 'skill_create'])

/**
 * Agent 行动资源(/api/agent-actions*、审批)的唯一 HTTP handler。
 * 从 agentRoutes 组合根拆出:回执 claim/重试/审批语义不变,闭包服务经依赖注入。
 * 返回 false 表示路径不属于本资源。
 */
export function createAgentActionRouteHandler({
  config,
  productStore,
  json,
  error,
  readJson,
  text,
  requireUser,
  enforceRateLimit,
  methodNotAllowed,
  mediaService,
  agentRunGeneration,
  publishProjectUpdated,
  observeAgentRun,
  isAuthorizedAgentMediaUrl,
  actionHasContext,
  requireActionProposal,
  authoritativeActionAttempt,
  commitAgentReviewAction,
  cancellationService,
  durableAgentActionExecution,
  durableAgentActionReconciliation,
  agentActionTimeoutMs,
  recordCollaborationActivity,
  configuredMcpTools,
  publishAgentRunUpdated,
}) {
  return async function handleAgentActionRoute(request, response, url, requestId) {
    if (url.pathname === '/api/agent-actions/status' || url.pathname === '/api/agent-actions/resolve') {
      const resolving = url.pathname.endsWith('/resolve')
      if (request.method !== 'POST') {
        return methodNotAllowed(response, resolving ? 'Agent 行动调和资源只接受提交请求。' : 'Agent 行动状态资源只接受查询请求。', 'POST')
      }
      const user = await requireUser(request)
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Agent 行动回执标识无效，请重试。')
      const body = await readJson(request, 16 * 1024, resolving ? 'Agent 行动调和请求过大。' : 'Agent 行动状态请求过大。')
      const projectId = text(body?.projectId, '项目', 160)
      const actionName = text(body?.name, '工具名称', 80)
      const toolCallId = text(body?.toolCallId, '工具调用标识', 160)
      await requireProjectPermission(productStore, user.id, projectId, agentToolPermission(actionName))
      const proposalContext = await requireActionProposal({
        user, projectId, actionName, toolCallId, argumentsValue: body?.arguments,
        body, requireExactContext: true,
      })
      const attempt = authoritativeActionAttempt({ user, projectId, proposalContext, idempotencyKey })
      const retryOptions = attempt.manualRetry ? { manualRetryOf: attempt.originalAction } : undefined
      const reconciliation = durableAgentActionReconciliation()
      if (resolving) {
        const resolution = await reconciliation.resolve({
          action: attempt.action,
          decision: body?.decision,
          ...(body?.preparedRetryIdempotencyKey !== undefined
            ? { preparedRetryIdempotencyKey: body.preparedRetryIdempotencyKey }
            : {}),
          ...(retryOptions ?? {}),
        })
        return json(response, 200, resolution)
      }
      const status = await reconciliation.readStatus(attempt.action, retryOptions)
      let execution
      if (status.status === 'succeeded') {
        const identity = agentActionReconciliationIdentity(attempt.action)
        let receipt
        try {
          receipt = await productStore.readAgentActionReceipt(user.id, identity.receiptId)
        } catch (caught) {
          throw agentActionReconciliationStoreError(caught)
        }
        const identityMatches = receipt?.id === identity.receiptId
          && receipt?.ownerId === identity.userId
          && receipt?.projectId === identity.projectId
          && receipt?.toolCallId === identity.toolCallId
          && receipt?.actionName === identity.actionName
          && receipt?.intentHash === identity.intentHash
          && receipt?.actionBindingHash === identity.actionBindingHash
        // 只回读已持久化的成功结果；人工 confirmed_applied 没有 result，因而不会伪造 execution。
        if (identityMatches && receipt.status === 'succeeded' && receipt.result !== undefined) {
          execution = structuredClone(receipt.result)
        }
      }
      return json(response, 200, { status, ...(execution !== undefined ? { execution } : {}) })
    }

    if (url.pathname === '/api/agent-action-approvals') {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 行动审批资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Agent 行动审批标识无效，请重试。')
      const body = await readJson(request, 16 * 1024, 'Agent 行动审批请求过大。')
      const projectId = text(body?.projectId, '项目', 160)
      const actionName = text(body?.name, '工具名称', 80)
      const toolCallId = text(body?.toolCallId, '工具调用标识', 160)
      if (!approvalRequired.has(actionName)) return error(response, 400, 'ACTION_APPROVAL_NOT_REQUIRED', '该行动不需要审批凭据。')
      await requireProjectPermission(productStore, user.id, projectId, agentToolPermission(actionName))
      await requireActionProposal({ user, projectId, actionName, toolCallId, argumentsValue: body?.arguments, body })
      if (!config.agentActionApprovalSecret) return error(response, 503, 'ACTION_APPROVAL_UNAVAILABLE', '当前行动审批服务尚未配置，请稍后重试。')
      return json(response, 200, {
        approval: createActionApprovalToken({
          secret: config.agentActionApprovalSecret,
          userId: user.id,
          projectId,
          actionName,
          toolCallId,
          argumentsValue: body?.arguments,
          idempotencyKey,
        }),
      })
    }

    if (url.pathname === '/api/agent-actions') {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 行动资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Agent 行动提交标识无效，请重试。')
      const body = await readJson(request, 16 * 1024, 'Agent 行动请求过大。')
      const projectId = text(body?.projectId, '项目', 160)
      const actionName = text(body?.name, '工具名称', 80)
      const toolCallId = text(body?.toolCallId, '工具调用标识', 160)
      await requireProjectPermission(productStore, user.id, projectId, agentToolPermission(actionName))
      const contextual = actionHasContext(body)
      const proposalContext = contextual
        ? await requireActionProposal({
            user, projectId, actionName, toolCallId, argumentsValue: body?.arguments,
            body, requireExactContext: true,
          })
        : standaloneAgentActions.has(actionName)
          ? undefined
          : await requireActionProposal({
              user, projectId, actionName, toolCallId, argumentsValue: body?.arguments, body,
            })
      const attempt = proposalContext
        ? authoritativeActionAttempt({ user, projectId, proposalContext, idempotencyKey })
        : undefined
      const attemptIdentity = attempt ? agentActionReconciliationIdentity(attempt.action) : undefined
      const executionArguments = proposalContext?.proposal?.arguments ?? body?.arguments
      let manualRetryToken = ''
      if (attempt?.manualRetry) {
        manualRetryToken = typeof body?.manualRetryAuthorization?.token === 'string'
          ? body.manualRetryAuthorization.token.trim()
          : ''
      } else if (attempt && body?.manualRetryAuthorization !== undefined) {
        throw new AgentToolRuntimeError(
          'AGENT_ACTION_MANUAL_RETRY_IDEMPOTENCY_REUSED',
          '手动重试必须使用新的行动提交标识。',
          409,
        )
      }
      if (approvalRequired.has(actionName)) {
        assertFreshActionApproval(body, {
          secret: config.agentActionApprovalSecret,
          userId: user.id,
          projectId,
          actionName,
          toolCallId,
          argumentsValue: executionArguments,
          idempotencyKey,
        })
      }
      const receiptId = attemptIdentity?.receiptId
        ?? `agent_action_${generationJobIdForIdempotency(user.id, `${projectId}:${idempotencyKey}`).slice(4)}`
      if (attempt?.manualRetry) {
        const authorization = await durableAgentActionReconciliation().consumeManualRetryAuthorization({
          action: attempt.originalAction,
          ...(manualRetryToken ? { token: manualRetryToken } : {}),
          retryIdempotencyKey: idempotencyKey,
        })
        if (authorization.retryReceiptId !== receiptId) {
          throw new AgentToolRuntimeError(
            'AGENT_ACTION_MANUAL_RETRY_SCOPE_MISMATCH',
            '手动重试授权与当前回执不匹配。',
            409,
          )
        }
      } else if (attempt && !attempt.manualRetry) {
        const originalIdentity = agentActionReconciliationIdentity(attempt.originalAction)
        let originalReceipt
        try {
          originalReceipt = await productStore.readAgentActionReceipt(user.id, originalIdentity.receiptId)
        } catch (caught) {
          throw agentActionReconciliationStoreError(caught)
        }
        if (originalReceipt?.resolution || originalReceipt?.status === 'uncertain') {
          throw new AgentToolRuntimeError(
            'AGENT_ACTION_RECONCILIATION_REQUIRED',
            '该行动已进入人工调和或结果未知状态，不能直接重放。',
            409,
          )
        }
      }
      const execute = async ({ signal, intentHash }) => {
        const registry = createBotanicAgentActionToolRegistry({
          // MCP 内联图片落成项目同源媒体，Artifact Index 与历史追溯才收得进。
          persistMcpMedia: (dataUrl) => mediaService.persistDataUrl({ ownerId: user.id, projectId, dataUrl }),
          ...createCanvasAgentEditExecutors({ productStore, publishProjectUpdated, models: config?.modelOptions ?? [], userId: user.id, projectId, mutationId: receiptId }),
          createWorkflow: async ({ planId }) => {
            const { project, prepared } = await agentRunGeneration.prepareProjectExecution(user.id, projectId, planId, { submission: false })
            const persistence = await agentRunGeneration.persistWorkflow(user.id, project, prepared)
            return {
              message: `已创建 ${prepared.workflows.length} 条画布工作流。`,
              canvasNodeIds: prepared.workflows.flatMap((workflow) => [workflow.promptNodeId, workflow.generateNodeId, workflow.resultNodeId]),
              canvasPatch: {
                nodes: prepared.workflows.flatMap((workflow) => [workflow.promptNode, workflow.generateNode, workflow.resultNode]),
                edges: prepared.workflows.flatMap((workflow) => workflow.edges),
                updatedAt: persistence.saved.document.updatedAt,
                baseRevision: persistence.baseRevision, revision: persistence.revision,
                baseGraphRevision: persistence.baseGraphRevision, graphRevision: persistence.graphRevision,
              },
            }
          },
          submitGeneration: async ({ planId }) => {
            const execution = await agentRunGeneration.submitGeneration(user.id, projectId, planId)
            return {
              message: `已提交 ${execution.jobs.length} 个 Agent 生成分支。`,
              run: publicAgentRun(execution.run),
              jobIds: execution.jobs.map((job) => job.id),
              canvasNodeIds: execution.workflows.flatMap((workflow) => [workflow.promptNodeId, workflow.generateNodeId, workflow.resultNodeId]),
            }
          },
          applySkill: async ({ skillId }) => {
            const builtIn = botanicAgentBuiltInSkill(skillId)
            if (builtIn) return { skill: builtIn }
            const skills = await productStore.listAgentSkills(user.id, projectId) ?? []
            const skill = skills.find((candidate) => candidate.id === skillId && isUsableAgentSkill(candidate))
            if (!skill) throw new AgentToolRuntimeError('SKILL_NOT_ALLOWED', 'Skill 不在当前项目的允许列表。', 403)
            return { skill: {
              id: skill.id,
              name: skill.name,
              instructions: skill.instructions,
              version: skill.version,
              contentHash: skill.contentHash,
              capabilities: skill.capabilities,
            } }
          },
          role: (await productStore.projectAccess(user.id, projectId))?.role,
          retryBranch: async ({ runId, branchId }) => {
            // 与 HTTP 路由共用同一实现与同一幂等键，因此工具重复触发不会重复扣费。
            const outcome = await retryAgentBranch({
              userId: user.id, runId, branchId, idempotencyKey, requestId, actor: user,
            })
            if (outcome.kind === 'error') {
              throw new AgentToolRuntimeError(outcome.code, outcome.message, outcome.status)
            }
            return { runId, branchId, jobId: outcome.job.id, reused: outcome.kind === 'reused', status: outcome.run?.status }
          },
          cancelRun: async ({ runId }) => {
            const run = await productStore.readAgentRun(user.id, runId)
            if (!run || run.projectId !== projectId) throw new AgentToolRuntimeError('AGENT_RUN_NOT_FOUND', '未找到当前项目的 Agent Run。', 404)
            const cancellation = await cancellationService().cancelAgentRun({
              userId: user.id, projectId, runId, requestedBy: user.id,
            })
            const cancelledRun = await productStore.readAgentRun(user.id, runId) ?? run
            try {
              await publishAgentRunUpdated?.({ projectId, run: publicAgentRun(cancelledRun) })
            } catch { /* durable 取消已完成，实时旁路失败不能反向伪造行动失败。 */ }
            return {
              runId,
              status: cancelledRun.status,
              cancelledJobCount: cancellation.cancelledJobCount,
              failures: cancellation.failures,
            }
          },
          decideReview: async ({ taskId, artifactId, decision, note }) => {
            const committed = await commitAgentReviewAction({
              actorId: user.id, expectedProjectId: projectId, taskId, idempotencyKey,
              entries: [{ artifactId, decision, note }],
            })
            const storedDecision = committed.decisions[0]
            return {
              taskId: committed.task.id,
              artifactId,
              decision: storedDecision.decision,
              candidateStatus: storedDecision.candidateStatus,
            }
          },
          retryReview: async ({ taskId, artifactId, note }) => {
            const committed = await commitAgentReviewAction({
              actorId: user.id, expectedProjectId: projectId, taskId, idempotencyKey,
              entries: [{ artifactId, decision: 'retry_requested', note }],
            })
            const run = committed.retryRuns[0]
            if (!run) throw new AgentToolRuntimeError('AGENT_REVIEW_RETRY_COMMIT_INVALID', '评审重试没有返回权威 Run。', 409)
            try {
              await publishAgentRunUpdated?.({ projectId: run.projectId, run: publicAgentRun(run) })
            } catch { /* queued Run 已原子落库，实时广播失败不能伪造提交失败。 */ }
            return {
              taskId: committed.task.id,
              artifactId,
              decision: 'retry_requested',
              candidateStatus: committed.decisions[0].candidateStatus,
              runId: run.id,
              status: run.status,
            }
          },
          promoteArtifact: async ({ artifactId, name }) => {
            const artifacts = await productStore.listAgentArtifacts(user.id, projectId, { limit: 200 }) ?? []
            const artifact = artifacts.find((item) => item.id === artifactId)
            if (!artifact?.url) throw new AgentToolRuntimeError('AGENT_ARTIFACT_NOT_FOUND', '未找到该结果，或它没有可入库的媒体。', 404)
            // 历史 Artifact 允许保留外链用于只读追溯，但入库会把 URL 变成项目可用媒体，
            // 因此这里只接受已经过本项目媒体授权边界的同源资源。
            if (!isAuthorizedAgentMediaUrl(artifact.url)) {
              throw new AgentToolRuntimeError('AGENT_ARTIFACT_MEDIA_NOT_AUTHORIZED', '该结果不是已授权的项目媒体，不能入库。', 403)
            }
            const project = await productStore.readProject(user.id, projectId)
            if (!project) throw new AgentToolRuntimeError('PROJECT_NOT_FOUND', '未找到当前项目。', 404)
            const assetId = `asset-${generationJobIdForIdempotency(user.id, `${projectId}:${artifactId}`).slice(4, 28)}`
            const assets = project.document.assets ?? []
            // 已入库就直接返回：重复确认不该产生第二份素材。
            if (assets.some((asset) => asset.id === assetId)) return { artifactId, assetId, reused: true }
            const document = {
              ...project.document,
              assets: [...assets, {
                id: assetId,
                name: name || artifact.label || '入库结果',
                image: artifact.url,
                role: '参考',
                source: 'generated',
                mediaKind: artifact.kind === 'video' ? 'video' : 'image',
                tags: ['Agent'],
              }],
            }
            const saved = await productStore.writeProject(user.id, document, project.revision, project.graphRevision)
            await publishProjectUpdated(saved, user.id)
            return { artifactId, assetId, reused: false }
          },
          publishWorkflow: async ({ name, sourceCanvasNodeId }) => {
            const project = await productStore.readProject(user.id, projectId)
            if (!project) throw new AgentToolRuntimeError('PROJECT_NOT_FOUND', '未找到当前项目。', 404)
            const node = (project.document.nodes ?? []).find((entry) => entry?.id === sourceCanvasNodeId)
            if (!node || node.type !== 'generate') {
              throw new AgentToolRuntimeError('WORKFLOW_SOURCE_NOT_GENERATE_NODE', '来源必须是画布上的生成节点。', 409)
            }
            const data = node.data ?? {}
            // 来源结果由服务端从权威画布解析：不猜「第一条可用节点」（Epic 3B）。
            const resultNodeIds = (project.document.nodes ?? [])
              .filter((entry) => entry?.type === 'result' && entry?.data?.outputOf === node.id && entry?.data?.jobId && entry?.data?.candidateId)
              .map((entry) => entry.id)
            const outcome = await publishProductionWorkflow({
              userId: user.id,
              projectId,
              id: `production-${sourceCanvasNodeId}`,
              name,
              definition: {
                prompt: data.generationRecipe?.prompt ?? data.prompt,
                model: data.settings?.model,
                settings: { ...(data.settings ?? {}), batchCount: data.batchCount ?? 1 },
                output: {
                  aspectRatio: data.settings?.aspectRatio,
                  resolution: data.settings?.resolution,
                  ...(data.settings?.duration ? { duration: data.settings.duration } : {}),
                  candidates: data.batchCount ?? 1,
                },
                assetGroupIds: [],
                confirmationPolicy: 'before-submit',
                ...(data.generationRecipe ? { recipe: data.generationRecipe } : {}),
              },
              source: {
                canvasNodeId: sourceCanvasNodeId,
                ...(data.agentRun?.runId ? { runId: data.agentRun.runId } : {}),
                ...(data.agentRun?.branchId ? { branchId: data.agentRun.branchId } : {}),
                resultNodeIds,
              },
            })
            if (outcome.kind === 'error') throw new AgentToolRuntimeError(outcome.code, outcome.message, outcome.status)
            return {
              workflowId: outcome.workflow.id,
              version: outcome.workflow.currentVersion,
              sourceCanvasNodeId,
              resultNodeCount: resultNodeIds.length,
            }
          },
          retryWorkflowFailed: async ({ runId }) => {
            const project = await productStore.readProject(user.id, projectId)
            if (!project) throw new AgentToolRuntimeError('PROJECT_NOT_FOUND', '未找到当前项目。', 404)
            const workflowRun = (project.document.productionWorkflowRuns ?? []).find((entry) => entry?.id === runId)
            if (!workflowRun) throw new AgentToolRuntimeError('PRODUCTION_WORKFLOW_RUN_NOT_FOUND', '未找到工作流运行。', 404)
            const failedItemIds = (workflowRun.items ?? []).filter((item) => item?.status === 'failed').map((item) => item.id)
            if (!failedItemIds.length) return { runId, retriedItemIds: [], message: 'no_failed_items' }
            // 真正的重投由既有工作流接口完成；这里只把失败项标回排队，避免在两处
            // 各写一份派发逻辑。已成功的项不动，因此不会重复生成。
            const retried = retryFailedWorkflowItems(workflowRun)
            const document = {
              ...project.document,
              productionWorkflowRuns: (project.document.productionWorkflowRuns ?? [])
                .map((entry) => (entry.id === runId ? retried : entry)),
            }
            const saved = await productStore.writeProject(user.id, document, project.revision, project.graphRevision)
            await publishProjectUpdated(saved, user.id)
            return { runId, retriedItemIds: failedItemIds, status: retried.status }
          },
          createSkill: async (argumentsValue) => {
            const input = validateAgentSkillCreation({ projectId, ...argumentsValue })
            // 批准人是确认这次行动的用户：Skill 只能由用户确认的创建动作进入
            // published，「已批准」不能凭创建这个动作本身成立（ADR 0006）。
            // riskOf 取自**当前行动注册表**：Skill 少报能力（声明只读却把写工具放进
            // Manifest 白名单）在这里就被拒绝，不留到运行时靠取最大值兜底。
            const projectSkillCatalog = [
              ...botanicAgentSystemSkills(),
              ...(await productStore.listAgentSkills(user.id, projectId) ?? []),
            ]
            const skill = createAgentSkill(input, {
              ownerId: user.id,
              approvedBy: user.id,
              riskOf: (name) => botanicAgentSkillToolRisk(name, registry),
              skillCatalog: projectSkillCatalog,
            })
            return { skill: publicAgentSkill(await productStore.putAgentSkill(user.id, skill)) }
          },
          mcpRuntime: configuredMcpTools,
        })
        const result = await executeConfirmedAgentAction({
          registry,
          name: actionName,
          arguments: executionArguments,
          toolCallId,
          confirmed: body?.confirmed,
          context: { projectId, userId: user.id, requestId, signal, actionIntentHash: intentHash },
        })
        return result
      }
      const execution = await durableAgentActionExecution().execute({
        userId: user.id,
        projectId,
        receiptId,
        toolCallId,
        name: actionName,
        arguments: executionArguments,
        ...(attemptIdentity ? { actionBindingHash: attemptIdentity.actionBindingHash } : {}),
        replayPolicy: attempt?.manualRetry ? 'never' : safelyReplayableAgentActions.has(actionName) ? 'safe' : 'never',
        executor: execute,
      })
      return json(response, 200, execution)
    }


    return false
  }
}
