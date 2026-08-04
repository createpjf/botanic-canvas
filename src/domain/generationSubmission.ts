import type { GenerationJob } from './canvas'

export type TimedOutGenerationSubmissionConfirmation =
  | { status: 'found'; job: GenerationJob }
  | { status: 'absent' }
  | { status: 'unknown'; error: unknown }

export type GenerationSubmissionFailureDisposition =
  | {
      kind: 'recovering'
      taskStatus: 'submission_unknown'
      message: string
    }
  | {
      kind: 'failed'
      taskStatus: 'failed'
      message?: string
    }

/**
 * 只有“服务端是否已接收 POST 无法确认”会进入恢复态。
 * 其他错误继续使用原有失败语义，避免把 Provider 失败伪装成网络恢复。
 */
export function generationSubmissionFailureDisposition(error: unknown): GenerationSubmissionFailureDisposition {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : ''
  if (code === 'SUBMISSION_STATUS_UNKNOWN') {
    return {
      kind: 'recovering',
      taskStatus: 'submission_unknown',
      message: '暂时无法确认任务状态，请勿重复提交；联网后将自动确认。',
    }
  }
  return {
    kind: 'failed',
    taskStatus: 'failed',
    message: error instanceof Error ? error.message : undefined,
  }
}

/**
 * POST 超时不等于服务端没有接收。只有项目任务列表成功返回且找不到
 * 同一幂等键时，才能判定本次提交尚未创建。
 */
export async function confirmTimedOutGenerationSubmission(input: {
  projectId: string
  idempotencyKey: string
  listJobs: (projectId: string) => Promise<GenerationJob[]>
}): Promise<TimedOutGenerationSubmissionConfirmation> {
  try {
    const jobs = await input.listJobs(input.projectId)
    const job = jobs.find((candidate) => candidate.idempotencyKey === input.idempotencyKey)
    return job ? { status: 'found', job } : { status: 'absent' }
  } catch (error) {
    return { status: 'unknown', error }
  }
}
