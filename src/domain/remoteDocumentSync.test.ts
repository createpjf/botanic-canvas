import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument } from './canvas.ts'
import { isRemoteDocumentConflict, resolveRemoteCanvasRefresh } from './remoteDocumentSync.ts'

test('旧版 412 与新版 409 的项目和画布版本冲突使用同一判定', () => {
  assert.equal(isRemoteDocumentConflict({ status: 412 }), true)
  assert.equal(isRemoteDocumentConflict({ status: 409, code: 'CANVAS_GRAPH_CONFLICT' }), true)
  assert.equal(isRemoteDocumentConflict({ status: 409, code: 'PROJECT_CONFLICT' }), true)
  assert.equal(isRemoteDocumentConflict({ status: 422, code: 'INVALID_DOCUMENT' }), false)
})

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

test('接受远端画布时保留本机 Agent 消息', () => {
  const cached = {
    ...document('project-1', 100, '旧缓存'),
    agentSessions: [{
      id: 'session-1', title: '对话', executionMode: 'auto' as const, contextNodeIds: [],
      messages: [{ id: 'message-local', role: 'user' as const, kind: 'text' as const, content: '本机', createdAt: 10, deliveryStatus: 'syncing' as const }],
      createdAt: 1, updatedAt: 10,
    }],
  }
  const remote = {
    ...document('project-1', 200, '其他设备的新版本'),
    agentSessions: [{
      id: 'session-1', title: '远端标题', executionMode: 'auto' as const, contextNodeIds: [],
      messages: [], createdAt: 1, updatedAt: 30,
    }],
  }
  const resolved = resolveRemoteCanvasRefresh({
    current: cached,
    remote,
    baselineUpdatedAt: cached.updatedAt,
    hasPendingDraft: false,
  })
  assert.equal(resolved.applied, true)
  assert.equal(resolved.document.name, '其他设备的新版本')
  assert.equal(resolved.document.agentSessions[0].title, '远端标题')
  assert.equal(resolved.document.agentSessions[0].messages[0].id, 'message-local')
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
