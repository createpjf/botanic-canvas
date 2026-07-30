import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProductStore } from './productStore.mjs'

function document(id, name = '测试项目') {
  return {
    schemaVersion: 16,
    id,
    name,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [],
    templates: [],
    history: [],
    deliveries: [],
    generationJobs: [],
    updatedAt: Date.now(),
  }
}

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-product-store-'))
  return {
    path: join(directory, 'product.json'),
    store: createProductStore({ dataPath: join(directory, 'product.json'), bootstrapAccessToken: 'owner-token' }),
  }
}

test('项目、成员授权和审计会持久化到服务端数据文件', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)

  const created = store.writeProject(owner.id, document('project-a'), undefined)
  assert.equal(created.created, true)
  assert.equal(created.revision, 1)

  const member = store.createUser(owner.id, {
    email: 'designer@example.com',
    name: 'Designer',
    accessToken: 'designer-token',
  })
  store.addProjectMember(owner.id, 'project-a', member.id, 'editor')

  const designer = store.authenticate('designer-token')
  assert.ok(designer)
  const saved = store.writeProject(designer.id, { ...document('project-a'), name: '已授权项目' }, 2)
  assert.equal(saved.revision, 3)

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  const recovered = reloaded.readProject(designer.id, 'project-a')
  assert.equal(recovered?.document.name, '已授权项目')
  assert.equal(recovered?.revision, 3)
  assert.ok(reloaded.listAuditEvents(owner.id, 'project-a').some((event) => event.action === 'project.updated'))
})

test('仅项目所有者可以永久删除项目及其任务', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  store.writeProject(owner.id, document('project-remove'), undefined)
  store.putGenerationJob(owner.id, {
    id: 'remove-job', projectId: 'project-remove', status: 'queued', kind: 'generation', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, rawInput: { projectId: 'project-remove' }, outputs: [], createdAt: Date.now(),
  })

  assert.equal(store.deleteProject(owner.id, 'project-remove'), true)
  assert.equal(store.readProject(owner.id, 'project-remove'), undefined)
  assert.equal(store.readGenerationJob(owner.id, 'remove-job'), undefined)
})

test('服务重启保留排队任务，并把执行中的任务标记为可重试失败', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  store.writeProject(owner.id, document('project-a'), undefined)

  store.putGenerationJob(owner.id, {
    id: 'queued-job',
    projectId: 'project-a',
    status: 'queued',
    kind: 'generation',
    batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    rawInput: { projectId: 'project-a' },
    outputs: [],
    createdAt: Date.now(),
  })
  store.putGenerationJob(owner.id, {
    id: 'running-job',
    projectId: 'project-a',
    status: 'running',
    kind: 'generation',
    batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    rawInput: { projectId: 'project-a' },
    outputs: [],
    createdAt: Date.now(),
  })

  assert.deepEqual(store.recoverGenerationJobs().map((job) => job.id), ['queued-job'])
  assert.equal(store.readGenerationJob(owner.id, 'running-job')?.status, 'failed')
})
