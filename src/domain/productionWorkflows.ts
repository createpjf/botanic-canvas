import type { CanvasDocument, GenerateNodeData, ProductionWorkflowDefinition } from './canvas.ts'
import { buildGraphGenerationRecipe } from './generationRecipe.ts'

export type ProductionWorkflowDraft = {
  sourceNodeId: string
  sourceAgentRunId?: string
  name: string
  definition: ProductionWorkflowDefinition
}

/**
 * 只把已经落在画布中的生成操作提升为生产工作流。定义保留引用身份，
 * 不复制图片字节或临时 URL；服务端在运行时从项目权威文档解析稳定媒体。
 */
export function productionWorkflowDraftFromCanvas(
  document: CanvasDocument,
  preferredGenerateNodeId?: string,
): ProductionWorkflowDraft | null {
  const generateNodes = document.nodes.filter((node) => node.type === 'generate')
  const orderedNodes = preferredGenerateNodeId
    ? [...generateNodes.filter((node) => node.id === preferredGenerateNodeId), ...generateNodes.filter((node) => node.id !== preferredGenerateNodeId)]
    : generateNodes
  for (const node of orderedNodes) {
    const graph = buildGraphGenerationRecipe(document, node.id)
    const data = node.data as GenerateNodeData
    if (!graph?.prompt.trim() || !graph.recipe.references.length) continue
    const sourceRun = data.agentRun
      ? document.agentRuns.find((run) => run.id === data.agentRun?.runId && ['completed', 'partial'].includes(run.status))
      : undefined
    if (data.agentRun && !sourceRun) continue
    const referenceAssetIds = new Set(graph.recipe.references.map((reference) => reference.assetId))
    const assetGroupIds = document.assetGroups
      .filter((group) => group.assetIds.some((assetId) => referenceAssetIds.has(assetId)))
      .map((group) => group.id)
    const recipe = {
      ...graph.recipe,
      references: graph.recipe.references.map(({ image: _image, ...reference }) => reference),
      ...(sourceRun ? { sourceAgentRunId: sourceRun.id } : {}),
    }
    return {
      sourceNodeId: node.id,
      sourceAgentRunId: sourceRun?.id,
      name: `${data.label || '生产工作流'} · 自动化`,
      definition: {
        prompt: graph.prompt,
        model: data.settings.model,
        settings: { ...data.settings, batchCount: data.batchCount },
        output: {
          aspectRatio: data.settings.aspectRatio,
          resolution: data.settings.resolution,
          ...(data.settings.duration ? { duration: data.settings.duration } : {}),
          candidates: data.batchCount,
        },
        brandRules: document.agentMemory.map((item) => item.content),
        assetGroupIds,
        confirmationPolicy: 'before-submit',
        recipe,
      },
    }
  }
  return null
}
