import { generationIdempotencyKey, generationJobIdForIdempotency } from './generationIdempotency.mjs'
import { providerForModel } from './generationModels.mjs'
import { GenerationError, persistedGenerationJob, validateGenerationInput } from './generationProvider.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'
import { buildGenerationUsage, reserveGenerationBudget } from './generationGovernance.mjs'
import { compileSubmissionCreativePlan } from './creativePlanResolver.mjs'

/**
 * 真实生成任务的单一提交入口。HTTP、Agent 与生产工作流都必须经过这里，避免
 * 三条入口分别实现幂等、额度预留和队列失败语义。
 */
export function createGenerationSubmissionService({ config, productStore, securityControls, enqueue }) {
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
    if (rawInput.agentRun !== undefined) {
      const runId = typeof rawInput.agentRun?.runId === 'string' ? rawInput.agentRun.runId.trim() : ''
      const branchId = typeof rawInput.agentRun?.branchId === 'string' ? rawInput.agentRun.branchId.trim() : ''
      if (!runId || !branchId || runId.length > 160 || branchId.length > 160) {
        throw new GenerationError(400, 'INVALID_REQUEST', 'Agent Run 或分支标识无效。')
      }
      const run = await productStore.readAgentRun(user.id, runId)
      if (!run || run.projectId !== input.projectId) throw new GenerationError(404, 'AGENT_RUN_NOT_FOUND', '未找到当前项目的 Agent Run。')
      if (!run.branches.some((branch) => branch.id === branchId)) throw new GenerationError(404, 'AGENT_BRANCH_NOT_FOUND', '未找到 Agent 分支。')
      agentRun = { runId, branchId }
    }

    const id = generationJobIdForIdempotency(user.id, idempotencyKey)
    const existing = await productStore.readGenerationJob(user.id, id)
    if (existing && (!retryExisting || !['failed', 'cancelled'].includes(existing.status))) return { job: existing, existing: true }
    if (existing && retryExisting) {
      const retried = {
        ...existing,
        status: 'queued',
        error: undefined,
        partialError: undefined,
        variants: (existing.variants ?? []).map((variant) => variant.status === 'succeeded'
          ? variant
          : { ...variant, status: 'queued', error: undefined, completedAt: undefined }),
        updatedAt: Date.now(),
      }
      await productStore.putGenerationJob(user.id, persistedGenerationJob(retried))
      await enqueue(retried.id)
      return { job: retried, existing: true, retried: true }
    }

    const rate = await securityControls.consume({
      scope: 'generation-output', subject: user.id,
      limit: config.security.generationOutputsPerDay, windowMs: 24 * 60 * 60_000,
      cost: input.batchCount,
    })
    if (!rate.allowed) {
      const failure = new GenerationError(429, 'RATE_LIMITED', '操作过于频繁，请稍后重试。')
      failure.retryAfterSeconds = rate.retryAfterSeconds
      throw failure
    }

    // 三个提交入口共用同一对 Resolve / Compile：这里补上 HTTP 与工作流的编译，
    // 让每个 Job 都带指纹，Artifact 才能一律反查到所属计划。
    const compiled = compileSubmissionCreativePlan({
      input,
      models: config.modelOptions ?? [],
      // 工作流提交沿用版本发布时固定的计划指纹，不按本次提交内容重算。
      productionWorkflow: rawInput?.productionWorkflow,
    })
    const timestamp = Date.now()
    const usage = buildGenerationUsage(input, {
      jobId: id,
      memberId: user.id,
      mediaKind: selectedModel.mediaKind,
      provider: selectedModel.provider,
    })
    const budget = await reserveGenerationBudget({ securityControls, usage, limits: config.generationBudgets })
    if (!budget.allowed) throw new GenerationError(402, 'GENERATION_BUDGET_EXCEEDED', '生成额度不足，请调整候选数、规格或联系工作区所有者。')
    const job = {
      id, ownerId: user.id, projectId: input.projectId, status: 'queued', kind: input.kind,
      createdAt: timestamp, updatedAt: timestamp, batchCount: input.batchCount, settings: input.settings,
      provider: selectedModel.provider === 'minimax'
        ? selectedModel.mediaKind === 'video' ? 'minimax-video' : 'minimax-image'
        : 'openai-images',
      refinementMode: input.refinementMode,
      idempotencyKey,
      outputs: [], error: undefined, rawInput, agentRun, usage,
      planFingerprint: compiled.planFingerprint,
      branchFingerprint: compiled.branchFingerprint,
      budgetWarning: budget.warning ? '生成额度接近上限。' : undefined,
    }
    await productStore.putGenerationJob(user.id, persistedGenerationJob(job))
    try {
      await enqueue(job.id)
    } catch {
      const failed = { ...job, status: 'failed', error: '生成任务无法进入队列，请检查 Redis Worker 后重试。', updatedAt: Date.now() }
      await productStore.putGenerationJob(user.id, persistedGenerationJob(failed))
      throw new GenerationError(503, 'QUEUE_UNAVAILABLE', failed.error)
    }
    return { job, existing: false }
  }
}

