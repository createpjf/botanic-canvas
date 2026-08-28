// @ts-check

export const AGENT_ENTITY_REFERENCES_PER_TOOL_LIMIT = 8
export const AGENT_ENTITY_REFERENCES_PER_TURN_LIMIT = 24

export const AGENT_ENTITY_REFERENCE_TYPES = Object.freeze([
  'agent_run',
  'generation_job',
  'artifact',
  'review_task',
  'workflow',
  'workflow_run',
  'delivery',
])

const referenceTypes = new Set(AGENT_ENTITY_REFERENCE_TYPES)
const stableEntityId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u
const toolReferenceTypes = Object.freeze({
  agent_run_read: new Set(['agent_run', 'generation_job']),
  generation_job_read: new Set(['generation_job', 'agent_run']),
  artifact_search: new Set(['artifact', 'agent_run', 'generation_job']),
  review_read: new Set(['review_task', 'agent_run', 'artifact']),
  workflow_run_read: new Set(['workflow_run', 'workflow', 'generation_job']),
  delivery_read: new Set(['delivery']),
  generation_submit: new Set(['agent_run', 'generation_job']),
  agent_branch_retry: new Set(['agent_run', 'generation_job']),
  agent_run_cancel: new Set(['agent_run']),
  artifact_promote: new Set(['artifact']),
  review_decide: new Set(['review_task', 'artifact']),
  review_retry: new Set(['review_task', 'artifact', 'agent_run']),
  workflow_publish: new Set(['workflow']),
  workflow_run_retry_failed: new Set(['workflow_run']),
})

function invalid(message) {
  throw Object.assign(new TypeError(message), { code: 'AGENT_ENTITY_REFERENCES_INVALID' })
}

function normalizedReference(value, name = 'Agent Entity Reference') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name}无效。`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(`${name}必须是普通对象。`)
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('id')) {
    invalid(`${name}包含不允许的字段。`)
  }
  if (typeof value.type !== 'string' || !referenceTypes.has(value.type)) invalid(`${name}类型无效。`)
  if (typeof value.id !== 'string' || !stableEntityId.test(value.id)) invalid(`${name}标识无效。`)
  return { type: value.type, id: value.id }
}

function deduplicatedReferences(values, maximum) {
  const references = []
  const seen = new Set()
  for (const value of values) {
    const reference = normalizedReference(value)
    const key = `${reference.type}:${reference.id}`
    if (seen.has(key)) continue
    seen.add(key)
    references.push(reference)
    if (references.length >= maximum) break
  }
  return references
}

/**
 * 持久化边界使用的严格投影。超限与非法字段都拒绝，不静默接受半份引用。
 */
export function validateAgentEntityReferences(value, options = {}) {
  const maximum = Math.max(0, Math.floor(Number(options.maximum) || AGENT_ENTITY_REFERENCES_PER_TURN_LIMIT))
  if (!Array.isArray(value) || value.length > maximum) invalid('Agent Entity References 数量无效。')
  return deduplicatedReferences(value, maximum)
}

/** Checkpoint 还要把引用类型绑定到产生它的显式工具，未知工具连空壳字段也不接受。 */
export function validateAgentToolEntityReferences(toolName, value) {
  const allowedTypes = typeof toolName === 'string' ? toolReferenceTypes[toolName] : undefined
  if (!allowedTypes) invalid('该工具不允许持久化业务引用。')
  const references = validateAgentEntityReferences(value, {
    maximum: AGENT_ENTITY_REFERENCES_PER_TOOL_LIMIT,
  })
  if (references.some((reference) => !allowedTypes.has(reference.type))) {
    invalid('工具业务引用类型与声明不匹配。')
  }
  return references
}

/** 多个可信工具结果按首见顺序合并；Turn 级上限在这里统一执行。 */
export function mergeAgentEntityReferences(...collections) {
  return deduplicatedReferences(
    collections.flatMap((collection) => (Array.isArray(collection) ? collection : [])),
    AGENT_ENTITY_REFERENCES_PER_TURN_LIMIT,
  )
}

function candidate(type, id) {
  if (typeof id !== 'string' || !stableEntityId.test(id)) return undefined
  return { type, id }
}

function array(value) {
  return Array.isArray(value) ? value : []
}

/**
 * 业务引用只从这里声明的「工具名 + 固定结果路径」提取。
 *
 * 禁止按 `*Id` 递归扫描：未知/MCP 输出可能含 URL、Prompt、媒体元数据或攻击者
 * 控制的任意 JSON；它们即使长得像业务标识，也不能进入 Turn/Message/Summary。
 */
const toolReferenceCandidates = Object.freeze({
  agent_run_read(output) {
    return [
      candidate('agent_run', output?.run?.id),
      ...array(output?.run?.branches).map((branch) => candidate('generation_job', branch?.activeJobId)),
    ]
  },
  generation_job_read(output) {
    return [
      candidate('generation_job', output?.job?.id),
      candidate('agent_run', output?.job?.agentRun?.runId),
    ]
  },
  artifact_search(output) {
    const artifacts = array(output?.artifacts)
    return [
      ...artifacts.map((artifact) => candidate('artifact', artifact?.id)),
      ...artifacts.map((artifact) => candidate('agent_run', artifact?.provenance?.runId)),
      ...artifacts.map((artifact) => candidate('generation_job', artifact?.jobId)),
    ]
  },
  review_read(output) {
    const tasks = array(output?.tasks)
    return [
      ...tasks.map((task) => candidate('review_task', task?.id)),
      ...tasks.map((task) => candidate('agent_run', task?.runId)),
      ...tasks.flatMap((task) => array(task?.results)
        .map((result) => candidate('artifact', result?.artifactId))),
      ...tasks.flatMap((task) => array(task?.decisions)
        .map((decision) => candidate('artifact', decision?.artifactId))),
    ]
  },
  workflow_run_read(output) {
    return [
      candidate('workflow_run', output?.run?.id),
      candidate('workflow', output?.run?.workflowId),
      ...array(output?.run?.items).map((item) => candidate('generation_job', item?.jobId)),
    ]
  },
  delivery_read(output) {
    return array(output?.deliveries).map((delivery) => candidate('delivery', delivery?.id))
  },
  generation_submit(output) {
    return [
      candidate('agent_run', output?.run?.id),
      ...array(output?.jobIds).map((jobId) => candidate('generation_job', jobId)),
    ]
  },
  agent_branch_retry(output) {
    return [
      candidate('agent_run', output?.runId),
      candidate('generation_job', output?.jobId),
    ]
  },
  agent_run_cancel(output) {
    return [candidate('agent_run', output?.runId)]
  },
  artifact_promote(output) {
    return [candidate('artifact', output?.artifactId)]
  },
  review_decide(output) {
    return [
      candidate('review_task', output?.taskId),
      candidate('artifact', output?.artifactId),
    ]
  },
  review_retry(output) {
    return [
      candidate('review_task', output?.taskId),
      candidate('artifact', output?.artifactId),
      candidate('agent_run', output?.runId),
    ]
  },
  workflow_publish(output) {
    return [candidate('workflow', output?.workflowId)]
  },
  workflow_run_retry_failed(output) {
    return [candidate('workflow_run', output?.runId)]
  },
})

export function extractAgentEntityReferences(toolName, output) {
  const extractor = typeof toolName === 'string' ? toolReferenceCandidates[toolName] : undefined
  if (typeof extractor !== 'function') return []
  const candidates = extractor(output).filter(Boolean)
  return deduplicatedReferences(candidates, AGENT_ENTITY_REFERENCES_PER_TOOL_LIMIT)
}
