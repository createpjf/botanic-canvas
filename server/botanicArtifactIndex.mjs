const artifactKinds = new Set(['image', 'video', 'text', 'workflow', 'asset_group', 'file'])
const originKinds = new Set(['agent_action', 'generation_output'])

const clone = (value) => structuredClone(value)

function invalid(message) {
  const error = new TypeError(message)
  error.code = 'INVALID_AGENT_ARTIFACT'
  throw error
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name}格式无效。`)
  return value
}

function text(value, name, maximumLength, { optional = false } = {}) {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || !value.trim()) invalid(`${name}不能为空。`)
  const result = value.trim()
  if (result.length > maximumLength) invalid(`${name}过长。`)
  return result
}

function timestamp(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback
}

function uniqueTextList(value, name, maximumItems, maximumLength = 160) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximumItems) invalid(`${name}格式无效。`)
  return [...new Set(value.map((item) => text(item, name, maximumLength)))]
}

function boundedObject(value, name, maximumBytes) {
  if (value === undefined) return undefined
  const result = clone(object(value, name))
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maximumBytes) invalid(`${name}过大。`)
  return result
}

function safeUrl(value) {
  if (value === undefined) return undefined
  const url = text(value, 'Artifact 地址', 2_048)
  if (url.startsWith('/api/media/')) return url
  try {
    if (new URL(url).protocol === 'https:') return url
  } catch {}
  invalid('Artifact 地址必须是同源媒体地址或 HTTPS 地址。')
}

/** Artifact Index 的稳定写模型；ID 只要求在同一项目内唯一。 */
export function validateIndexedArtifact(value, { now = Date.now() } = {}) {
  const artifact = object(value, 'Artifact')
  if (!artifactKinds.has(artifact.kind)) invalid('Artifact 类型无效。')
  const provenance = object(artifact.provenance, 'Artifact 血缘')
  const origin = object(artifact.origin, 'Artifact 来源')
  if (!originKinds.has(origin.type)) invalid('Artifact 来源类型无效。')
  const createdAt = timestamp(artifact.createdAt, now)
  const result = {
    id: text(artifact.id, 'Artifact 标识', 240),
    kind: artifact.kind,
    label: text(artifact.label, 'Artifact 名称', 240),
    provenance: {
      actionId: text(provenance.actionId, 'Artifact 行动标识', 240),
      toolName: text(provenance.toolName, 'Artifact 工具名称', 160),
      ...(provenance.runId === undefined ? {} : { runId: text(provenance.runId, 'Agent Run 标识', 160) }),
      ...(provenance.externalTool === undefined ? {} : { externalTool: text(provenance.externalTool, '外部工具名称', 240) }),
      sourceNodeIds: uniqueTextList(provenance.sourceNodeIds, 'Artifact 来源节点', 64),
    },
    origin: {
      type: origin.type,
      ...(origin.sessionId === undefined ? {} : { sessionId: text(origin.sessionId, 'Agent 会话标识', 160) }),
      ...(origin.messageId === undefined ? {} : { messageId: text(origin.messageId, 'Agent 消息标识', 160) }),
      ...(origin.actionId === undefined ? {} : { actionId: text(origin.actionId, 'Agent 行动标识', 240) }),
      ...(origin.jobId === undefined ? {} : { jobId: text(origin.jobId, '生成任务标识', 240) }),
      ...(origin.outputId === undefined ? {} : { outputId: text(origin.outputId, '生成输出标识', 240) }),
    },
    createdAt,
    updatedAt: Math.max(createdAt, timestamp(artifact.updatedAt, now)),
  }
  if (artifact.placement !== undefined) {
    if (artifact.placement !== 'canvas' && artifact.placement !== 'panel') invalid('Artifact 落点无效。')
    result.placement = artifact.placement
  }
  if (artifact.content !== undefined) result.content = text(artifact.content, 'Artifact 内容', 64_000)
  if (artifact.url !== undefined) result.url = safeUrl(artifact.url)
  if (artifact.mimeType !== undefined) result.mimeType = text(artifact.mimeType, 'Artifact MIME 类型', 160)
  if (artifact.metadata !== undefined) result.metadata = boundedObject(artifact.metadata, 'Artifact 元数据', 64 * 1024)
  return result
}

function collectSafely(items, create) {
  const artifacts = []
  for (const item of items) {
    try {
      artifacts.push(create(item))
    } catch {
      // 历史快照可能包含旧版或损坏产物；单条无效记录不能阻断整个项目回填。
    }
  }
  return artifacts
}

export function artifactsFromAgentMessage(message, {
  sessionId,
  updatedAt = message?.createdAt,
  now = Date.now(),
} = {}) {
  const actions = Array.isArray(message?.plan?.actions) ? message.plan.actions : []
  return actions.flatMap((action) => artifactsFromActionResult(action?.result, {
    actionId: action?.id,
    toolName: action?.toolName,
    sessionId,
    messageId: message?.id,
    createdAt: message?.createdAt,
    updatedAt,
    now,
  }))
}

export function artifactsFromActionResult(result, {
  actionId,
  toolName,
  sessionId,
  messageId,
  createdAt,
  updatedAt = createdAt,
  now = Date.now(),
} = {}) {
  return collectSafely(
    Array.isArray(result?.artifacts) ? result.artifacts : [],
    (artifact) => validateIndexedArtifact({
      ...clone(artifact),
      provenance: {
        actionId: artifact?.provenance?.actionId || actionId,
        toolName: artifact?.provenance?.toolName || toolName,
        ...clone(artifact?.provenance ?? {}),
      },
      origin: {
        type: 'agent_action',
        sessionId,
        messageId,
        actionId,
      },
      createdAt,
      updatedAt,
    }, { now }),
  )
}

export function artifactsFromActionReceipt(receipt, { now = Date.now() } = {}) {
  const result = receipt?.output?.artifacts
    ? receipt.output
    : receipt?.result?.output ?? receipt?.result ?? receipt?.output
  const toolCall = receipt?.toolCall ?? receipt?.result?.toolCall
  return artifactsFromActionResult(result, {
    actionId: receipt?.toolCallId ?? toolCall?.id,
    toolName: toolCall?.name,
    createdAt: receipt?.createdAt,
    now,
  })
}

export function artifactsFromGenerationJob(job, { document, now = Date.now() } = {}) {
  const committedOutputs = Array.isArray(job?.outputs)
    ? job.outputs.filter((output) => typeof output?.id === 'string' && output.id.trim() && typeof output?.image === 'string' && output.image.trim())
    : []
  const lateOutputs = Array.isArray(job?.lateOutputs)
    ? job.lateOutputs.filter((output) => typeof output?.id === 'string' && output.id.trim() && typeof output?.image === 'string' && output.image.trim())
    : []
  const outputs = [
    ...committedOutputs.map((output) => ({ ...output, late: false })),
    ...lateOutputs.map((output) => ({ ...output, late: true })),
  ]
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  const assets = Array.isArray(document?.assets) ? document.assets : []
  // 精修血缘（Epic 9.2「任一精修可回到父版本」）。
  //
  // 「不覆盖原件」本来就成立：每次精修是一个新 Job，产出新的 Artifact 标识。断的是
  // 另一半 —— 父子关系只记在 Job 的 `parentNodeId` 上，而 Artifact Index 是历史血缘
  // 目录、且**明确不随画布节点删除而级联删除**。节点一删，从 Artifact 就再也回不到
  // 父版本了，尽管两份原件都还在。
  //
  // 因此在这里把父版本身份**落到 Artifact 上**，而不是每次去画布上现查。
  const parentNode = job?.parentNodeId
    ? nodes.find((node) => node?.id === job.parentNodeId && node?.type === 'result')
    : undefined
  const parentArtifactId = job?.inputProvenance?.parent?.artifactId
    ?? (parentNode?.data?.jobId && parentNode?.data?.candidateId
    ? `generation:${parentNode.data.jobId}:${parentNode.data.candidateId}`
    // 早期单输出结果节点没有 candidateId，此时构造不出唯一的 Artifact 标识。
    // 宁可只留 parentNodeId，也不猜一个 —— 猜错会把血缘指到同一次任务的另一张图上。
    : undefined)
  return collectSafely(outputs, (output) => {
    const resultNode = !output.late && nodes.find((node) => node?.type === 'result'
      && node?.data?.jobId === job.id
      && (node?.data?.candidateId === output.id || (!node?.data?.candidateId && committedOutputs.length === 1)))
    const variant = Array.isArray(job.variants)
      ? job.variants.find((item) => item?.output?.id === output.id)
      : undefined
    const mediaKind = output.mediaKind === 'video' ? 'video' : 'image'
    const immutableSourceNodeIds = [
      ...(job.inputProvenance?.references ?? []).map((reference) => reference.nodeId),
      job.inputProvenance?.parent?.nodeId,
    ].filter(Boolean)
    const sourceNodeIds = [...new Set([
      ...(immutableSourceNodeIds.length
        ? immutableSourceNodeIds
        : Array.isArray(resultNode?.data?.sourceNodeIds) ? resultNode.data.sourceNodeIds : []),
      ...(resultNode?.id ? [resultNode.id] : []),
    ])]
    const completedAt = timestamp(variant?.completedAt, timestamp(job.updatedAt, timestamp(job.createdAt, now)))
    // 结果面板要展示“图 + 生成它的 prompt”；配方优先，回落到本次任务的原始请求。
    const prompt = [job.generationRecipe?.prompt, job.rawInput?.prompt]
      .find((value) => typeof value === 'string' && value.trim())
    return validateIndexedArtifact({
      id: `${output.late ? 'generation-late' : 'generation'}:${job.id}:${output.id}`,
      kind: mediaKind,
      label: output.late
        ? (mediaKind === 'video' ? '迟到视频（已隔离）' : '迟到图片（已隔离）')
        : resultNode?.data?.label?.trim() || (mediaKind === 'video' ? '生成视频' : '生成图片'),
      url: output.image,
      placement: output.late ? 'panel' : 'canvas',
      metadata: {
        source: 'generation',
        ...(prompt ? { prompt: prompt.trim().slice(0, 6_000) } : {}),
        status: output.late ? 'late_discarded' : job.status,
        jobId: job.id,
        branchId: job.agentRun?.branchId,
        groupId: job.agentRun?.runId,
        outputId: output.id,
        dismissed: output.late || (Array.isArray(job.dismissedOutputIds) && job.dismissedOutputIds.includes(output.id)),
        ...(output.late ? {
          quarantined: true,
          lateReason: output.reason,
          executionGeneration: output.executionGeneration,
        } : {}),
        savedToLibrary: assets.some((asset) => asset?.source === 'generated' && asset?.image === output.image),
        settings: clone(job.settings),
        // 编译计划指纹随 Artifact 一起落库：这是「任一 Artifact 可反查 Plan」的落点。
        // 顶层字段优先，回落到配方 —— 指纹上线前的历史任务只有配方里那一份。
        ...(job.planFingerprint ?? job.generationRecipe?.planFingerprint
          ? { planFingerprint: job.planFingerprint ?? job.generationRecipe?.planFingerprint }
          : {}),
        ...(job.branchFingerprint ?? job.generationRecipe?.branchFingerprint ?? job.generationRecipe?.sourcePlanFingerprint
          ? { branchFingerprint: job.branchFingerprint ?? job.generationRecipe?.branchFingerprint ?? job.generationRecipe?.sourcePlanFingerprint }
          : {}),
        ...(job.rawInput?.productionWorkflow
          ? { productionWorkflow: clone(job.rawInput.productionWorkflow) }
          : {}),
        // 父版本身份随 Artifact 落库，节点删除后仍能回到原件。
        ...(job.parentNodeId ? { parentNodeId: job.parentNodeId } : {}),
        ...(parentArtifactId ? { parentArtifactId } : {}),
        ...(job.targetBinding ? { targetBinding: clone(job.targetBinding) } : {}),
        ...(job.inputProvenance ? { inputProvenance: clone(job.inputProvenance) } : {}),
      },
      provenance: {
        actionId: `generation:${job.id}`,
        toolName: mediaKind === 'video' ? 'video_generation' : 'image_generation',
        runId: job.agentRun?.runId,
        sourceNodeIds,
      },
      origin: { type: 'generation_output', jobId: job.id, outputId: output.id },
      createdAt: output.late ? timestamp(output.recordedAt, completedAt) : completedAt,
      updatedAt: timestamp(job.updatedAt, completedAt),
    }, { now })
  })
}

export function artifactsFromDocument(document, { generationJobs = [], now = Date.now() } = {}) {
  const actionArtifacts = (Array.isArray(document?.agentSessions) ? document.agentSessions : []).flatMap((session) =>
    (Array.isArray(session?.messages) ? session.messages : []).flatMap((message) => artifactsFromAgentMessage(message, {
      sessionId: session.id,
      updatedAt: session.updatedAt,
      now,
    })),
  )
  const generationArtifacts = generationJobs.flatMap((job) => artifactsFromGenerationJob(job, { document, now }))
  return mergeArtifactRecords([...actionArtifacts, ...generationArtifacts])
}

export function mergeArtifactRecords(artifacts) {
  const byId = new Map()
  for (const artifact of artifacts) {
    if (!artifact?.id) continue
    const existing = byId.get(artifact.id)
    if (!existing || Number(artifact.updatedAt ?? 0) >= Number(existing.updatedAt ?? 0)) byId.set(artifact.id, clone(artifact))
  }
  return [...byId.values()].sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))
}

export function encodeArtifactCursor(artifact) {
  const createdAt = Number(artifact?.createdAt)
  const id = typeof artifact?.id === 'string' ? artifact.id : ''
  if (!Number.isFinite(createdAt) || createdAt < 0 || !id) invalid('Artifact 分页游标无效。')
  return Buffer.from(JSON.stringify([createdAt, id]), 'utf8').toString('base64url')
}

export function decodeArtifactCursor(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (/^\d+$/u.test(String(value))) {
    const createdAt = Number(value)
    if (Number.isFinite(createdAt)) return { createdAt }
  }
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    if (Number.isFinite(Number(createdAt)) && Number(createdAt) >= 0 && typeof id === 'string' && id) {
      return { createdAt: Number(createdAt), id }
    }
  } catch {}
  invalid('Artifact 分页游标无效。')
}

/**
 * 只读迁移对账：expected 是仍可从旧实体推导出的产物；索引中额外记录属于
 * 删除画布节点后应继续保留的历史，不视为失败。
 */
export function reconcileArtifactIndex({ expectedArtifacts = [], indexedArtifacts = [] } = {}) {
  const expectedIds = expectedArtifacts
    .map((artifact) => artifact?.id)
    .filter((id) => typeof id === 'string' && id.trim())
  const indexedIds = indexedArtifacts
    .map((artifact) => artifact?.id)
    .filter((id) => typeof id === 'string' && id.trim())
  const expected = new Set(expectedIds)
  const indexed = new Set(indexedIds)
  const missingIds = [...expected].filter((id) => !indexed.has(id)).sort()
  const retainedHistoryIds = [...indexed].filter((id) => !expected.has(id)).sort()
  return {
    status: missingIds.length ? 'failed' : 'passed',
    expectedCount: expected.size,
    indexedCount: indexed.size,
    missingCount: missingIds.length,
    retainedHistoryCount: retainedHistoryIds.length,
    duplicateExpectedCount: expectedIds.length - expected.size,
    missingIds,
    retainedHistoryIds,
  }
}

export const artifactIndexLimits = Object.freeze({ page: 200 })
