import type { GenerationJob } from './canvas'

export type TimedOutGenerationSubmissionConfirmation =
  | { status: 'found'; job: GenerationJob }
  | { status: 'absent' }
  | { status: 'unknown'; error: unknown }

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
