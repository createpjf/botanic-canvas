import assert from 'node:assert/strict'
import test from 'node:test'
import { parseProjectRealtimeEvent, projectRealtimeConnectionOpened, shouldRefreshFromRealtimeEvent } from './realtimeSync.ts'

test('首次连接不触发恢复，断线重连后触发恢复', () => {
  const first = projectRealtimeConnectionOpened(false)
  assert.deepEqual(first, {
    openedBefore: true,
    event: { reconnected: false },
  })

  const reconnect = projectRealtimeConnectionOpened(first.openedBefore)
  assert.deepEqual(reconnect, {
    openedBefore: true,
    event: { reconnected: true },
  })
})

test('其他设备发布当前项目的新版本时刷新画布', () => {
  assert.equal(shouldRefreshFromRealtimeEvent({
    event: { type: 'project.updated', projectId: 'project-1', revision: 5, updatedAt: 200 },
    currentProjectId: 'project-1',
    currentUpdatedAt: 100,
  }), true)
})

test('保留项目更新的协作者来源，供界面解释远端变更', () => {
  const event = {
    type: 'project.updated', projectId: 'project-1', revision: 5, updatedAt: 200, actorId: 'member-2', actorName: 'Mia',
  }
  assert.deepEqual(parseProjectRealtimeEvent(event, 'project-1'), event)
})

test('只接受当前项目且成员列表有效的协作在线状态', () => {
  const event = {
    type: 'collaboration.presence',
    projectId: 'project-1',
    members: [
      { userId: 'member-1', connectionCount: 2 },
      { userId: 'member-2', actorName: 'Mia', connectionCount: 1 },
    ],
  }
  assert.deepEqual(parseProjectRealtimeEvent(event, 'project-1'), event)
  assert.equal(parseProjectRealtimeEvent({ ...event, projectId: 'project-2' }, 'project-1'), undefined)
  assert.equal(parseProjectRealtimeEvent({ ...event, members: [{ userId: '', connectionCount: 0 }] }, 'project-1'), undefined)
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
    event: { type: 'project.updated', projectId: 'project-1', revision: 5, updatedAt: 300 },
    currentProjectId: 'project-1',
    currentUpdatedAt: 100,
    appliedRevision: 5,
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

test('CRDT 增量携带可持久化的协作动态', () => {
  const event = {
    type: 'canvas.crdt.update', projectId: 'project-1', update: 'AQID', actorId: 'member-2', actorName: 'Mia',
    activity: {
      id: 'activity-1', actorId: 'member-2', actorName: 'Mia', kind: 'canvas', summary: '新增了「海边版本」',
      target: { kind: 'node', nodeId: 'node-2' }, occurredAt: 200, unread: true, count: 1,
    },
  }
  assert.deepEqual(parseProjectRealtimeEvent(event, 'project-1'), event)
  assert.equal(parseProjectRealtimeEvent({ ...event, activity: { id: 'broken' } }, 'project-1'), undefined)
})

test('独立 Agent 实体变更通过协作动态实时失效', () => {
  const event = {
    type: 'collaboration.activity', projectId: 'project-1',
    activity: {
      id: 'agent-message-1', actorId: 'member-2', actorName: 'Mia', kind: 'conversation', summary: '更新了对话「海边方向」',
      target: { kind: 'message', sessionId: 'session-1', messageId: 'message-1' }, occurredAt: 200, unread: true, count: 1,
    },
  }
  assert.deepEqual(parseProjectRealtimeEvent(event, 'project-1'), event)
  assert.equal(parseProjectRealtimeEvent({ ...event, projectId: 'project-2' }, 'project-1'), undefined)
  assert.equal(parseProjectRealtimeEvent({ ...event, activity: { id: 'broken' } }, 'project-1'), undefined)
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
