import { createHash } from 'node:crypto'

const workflowRunTerminalStatuses = new Set(['succeeded', 'partially_failed', 'failed', 'cancelled'])
const workflowItemTerminalStatuses = new Set(['succeeded', 'failed', 'cancelled'])

function clone(value) {
  return structuredClone(value)
}

function workflowItemIdempotencyKey(runId, itemId) {
  const digest = createHash('sha256').update(`${runId}:${itemId}`).digest('base64url')
  return `workflow_${digest}`
}

function requiredText(value, label, maximum = 2_000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`)
  if (value.length > maximum) throw new Error(`${label}过长。`)
  return value.trim()
}

function normalizeDefinition(value) {
  const definition = clone(value ?? {})
  definition.prompt = requiredText(definition.prompt, '工作流 Prompt', 12_000)
  definition.model = requiredText(definition.model, '工作流模型', 160)
  definition.settings = clone(definition.settings ?? {})
  definition.output = clone(definition.output ?? {})
  definition.brandRules = Array.isArray(definition.brandRules)
    ? definition.brandRules.map((rule) => requiredText(rule, '品牌规则', 1_000))
    : []
  definition.assetGroupIds = Array.isArray(definition.assetGroupIds)
    ? [...new Set(definition.assetGroupIds.map((id) => requiredText(id, '素材组', 160)))]
    : []
  definition.confirmationPolicy = definition.confirmationPolicy ?? 'before-submit'
  if (definition.graph?.nodes) {
    definition.graph = {
      nodes: definition.graph.nodes.map((node) => ({
        id: requiredText(node?.id, '图节点标识', 160),
        kind: requiredText(node?.kind, '图节点类型', 40),
        dependencies: Array.isArray(node.dependencies) ? node.dependencies.map((value) => requiredText(value, '依赖节点', 160)) : [],
        ...(node.label ? { label: requiredText(node.label, '图节点名称', 120) } : {}),
        ...(node.parentSourceNodeId ? { parentSourceNodeId: requiredText(node.parentSourceNodeId, '母版节点', 160) } : {}),
      })),
    }
  }
  return definition
}

function stableMediaId(value) {
  if (typeof value !== 'string') return undefined
  if (/^media_[A-Za-z0-9_-]+$/.test(value)) return value
  const match = value.match(/^\/api\/media\/([^/?#]+)$/)
  return match ? decodeURIComponent(match[1]) : undefined
}

/**
 * 工作流版本只保存素材/节点身份；运行时再从项目权威文档解析稳定媒体标识。
 * 这避免把 data URL、临时 Object URL 或私有对象存储地址固化进工作流。
 */
export function resolveProductionWorkflowRecipe(definition, document) {
  const recipe = clone(definition?.recipe ?? {})
  const references = Array.isArray(recipe.references) ? recipe.references : []
  const assets = Array.isArray(document?.assets) ? document.assets : []
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  recipe.references = references.map((value, index) => {
    const reference = clone(value ?? {})
    const asset = assets.find((entry) => entry.id === reference.assetId)
    const node = nodes.find((entry) => entry.id === reference.nodeId)
    const mediaId = stableMediaId(reference.mediaId)
      ?? stableMediaId(asset?.image)
      ?? stableMediaId(node?.data?.image)
    if (!mediaId) {
      throw new Error(`生产工作流引用「${reference.name ?? `素材 ${index + 1}`}」缺少稳定媒体，请重新入库后再运行。`)
    }
    return {
      nodeId: reference.nodeId,
      assetId: reference.assetId,
      name: reference.name ?? asset?.name ?? node?.data?.name ?? `素材 ${index + 1}`,
      role: reference.role ?? asset?.role ?? node?.data?.role ?? '参考',
      primary: Boolean(reference.primary),
      priority: Number.isFinite(Number(reference.priority)) ? Number(reference.priority) : index + 1,
      mediaKind: reference.mediaKind ?? asset?.mediaKind ?? node?.data?.mediaKind ?? 'image',
      ...(reference.inputRole ? { inputRole: reference.inputRole } : {}),
      mediaId,
    }
  })
  return recipe
}

function runStatus(items, fallback = 'running') {
  if (items.some((item) => item.status === 'running' || item.status === 'queued')) return fallback
  const succeeded = items.filter((item) => item.status === 'succeeded').length
  const failed = items.filter((item) => item.status === 'failed').length
  if (succeeded === items.length) return 'succeeded'
  if (failed === items.length) return 'failed'
  if (succeeded > 0 && failed > 0) return 'partially_failed'
  return fallback
}

/**
 * 生产工作流定义采用只追加版本。运行只保存版本号与版本快照引用，发布新版本
 * 不会改变正在执行或历史运行的 Prompt、模型、品牌规则和确认策略。
 */
export function createProductionWorkflowVersion(input, { actorId, now = Date.now() } = {}) {
  const id = requiredText(input?.id, '工作流标识', 160)
  const projectId = requiredText(input?.projectId, '项目标识', 160)
  const name = requiredText(input?.name, '工作流名称', 120)
  const previous = input.previous ? clone(input.previous) : undefined
  if (previous && (previous.id !== id || previous.projectId !== projectId)) throw new Error('工作流版本归属不一致。')
  const version = Number(previous?.currentVersion ?? 0) + 1
  const entry = {
    version,
    definition: normalizeDefinition(input.definition),
    createdAt: now,
    createdBy: requiredText(actorId, '操作者', 160),
  }
  return {
    id,
    projectId,
    name,
    currentVersion: version,
    versions: [...(previous?.versions ?? []), entry],
    createdAt: previous?.createdAt ?? now,
    createdBy: previous?.createdBy ?? entry.createdBy,
    updatedAt: now,
    updatedBy: entry.createdBy,
  }
}

export function productionWorkflowVersion(workflow, version = workflow?.currentVersion) {
  return workflow?.versions?.find((entry) => entry.version === Number(version))
}

export function createProductionWorkflowRun(input, { actorId, now = Date.now() } = {}) {
  const workflow = clone(input?.workflow)
  const version = productionWorkflowVersion(workflow, input?.workflowVersion)
  if (!version) throw new Error('工作流版本不存在。')
  const id = requiredText(input?.id, '运行标识', 160)
  const itemInputs = Array.isArray(input?.itemInputs) ? input.itemInputs : []
  if (!itemInputs.length) throw new Error('工作流运行至少需要一个输入项。')
  const ids = new Set()
  const items = itemInputs.map((item, index) => {
    const itemId = requiredText(item?.id ?? `item-${index + 1}`, '运行项标识', 160)
    if (ids.has(itemId)) throw new Error('工作流运行项标识重复。')
    ids.add(itemId)
    return {
      id: itemId,
      index,
      input: clone(item),
      status: 'queued',
      attempt: 1,
      idempotencyKey: workflowItemIdempotencyKey(id, itemId),
      updatedAt: now,
      ...(version.definition.graph?.nodes ? {
        nodeRuns: version.definition.graph.nodes.map((node) => ({
          nodeId: node.id,
          kind: node.kind,
          status: 'blocked',
          ...(node.label ? { label: node.label } : {}),
          updatedAt: now,
        })),
      } : {}),
    }
  })
  return {
    id,
    workflowId: workflow.id,
    workflowVersion: version.version,
    projectId: workflow.projectId,
    definition: clone(version.definition),
    status: 'queued',
    items,
    ...(version.definition.graph ? { approvals: [], validationReports: [] } : {}),
    createdAt: now,
    createdBy: requiredText(actorId, '操作者', 160),
    updatedAt: now,
  }
}

export function transitionProductionWorkflowRun(value, action, { now = Date.now() } = {}) {
  const run = clone(value)
  if (workflowRunTerminalStatuses.has(run.status)) throw new Error('工作流运行已进入终态。')
  if (action === 'start' && run.status !== 'queued') throw new Error('只有排队中的工作流可以启动。')
  if (action === 'pause' && run.status !== 'running') throw new Error('只有执行中的工作流可以暂停。')
  if (action === 'resume' && run.status !== 'paused') throw new Error('只有暂停的工作流可以恢复。')
  if (!['start', 'pause', 'resume', 'cancel'].includes(action)) throw new Error('工作流运行操作不支持。')
  if (action === 'cancel') {
    run.status = 'cancelled'
    run.items = run.items.map((item) => {
      const cancelledItem = workflowItemTerminalStatuses.has(item.status)
        ? item
        : { ...item, status: 'cancelled', updatedAt: now }
      if (!cancelledItem.nodeRuns) return cancelledItem
      return {
        ...cancelledItem,
        nodeRuns: cancelledItem.nodeRuns.map((node) => ['succeeded', 'failed', 'cancelled'].includes(node.status)
          ? node
          : { ...node, status: 'cancelled', updatedAt: now }),
      }
    })
    run.completedAt = now
  } else {
    run.status = action === 'pause' ? 'paused' : 'running'
    if (action === 'start') run.startedAt = run.startedAt ?? now
  }
  run.updatedAt = now
  return run
}

export function applyWorkflowItemResult(value, itemId, result, { now = Date.now() } = {}) {
  const run = clone(value)
  const itemIndex = run.items.findIndex((item) => item.id === itemId)
  if (itemIndex < 0) throw new Error('工作流运行项不存在。')
  if (!['running', 'succeeded', 'failed', 'cancelled'].includes(result?.status)) throw new Error('工作流运行项状态无效。')
  const nextItem = {
    ...run.items[itemIndex],
    ...clone(result),
    updatedAt: now,
  }
  if (workflowItemTerminalStatuses.has(nextItem.status)) nextItem.completedAt = now
  run.items[itemIndex] = nextItem
  run.status = runStatus(run.items, run.status === 'queued' ? 'running' : run.status)
  run.updatedAt = now
  if (workflowRunTerminalStatuses.has(run.status)) run.completedAt = now
  return run
}

export function retryFailedWorkflowItems(value, { now = Date.now() } = {}) {
  const run = clone(value)
  const failedItems = run.items.filter((item) => item.status === 'failed')
  if (!failedItems.length) throw new Error('没有可重试的失败项。')
  run.items = run.items.map((item) => item.status !== 'failed' ? item : {
    ...item,
    status: 'queued',
    attempt: Number(item.attempt ?? 1) + 1,
    error: undefined,
    completedAt: undefined,
    updatedAt: now,
  })
  run.status = 'running'
  run.completedAt = undefined
  run.updatedAt = now
  return run
}

export function productionWorkflowLineage(input) {
  return {
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    workflowRunId: input.runId,
    workflowItemId: input.itemId,
    generationJobId: input.jobId,
    artifactId: input.artifactId,
    canvasNodeId: input.canvasNodeId,
    sourceVersionId: input.sourceVersionId,
  }
}

function graphNodeMap(item) {
  return new Map((item?.nodeRuns ?? []).map((node) => [node.nodeId, node]))
}

function completeImmediateGraphNode(run, node, { now, quality }) {
  if (node.kind === 'content' || node.kind === 'context') {
    node.status = 'succeeded'
  } else if (node.kind === 'approval') {
    node.status = 'awaiting_approval'
  } else if (node.kind === 'validation') {
    const report = quality ?? { checks: [], blockingPassed: true }
    const reportId = `validation-${node.nodeId}-${now}`
    run.validationReports = [...(run.validationReports ?? []), {
      id: reportId,
      itemId: run.items[0].id,
      nodeId: node.nodeId,
      scope: 'preflight',
      status: report.blockingPassed ? 'passed' : 'failed',
      checks: clone(report.checks ?? []),
      createdAt: now,
    }]
    node.validationReportId = reportId
    node.status = report.blockingPassed ? 'succeeded' : 'failed'
    if (!report.blockingPassed) node.error = { code: 'VALIDATION_FAILED', message: '质量预检未通过。' }
  } else if (node.kind === 'delivery') {
    const blockingFailed = (run.items[0].nodeRuns ?? []).some((entry) => (
      (entry.kind === 'approval' || entry.kind === 'validation') && entry.status === 'failed'
    ))
    if (blockingFailed) {
      node.status = 'failed'
      node.error = { code: 'DELIVERY_BLOCKED', message: '审批或 QA 未通过时不能交付。' }
    } else {
      node.status = 'succeeded'
      node.artifactIds = run.items.flatMap((item) => item.artifactIds ?? [])
    }
  }
  node.updatedAt = now
}

export function advanceProductionWorkflowRun(run, { now = Date.now(), quality } = {}) {
  if (!run?.definition?.graph) return clone(run)
  const next = clone(run)
  const item = next.items[0]
  if (!item?.nodeRuns) return next
  let changed = true
  while (changed) {
    changed = false
    const nodeRunById = graphNodeMap(item)
    const definitions = new Map(next.definition.graph.nodes.map((node) => [node.id, node]))
    for (const node of item.nodeRuns) {
      if (!['blocked', 'queued'].includes(node.status)) continue
      const definition = definitions.get(node.nodeId)
      const depsOk = (definition?.dependencies ?? []).every((dep) => nodeRunById.get(dep)?.status === 'succeeded')
      if (!depsOk) continue
      if (node.status === 'blocked') {
        node.status = 'queued'
        node.updatedAt = now
        changed = true
      }
      if (node.status === 'queued' && node.kind !== 'generation') {
        completeImmediateGraphNode(next, node, { now, quality })
        changed = true
      }
    }
  }
  next.updatedAt = now
  return next
}

export function recordWorkflowApprovalDecision(run, input, { actorId, now = Date.now(), quality } = {}) {
  const next = clone(run)
  const node = next.items[0]?.nodeRuns?.find((entry) => entry.nodeId === input?.nodeId)
  if (!node || node.kind !== 'approval') throw new Error('审批节点不存在。')
  if (node.status !== 'awaiting_approval') throw new Error('当前节点不可审批。')
  if (!['approved', 'rejected'].includes(input.decision)) throw new Error('审批决定无效。')
  const decision = {
    id: requiredText(input.id ?? `approval-${node.nodeId}-${now}`, '审批标识', 160),
    nodeId: node.nodeId,
    decision: input.decision,
    ...(input.comment ? { comment: requiredText(input.comment, '审批意见', 2_000) } : {}),
    actorId: requiredText(actorId, '操作者', 160),
    createdAt: now,
  }
  next.approvals = [...(next.approvals ?? []), decision]
  node.approvalDecisionId = decision.id
  node.status = input.decision === 'approved' ? 'succeeded' : 'failed'
  node.updatedAt = now
  if (input.decision === 'rejected') node.error = { code: 'APPROVAL_REJECTED', message: input.comment || '文案未批准。' }
  return advanceProductionWorkflowRun(next, { now, quality })
}

export function applyWorkflowNodeResult(run, nodeId, result, { now = Date.now(), quality } = {}) {
  const next = clone(run)
  const node = next.items[0]?.nodeRuns?.find((entry) => entry.nodeId === nodeId)
  if (!node || node.kind !== 'generation') throw new Error('生成节点不存在。')
  node.status = result.status
  node.updatedAt = now
  if (result.jobId) node.jobId = result.jobId
  if (result.artifactIds) node.artifactIds = clone(result.artifactIds)
  if (result.error) node.error = clone(result.error)
  const item = next.items.find((entry) => entry.id === (result.itemId ?? next.items[0].id))
  if (item && result.status === 'succeeded') {
    item.status = 'succeeded'
    item.jobId = result.jobId ?? item.jobId
    item.artifactIds = result.artifactIds ?? item.artifactIds
    item.updatedAt = now
  }
  return advanceProductionWorkflowRun(next, { now, quality })
}

export function retryFailedWorkflowNodes(run, nodeId, { now = Date.now() } = {}) {
  const next = clone(run)
  const node = next.items[0]?.nodeRuns?.find((entry) => entry.nodeId === nodeId)
  if (!node || node.kind !== 'generation' || node.status !== 'failed') throw new Error('没有可重试的失败生成节点。')
  node.status = 'queued'
  node.error = undefined
  node.updatedAt = now
  next.status = 'running'
  next.completedAt = undefined
  next.updatedAt = now
  return next
}

export function queuedGenerationNodeIds(run) {
  return (run.items[0]?.nodeRuns ?? [])
    .filter((node) => node.kind === 'generation' && node.status === 'queued')
    .map((node) => node.nodeId)
}
