import type { BotanicAgentArtifact } from './agent'

/** 血缘包含输入与输出；定位、继续编辑只使用输出，不改写历史血缘。 */
export function agentArtifactTargetNodeIds(artifact: BotanicAgentArtifact): string[] {
  const sources = [...new Set(artifact.provenance.sourceNodeIds ?? [])]
  if (artifact.metadata?.source !== 'generation') return sources
  const inputs = new Set<unknown>([artifact.metadata.parentNodeId])
  const provenance = artifact.metadata.inputProvenance
  if (provenance && typeof provenance === 'object') {
    const { references, parent } = provenance as { references?: unknown; parent?: unknown }
    for (const item of [...(Array.isArray(references) ? references : []), parent]) {
      if (item && typeof item === 'object' && 'nodeId' in item) inputs.add(item.nodeId)
    }
  }
  return sources.filter((id) => !inputs.has(id))
}
