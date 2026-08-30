import { generationIdempotencyKey, generationJobIdForIdempotency } from './generationIdempotency.mjs'
import { providerForModel } from './generationModels.mjs'
import { GenerationError, persistedGenerationJob, validateGenerationInput } from './generationProvider.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'
import { buildGenerationUsage, releaseGenerationBudget, reserveGenerationBudget } from './generationGovernance.mjs'
import { compileSubmissionCreativePlan } from './creativePlanResolver.mjs'
import { compareAndSetGenerationJob } from './generationJobCas.mjs'
import { createIdempotencyRequestBinding, matchingIdempotencyRequestBinding } from './idempotencyRequestBinding.mjs'
import { assertGenerationTargetBinding } from './agentTargetBinding.mjs'
import { generationInputProvenance } from './generationInputProvenance.mjs'

const generationSubmissionScope = 'generation.submit'

function generationSubmissionBinding(rawInput, input, agentRun) {
  return createIdempotencyRequestBinding({
    scope: generationSubmissionScope,
    projectId: input.projectId,
    request: { rawInput, ...(agentRun ? { agentRun } : {}) },
  })
}

function generationIdempotencyConflict() {
  return new GenerationError(409, 'IDEMPOTENCY_KEY_CONFLICT', '同一提交标识已绑定到另一份生成请求，请使用新的提交标识。')
}

/**
 * 真实生成任务的单一提交入口。HTTP、Agent 与生产工作流都必须经过这里，避免
 * 三条入口分别实现幂等、额度预留和队列失败语义。
 */
