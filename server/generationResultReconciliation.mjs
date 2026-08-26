function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function candidateLabel(kind, index) {
  return `${kind === 'refinement' ? '精修候选' : '生成候选'} ${index + 1}`
}

function preservedResultLabel(current, kind, index) {
  const fallback = candidateLabel(kind, index)
  const value = typeof current === 'string' ? current.trim() : ''
  if (!value || value === fallback || value === 'Agent 结果') return fallback
  return value
}

function agentNodeIds(job) {
  const suffix = job?.agentRun?.runId && job?.agentRun?.branchId
    ? `${job.agentRun.runId}-${job.agentRun.branchId}`.replace(/[^A-Za-z0-9_-]/g, '-')
    : undefined
  if (job?.generateNodeId && job?.resultNodeId) {
    return {
      promptNodeId: job.promptNodeId ?? (suffix ? `agent-prompt-${suffix}` : undefined),
      generateNodeId: job.generateNodeId,
      resultNodeId: job.resultNodeId,
    }
  }
  if (!suffix) return {}
  return {
    promptNodeId: `agent-prompt-${suffix}`,
    generateNodeId: `agent-generate-${suffix}`,
    resultNodeId: `agent-result-${suffix}`,
  }
}

function recoveredRecipe(job) {
  const recipe = job?.generationRecipe
  if (!recipe || !Array.isArray(recipe.references)) return undefined
  return {
    ...recipe,
    references: recipe.references.map((reference) => ({ ...reference })),
  }
}

function recoveredPosition(job, key, fallback) {
  const position = job?.[key]
  if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) return fallback
  return { x: Number(position.x), y: Number(position.y) }
}

function outputIsProjected(nodes, job, output) {
  return nodes.some((node) => {
    if (node.type !== 'result' || node.data?.jobId !== job.id || !node.data?.image) return false
    if (node.data.candidateId === output.id) return true
    return job.outputs.length === 1 && !node.data.candidateId
  })
}

function agentResultPlaceholder({ id, generate, job, settings, generationKind, recipe, position, variant = 0 }) {
  return {
    id,
    type: 'result',
    position,
    draggable: true,
    selected: false,
    data: {
      kind: 'result',
      outputOf: generate.id,
      label: 'Agent 结果',
      status: 'generating',
      taskStatus: 'queued',
      jobId: job.id,
      taskGroupId: id,
      taskNodeId: id,
      variant,
      generationKind,
      refinementMode: job.refinementMode ?? 'faithful',
      generationSettings: settings,
      agentRun: job.agentRun,
      ...(recipe ? { generationRecipe: recipe, rootRecipe: recipe } : {}),
    },
  }
}

function sourceHandleForNode(node) {
  return node?.type === 'asset' ? 'asset-output' : 'output'
}

