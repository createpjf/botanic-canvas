import { AgentToolRuntimeError } from './agentToolRuntime.mjs'
import { validateGenerationInput } from './generationProvider.mjs'
import { generationJobProjectionComplete, reconcileGenerationResults } from './generationResultReconciliation.mjs'

function clone(value) {
  return structuredClone(value)
}

function mediaInput(image) {
  if (typeof image !== 'string' || !image) {
    throw new AgentToolRuntimeError('AGENT_REFERENCE_MISSING', 'Agent 参考图片不存在。', 409)
  }
  const mediaMatch = image.match(/^\/api\/media\/(media_[A-Za-z0-9_-]+)$/)
  if (mediaMatch) return { mediaId: mediaMatch[1] }
  if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(image)) return { dataUrl: image }
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
  return 'openai-images'
}

function initialGenerationReferences(run, document) {
  const snapshot = run.plan?.contextSnapshot
  if (!Array.isArray(snapshot) || !snapshot.length) {
    throw new AgentToolRuntimeError('AGENT_INITIAL_REFERENCE_INVALID', 'Agent 首次生成只支持已存入画布的图片素材或图片结果。', 409)
  }
  const imageSnapshot = snapshot.filter((item) => (
    (item.kind === '素材' || item.kind === '结果') && item.mediaKind === 'image'
  ))
  if (!imageSnapshot.length) {
    throw new AgentToolRuntimeError('AGENT_INITIAL_REFERENCE_INVALID', 'Agent 首次生成只支持已存入画布的图片素材或图片结果。', 409)
  }
  const nodesById = new Map((document.nodes ?? []).map((node) => [node.id, node]))
  return imageSnapshot.map((item, index) => {
    const node = nodesById.get(item.nodeId)
    const isMediaNode = node?.type === 'asset' || node?.type === 'result'
    const isImage = node?.data?.mediaKind === undefined || node.data.mediaKind === 'image'
    const image = node?.data?.image
    if (!isMediaNode || !isImage || typeof image !== 'string' || !image) {
      throw new AgentToolRuntimeError('AGENT_INITIAL_REFERENCE_INVALID', 'Agent 首次生成只支持已存入画布的图片素材或图片结果。', 409)
    }
    return {
      nodeId: node.id,
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
      name: node.data.name ?? node.data.label ?? `参考图 ${index + 1}`,
      image,
      role: node.data.role ?? '参考',
      primary: Boolean(node.data.primary),
      priority: index + 1,
    }
  })
}

/** 素材组分支把本分支的素材并进参考集；同角色的旧参考被替换而不是叠加。 */
function withBranchAsset(references, run, document, branch) {
  const recipeTail = {
    prompt: run.plan.prompt,
    batchCount: run.plan.output.mode === 'single' ? run.plan.output.count : run.plan.output.candidatesPerItem,
    settings: clone(run.plan.settings),
  }
  if (!branch.assetId) return { references, ...recipeTail }
  const asset = (document.assets ?? []).find((candidate) => candidate.id === branch.assetId)
  if (!asset) throw new AgentToolRuntimeError('AGENT_BRANCH_ASSET_MISSING', `分支素材「${branch.label}」已不存在。`, 409)
  const kept = references.filter((reference) => reference.role !== asset.role)
  kept.push({
    assetId: asset.id,
    name: asset.name,
    image: asset.image,
    role: asset.role ?? '参考',
    primary: Boolean(asset.primary),
    priority: kept.length + 1,
  })
  return { references: kept, ...recipeTail }
}

/**
 * 继续生成时“这一轮”的参考集：只取用户本轮锁定的画布图片素材/结果。
 * 父结果本身通过 parent 单独传入，不重复进参考集。
 */
function refinementReferences(run, document) {
  const snapshot = run.plan?.contextSnapshot
  if (!Array.isArray(snapshot) || !snapshot.length) return []
  const nodesById = new Map((document.nodes ?? []).map((node) => [node.id, node]))
  const parentNodeId = run.plan?.selectedResultNodeId
  return snapshot.flatMap((item, index) => {
    if (item.kind !== '素材' && item.kind !== '结果') return []
    if (item.mediaKind !== 'image') return []
    if (item.nodeId === parentNodeId) return []
    const node = nodesById.get(item.nodeId)
    const isMediaNode = node?.type === 'asset' || node?.type === 'result'
    const isImage = node?.data?.mediaKind === undefined || node.data.mediaKind === 'image'
    const image = node?.data?.image
    if (!isMediaNode || !isImage || typeof image !== 'string' || !image) return []
    return [{
      nodeId: node.id,
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
      name: node.data.name ?? node.data.label ?? `参考图 ${index + 1}`,
      image,
      role: node.data.role ?? '参考',
      primary: Boolean(node.data.primary),
      priority: index + 1,
    }]
  })
}

/**
 * 每一轮的参考集由 intent 决定，三条路径互不污染：
 * - 首次生成：用户这次锁定的画布图片。
 * - 从原配方重做：语义就是复用最初那次配方，因此只有它读 rootRecipe。
 * - 其余继续生成：只带用户本轮重新指定的参考；上一轮结果通过 parent 单独传入。
 *   不再沿用最初那次的参考，否则改得越多参考越脏，画面会被最初的素材拖回去。
 */
