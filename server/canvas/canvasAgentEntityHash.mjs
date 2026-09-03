// @ts-check

import { canonicalHash } from '../canonicalHash.mjs'

/** Hash 一个节点及其邻接边；无关画布变更不影响它。 */
export function canvasAgentEntityHash(document, nodeId) {
  const node = (document.nodes ?? []).find((item) => item.id === nodeId)
  if (!node) return undefined
  const edges = (document.edges ?? []).filter((edge) => edge.source === nodeId || edge.target === nodeId)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const { selected: _selected, ...stableNode } = node
  const memberIds = node.type === 'frame' ? (document.nodes ?? []).filter((item) => item.data?.frameId === nodeId).map((item) => item.id).sort() : []
  return canonicalHash({ node: stableNode, edges, ...(node.type === 'frame' ? { memberIds } : {}) })
}
