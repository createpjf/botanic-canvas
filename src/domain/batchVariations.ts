import type { AssetGroup, BatchVariationRun, GenerationSettings } from './canvas.ts'
import { clampBatchCount, cloneGenerationSettings } from './generationRecipe.ts'

export type BatchVariationPlanInput = {
  now: number
  sourceResultNodeId: string
  group: Pick<AssetGroup, 'id' | 'name' | 'role' | 'assetIds'>
  prompt: string
  candidatesPerAsset: number
  maximumBatchCount: number
  settings: GenerationSettings
  resolveAssetName: (assetId: string, index: number) => string
  agentRunId?: string
  agentBranches?: Array<{ assetId: string; branchId: string }>
}

/** 验证并建立持久化父任务；每个素材始终对应一个独立子任务。 */
export function createBatchVariationRun(input: BatchVariationPlanInput): BatchVariationRun {
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('请先描述这批图片要如何变化。')
  if (!input.group.assetIds.length) throw new Error('这个素材组暂无可用图片。')
  const candidatesPerAsset = Math.min(input.maximumBatchCount, clampBatchCount(input.candidatesPerAsset))
  if (input.group.assetIds.length * candidatesPerAsset > 20) {
    throw new Error(`单次批量最多创建 20 张结果；当前为 ${input.group.assetIds.length} × ${candidatesPerAsset}。`)
  }
  return {
    id: `batch-variation-${input.now}`,
    sourceResultNodeId: input.sourceResultNodeId,
    groupId: input.group.id,
    groupName: input.group.name,
    variableRole: input.group.role,
    prompt,
    candidatesPerAsset,
    settings: cloneGenerationSettings(input.settings),
    status: 'queued',
    items: input.group.assetIds.map((assetId, index) => ({
      id: `batch-item-${input.now}-${index}`,
      assetId,
      assetName: input.resolveAssetName(assetId, index),
      status: 'queued',
      agentBranchId: input.agentBranches?.find((branch) => branch.assetId === assetId)?.branchId,
    })),
    createdAt: input.now,
    updatedAt: input.now,
    agentRunId: input.agentRunId,
  }
}

export function summarizeBatchVariationRun(items: Array<Pick<BatchVariationRun['items'][number], 'status'>>) {
  const succeeded = items.filter((item) => item.status === 'succeeded').length
  const failed = items.filter((item) => item.status === 'failed' || item.status === 'cancelled').length
  const status: BatchVariationRun['status'] = succeeded === items.length ? 'succeeded' : succeeded ? 'partial' : 'failed'
  return { status, succeeded, failed }
}

/** 共享的有界并发执行器；避免 Promise.all 同时提交全部变体。 */
export async function mapBatchVariationWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1))
  let cursor = 0
  async function consume() {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: limit }, () => consume()))
}
