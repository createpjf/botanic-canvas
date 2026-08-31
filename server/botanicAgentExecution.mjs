import { AgentToolRuntimeError } from './agentToolRuntime.mjs'
import { validateGenerationInput } from './generationProvider.mjs'
import { generationJobForCanvasProjection, generationJobProjectionComplete, reconcileGenerationResults } from './generationResultReconciliation.mjs'
import { compileAgentBranchRecipe } from './botanicCreativePlanCompiler.mjs'
import { compiledBranchFromRun, normalizeResolverModels, resolveCreativePlan } from './creativePlanResolver.mjs'
import { canonicalImageDataUrlPattern } from './mediaFormats.mjs'
import { generationInputProvenance } from './generationInputProvenance.mjs'

function clone(value) {
  return structuredClone(value)
}

function mediaInput(image) {
  if (typeof image !== 'string' || !image) {
    throw new AgentToolRuntimeError('AGENT_REFERENCE_MISSING', 'Agent 参考图片不存在。', 409)
  }
  const mediaMatch = image.match(/^\/api\/media\/(media_[A-Za-z0-9_-]+)$/)
  if (mediaMatch) return { mediaId: mediaMatch[1] }
  if (canonicalImageDataUrlPattern().test(image)) return { dataUrl: image }
  throw new AgentToolRuntimeError('AGENT_REFERENCE_INVALID', 'Agent 参考图片尚未存入受控媒体库。', 409)
}

function branchNodeIds(runId, branchId) {
  const suffix = `${runId}-${branchId}`.replace(/[^A-Za-z0-9_-]/g, '-')
  return {
    promptNodeId: `agent-prompt-${suffix}`,
    generateNodeId: `agent-generate-${suffix}`,
    resultNodeId: `agent-result-${suffix}`,
  }
}

function appendMissingById(items, additions) {
  const existingIds = new Set(items.map((item) => item.id))
  return [...items, ...additions.filter((item) => !existingIds.has(item.id))]
}

function mergeWorkflowNodes(items, additions, submission) {
  const result = [...items]
  for (const addition of additions) {
    const index = result.findIndex((item) => item.id === addition.id)
    if (index < 0) result.push(addition)
    else if (submission && (result[index].data?.taskStatus === 'draft' || result[index].data?.status === 'idle')) {
      result[index] = { ...addition, position: result[index].position, selected: result[index].selected ?? false }
    }
  }
  return result
}

function providerName(model) {
  if (!model) throw new AgentToolRuntimeError('AGENT_MODEL_NOT_CONFIGURED', 'Agent 计划使用的生成模型尚未配置。', 503)
  if (model.provider === 'minimax') return model.mediaKind === 'video' ? 'minimax-video' : 'minimax-image'
  if (model.provider === 'flock') return 'flock-image'
  return 'openai-images'
}

function rawGenerationInput(run, parentNode, recipe, { videoModel = false } = {}) {
  const kind = run.plan.intent === 'redo_from_root' || run.plan.intent === 'initial_generation'
    ? 'generation'
    : 'refinement'
  return {
    projectId: run.projectId,
    kind,
    refinementMode: 'faithful',
    prompt: recipe.prompt,
    batchCount: recipe.batchCount,
    settings: clone(recipe.settings),
    recipe: {
      prompt: recipe.prompt,
      ...(recipe.creativeIntent ? { creativeIntent: recipe.creativeIntent } : {}),
      ...(recipe.constraints?.length ? { constraints: clone(recipe.constraints) } : {}),
      ...(recipe.qualityPolicy ? { qualityPolicy: clone(recipe.qualityPolicy) } : {}),
      ...(recipe.sourcePlanFingerprint ? { sourcePlanFingerprint: recipe.sourcePlanFingerprint } : {}),
      ...(recipe.referenceBindings?.length ? { referenceBindings: clone(recipe.referenceBindings) } : {}),
      ...(recipe.memoryBindings?.length ? { memoryBindings: clone(recipe.memoryBindings) } : {}),
      ...(recipe.skillBindings?.length ? { skillBindings: clone(recipe.skillBindings) } : {}),
      references: recipe.references.map((reference, index) => ({
        ...(reference.nodeId ? { nodeId: reference.nodeId } : {}),
        ...(reference.assetId ? { assetId: reference.assetId } : {}),
        name: reference.name,
        role: reference.role,
        primary: Boolean(reference.primary),
        priority: reference.priority,
        // 视频参考必须显式声明首帧角色，否则 Provider 按参考数量猜输入模式。
        ...(videoModel && index === 0 ? { inputRole: 'first_frame' } : {}),
        ...mediaInput(reference.image),
      })),
      // 局部重绘选区随任务下发；位图蒙版由生成 Worker 按基准图真实像素生成。
      ...(!videoModel && run.plan.region?.rect ? { maskRegion: clone(run.plan.region.rect) } : {}),
    },
    ...(kind === 'refinement'
      ? { parent: { nodeId: parentNode.id, name: parentNode.data?.label ?? '父版本', ...mediaInput(parentNode.data?.image) } }
      : {}),
  }
}

