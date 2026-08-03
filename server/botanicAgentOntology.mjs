const NODE_LIMIT = 240
const EDGE_LIMIT = 400
const GROUP_LIMIT = 80

function text(value, maximumLength = 160) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maximumLength)
    : undefined
}

function nodeLabel(node) {
  const data = node?.data
  return text(data?.name) ?? text(data?.label) ?? text(data?.title) ?? node?.type ?? '未命名节点'
}

function nodeSummary(node) {
  if (!node || typeof node.id !== 'string' || !node.id.trim()) return undefined
  const summary = {
    id: node.id.trim().slice(0, 160),
    type: text(node.type, 40) ?? 'unknown',
    label: nodeLabel(node),
  }
  const role = text(node.data?.role, 40)
  const mediaKind = text(node.data?.mediaKind, 40)
  const status = text(node.data?.status, 40)
  if (role) summary.role = role
  if (mediaKind) summary.mediaKind = mediaKind
  if (status) summary.status = status
  return summary
}

export function buildBotanicAgentOntology(document, contextNodeIds = []) {
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  const nodeSummaries = nodes.map(nodeSummary).filter(Boolean).slice(0, NODE_LIMIT)
  const nodeIds = new Set(nodeSummaries.map((node) => node.id))
  const context = [...new Set((Array.isArray(contextNodeIds) ? contextNodeIds : [])
    .filter((id) => typeof id === 'string' && nodeIds.has(id.trim()))
    .map((id) => id.trim()))].slice(0, 32)
  const edges = (Array.isArray(document?.edges) ? document.edges : [])
    .filter((edge) => typeof edge?.source === 'string' && typeof edge?.target === 'string')
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .slice(0, EDGE_LIMIT)
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      relation: `${nodeSummaries.find((node) => node.id === edge.source)?.type ?? 'node'} -> ${nodeSummaries.find((node) => node.id === edge.target)?.type ?? 'node'}`,
    }))
  const assetGroups = (Array.isArray(document?.assetGroups) ? document.assetGroups : [])
    .filter((group) => typeof group?.id === 'string' && typeof group?.name === 'string')
    .slice(0, GROUP_LIMIT)
    .map((group) => ({
      id: group.id.slice(0, 160),
      name: group.name.trim().slice(0, 160),
      ...(text(group.role, 40) ? { role: text(group.role, 40) } : {}),
      assetCount: Array.isArray(group.assetIds) ? Math.min(1000, group.assetIds.length) : 0,
    }))

  return {
    project: {
      id: text(document?.id, 160) ?? 'unknown-project',
      name: text(document?.name, 160) ?? '未命名项目',
    },
    contextNodeIds: context,
    nodes: nodeSummaries,
    edges,
    assetGroups,
  }
}

export function safeBotanicAgentMemory(document) {
  return (Array.isArray(document?.agentMemory) ? document.agentMemory : [])
    .filter((item) => item && typeof item.id === 'string' && typeof item.kind === 'string' && typeof item.content === 'string')
    .slice(0, 30)
    .map((item) => ({
      id: item.id.slice(0, 160),
      kind: item.kind.slice(0, 32),
      content: item.content.trim().slice(0, 1000),
      sourceNodeIds: Array.isArray(item.sourceNodeIds) ? item.sourceNodeIds.filter((id) => typeof id === 'string').slice(0, 12) : [],
    }))
}

export function safeBotanicAgentSkills(skills) {
  return (Array.isArray(skills) ? skills : [])
    .filter((skill) => skill?.status === 'active' && typeof skill.id === 'string' && typeof skill.name === 'string' && typeof skill.instructions === 'string')
    .slice(0, 30)
    .map((skill) => ({
      id: skill.id.slice(0, 160),
      name: skill.name.trim().slice(0, 160),
      instructions: skill.instructions.trim().slice(0, 4000),
      status: 'active',
    }))
}
