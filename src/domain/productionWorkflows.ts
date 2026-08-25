import type {
  CanvasDocument,
  GenerateNodeData,
  ProductionWorkflowDefinition,
  ProductionWorkflowSource,
  ResultNodeData,
} from './canvas.ts'
import { buildGraphGenerationRecipe } from './generationRecipe.ts'

export type ProductionWorkflowDraft = {
  /** 来源身份的唯一表达；不再另存 `sourceNodeId`，避免同一事实有两处副本。 */
  source: ProductionWorkflowSource
  sourceAgentRunId?: string
  name: string
  definition: ProductionWorkflowDefinition
}

/** 提升被拒绝的具体原因；UI 据此说明下一步，不回退到别的节点。 */
export type ProductionWorkflowDraftRejection =
  | 'source_not_selected'
  | 'node_not_found'
  | 'not_generate_node'
  | 'prompt_empty'
  | 'run_not_terminal'

export type ProductionWorkflowDraftResult =
  | { ok: true; draft: ProductionWorkflowDraft }
  | { ok: false; reason: ProductionWorkflowDraftRejection }

/** 可作为发布来源的生成节点摘要；供发布面板显式列举，不做隐式挑选。 */
export type ProductionWorkflowSourceOption = {
  nodeId: string
  label: string
  runId?: string
  branchId?: string
  resultCount: number
  hasReferences: boolean
}

const terminalRunStatuses = ['completed', 'partial']

/**
 * 该生成节点已产出、且带稳定任务与候选标识的结果节点。
 * Agent 分支优先按 Run/分支归属匹配；非 Agent 节点按 `outputOf` 溯源。
 */
function sourceResultNodeIds(document: CanvasDocument, generateNodeId: string, agentRun?: { runId: string; branchId: string }) {
  return document.nodes.flatMap((node) => {
    if (node.type !== 'result') return []
    const data = node.data as ResultNodeData
    if (!data.image || !data.jobId || !data.candidateId) return []
    const matches = agentRun
      ? data.agentRun?.runId === agentRun.runId && data.agentRun?.branchId === agentRun.branchId
      : data.outputOf === generateNodeId
    return matches ? [node.id] : []
  })
}

function generateNodes(document: CanvasDocument) {
  return document.nodes.filter((node) => node.type === 'generate')
}

/**
 * 列举当前画布上全部可提升的生成节点。返回顺序即画布节点顺序；
 * 调用方必须让用户显式选择其中一个，不得代为挑选。
 */
export function eligibleProductionWorkflowSources(document: CanvasDocument): ProductionWorkflowSourceOption[] {
  return generateNodes(document).flatMap((node) => {
    const graph = buildGraphGenerationRecipe(document, node.id)
    if (!graph?.prompt.trim()) return []
    const data = node.data as GenerateNodeData
    if (data.agentRun && !document.agentRuns.some((run) => run.id === data.agentRun?.runId && terminalRunStatuses.includes(run.status))) {
      return []
    }
    return [{
      nodeId: node.id,
      label: data.label || '生产工作流',
      ...(data.agentRun ? { runId: data.agentRun.runId, branchId: data.agentRun.branchId } : {}),
      resultCount: sourceResultNodeIds(document, node.id, data.agentRun).length,
      hasReferences: graph.recipe.references.length > 0,
    }]
  })
}

/**
 * 把用户显式选中的生成节点提升为生产工作流草稿。定义保留引用身份，
 * 不复制图片字节或临时 URL；服务端在运行时从项目权威文档解析稳定媒体。
 *
 * `sourceNodeId` 必填：发布来源由用户选择，本函数不遍历画布挑第一个可用节点。
 * 允许零引用的纯文字来源 —— 纯文字生成同样是可提升的已验证流程。
 */
export function productionWorkflowDraftFromCanvas(
  document: CanvasDocument,
  sourceNodeId: string,
): ProductionWorkflowDraftResult {
  if (!sourceNodeId) return { ok: false, reason: 'source_not_selected' }
  const node = document.nodes.find((entry) => entry.id === sourceNodeId)
  if (!node) return { ok: false, reason: 'node_not_found' }
  if (node.type !== 'generate') return { ok: false, reason: 'not_generate_node' }

  const graph = buildGraphGenerationRecipe(document, node.id)
  if (!graph?.prompt.trim()) return { ok: false, reason: 'prompt_empty' }

  const data = node.data as GenerateNodeData
  const sourceRun = data.agentRun
    ? document.agentRuns.find((run) => run.id === data.agentRun?.runId && terminalRunStatuses.includes(run.status))
    : undefined
  if (data.agentRun && !sourceRun) return { ok: false, reason: 'run_not_terminal' }

  const referenceAssetIds = new Set(graph.recipe.references.map((reference) => reference.assetId))
  const assetGroupIds = document.assetGroups
    .filter((group) => group.assetIds.some((assetId) => referenceAssetIds.has(assetId)))
    .map((group) => group.id)
  const recipe = {
    ...graph.recipe,
    references: graph.recipe.references.map(({ image: _image, ...reference }) => reference),
    ...(sourceRun ? { sourceAgentRunId: sourceRun.id } : {}),
  }
  const source: ProductionWorkflowSource = {
    canvasNodeId: node.id,
    ...(data.agentRun ? { runId: data.agentRun.runId, branchId: data.agentRun.branchId } : {}),
    resultNodeIds: sourceResultNodeIds(document, node.id, data.agentRun),
  }
  return {
    ok: true,
    draft: {
      source,
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
        // 品牌规则不在这里派生：它要写进不可变的工作流版本，必须由服务端经唯一的
        // 记忆选择器从权威文档取（激活过滤 + 版本绑定），客户端这份副本没有资格。
        assetGroupIds,
        confirmationPolicy: 'before-submit',
        recipe,
      },
    },
  }
}