/**
 * 画布节点的输出端口 id 按节点类型不同：素材节点是 asset-output，结果节点是 output。
 * 连线指向不存在的端口时 React Flow 不会渲染这条边——参考图看起来就“没连上”。
 */
function sourceHandleForNode(node) {
  return node?.type === 'asset' ? 'asset-output' : 'output'
}

function clipBranchLabel(value) {
  if (typeof value !== 'string' || !value.trim()) return '新版本'
  return Array.from(value.replace(/[\s·.,，。:：；;、\-_/\\]+/gu, '')).slice(0, 8).join('') || '新版本'
}

function workflowForBranch({ run, branch, parentNode, recipe, jobId, branchIndex, now, submission, nodesById }) {
  const { promptNodeId, generateNodeId, resultNodeId } = branchNodeIds(run.id, branch.id)
  const parentPosition = parentNode?.position ?? { x: 0, y: 0 }
  const y = parentPosition.y + branchIndex * 420
  const generationKind = run.plan.intent === 'redo_from_root' || run.plan.intent === 'initial_generation'
    ? 'generation'
    : 'refinement'
  const generateNode = {
    id: generateNodeId,
    type: 'generate',
    position: { x: parentPosition.x + 460, y },
    draggable: true,
    selected: false,
    data: {
      kind: 'generate', label: clipBranchLabel(branch.label), prompt: '',
      batchCount: recipe.batchCount, settings: clone(recipe.settings), status: submission ? 'queued' : 'idle',
      generationKind, refinementMode: 'faithful', jobId,
      agentRun: { runId: run.id, branchId: branch.id, attempt: branch.attempt ?? 0 },
    },
  }
  const promptNode = {
    id: promptNodeId,
    type: 'text',
    position: { x: generateNode.position.x, y: generateNode.position.y - 172 },
    draggable: true,
    selected: false,
    data: { kind: 'text', label: generationKind === 'refinement' ? '精修描述' : '生成描述', content: recipe.promptForDisplay ?? recipe.prompt },
  }
  const resultNode = {
    id: resultNodeId,
    type: 'result',
    position: { x: parentPosition.x + 920, y },
    draggable: true,
    selected: false,
    data: {
      kind: 'result', outputOf: generateNodeId, label: clipBranchLabel(branch.label),
      status: submission ? 'generating' : 'ready', taskStatus: submission ? 'queued' : 'draft',
      ...(submission ? { submittedAt: now } : {}),
      jobId, taskGroupId: resultNodeId, taskNodeId: resultNodeId, variant: 0,
      generationKind, refinementMode: 'faithful', generationSettings: clone(recipe.settings),
      agentRun: { runId: run.id, branchId: branch.id, attempt: branch.attempt ?? 0 },
      generationRecipe: clone(recipe),
      ...(run.plan.intent === 'initial_generation'
        ? { rootRecipe: clone(recipe) }
        : parentNode?.data?.rootRecipe ? { rootRecipe: clone(parentNode.data.rootRecipe) } : {}),
    },
  }
  const edges = [{
    id: `agent-prompt-edge-${jobId}`, source: promptNodeId, sourceHandle: 'output',
    target: generateNodeId, targetHandle: 'input', type: 'default',
    style: { stroke: '#8bad97', strokeWidth: 1.4 }, data: { system: true, role: 'prompt' }, reconnectable: false,
  }, {
    id: `agent-output-edge-${jobId}`, source: generateNodeId, sourceHandle: 'output',
    target: resultNodeId, targetHandle: 'input', type: 'default',
    style: { stroke: '#2a5238', strokeWidth: 1.7 }, data: { system: true, role: 'output' }, reconnectable: false,
  }]
  if (generationKind === 'refinement') edges.unshift({
    id: `agent-parent-edge-${jobId}`, source: parentNode.id, sourceHandle: sourceHandleForNode(parentNode),
    target: generateNodeId, targetHandle: 'input', type: 'default',
    style: { stroke: '#2a5238', strokeWidth: 1.7 }, data: { system: true, role: 'parent' }, reconnectable: false,
  })
  for (const reference of recipe.references) {
    if (!reference.nodeId) continue
    edges.unshift({
      id: `agent-reference-edge-${jobId}-${reference.nodeId}`, source: reference.nodeId,
      sourceHandle: sourceHandleForNode(nodesById?.get(reference.nodeId)),
      target: generateNodeId, targetHandle: 'input', type: 'default',
      style: { stroke: '#8bad97', strokeWidth: 1.4 }, data: { system: true, role: 'reference' }, reconnectable: false,
    })
  }
  return { promptNode, generateNode, resultNode, edges, promptNodeId, generateNodeId, resultNodeId }
}

