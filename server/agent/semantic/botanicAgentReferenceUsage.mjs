import { AGENT_REFERENCE_STAGES, AGENT_REFERENCE_MODES, AGENT_REFERENCE_REASONS } from '../../agentProtocol.mjs'

const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value)

/** 白名单投影：原图、caption、标签和 Provider body 都不能进入事件。 */
export function safeAgentReferenceUsage(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  return value.slice(0, 32).flatMap((item) => {
    if (!item || !validId(item.nodeId) || seen.has(item.nodeId)
      || !AGENT_REFERENCE_STAGES.includes(item.stage) || !AGENT_REFERENCE_MODES.includes(item.mode)
      || ((item.stage === 'prepared' || item.stage === 'submitted') && item.mode === 'none')) return []
    seen.add(item.nodeId)
    return [{ nodeId: item.nodeId, stage: item.stage, mode: item.mode,
      ...(AGENT_REFERENCE_REASONS.includes(item.reason) ? { reason: item.reason } : {}) }]
  })
}

function failureReason(caught) {
  if (AGENT_REFERENCE_REASONS.includes(caught)) return caught
  const status = Number(caught?.statusCode ?? caught?.status)
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 404) return 'unavailable'
  if (status === 413) return 'too_large'
  if (status === 415) return 'unsupported'
  return 'network'
}

/** 仅当轮的视觉准备记录；不进入 Message、Run、Plan 或 Checkpoint。 */
export function createAgentReferenceUsage(document, contextNodeIds = []) {
  const nodes = new Map((document?.nodes ?? []).map((node) => [node.id, node]))
  const ids = [...new Set(contextNodeIds)].filter((id) => {
    const node = nodes.get(id)
    return validId(id) && (!node || node.type === 'asset' || node.type === 'result')
  }).slice(0, 32)
  const failures = new Map()
  let prepared = new Map()
  let mode = 'none'
  return {
    failed(nodeId, caught) { failures.set(nodeId, failureReason(caught)) },
    prepared(records, nextMode) { prepared = new Map(records.map((record) => [record.nodeId, record])); mode = nextMode },
    async publish(emit, messages, knownOnly = false) {
      if (!ids.length || typeof emit !== 'function') return
      const images = new Set((messages ?? []).flatMap((message) => Array.isArray(message.content)
        ? message.content.flatMap((part) => part?.type === 'image_url' ? [part.image_url?.url] : []) : []))
      const text = (messages ?? []).flatMap((message) => typeof message.content === 'string' ? [message.content]
        : Array.isArray(message.content) ? message.content.flatMap((part) => typeof part?.text === 'string' ? [part.text] : []) : [])
      const items = ids.flatMap((nodeId) => {
        const record = prepared.get(nodeId)
        if (!record) {
          if (knownOnly && !failures.has(nodeId)) return []
          const reason = failures.get(nodeId) ?? 'unavailable'
          return { nodeId, mode: 'none', stage: reason === 'limit' ? 'omitted' : 'failed', reason }
        }
        if (!messages) return { nodeId, stage: 'prepared', mode }
        const included = mode === 'image' ? images.has(record.part?.image_url?.url)
          : Boolean(record.description && text.some((content) => content.includes(record.description)))
        return included ? { nodeId, stage: 'submitted', mode }
          : { nodeId, stage: 'omitted', mode: 'none', reason: 'context_omitted' }
      })
      // 展示失败不改变业务结果。传出的只是白名单元数据。
      try { await emit({ type: 'references', items: safeAgentReferenceUsage(items) }) } catch { /* 由事件通道处理连接失败。 */ }
    },
  }
}

/** 准备阶段可能先于 ToolLoop 失败；仍以当前 attempt 的白名单事件留下原因。 */
export async function publishAgentReferencePreparationFailure(references, options, attemptId) {
  if (typeof options.onEvent !== 'function') return
  try { await options.onEvent({ type: 'attempt', action: 'start', attemptId }) } catch (caught) {
    if (options.requireDurableAttemptReset === true) throw caught
  }
  await references.publish((event) => options.onEvent({ ...event, attemptId }), undefined, true)
}

/** 观察实际传入 Provider 的消息（已经过 ToolLoop compaction），不是候选列表。 */
export async function sampleWithAgentReferences(provider, request, references, emit) {
  request.signal?.throwIfAborted()
  const sampling = provider.sample(request)
  const [result] = await Promise.all([sampling, references?.publish(emit, request.messages)])
  return result
}

export function agentReferenceEventPayload(event) {
  if (event?.type !== 'references' || !validId(event.attemptId)) return undefined
  const items = safeAgentReferenceUsage(event.items)
  return items.length ? { attemptId: event.attemptId, items } : undefined
}
