// @ts-check
import { createAgentOperationalReaders } from '../../observability/agentOperationalReaders.mjs'
import { createAgentToolRegistry } from '../tools/agentToolRuntime.mjs'
import { createBotanicAgentOperationalToolDefinitions } from '../tools/botanicAgentOperationalTools.mjs'
import { createBotanicAgentWebResearchTools } from '../tools/botanicAgentWebTools.mjs'

function safeLabel(node) {
  const value = node?.data?.title ?? node?.data?.label ?? node?.data?.name
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : undefined
}

/** 画布只读投影不返回 image/url/prompt 等可能含媒体或 Provider 原文的字段。 */
function canvasReadDefinition(document) {
  return {
    name: 'canvas_read',
    label: '读取画布摘要',
    description: '读取当前项目画布的节点、连线和类型摘要；不返回媒体地址、图片字节或生成 Prompt。',
    risk: 'read',
    recovery: 'reexecute',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    validate: () => ({}),
    execute: async () => {
      const nodes = Array.isArray(document?.nodes) ? document.nodes : []
      const edges = Array.isArray(document?.edges) ? document.edges : []
      const selected = nodes.slice(0, 100).map((node) => ({
        id: typeof node?.id === 'string' ? node.id.slice(0, 160) : undefined,
        type: typeof node?.type === 'string' ? node.type.slice(0, 80) : undefined,
        ...(safeLabel(node) ? { label: safeLabel(node) } : {}),
      }))
      return {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodes: selected,
        omittedNodeCount: Math.max(0, nodes.length - selected.length),
      }
    },
  }
}

/**
 * 每个 activation 都从当前项目事实重建同名 Registry，再由 descriptor capabilityHash
 * 校验 schema/governance 没有漂移；客户端永远不能注入定义。
 *
 * @param {{
 *   productStore?: any,
 *   config?: any,
 *   userId?: string,
 *   projectId?: string,
 *   consumeWebResearchQuota?: (userId: string, projectId: string, capability?: string) => Promise<any>,
 * }} [input]
 */
export async function createAgentSubagentProjectRegistry({
  productStore,
  config,
  userId,
  projectId,
  consumeWebResearchQuota,
} = {}) {
  if (!productStore || !userId || !projectId) throw new TypeError('Subagent Registry 缺少项目身份。')
  const project = await productStore.readProject(userId, projectId)
  if (!project?.document) {
    throw Object.assign(new Error('Subagent 来源项目不存在。'), {
      code: 'AGENT_SUBAGENT_PROJECT_NOT_FOUND',
      statusCode: 404,
    })
  }
  const operations = createAgentOperationalReaders({
    productStore,
    userId,
    projectId,
    document: project.document,
    semanticSearch: config?.semanticSearch,
  })
  const webResearch = config?.webSearch
    ? {
        ...config.webSearch,
        consumeQuota: typeof consumeWebResearchQuota === 'function'
          ? () => consumeWebResearchQuota(userId, projectId, 'execute-external-tool')
          : undefined,
      }
    : undefined
  // 外部读取沿用 canonical journal 恢复语义(H6B),与根 Turn/Chat/Planner 一致;
  // completed 复用 durable envelope,dispatched 无结果收口 outcome-unknown,绝不重复外呼。
  const webTools = createBotanicAgentWebResearchTools(webResearch)
  const registry = createAgentToolRegistry([
    canvasReadDefinition(project.document),
    ...createBotanicAgentOperationalToolDefinitions(operations),
    ...webTools,
  ])
  return { project, registry }
}
