import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenerationSubmissionService } from './generationSubmissionService.mjs'

function harness() {
  const jobs = new Map()
  const enqueued = []
  const reservations = []
  const consumes = []
  const service = createGenerationSubmissionService({
    config: {
      models: ['gpt-image-2'],
      modelOptions: [{
        id: 'gpt-image-2', provider: 'openai', mediaKind: 'image',
        aspectRatios: ['1:1'], resolutions: ['1K'],
      }],
      maximumBatchCount: 4,
      maximumReferenceBytes: 8 * 1024 * 1024,
      security: { generationOutputsPerDay: 100 },
      generationBudgets: { workspace: 100, project: 100, member: 100 },
    },
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readGenerationJob: async (_userId, id) => jobs.get(id),
      putGenerationJob: async (_userId, job) => { jobs.set(job.id, structuredClone(job)); return job },
      readAgentRun: async () => undefined,
    },
    securityControls: {
      consume: async (input) => { consumes.push(input); return { allowed: true } },
      reserveMany: async (input) => { reservations.push(input); return { allowed: true, reused: false, remaining: 99 } },
    },
    enqueue: async (id) => { enqueued.push(id) },
  })
  return { service, jobs, enqueued, reservations, consumes }
}

const rawInput = {
  projectId: 'project-a', kind: 'generation', prompt: '生成品牌首图', batchCount: 1,
  settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
  recipe: { references: [{ name: '产品', mediaId: 'media_product', inputRole: 'reference_image' }] },
}

test('重复提交复用同一任务、队列和预算预留', async () => {
  const { service, enqueued, reservations, consumes } = harness()
  const first = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'workflow_run-a_item-a' })
  const duplicate = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'workflow_run-a_item-a' })

  assert.equal(duplicate.job.id, first.job.id)
  assert.equal(duplicate.existing, true)
  assert.equal(enqueued.length, 1)
  assert.equal(reservations.length, 1)
  assert.equal(consumes.length, 1)
})

test('失败项原配方重试复用任务与幂等键且不重复扣费', async () => {
  const { service, jobs, enqueued, reservations, consumes } = harness()
  const first = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'workflow_run-a_item-a' })
  jobs.set(first.job.id, {
    ...jobs.get(first.job.id), status: 'failed', error: 'provider timeout',
    variants: [{ index: 0, status: 'failed', error: 'provider timeout' }],
  })

  const retried = await service({
    user: { id: 'user-a' }, rawInput, idempotencyKey: 'workflow_run-a_item-a', retryExisting: true,
  })

  assert.equal(retried.job.id, first.job.id)
  assert.equal(retried.job.idempotencyKey, 'workflow_run-a_item-a')
  assert.equal(retried.job.status, 'queued')
  assert.equal(retried.retried, true)
  assert.equal(enqueued.length, 2)
  assert.equal(reservations.length, 1)
  assert.equal(consumes.length, 1)
})

test('HTTP 提交也经过 Compiler：每个 Job 都带指纹，画布结果不断链', async () => {
  // 指纹只在 Agent 路径上有，「任一 Artifact 可反查 Plan」就只对 Agent 结果成立，
  // 画布上手工生成的图会断链。
  const { service, jobs } = harness()
  const submitted = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-fingerprint' })
  assert.ok(submitted.job.planFingerprint)
  assert.ok(submitted.job.branchFingerprint)
  // 落库同样带上：Artifact 是从持久化任务派生的。
  const stored = jobs.get(submitted.job.id)
  assert.equal(stored.planFingerprint, submitted.job.planFingerprint)
  assert.equal(stored.branchFingerprint, submitted.job.branchFingerprint)
})

test('同一份提交内容得到同一指纹，改了内容就换指纹', async () => {
  const a = await harness().service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-same-content-a' })
  const b = await harness().service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-same-content-b' })
  // 指纹描述「提交了什么」，与幂等键无关。
  assert.equal(b.job.planFingerprint, a.job.planFingerprint)

  const c = await harness().service({
    user: { id: 'user-a' },
    rawInput: { ...rawInput, prompt: '换成完全不同的画面描述' },
    idempotencyKey: 'submission-other-content-c',
  })
  assert.notEqual(c.job.planFingerprint, a.job.planFingerprint)
})

test('画布提交不带创作约束时，编译不改写用户的 Prompt', async () => {
  // 编译对这条路径的价值是指纹，不是改写 Prompt；悄悄给 Prompt 加前缀会改变实际生成。
  const { service } = harness()
  const submitted = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-prompt-intact' })
  assert.equal(submitted.job.rawInput.prompt, '生成品牌首图')
  // 也不给手工生成凭空声明质量策略与约束 —— 那等于宣称用户选过它们。
  assert.equal(submitted.job.rawInput.recipe.qualityPolicy, undefined)
  assert.equal(submitted.job.rawInput.recipe.constraints, undefined)
})

test('工作流提交沿用版本发布时固定的计划指纹，各项仍可区分', async () => {
  // 「纯文字 Run 可发布、执行并生成与原 Compiled Plan 指纹一致的结果」靠这条成立：
  // 各项按本次提交内容各算一个指纹的话，结果就归不回那一次发布。
  const workflowInput = (itemId) => ({
    ...rawInput,
    productionWorkflow: {
      workflowId: 'wf-1', workflowVersion: 2, workflowRunId: 'wf-run-1',
      workflowItemId: itemId, planFingerprint: 'published-plan-fp',
    },
  })
  const first = await harness().service({ user: { id: 'user-a' }, rawInput: workflowInput('SKU-1'), idempotencyKey: 'workflow_run-a_sku-1' })
  const second = await harness().service({ user: { id: 'user-a' }, rawInput: workflowInput('SKU-2'), idempotencyKey: 'workflow_run-a_sku-2' })

  assert.equal(first.job.planFingerprint, 'published-plan-fp')
  assert.equal(second.job.planFingerprint, 'published-plan-fp')
  // 分支指纹按批量项身份派生，因此两项互不相同但都归回同一次发布。
  assert.notEqual(first.job.branchFingerprint, second.job.branchFingerprint)
})

test('没有工作流来源的提交仍按提交内容算指纹', async () => {
  const plain = await harness().service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-plain-fingerprint' })
  assert.ok(plain.job.planFingerprint)
  assert.notEqual(plain.job.planFingerprint, 'published-plan-fp')
})