function ensureAgentGenerationPlaceholder(next, job) {
  if (!job?.agentRun || job.status !== 'succeeded' || !job.outputs?.length) return false
  const { promptNodeId, generateNodeId, resultNodeId } = agentNodeIds(job)
  if (!generateNodeId || !resultNodeId) return false
  const nodes = next.nodes
  let changed = false
  let generate = nodes.find((node) => node.id === generateNodeId && node.type === 'generate')
    ?? nodes.find((node) => node.type === 'generate' && node.data?.jobId === job.id)
  let result = nodes.find((node) => node.type === 'result' && node.data?.jobId === job.id && !node.data?.image)
    ?? nodes.find((node) => node.id === resultNodeId && node.type === 'result')
    ?? nodes.find((node) => node.type === 'result' && node.data?.jobId === job.id)
  const settings = job.settings ?? job.rawInput?.settings ?? {}
  const generationKind = job.kind ?? job.rawInput?.kind ?? 'generation'
  const recipe = recoveredRecipe(job)

  if (!generate) {
    const position = recoveredPosition(job, 'generateNodePosition', { x: 0, y: 0 })
    generate = {
      id: generateNodeId,
      type: 'generate',
      position,
      draggable: true,
      selected: false,
      data: {
        kind: 'generate',
        label: 'Agent 生成',
        prompt: '',
        batchCount: job.batchCount ?? job.rawInput?.batchCount ?? job.outputs.length,
        settings,
        status: 'succeeded',
        generationKind,
        refinementMode: job.refinementMode ?? 'faithful',
        jobId: job.id,
        agentRun: job.agentRun,
      },
    }
    nodes.push(generate)
    changed = true
  }

  let prompt = promptNodeId
    ? nodes.find((node) => node.id === promptNodeId && node.type === 'text')
    : undefined
  if (!prompt && promptNodeId) {
    prompt = {
      id: promptNodeId,
      type: 'text',
      position: { x: generate.position?.x ?? 0, y: (generate.position?.y ?? 0) - 172 },
      draggable: true,
      selected: false,
      data: {
        kind: 'text',
        label: generationKind === 'refinement' ? '精修描述' : '生成描述',
        content: job.rawInput?.prompt ?? recipe?.prompt ?? '',
      },
    }
    nodes.push(prompt)
    changed = true
  }

  const missingOutputIndexes = job.outputs
    .map((output, index) => outputIsProjected(nodes, job, output) ? -1 : index)
    .filter((index) => index >= 0)
  if (result?.data?.image && missingOutputIndexes.length) {
    const pendingResultId = `${resultNodeId}-pending`
    result = nodes.find((node) => node.id === pendingResultId && node.type === 'result')
    if (!result) {
      result = agentResultPlaceholder({
        id: pendingResultId,
        generate,
        job,
        settings,
        generationKind,
        recipe,
        position: recoveredPosition(job, 'resultNodePosition', {
          x: (generate.position?.x ?? 0) + 460,
          y: (generate.position?.y ?? 0) + missingOutputIndexes[0] * 370,
        }),
        variant: missingOutputIndexes[0],
      })
      nodes.push(result)
      changed = true
    }
  }

  if (!result) {
    const position = recoveredPosition(job, 'resultNodePosition', {
      x: (generate.position?.x ?? 0) + 460,
      y: generate.position?.y ?? 0,
    })
    result = agentResultPlaceholder({ id: resultNodeId, generate, job, settings, generationKind, recipe, position })
    nodes.push(result)
    changed = true
  } else {
    const data = result.data ?? {}
    const nextData = {
      ...data,
      outputOf: data.outputOf ?? generate.id,
      jobId: data.jobId ?? job.id,
      taskGroupId: data.taskGroupId ?? result.id,
      taskNodeId: data.taskNodeId ?? result.id,
      generationKind: data.generationKind ?? generationKind,
      refinementMode: data.refinementMode ?? job.refinementMode ?? 'faithful',
      generationSettings: data.generationSettings ?? settings,
      agentRun: data.agentRun ?? job.agentRun,
      ...(recipe && !data.generationRecipe ? { generationRecipe: recipe } : {}),
      ...(recipe && !data.rootRecipe ? { rootRecipe: recipe } : {}),
    }
    if (JSON.stringify(nextData) !== JSON.stringify(data)) {
      result.data = nextData
      changed = true
    }
  }

  if (!next.edges.some((edge) => edge.source === generate.id && edge.target === result.id)) {
    next.edges.push({
      id: `agent-output-edge-${job.id}-${result.id}`,
      source: generate.id,
      sourceHandle: 'output',
      target: result.id,
      targetHandle: 'input',
      type: 'default',
      style: { stroke: '#2a5238', strokeWidth: 1.7 },
      data: { system: true, role: 'output' },
      reconnectable: false,
    })
    changed = true
  }
  if (prompt && !next.edges.some((edge) => edge.data?.role === 'prompt'
    && edge.source === prompt.id
    && edge.target === generate.id)) {
    next.edges.push({
      id: `agent-prompt-edge-${job.id}`,
      source: prompt.id,
      sourceHandle: 'output',
      target: generate.id,
      targetHandle: 'input',
      type: 'default',
      style: { stroke: '#8bad97', strokeWidth: 1.4 },
      data: { system: true, role: 'prompt' },
      reconnectable: false,
    })
    changed = true
  }
  const parent = generationKind === 'refinement' && job.parentNodeId
    ? nodes.find((node) => node.id === job.parentNodeId && node.type === 'result')
    : undefined
  if (parent && !next.edges.some((edge) => edge.data?.role === 'parent'
    && edge.source === parent.id
    && edge.target === generate.id)) {
    next.edges.push({
      id: `agent-parent-edge-${job.id}`,
      source: parent.id,
      sourceHandle: sourceHandleForNode(parent),
      target: generate.id,
      targetHandle: 'input',
      type: 'default',
      style: { stroke: '#2a5238', strokeWidth: 1.7 },
      data: { system: true, role: 'parent' },
      reconnectable: false,
    })
    changed = true
  }
  for (const reference of recipe?.references ?? []) {
    if (!reference.nodeId || !nodes.some((node) => node.id === reference.nodeId)) continue
    if (next.edges.some((edge) => edge.data?.role === 'reference'
      && edge.source === reference.nodeId
      && edge.target === generate.id)) continue
    next.edges.push({
      id: `agent-reference-edge-${job.id}-${reference.nodeId}`,
      source: reference.nodeId,
      sourceHandle: sourceHandleForNode(nodes.find((node) => node.id === reference.nodeId)),
      target: generate.id,
      targetHandle: 'input',
      type: 'default',
      style: { stroke: '#8bad97', strokeWidth: 1.4 },
      data: { system: true, role: 'reference' },
      reconnectable: false,
    })
    changed = true
  }
  return changed
}

