import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerationJob } from './canvas.ts'
import { confirmTimedOutGenerationSubmission, generationSubmissionFailureDisposition } from './generationSubmission.ts'

const recoveredJob: GenerationJob = {
  id: 'job-recovered',
  status: 'queued',
  kind: 'generation',
  createdAt: 1,
  updatedAt: 1,
  batchCount: 1,
  outputCount: 0,
  provider: 'openai',
  model: 'gpt-image-2',
  idempotencyKey: 'submission-fixed',
}

test('提交超时后用 projectId 与同一幂等键接管服务端已创建任务', async () => {
  const queriedProjects: string[] = []
  const confirmation = await confirmTimedOutGenerationSubmission({
    projectId: 'project-timeout',
    idempotencyKey: 'submission-fixed',
    listJobs: async (projectId) => {
      queriedProjects.push(projectId)
      return [
        { ...recoveredJob, id: 'job-other', idempotencyKey: 'other-key' },
        recoveredJob,
      ]
    },
  })

  assert.deepEqual(queriedProjects, ['project-timeout'])
  assert.deepEqual(confirmation, { status: 'found', job: recoveredJob })
})

test('服务端查询成功且无同幂等键任务时才确认为不存在', async () => {
  const confirmation = await confirmTimedOutGenerationSubmission({
    projectId: 'project-timeout',
    idempotencyKey: 'submission-fixed',
    listJobs: async () => [{ ...recoveredJob, idempotencyKey: 'other-key' }],
  })

  assert.deepEqual(confirmation, { status: 'absent' })
})

test('超时后无法查询服务端时标记状态未知，不宣告任务失败', async () => {
  const lookupError = new Error('offline')
  const confirmation = await confirmTimedOutGenerationSubmission({
    projectId: 'project-timeout',
    idempotencyKey: 'submission-fixed',
    listJobs: async () => { throw lookupError },
  })

  assert.deepEqual(confirmation, { status: 'unknown', error: lookupError })
})

test('画布仅将提交状态未知保留为可恢复任务', () => {
  assert.deepEqual(generationSubmissionFailureDisposition({ code: 'SUBMISSION_STATUS_UNKNOWN' }), {
    kind: 'recovering',
    taskStatus: 'submission_unknown',
    message: '暂时无法确认任务状态，请勿重复提交；联网后将自动确认。',
  })
  assert.equal(generationSubmissionFailureDisposition({ code: 'SUBMISSION_NOT_CONFIRMED' }).kind, 'failed')
  assert.equal(generationSubmissionFailureDisposition(new Error('offline')).kind, 'failed')
})
