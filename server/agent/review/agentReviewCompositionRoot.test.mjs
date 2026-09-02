import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentReviewMediaResolver } from './agentReviewMediaResolver.mjs'
import { createAgentReviewVisionJudge } from './agentReviewVision.mjs'
import { createEvaluatorSkillRunner } from './agentReviewSkillEvaluator.mjs'

const candidate = { artifactId: 'generation:job-a:out-a', output: { id: 'out-a', image: '/api/media/media_a' } }
const criterion = { id: 'skill.no_claims@1', instructions: '不得夸大。' }

test('Review 组合根按 owner/project 授权取图，内置与 evaluator 共用正确接口', async () => {
  const mediaCalls = []
  let modelCalls = 0
  const resolveMedia = createAgentReviewMediaResolver({
    enabled: true,
    async readGenerationInput(ownerId, mediaId, projectId, { signal } = {}) {
      mediaCalls.push({ ownerId, mediaId, projectId, signal })
      return projectId === 'project-a'
        ? { mimeType: 'image/png', buffer: Buffer.from('image-a') }
        : undefined
    },
  })
  const reviewCandidate = createAgentReviewVisionJudge({
    runtimeConfig: { agentVisionModel: 'vision-1', flockApiKey: 'key' },
    resolveMedia,
    callModel: async () => {
      modelCalls += 1
      return { choices: [{ message: { content: '{"criteria":[{"id":"identity","verdict":"pass","evidence":"一致"}]}' } }] }
    },
  })
  const judgeWith = createEvaluatorSkillRunner({
    runtimeConfig: { agentVisionModel: 'vision-1', flockApiKey: 'key' },
    resolveMedia,
    callModel: async () => {
      modelCalls += 1
      return { choices: [{ message: { content: '{"verdict":"pass","evidence":"符合"}' } }] }
    },
  })
  const task = {
    ownerId: 'owner-a', projectId: 'project-a',
    qualityPolicy: { requiredCriteria: ['identity'] }, qualityPolicyFingerprint: 'fp-a',
  }

  await reviewCandidate({ candidate, task })
  await judgeWith({ criterion, candidate, task })({ signal: AbortSignal.timeout(1_000) })
  assert.equal(modelCalls, 2)
  assert.deepEqual(mediaCalls.map(({ ownerId, mediaId, projectId }) => ({ ownerId, mediaId, projectId })), [
    { ownerId: 'owner-a', mediaId: 'media_a', projectId: 'project-a' },
    { ownerId: 'owner-a', mediaId: 'media_a', projectId: 'project-a' },
  ])

  const foreignTask = { ...task, projectId: 'project-b' }
  const builtIn = await reviewCandidate({ candidate, task: foreignTask })
  const evaluator = await judgeWith({ criterion, candidate, task: foreignTask })({ signal: AbortSignal.timeout(1_000) })
  assert.equal(modelCalls, 2, '跨项目媒体不可读时不得调用视觉 Provider')
  assert.equal(builtIn.criteria[0].verdict, 'unverifiable')
  assert.equal(evaluator.verdict, 'unverifiable')
})
