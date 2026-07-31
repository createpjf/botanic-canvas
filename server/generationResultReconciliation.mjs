function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function candidateLabel(kind, index) {
  return `${kind === 'refinement' ? '精修候选' : '生成候选'} ${index + 1}`
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

function persistedJob(job, generateNodeId, resultNodeId) {
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
    generateNodeId,
    resultNodeId,
  }
}

/** 将已成功、但未被浏览器写回的历史任务结果补入画布。 */
export function reconcileGenerationResults(document, jobs) {
  const next = clone(document)
  const nodes = Array.isArray(next.nodes) ? next.nodes : []
  const edges = Array.isArray(next.edges) ? next.edges : []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const usedJobIds = new Set(nodes
    .filter((node) => node.type === 'result' && node.data?.image && node.data?.jobId)
    .map((node) => node.data.jobId))
  const groups = nodes.filter((node) => node.type === 'result'
    && !node.data?.image
    && node.data?.outputOf
    && (!node.data?.taskGroupId || node.id === node.data.taskGroupId)
    // 曾被旧客户端误标为“图像服务没有返回结果”的任务，也应允许权威任务表纠正。
    && (node.data?.taskStatus === 'succeeded' || node.data?.status === 'ready'
      || node.data?.error === '图像服务没有返回结果，请重试。'
      || node.data?.error === '生成服务没有返回结果，请重试。'))
  let changed = false

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

    for (const [index, output] of (job.outputs ?? []).entries()) {
      const target = groupNodes[index]
      const data = {
        ...base,
        image: output.image,
        mediaKind: output.mediaKind ?? 'image',
        candidateId: output.id,
        taskNodeId: target?.id ?? `result-${output.id}`,
        label: candidateLabel(job.kind, index),
        variant: index,
      }
      if (target) {
        target.data = { ...target.data, ...data }
      } else {
        const id = `result-${job.id}-${output.id}`
        nodes.push({
          id,
          type: 'result',
          position: { x: root.position.x, y: root.position.y + index * 370 },
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
      changed = true
    }
    if (!changed) continue
    const record = persistedJob(job, result.outputOf, root.id)
    next.generationJobs = [record, ...(next.generationJobs ?? []).filter((item) => item.id !== job.id)].slice(0, 60)
  }

  return { document: changed ? { ...next, nodes, edges, updatedAt: Date.now() } : document, changed }
}
