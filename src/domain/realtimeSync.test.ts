import assert from 'node:assert/strict'
import test from 'node:test'
import { parseProjectRealtimeEvent, shouldRefreshFromRealtimeEvent } from './realtimeSync.ts'

test('其他设备发布当前项目的新版本时刷新画布', () => {
  assert.equal(shouldRefreshFromRealtimeEvent({
    event: { type: 'project.updated', projectId: 'project-1', revision: 5, updatedAt: 200 },
    currentProjectId: 'project-1',
    currentUpdatedAt: 100,
  }), true)
})

test('忽略其他项目、旧版本和未知实时消息', () => {
  assert.equal(shouldRefreshFromRealtimeEvent({
    event: { type: 'project.updated', projectId: 'project-2', revision: 5, updatedAt: 200 },
    currentProjectId: 'project-1',
    currentUpdatedAt: 100,
  }), false)
  assert.equal(shouldRefreshFromRealtimeEvent({
    event: { type: 'project.updated', projectId: 'project-1', revision: 4, updatedAt: 100 },
    currentProjectId: 'project-1',
    currentUpdatedAt: 100,
  }), false)
  assert.equal(shouldRefreshFromRealtimeEvent({
    event: { type: 'unknown', projectId: 'project-1', updatedAt: 300 },
    currentProjectId: 'project-1',
    currentUpdatedAt: 100,
  }), false)
})

test('只接受当前项目且格式有效的 CRDT 增量', () => {
  assert.deepEqual(parseProjectRealtimeEvent({
    type: 'canvas.crdt.update',
    projectId: 'project-1',
    update: 'AQID',
  }, 'project-1'), {
    type: 'canvas.crdt.update',
    projectId: 'project-1',
    update: 'AQID',
  })
  assert.equal(parseProjectRealtimeEvent({
    type: 'canvas.crdt.update',
    projectId: 'project-2',
    update: 'AQID',
  }, 'project-1'), undefined)
  assert.equal(parseProjectRealtimeEvent({
    type: 'canvas.crdt.update',
    projectId: 'project-1',
    update: 'not base64!',
  }, 'project-1'), undefined)
})

test('只接受当前项目且格式完整的 Agent Run 进度', () => {
  const event = {
    type: 'agent.run.updated', projectId: 'project-1',
    run: {
      id: 'run-1', projectId: 'project-1', status: 'running', completedBranchCount: 0, failedBranchCount: 0,
      branches: [{ id: 'branch-1', label: '海边', status: 'running', attempt: 0, jobIds: ['job-1'], outputCount: 0, updatedAt: 20 }],
      createdAt: 10, updatedAt: 20,
    },
  }
  assert.deepEqual(parseProjectRealtimeEvent(event, 'project-1'), event)
  assert.equal(parseProjectRealtimeEvent({ ...event, projectId: 'project-2' }, 'project-1'), undefined)
  assert.equal(parseProjectRealtimeEvent({ ...event, run: { id: 'run-1' } }, 'project-1'), undefined)
})
