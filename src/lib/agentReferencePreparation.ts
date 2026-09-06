import { readAgentReferenceUsageItems } from '../domain/agentReferenceUsage'
import { productRequest, ProductApiError } from './productSession'

/** 独立准备请求；不提交消息或重试 Turn/Run。返回值不能覆盖历史采用记录。 */
export async function prepareAgentReference(projectId: string, nodeId: string, plannerModel: string, signal: AbortSignal) {
  const response = await productRequest<{ items: unknown }>(`/api/projects/${encodeURIComponent(projectId)}/agent-references/prepare`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeIds: [nodeId], plannerModel }),
  })
  const items = readAgentReferenceUsageItems(response.items)
  if (items.length !== 1 || items[0].nodeId !== nodeId || items[0].stage === 'submitted') {
    throw new ProductApiError('引用准备结果无效。', 502, 'INVALID_REFERENCE_PREPARATION')
  }
  return items[0]
}