function jobSubmissionSettings(job) {
  const settings = job?.settings ?? job?.rawInput?.settings
  return settings && typeof settings.model === 'string' && settings.aspectRatio ? settings : undefined
}

function settingsMatchSubmission(snapshot, settings) {
  if (!snapshot) return false
  return snapshot.model === settings.model
    && snapshot.aspectRatio === settings.aspectRatio
    && (snapshot.resolution ?? null) === (settings.resolution ?? null)
}

/**
 * 一次性数据修复（幂等）：旧版恢复兜底曾把已落图任务的任务号错配进新占位节点，
 * 随后的对账又用占位节点的参数快照覆写了持有旧图的历史节点。任务存储里的提交
 * 参数是权威，据此：
 * - 持图节点的参数快照与产出它的任务不一致时，按任务提交参数回填（含血缘）；
 * - 占位节点声称的任务已在其他节点完整落图时，交还给真正以它为落点的任务，
 *   找不到原任务就如实标记失败，不再永远显示「等待生成结果」。
 */
function repairMisattributedGenerationHistory(next, jobs) {
  let changed = false
  const jobById = new Map((jobs ?? []).map((job) => [job.id, job]))
  const outputSourceByTarget = new Map()
  for (const edge of next.edges) {
    if (edge?.data?.role === 'output' && edge.source && edge.target) outputSourceByTarget.set(edge.target, edge.source)
  }
  const generateNodeIds = new Set(next.nodes.filter((node) => node.type === 'generate').map((node) => node.id))

  for (const node of next.nodes) {
    if (node.type !== 'result') continue
    const data = node.data ?? {}
    const job = data.jobId ? jobById.get(data.jobId) : undefined
    if (!job) continue

    if (data.image) {
      if (job.status !== 'succeeded') continue
      const settings = jobSubmissionSettings(job)
      if (!settings) continue
      const output = (job.outputs ?? []).find((item) => item.id === data.candidateId)
        ?? ((job.outputs ?? []).length === 1 && !data.candidateId ? job.outputs[0] : undefined)
      // 只在能确认「这个节点持有的正是这个任务的这份输出」时修复，身份对不上一律不动。
      if (!output || output.image !== data.image) continue
      if (settingsMatchSubmission(data.generationSettings, settings)) continue
      const recipe = recoveredRecipe(job)
      const edgeSource = outputSourceByTarget.get(node.id)
      node.data = {
        ...data,
        generationSettings: { ...settings },
        ...(recipe ? { generationRecipe: recipe } : {}),
        generationKind: job.kind ?? data.generationKind,
        refinementMode: job.refinementMode ?? data.refinementMode,
        // 血缘按画布上的系统输出连线恢复；被覆写的分组指针指向别的任务根，
        // 回归自身可避免旧任务根的批量状态更新再次波及本节点。
        outputOf: edgeSource && generateNodeIds.has(edgeSource) ? edgeSource : data.outputOf,
        taskGroupId: node.id,
        taskNodeId: node.id,
        submittedAt: job.createdAt ?? data.submittedAt,
      }
      changed = true
      continue
    }

    if (job.status !== 'succeeded' || !(job.outputs ?? []).length) continue
    const stolen = job.outputs.every((output) => outputIsProjected(next.nodes, job, output))
    if (!stolen) continue
    const reclaimed = (jobs ?? []).find((candidate) => candidate.id !== job.id
      && (candidate.resultNodeId === node.id || (data.taskGroupId && candidate.resultNodeId === data.taskGroupId))
      && !(candidate.status === 'succeeded' && (candidate.outputs ?? []).length
        && candidate.outputs.every((output) => outputIsProjected(next.nodes, candidate, output))))
    if (reclaimed) {
      node.data = {
        ...data,
        jobId: reclaimed.id,
        status: reclaimed.status === 'succeeded'
          ? 'ready'
          : reclaimed.status === 'failed'
            ? 'failed'
            : reclaimed.status === 'cancelled' ? 'cancelled' : 'generating',
        taskStatus: reclaimed.status,
        error: reclaimed.error,
      }
    } else {
      node.data = {
        ...data,
        jobId: undefined,
        status: 'failed',
        taskStatus: 'failed',
        error: '任务恢复时被错误关联到旧任务，且找不到原任务记录；请重新生成。',
      }
    }
    changed = true
  }
  return changed
}