export function createGenerationSubmissionService({ config, productStore, securityControls, enqueue, mediaService }) {
  return async function submitGeneration({ user, rawInput, idempotencyKey: rawIdempotencyKey, retryExisting = false }) {
    const idempotencyKey = generationIdempotencyKey(rawIdempotencyKey)
    if (!idempotencyKey) throw new GenerationError(400, 'INVALID_IDEMPOTENCY_KEY', '任务提交标识无效，请刷新页面后重试。')
    const input = validateGenerationInput(rawInput, {
      models: config.modelOptions?.length ? config.modelOptions : config.models,
      maximumBatchCount: config.maximumBatchCount,
      maximumReferenceBytes: config.maximumReferenceBytes,
    })
    const selectedModel = providerForModel(config.modelOptions ?? [], input.settings.model)
    if (!selectedModel) throw new GenerationError(503, 'PROVIDER_NOT_CONFIGURED', '所选生成模型尚未配置，请检查对应供应商 API Key。')
    await requireProjectPermission(productStore, user.id, input.projectId, 'create-generation')

    let agentRun
    let targetBinding
    if (rawInput.agentRun !== undefined) {
      const runId = typeof rawInput.agentRun?.runId === 'string' ? rawInput.agentRun.runId.trim() : ''
      const branchId = typeof rawInput.agentRun?.branchId === 'string' ? rawInput.agentRun.branchId.trim() : ''
      if (!runId || !branchId || runId.length > 160 || branchId.length > 160) {
        throw new GenerationError(400, 'INVALID_REQUEST', 'Agent Run 或分支标识无效。')
      }
      const run = await productStore.readAgentRun(user.id, runId)
      if (!run || run.projectId !== input.projectId) throw new GenerationError(404, 'AGENT_RUN_NOT_FOUND', '未找到当前项目的 Agent Run。')
      const branch = run.branches.find((candidate) => candidate.id === branchId)
      if (!branch) throw new GenerationError(404, 'AGENT_BRANCH_NOT_FOUND', '未找到 Agent 分支。')
      agentRun = { runId, branchId, attempt: Number(branch.attempt) || 0 }
      targetBinding = run.plan?.targetBinding
      if (targetBinding) {
        try {
          await assertGenerationTargetBinding(targetBinding, input.parent, {
            resolveMedia: mediaService?.enabled
              ? (mediaId) => mediaService.readGenerationInput(user.id, mediaId, input.projectId)
              : undefined,
          })
        } catch (caught) {
          throw new GenerationError(caught?.statusCode ?? 409, caught?.code ?? 'AGENT_TARGET_STALE', caught?.message ?? '已确认目标已经变化。')
        }
      }
    }

    const binding = generationSubmissionBinding(rawInput, input, agentRun)
    const id = generationJobIdForIdempotency(user.id, idempotencyKey)
    const outputReservation = {
      reservationId: `generation-output:${user.id}:${input.projectId}:${id}`,
      windowMs: 24 * 60 * 60_000,
      entries: [{
        scope: 'generation-output', subject: user.id,
        limit: config.security.generationOutputsPerDay,
        cost: input.batchCount,
      }],
    }
    const compiled = compileSubmissionCreativePlan({
      input,
      models: config.modelOptions ?? [],
      productionWorkflow: rawInput?.productionWorkflow,
    })
    const usage = buildGenerationUsage(input, {
      jobId: id,
      memberId: user.id,
      mediaKind: selectedModel.mediaKind,
      provider: selectedModel.provider,
    })
    async function releaseReservations(reservations) {
      if (reservations?.budget?.allowed && !reservations.budget.reused) {
        await releaseGenerationBudget({
          securityControls, usage, limits: config.generationBudgets,
          reservedAt: reservations.budget.reservedAt,
        })
      }
      if (reservations?.output?.allowed && !reservations.output.reused) {
        await securityControls.releaseMany({ ...outputReservation, reservedAt: reservations.output.reservedAt })
      }
    }
    async function reserveReservations() {
      const output = await securityControls.reserveMany(outputReservation)
      if (!output.allowed) {
        const failure = new GenerationError(429, 'RATE_LIMITED', '操作过于频繁，请稍后重试。')
        failure.retryAfterSeconds = output.retryAfterSeconds
        throw failure
      }
      let budget
      try {
        budget = await reserveGenerationBudget({ securityControls, usage, limits: config.generationBudgets })
      } catch (caught) {
        await releaseReservations({ output })
        throw caught
      }
      if (!budget.allowed) {
        await releaseReservations({ output, budget })
        throw new GenerationError(402, 'GENERATION_BUDGET_EXCEEDED', '生成额度不足，请调整候选数、规格或联系工作区所有者。')
      }
      return { output, budget }
    }
    const existing = await productStore.readGenerationJob(user.id, id)
    if (existing) {
      // Legacy Job 没有 endpoint scope。仅无 Agent Run 关联的旧通用提交可从其 immutable
      // rawInput 安全派生；带 Run 的旧记录可能来自 branch retry，无法判明来源时 fail closed。
      const storedBinding = existing.idempotencyBinding ?? (!existing.agentRun && existing.rawInput
        ? generationSubmissionBinding(existing.rawInput, { projectId: existing.projectId }, undefined)
        : undefined)
      if (!matchingIdempotencyRequestBinding(storedBinding, binding)) throw generationIdempotencyConflict()
    }
    if (existing && (!retryExisting || !['failed', 'cancelled'].includes(existing.status))) return { job: existing, existing: true }
    if (existing && retryExisting) {
      const reservations = await reserveReservations()
      const retried = {
        ...existing,
        status: 'queued',
        error: undefined,
        errorCode: undefined,
        cancel: undefined,
        partialError: undefined,
        projectWritebackPending: undefined,
        projectWritebackAttempts: undefined,
        projectWritebackError: undefined,
        projectWritebackUpdatedAt: undefined,
        variants: (existing.variants ?? []).map((variant) => variant.status === 'succeeded'
          ? variant
          : { ...variant, status: 'queued', error: undefined, completedAt: undefined }),
        updatedAt: Date.now(),
      }
      const reset = await compareAndSetGenerationJob(productStore, user.id, existing, retried, { clearExecution: true })
      if (!reset?.changed) return { job: reset?.job ?? existing, existing: true }
      const queued = reset.job
      try {
        await enqueue(queued.id)
      } catch {
        const failed = { ...queued, status: 'failed', error: '生成任务无法进入队列，请检查 Redis Worker 后重试。', updatedAt: Date.now() }
        const failure = await compareAndSetGenerationJob(productStore, user.id, queued, failed)
        if (!failure?.changed) return { job: failure?.job ?? queued, existing: true, retried: true }
        await releaseReservations(reservations)
        throw new GenerationError(503, 'QUEUE_UNAVAILABLE', failed.error)
      }
      return { job: queued, existing: true, retried: true }
    }
    const reservations = await reserveReservations()
    const timestamp = Date.now()
    const job = {
      id, ownerId: user.id, projectId: input.projectId, status: 'queued', kind: input.kind,
      createdAt: timestamp, updatedAt: timestamp, batchCount: input.batchCount, settings: input.settings,
      provider: selectedModel.provider === 'minimax'
        ? selectedModel.mediaKind === 'video' ? 'minimax-video' : 'minimax-image'
        : selectedModel.provider === 'flock'
          ? 'flock-image'
          : 'openai-images',
      refinementMode: input.refinementMode,
      idempotencyKey,
      outputs: [], error: undefined, rawInput, agentRun, targetBinding, usage, idempotencyBinding: binding,
      inputProvenance: generationInputProvenance(input, targetBinding),
      parentNodeId: input.parent?.nodeId,
      planFingerprint: compiled.planFingerprint,
      branchFingerprint: compiled.branchFingerprint,
      budgetWarning: reservations.budget.warning ? '生成额度接近上限。' : undefined,
    }
    let queued
    try {
      queued = await productStore.putGenerationJob(user.id, persistedGenerationJob(job)) ?? persistedGenerationJob(job)
    } catch (caught) {
      const recovered = await productStore.readGenerationJob(user.id, id).catch(() => undefined)
      if (!recovered || !matchingIdempotencyRequestBinding(recovered.idempotencyBinding, binding)) {
        await releaseReservations(reservations)
        throw caught
      }
      queued = recovered
    }
    if (!matchingIdempotencyRequestBinding(queued.idempotencyBinding, binding)) throw generationIdempotencyConflict()
    // guarded put 可能返回并发请求已 claim/settle 的权威 Job。此时重复 enqueue
    // 没有价值；更不能把网络失败解释成 running→failed，终结真实 Worker。
    if (queued.status !== 'queued' || queued.execution) return { job: queued, existing: true }
    try {
      await enqueue(queued.id)
    } catch {
      const failed = { ...queued, status: 'failed', error: '生成任务无法进入队列，请检查 Redis Worker 后重试。', updatedAt: Date.now() }
      const failure = await compareAndSetGenerationJob(productStore, user.id, queued, failed)
      if (!failure?.changed) return { job: failure?.job ?? queued, existing: true }
      await releaseReservations(reservations)
      throw new GenerationError(503, 'QUEUE_UNAVAILABLE', failed.error)
    }
    return { job: queued, existing: false }
  }
}
