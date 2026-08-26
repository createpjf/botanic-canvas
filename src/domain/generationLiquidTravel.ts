import type { CanvasGenerationTaskStatus, GenerationMediaKind } from './canvas.ts'

/**
 * 结果节点 liquid 的推进量。
 *
 * 生成任务没有 Provider 百分比，`store.generationProgress` 也始终为 0。
 * 这里只消费真实任务阶段和已等待秒数：单次从左到右逼近上限后停住，
 * 不循环、不回扫、不到 1。完成时由结果画面替换液面，不把液面画满冒充 100%。
 */

export const GENERATION_LIQUID_TRAVEL = {
  submissionUnknown: 0.12,
  uploading: 0.16,
  queued: 0.22,
  runningStart: 0.24,
  ceiling: 0.86,
  imageHorizonSeconds: 16,
  videoHorizonSeconds: 45,
} as const

export function isGenerationLiquidRunningStatus(status?: CanvasGenerationTaskStatus) {
  return !status || status === 'running'
}

export function generationLiquidTravel(input: {
  taskStatus?: CanvasGenerationTaskStatus
  elapsedSeconds?: number
  mediaKind?: GenerationMediaKind
} = {}) {
  const status = input.taskStatus
  if (status === 'submission_unknown') return GENERATION_LIQUID_TRAVEL.submissionUnknown
  if (status === 'uploading') return GENERATION_LIQUID_TRAVEL.uploading
  if (status === 'queued') return GENERATION_LIQUID_TRAVEL.queued
  if (status === 'failed' || status === 'cancelled') return GENERATION_LIQUID_TRAVEL.queued

  const elapsed = Math.max(0, input.elapsedSeconds ?? 0)
  const horizon = input.mediaKind === 'video'
    ? GENERATION_LIQUID_TRAVEL.videoHorizonSeconds
    : GENERATION_LIQUID_TRAVEL.imageHorizonSeconds
  const start = GENERATION_LIQUID_TRAVEL.runningStart
  const span = GENERATION_LIQUID_TRAVEL.ceiling - start
  return start + span * (1 - Math.exp(-elapsed / horizon))
}