function matchingJob({ result, generate, jobs, usedJobIds }) {
  const explicitId = result.jobId ?? generate?.data?.jobId
  if (explicitId) return jobs.find((job) => job.id === explicitId && job.status === 'succeeded' && job.outputs?.length)
  const kind = result.generationKind ?? generate?.data?.generationKind ?? 'generation'
  const submittedAt = Number(result.submittedAt) || 0
  return jobs
    .filter((job) => !usedJobIds.has(job.id) && job.status === 'succeeded' && job.kind === kind && job.outputs?.length)
    .sort((left, right) => Math.abs(left.createdAt - submittedAt) - Math.abs(right.createdAt - submittedAt))[0]
}

function persistedJob(job, generateNodeId, resultNodeId, existing = {}) {
  return {
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
    generateNodeId: generateNodeId ?? job.generateNodeId ?? existing.generateNodeId,
    promptNodeId: job.promptNodeId ?? existing.promptNodeId,
    resultNodeId: resultNodeId ?? job.resultNodeId ?? existing.resultNodeId,
    parentNodeId: job.parentNodeId ?? existing.parentNodeId,
    agentRun: job.agentRun ?? existing.agentRun,
  }
}

export function retargetGenerationJobForRetry(document, previousJobId, nextJobId, now = Date.now()) {
  let changed = false
  const next = clone(document)
  next.nodes = (next.nodes ?? []).map((node) => {
    if (node.data?.jobId !== previousJobId) return node
    changed = true
    if (node.type === 'result') return {
      ...node,
      data: { ...node.data, jobId: nextJobId, status: 'generating', taskStatus: 'queued', submittedAt: now, error: undefined },
    }
    if (node.type === 'generate') return {
      ...node,
      data: { ...node.data, jobId: nextJobId, status: 'queued', error: undefined },
    }
    return node
  })
  next.generationJobs = (next.generationJobs ?? []).map((job) => job.id !== previousJobId ? job : {
    ...job,
    id: nextJobId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    outputCount: 0,
    outputs: [],
    error: undefined,
  })
  return { document: changed ? { ...next, updatedAt: now } : document, changed }
}