function publicJobRecord(job, workflow) {
  return {
    id: job.id, status: job.status, kind: job.kind, refinementMode: job.refinementMode,
    createdAt: job.createdAt, updatedAt: job.updatedAt, batchCount: job.batchCount,
    outputCount: 0, provider: job.provider, model: job.settings.model, outputs: [],
    generateNodeId: workflow.generateNodeId, resultNodeId: workflow.resultNodeId,
    promptNodeId: workflow.promptNodeId, parentNodeId: job.parentNodeId,
    agentRun: clone(job.agentRun),
  }
}

/** 引用身份：快照存不了图片字节，只能存这几个标识，比对也只能按它们来。 */
function referenceIdentity(reference) {
  return `${reference?.nodeId ?? ''}|${reference?.assetId ?? ''}|${reference?.role ?? ''}`
}

/**
 * 用确认时的编译快照执行这一支。
 *
 * 快照里没有图片字节（媒体不进快照），所以图片仍由 Resolve 从权威文档重新取；
 * 创作语义（Prompt、设置、约束、质量策略、绑定与指纹）全部来自快照。
 *
 * 如果重新解析出的引用身份与快照不一致，就地阻断：继续执行等于用另一组素材去
 * 顶替用户确认过的那一组，还挂着原来的指纹（ADR 0005 不变量四）。
 */
function recipeFromCompiledBranch(baseRecipe, compiledBranch) {
  const resolved = (baseRecipe.references ?? []).map(referenceIdentity)
  const confirmed = (compiledBranch.references ?? []).map(referenceIdentity)
  if (resolved.length !== confirmed.length || resolved.some((value, index) => value !== confirmed[index])) {
    throw new AgentToolRuntimeError(
      'AGENT_PLAN_REFERENCE_DRIFT',
      '确认时使用的参考素材已发生变化，请重新确认这次生成。',
      409,
    )
  }
  return {
    ...baseRecipe,
    prompt: compiledBranch.prompt,
    promptForDisplay: baseRecipe.prompt,
    batchCount: compiledBranch.batchCount ?? baseRecipe.batchCount,
    settings: clone(compiledBranch.settings),
    constraints: clone(compiledBranch.constraints ?? []),
    creativeIntent: compiledBranch.taskIntent,
    qualityPolicy: clone(compiledBranch.qualityPolicy),
    sourcePlanFingerprint: compiledBranch.branchFingerprint,
    planFingerprint: compiledBranch.planFingerprint,
    branchFingerprint: compiledBranch.branchFingerprint,
    referenceBindings: clone(compiledBranch.referenceBindings ?? []),
    ...(compiledBranch.memoryBindings?.length ? { memoryBindings: clone(compiledBranch.memoryBindings) } : {}),
    ...(compiledBranch.skillBindings?.length ? { skillBindings: clone(compiledBranch.skillBindings) } : {}),
  }
}