function recipeForRun(run, document, parentNode, branch, resolvedInitialReferences) {
  if (run.plan.intent === 'initial_generation') {
    return withBranchAsset(clone(resolvedInitialReferences), run, document, branch)
  }
  if (run.plan.intent === 'redo_from_root') {
    const rootRecipe = parentNode.data?.rootRecipe ?? parentNode.data?.generationRecipe
    if (!rootRecipe || !Array.isArray(rootRecipe.references)) {
      throw new AgentToolRuntimeError('AGENT_RECIPE_MISSING', '父结果缺少可追溯的生成配方。', 409)
    }
    return withBranchAsset(clone(rootRecipe.references), run, document, branch)
  }
  return withBranchAsset(refinementReferences(run, document), run, document, branch)
}

function rawGenerationInput(run, parentNode, recipe) {
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
      references: recipe.references.map((reference) => ({
        name: reference.name,
        role: reference.role,
        primary: Boolean(reference.primary),
        priority: reference.priority,
        ...mediaInput(reference.image),
      })),
    },
    ...(kind === 'refinement'
      ? { parent: { name: parentNode.data?.label ?? '父版本', ...mediaInput(parentNode.data?.image) } }
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
      kind: 'generate', label: branch.label, prompt: recipe.prompt,
      batchCount: recipe.batchCount, settings: clone(recipe.settings), status: submission ? 'queued' : 'idle',
      generationKind, refinementMode: 'faithful', jobId,
    },
  }
  const promptNode = {
    id: promptNodeId,
    type: 'text',
    position: { x: generateNode.position.x, y: generateNode.position.y - 172 },
    draggable: true,
    selected: false,
    data: { kind: 'text', label: generationKind === 'refinement' ? '精修描述' : '生成描述', content: recipe.prompt },
  }
  const resultNode = {
    id: resultNodeId,
    type: 'result',
    position: { x: parentPosition.x + 920, y },
    draggable: true,
    selected: false,
    data: {
      kind: 'result', outputOf: generateNodeId, label: branch.label,
      status: submission ? 'generating' : 'ready', taskStatus: submission ? 'queued' : 'draft',
      ...(submission ? { submittedAt: now } : {}),
      jobId, taskGroupId: resultNodeId, taskNodeId: resultNodeId, variant: 0,
      generationKind, refinementMode: 'faithful', generationSettings: clone(recipe.settings),
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
    agentRun: clone(job.agentRun),
  }
}

export function prepareAgentRunExecution({
  run, document, now = Date.now(), jobIdForBranch,
  models, maximumBatchCount, maximumReferenceBytes, submission = true,
}) {
  if (!run || !document || typeof jobIdForBranch !== 'function') {
    throw new TypeError('Agent 服务端执行缺少可信上下文。')
  }
  if (run.projectId !== document.id) {
    throw new AgentToolRuntimeError('AGENT_PROJECT_MISMATCH', 'Agent Run 不属于当前画布。', 409)
  }
  const isInitialGeneration = run.plan?.intent === 'initial_generation'
  const resolvedInitialReferences = isInitialGeneration ? initialGenerationReferences(run, document) : undefined
  const parentNode = isInitialGeneration
    ? (document.nodes ?? []).find((node) => node.id === resolvedInitialReferences[0].nodeId)
    : (document.nodes ?? []).find((node) => node.id === run.plan?.selectedResultNodeId && node.type === 'result')
  if (!parentNode) throw new AgentToolRuntimeError('AGENT_PARENT_NOT_FOUND', 'Agent 父结果节点已不存在。', 409)

  const nodesById = new Map((document.nodes ?? []).map((node) => [node.id, node]))
  const jobs = []
  const workflows = []
  for (const [branchIndex, branch] of run.branches.entries()) {
    const jobId = jobIdForBranch(branch)
    const recipe = recipeForRun(run, document, parentNode, branch, resolvedInitialReferences)
    const rawInput = rawGenerationInput(run, parentNode, recipe)
    const validated = validateGenerationInput(rawInput, { models, maximumBatchCount, maximumReferenceBytes })
    const selectedModel = models.map((model) => typeof model === 'string' ? { id: model, provider: 'openai', mediaKind: 'image' } : model)
      .find((model) => model.id === validated.settings.model)
    const job = {
      id: jobId, ownerId: run.ownerId, projectId: run.projectId,
      status: 'queued', kind: validated.kind, refinementMode: validated.refinementMode,
      createdAt: now, updatedAt: now, batchCount: validated.batchCount,
      settings: clone(validated.settings), provider: providerName(selectedModel),
      idempotencyKey: `${run.id}:${branch.id}:attempt-${branch.attempt ?? 0}`,
      outputs: [], error: undefined, rawInput,
      agentRun: { runId: run.id, branchId: branch.id },
    }
    const workflow = workflowForBranch({ run, branch, parentNode, recipe, jobId, branchIndex, now, submission, nodesById })
    job.generateNodeId = workflow.generateNodeId
    job.resultNodeId = workflow.resultNodeId
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
    const nextRecord = {
      id: job.id,
      status: job.status,
      kind: job.kind,
      refinementMode: job.refinementMode,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      batchCount: job.batchCount,
      outputCount: job.outputs?.length ?? 0,
      provider: job.provider ?? 'openai-images',
      model: job.settings?.model,
      error: job.error,
      missingOutputCount: job.missingOutputCount ?? 0,
      partialError: job.partialError,
      outputs: job.outputs ?? [],
      generateNodeId: job.generateNodeId ?? existingRecord?.generateNodeId,
      resultNodeId: job.resultNodeId ?? existingRecord?.resultNodeId,
      agentRun: job.agentRun ?? existingRecord?.agentRun,
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