/** 将已成功、但未被浏览器写回的历史任务结果补入画布。 */
export function reconcileGenerationResults(document, jobs, { ensureAgentPlaceholders = false } = {}) {
  const next = clone(document)
  const nodes = Array.isArray(next.nodes) ? next.nodes : []
  const edges = Array.isArray(next.edges) ? next.edges : []
  next.nodes = nodes
  next.edges = edges
  let changed = false
  if (ensureAgentPlaceholders) {
    for (const job of jobs ?? []) changed = ensureAgentGenerationPlaceholder(next, job) || changed
  }
  // 先修复被错配恢复污染的节点，再做常规回填：被交还真实任务的占位节点
  // 可以在同一次对账里直接拿到自己的输出。
  changed = repairMisattributedGenerationHistory(next, jobs) || changed
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const usedJobIds = new Set(nodes
    .filter((node) => node.type === 'result' && node.data?.image && node.data?.jobId)
    .map((node) => node.data.jobId))
  const groups = nodes.filter((node) => node.type === 'result'
    && !node.data?.image
    && node.data?.outputOf
    && (!node.data?.taskGroupId || node.id === node.data.taskGroupId)
    // 曾被旧客户端误标为“图像服务没有返回结果”的任务，也应允许权威任务表纠正。
    && (['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(node.data?.taskStatus) || node.data?.status === 'ready'
      || node.data?.error === '图像服务没有返回结果，请重试。'
      || node.data?.error === '生成服务没有返回结果，请重试。'))
  for (const root of groups) {
    const result = root.data
    const generate = nodeById.get(result.outputOf)
    const job = matchingJob({ result, generate, jobs, usedJobIds })
    if (!job) continue
    usedJobIds.add(job.id)
    const groupNodes = nodes.filter((node) => node.type === 'result'
      && !node.data?.image
      && (node.id === root.id || node.data?.taskGroupId === root.id))
      .sort((left, right) => (left.data?.variant ?? 0) - (right.data?.variant ?? 0))
    const base = { ...result, taskGroupId: root.id, status: 'ready', taskStatus: 'succeeded', jobId: job.id, error: undefined }

    let groupChanged = false
    const usedTargetNodeIds = new Set()
    for (const [index, output] of (job.outputs ?? []).entries()) {
      // 已在画布上落图的输出是既成历史，不允许重复投影：占位节点被错配上旧任务号时，
      // 按「任务号 + 候选号」会命中持有旧图的历史节点，用占位节点的参数快照（base）
      // 覆写它就是篡改历史（画框比例、分辨率、模型、血缘全被换成下游任务的）。
      if (outputIsProjected(nodes, job, output)) continue
      const target = nodes.find((node) => node.type === 'result'
        && !node.data?.image
        && node.data?.jobId === job.id
        && node.data?.candidateId === output.id)
        ?? groupNodes.find((node) => !usedTargetNodeIds.has(node.id) && node.data?.variant === index)
        ?? groupNodes.find((node) => !usedTargetNodeIds.has(node.id))
      const data = {
        ...base,
        image: output.image,
        mediaKind: output.mediaKind ?? 'image',
        candidateId: output.id,
        taskNodeId: target?.id ?? `result-${output.id}`,
        label: preservedResultLabel(target?.data?.label, job.kind, index),
        variant: index,
      }
      if (target) {
        const nextData = { ...target.data, ...data }
        if (JSON.stringify(nextData) !== JSON.stringify(target.data)) {
          target.data = nextData
          groupChanged = true
        }
        usedTargetNodeIds.add(target.id)
      } else {
        const id = `result-${job.id}-${output.id}`
        nodes.push({
          id,
          type: 'result',
          position: { x: root.position?.x ?? 0, y: (root.position?.y ?? 0) + index * 370 },
          draggable: true,
          selected: false,
          data: { ...data, taskNodeId: id },
        })
        if (!edges.some((edge) => edge.source === result.outputOf && edge.target === id)) {
          edges.push({
            id: `output-edge-${job.id}-${output.id}`,
            source: result.outputOf,
            sourceHandle: 'output',
            target: id,
            targetHandle: 'input',
            type: 'default',
            style: { stroke: '#2a5238', strokeWidth: 1.7 },
            data: { system: true, role: 'output' },
            reconnectable: false,
          })
        }
      }
      groupChanged = true
    }
    if (!groupChanged) continue
    changed = true
    const existing = next.generationJobs?.find((item) => item.id === job.id) ?? {}
    const record = persistedJob(job, result.outputOf, root.id, existing)
    next.generationJobs = [record, ...(next.generationJobs ?? []).filter((item) => item.id !== job.id)].slice(0, 60)
  }

  return { document: changed ? { ...next, nodes, edges, updatedAt: Date.now() } : document, changed }
}

export function generationJobProjectionComplete(document, job) {
  if (job?.status !== 'succeeded' || !Array.isArray(job.outputs) || !job.outputs.length) return true
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  return job.outputs.every((output) => nodes.some((node) => node.type === 'result'
    && node.data?.jobId === job.id
    && typeof node.data?.image === 'string'
    && node.data.image
    && (node.data.candidateId === output.id || (job.outputs.length === 1 && !node.data.candidateId))))
}