export function prepareAgentRunExecution({
  run, document, now = Date.now(), jobIdForBranch,
  models, maximumBatchCount, maximumReferenceBytes, submission = true,
}) {
  if (!run || !document || typeof jobIdForBranch !== 'function') {
    throw new TypeError('Agent 服务端执行缺少可信上下文。')
  }
  // 引用解析与分支覆盖由 Resolve 阶段拥有（ADR 0005）：确认时编译快照和这里执行
  // 必须得到同一份引用集，因此只有一份实现。
  const resolved = resolveCreativePlan({ run, document, models })
  const { parentNode } = resolved
  const nodesById = new Map((document.nodes ?? []).map((node) => [node.id, node]))
  const normalizedModels = resolved.models
  const jobs = []
  const workflows = []
  for (const [branchIndex, branch] of run.branches.entries()) {
    const jobId = jobIdForBranch(branch)
    const { recipe: baseRecipe, isVideo: branchModelIsVideo } = resolved.branches[branchIndex]
    // 确认时已经编译过就直接用那份快照：重试与恢复不得重新编译，否则模型目录、
    // Memory 或 Skill 改动会让历史 Run 漂移（ADR 0005 不变量三）。
    const compiledBranch = compiledBranchFromRun(run, branch.id)
    const recipe = compiledBranch
      ? recipeFromCompiledBranch(baseRecipe, compiledBranch)
      : compileAgentBranchRecipe({
        // Resolve 已完成旁白清理与分支增量拼接；编译层只把这份可信画面描述
        // 包装成执行契约，不能再次回读规划器的叙述性 plan.prompt。
        plan: { ...run.plan, prompt: baseRecipe.prompt, settings: baseRecipe.settings },
        baseRecipe,
        branch,
        models: normalizedModels,
        memoryBindings: run.plan.memoryBindings,
        skillBindings: run.plan.skillBindings,
      })
    const rawInput = rawGenerationInput(run, parentNode, recipe, { videoModel: branchModelIsVideo })
    const validated = validateGenerationInput(rawInput, { models, maximumBatchCount, maximumReferenceBytes })
    const selectedModel = normalizedModels.find((model) => model.id === validated.settings.model)
    const targetBinding = run.plan.targetBinding
    const job = {
      id: jobId, ownerId: run.ownerId, projectId: run.projectId,
      status: 'queued', kind: validated.kind, refinementMode: validated.refinementMode,
      createdAt: now, updatedAt: now, batchCount: validated.batchCount,
      settings: clone(validated.settings), provider: providerName(selectedModel),
      idempotencyKey: `${run.id}:${branch.id}:attempt-${branch.attempt ?? 0}`,
      outputs: [], error: undefined, rawInput,
      agentRun: { runId: run.id, branchId: branch.id, attempt: branch.attempt ?? 0 },
      ...(targetBinding ? { targetBinding: clone(targetBinding) } : {}),
      referenceBindings: clone(recipe.referenceBindings ?? []),
      inputProvenance: generationInputProvenance(validated, targetBinding),
      // 指纹提到任务顶层：Artifact 要能反查「这张图属于哪一次确认的哪一支」，
      // 埋在 generationRecipe 里则每个读取方都得自己往下挖一层。
      ...(recipe.planFingerprint ? { planFingerprint: recipe.planFingerprint } : {}),
      ...(recipe.branchFingerprint ? { branchFingerprint: recipe.branchFingerprint } : {}),
    }
    const workflow = workflowForBranch({ run, branch, parentNode, recipe, jobId, branchIndex, now, submission, nodesById })
    job.generateNodeId = workflow.generateNodeId
    job.promptNodeId = workflow.promptNodeId
    job.resultNodeId = workflow.resultNodeId
    if (workflow.generateNode.data.generationKind === 'refinement') job.parentNodeId = parentNode.id
    job.generateNodePosition = clone(workflow.generateNode.position)
    job.resultNodePosition = clone(workflow.resultNode.position)
    job.generationRecipe = clone(recipe)
    jobs.push(job)
    workflows.push(workflow)
  }

  const nodes = mergeWorkflowNodes(document.nodes ?? [], workflows.flatMap((workflow) => [workflow.promptNode, workflow.generateNode, workflow.resultNode]), submission)
  const edges = appendMissingById(document.edges ?? [], workflows.flatMap((workflow) => workflow.edges))
  const generationJobs = submission
    ? appendMissingById(document.generationJobs ?? [], jobs.map((job, index) => publicJobRecord(job, workflows[index])))
    : clone(document.generationJobs ?? [])
  return { document: { ...clone(document), nodes, edges, generationJobs, updatedAt: now }, jobs, workflows }
}

