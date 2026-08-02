import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument } from './canvas.ts'
import { resolveRemoteCanvasRefresh } from './remoteDocumentSync.ts'

function document(id: string, updatedAt: number, name: string): CanvasDocument {
  return {
    id,
    name,
    schemaVersion: 25,
    updatedAt,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [],
    assetGroups: [],
    templates: [],
    history: [],
    deliveries: [],
    generationJobs: [],
    agentRuns: [],
    agentSessions: [],
    agentMemory: [],
    batchVariationRuns: [],
  }
}

test('已打开旧缓存且没有本地编辑时立即接受服务器权威画布', () => {
  const cached = document('project-1', 100, '旧缓存')
  const remote = document('project-1', 200, '其他设备的新版本')

  const resolved = resolveRemoteCanvasRefresh({
    current: cached,
    remote,
    baselineUpdatedAt: cached.updatedAt,
    hasPendingDraft: false,
  })

  assert.equal(resolved.applied, true)
  assert.equal(resolved.document.name, '其他设备的新版本')
})

test('远端返回前发生本地编辑时不覆盖当前画布', () => {
  const cached = document('project-1', 100, '旧缓存')
  const edited = document('project-1', 300, '当前电脑正在编辑')
  const remote = document('project-1', 200, '其他设备的新版本')

  const resolved = resolveRemoteCanvasRefresh({
    current: edited,
    remote,
    baselineUpdatedAt: cached.updatedAt,
    hasPendingDraft: false,
  })

  assert.equal(resolved.applied, false)
  assert.equal(resolved.document.name, '当前电脑正在编辑')
})

test('服务器仍是同一版本时不重复替换当前画布', () => {
  const current = document('project-1', 200, '已同步版本')
  const remote = document('project-1', 200, '已同步版本')

  const resolved = resolveRemoteCanvasRefresh({
    current,
    remote,
    baselineUpdatedAt: current.updatedAt,
    hasPendingDraft: false,
  })

  assert.equal(resolved.applied, false)
  assert.equal(resolved.document, current)
})

test('服务器时间戳落后于本机缓存时不回退画布', () => {
  const current = document('project-1', 200, '较新的本机缓存')
  const remote = document('project-1', 100, '较旧的服务器版本')

  const resolved = resolveRemoteCanvasRefresh({
    current,
    remote,
    baselineUpdatedAt: current.updatedAt,
    hasPendingDraft: false,
  })

  assert.equal(resolved.applied, false)
  assert.equal(resolved.document, current)
})

test('存在未同步本地草稿或已经切换项目时拒绝远端整份覆盖', () => {
  const cached = document('project-1', 100, '本地草稿')
  const remote = document('project-1', 200, '远端版本')

  assert.equal(resolveRemoteCanvasRefresh({
    current: cached,
    remote,
    baselineUpdatedAt: cached.updatedAt,
    hasPendingDraft: true,
  }).applied, false)

  assert.equal(resolveRemoteCanvasRefresh({
    current: document('project-2', 400, '另一个项目'),
    remote,
    baselineUpdatedAt: cached.updatedAt,
    hasPendingDraft: false,
  }).applied, false)
})
