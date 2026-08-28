// @ts-check

import { mapWithConcurrency } from './concurrency.mjs'

/**
 * @typedef {{ index?: number | string, status?: string, output?: unknown }} CompletedVariant
 * @typedef {{ index: number, status: 'running' | 'succeeded' | 'failed', output?: unknown, error?: string }} VariantUpdate
 */

/**
 * 统一候选级恢复、生命周期事件与部分成功归并。
 * Provider Adapter 只实现「生成一个候选」，不再各自维护第二套批任务状态机。
 *
 * @param {{
 *   batchCount: number,
 *   completedVariants?: CompletedVariant[],
 *   concurrency?: number,
 *   onVariant?: (update: VariantUpdate) => void | Promise<void>,
 *   generateVariant: (index: number) => Promise<unknown>,
 *   shouldAbortBatch?: (error: unknown, state: { index: number, hasOutput: boolean }) => boolean,
 *   emptyError: () => Error,
 *   partialError: (summary: { outputCount: number, batchCount: number, missingOutputCount: number }) => string,
 * }} input
 */
export async function runGenerationVariants(input) {
  const {
    batchCount,
    completedVariants = [],
    concurrency = 1,
    onVariant,
    generateVariant,
    shouldAbortBatch,
    emptyError,
    partialError,
  } = input
  const indexes = Array.from({ length: batchCount }, (_, index) => index)
  const previousOutputs = new Map(
    completedVariants
      .filter((variant) => (
        variant?.status === 'succeeded'
        && variant.output
        && Number.isInteger(Number(variant.index))
        && Number(variant.index) >= 0
        && Number(variant.index) < batchCount
      ))
      .map((variant) => [Number(variant.index), variant.output]),
  )
  const pendingIndexes = indexes.filter((index) => !previousOutputs.has(index))
  let successfulOutputCount = 0
  let abortBatch = false
  const settled = await mapWithConcurrency(pendingIndexes, concurrency, async (index) => {
    if (abortBatch) return { status: /** @type {const} */ ('skipped'), index }
    await onVariant?.({ index, status: 'running' })
    try {
      const output = await generateVariant(index)
      await onVariant?.({ index, status: 'succeeded', output })
      successfulOutputCount += 1
      return { status: /** @type {const} */ ('fulfilled'), index, output }
    } catch (error) {
      await onVariant?.({
        index,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      if (shouldAbortBatch?.(error, {
        index,
        hasOutput: previousOutputs.size + successfulOutputCount > 0,
      })) abortBatch = true
      return { status: /** @type {const} */ ('rejected'), index, reason: error }
    }
  })

  const outputsByIndex = new Map(previousOutputs)
  for (const result of settled) {
    if (result.status === 'fulfilled') outputsByIndex.set(result.index, result.output)
  }
  const outputs = indexes.flatMap((index) => (
    outputsByIndex.has(index) ? [outputsByIndex.get(index)] : []
  ))
  if (!outputs.length) {
    const firstFailure = settled.find((result) => result.status === 'rejected')
    if (firstFailure?.status === 'rejected') throw firstFailure.reason
    throw emptyError()
  }

  const missingOutputCount = Math.max(0, batchCount - outputs.length)
  return {
    outputs,
    missingOutputCount,
    partialError: missingOutputCount
      ? partialError({ outputCount: outputs.length, batchCount, missingOutputCount })
      : undefined,
  }
}