export function reconcileAgentGenerationJobToProject(document, job, now = Date.now()) {
  if (!document || !job?.id) return { document, changed: false }
  if (job.status === 'succeeded' && job.outputs?.length) {
    const reconciled = reconcileGenerationResults(document, [job], { ensureAgentPlaceholders: true })
    const projectedDocument = reconciled.document ?? document
    const existingRecord = projectedDocument.generationJobs?.find((record) => record.id === job.id)
    const projectedJob = generationJobForCanvasProjection(projectedDocument, job)
    const nextRecord = {
      id: projectedJob.id,
      status: projectedJob.status,
      kind: projectedJob.kind,
      refinementMode: projectedJob.refinementMode,
      createdAt: projectedJob.createdAt,
      updatedAt: projectedJob.updatedAt,
      batchCount: projectedJob.batchCount,
      outputCount: projectedJob.outputs?.length ?? 0,
      provider: projectedJob.provider ?? 'openai-images',
      model: projectedJob.settings?.model,
      error: projectedJob.error,
      missingOutputCount: projectedJob.missingOutputCount ?? 0,
      partialError: projectedJob.partialError,
      outputs: projectedJob.outputs ?? [],
      dismissedOutputIds: projectedJob.dismissedOutputIds,
      projectionDismissedAt: projectedJob.projectionDismissedAt,
      generateNodeId: projectedJob.generateNodeId ?? existingRecord?.generateNodeId,
      promptNodeId: projectedJob.promptNodeId ?? existingRecord?.promptNodeId,
      resultNodeId: projectedJob.resultNodeId ?? existingRecord?.resultNodeId,
      parentNodeId: projectedJob.parentNodeId ?? existingRecord?.parentNodeId,
      agentRun: projectedJob.agentRun ?? existingRecord?.agentRun,
    }
    const recordChanged = JSON.stringify(existingRecord) !== JSON.stringify(nextRecord)
    const complete = generationJobProjectionComplete(projectedDocument, job)
    if (!reconciled.changed && !recordChanged) return { document, changed: false, complete }
    const next = {
      ...clone(projectedDocument),
      generationJobs: [nextRecord, ...(projectedDocument.generationJobs ?? []).filter((record) => record.id !== job.id)].slice(0, 60),
      updatedAt: now,
    }
    return { document: next, changed: true, complete }
  }
  let changed = false
  const nodes = (document.nodes ?? []).map((node) => {
    if (node.data?.jobId !== job.id) return node
    changed = true
    if (node.type === 'generate') return {
      ...node, data: { ...node.data, status: job.status, error: job.error },
    }
    return {
      ...node,
      data: {
        ...node.data,
        status: job.status === 'failed' || job.status === 'cancelled' ? 'ready' : 'generating',
        taskStatus: job.status, error: job.error,
      },
    }
  })
  if (!changed) return { document, changed: false }
  const generationJobs = (document.generationJobs ?? []).map((record) => record.id !== job.id ? record : {
    ...record, status: job.status, updatedAt: job.updatedAt ?? now, error: job.error,
    outputCount: job.outputs?.length ?? 0, outputs: job.outputs ?? [],
  })
  return { document: { ...clone(document), nodes, generationJobs, updatedAt: now }, changed: true }
}
