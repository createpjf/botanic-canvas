// @ts-check

function text(value, limit = 160) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined
}

// label 是用户可编辑的显示名；兼容只有 name/title 的历史节点。
export function canvasAgentNodeLabel(node) {
  return text(node?.data?.label) ?? text(node?.data?.name) ?? text(node?.data?.title) ?? text(node?.type, 40) ?? '未命名节点'
}

export function canvasAgentNodeStatus(node) {
  return text(node?.data?.taskStatus, 40) ?? text(node?.data?.status, 40) ?? (node?.type === 'generate' ? 'idle' : undefined)
}

/** 快照和实时读取共用的窄元数据；正文、坐标、权限与生成血缘各归其现有所有者。 */
export function canvasAgentNodeMetadata(node) {
  const data = node?.data ?? {}
  const status = canvasAgentNodeStatus(node)
  return {
    id: node.id, type: text(node.type, 40) ?? 'unknown', label: canvasAgentNodeLabel(node),
    ...(status ? { status } : {}),
    ...(text(data.role, 40) ? { role: text(data.role, 40) } : {}),
    ...(text(data.mediaKind, 40) ? { mediaKind: text(data.mediaKind, 40) } : {}),
    ...(text(data.frameId) ? { frameId: text(data.frameId) } : {}),
    ...(node.type === 'frame' && text(data.stage, 40) ? { stage: text(data.stage, 40) } : {}),
  }
}

export function canvasAgentEdgeRole(edge, nodeById) {
  return text(edge?.data?.role, 80) ?? text(nodeById.get(edge?.source)?.data?.role, 80)
}

export function canvasAgentEdgeMetadata(edge, nodeById) {
  const role = canvasAgentEdgeRole(edge, nodeById)
  return {
    ...(typeof edge.id === 'string' ? { id: edge.id } : {}),
    source: edge.source, target: edge.target,
    ...(text(edge.sourceHandle) ? { sourceHandle: text(edge.sourceHandle) } : {}),
    ...(text(edge.targetHandle) ? { targetHandle: text(edge.targetHandle) } : {}),
    ...(role ? { role } : {}),
    system: edge?.data?.system === true,
  }
}
