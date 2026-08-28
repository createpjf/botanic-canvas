import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument, CanvasNode } from './canvas.ts'
import {
  appendCollaborationActivity,
  collaborationDocumentChange,
  collaborationDocumentChanges,
  markCollaborationActivitiesRead,
} from './collaborationActivity.ts'

function node(id: string, label: string, x = 0): CanvasNode {
  return {
    id,
    type: 'text',
    position: { x, y: 0 },
    data: { kind: 'text', label, content: label },
  }
}

function document(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return {
    schemaVersion: 25,
    id: 'project-1',
    name: '项目',
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    assets: [], assetGroups: [], templates: [], history: [], deliveries: [],
    generationJobs: [], batchVariationRuns: [], agentRuns: [], agentSessions: [], agentMemory: [],
    updatedAt: 1,
    ...overrides,
  }
}

test('协作变更摘要优先给出可定位的节点变化', () => {
  const change = collaborationDocumentChange(
    document({ nodes: [node('node-1', '夏日窗台')] }),
    document({ nodes: [node('node-1', '夏日窗台'), node('node-2', '海边版本')] }),
  )

  assert.deepEqual(change, {
    kind: 'canvas',
    summary: '新增了「海边版本」',
    target: { kind: 'node', nodeId: 'node-2' },
  })
})

test('冲突审阅保留多个可定位的具体差异', () => {
  const changes = collaborationDocumentChanges(
    document({ name: '旧项目', nodes: [node('node-1', '主视觉'), node('node-2', '待删除')] }),
    document({ name: '新项目', nodes: [node('node-1', '海边主视觉'), node('node-3', '新方向')] }),
  )

  assert.deepEqual(changes, [
    { kind: 'canvas', summary: '更新了「海边主视觉」', target: { kind: 'node', nodeId: 'node-1' } },
    { kind: 'canvas', summary: '新增了「新方向」', target: { kind: 'node', nodeId: 'node-3' } },
    { kind: 'canvas', summary: '移除了「待删除」' },
    { kind: 'project', summary: '将项目重命名为「新项目」', target: { kind: 'project' } },
  ])
})

test('移动节点和更新节点内容使用不同摘要', () => {
  assert.deepEqual(collaborationDocumentChange(
    document({ nodes: [node('node-1', '主视觉')] }),
    document({ nodes: [node('node-1', '主视觉', 120)] }),
  ), {
    kind: 'canvas', summary: '移动了「主视觉」', target: { kind: 'node', nodeId: 'node-1' },
  })

  assert.deepEqual(collaborationDocumentChange(
    document({ nodes: [node('node-1', '主视觉')] }),
    document({ nodes: [node('node-1', '海边主视觉')] }),
  ), {
    kind: 'canvas', summary: '更新了「海边主视觉」', target: { kind: 'node', nodeId: 'node-1' },
  })
})

test('文档不再从内嵌消息派生对话变更', () => {
  const base = document({
    agentSessions: [{ id: 'session-1', title: '海边创作', executionMode: 'manual', contextNodeIds: [], messages: [], createdAt: 1, updatedAt: 1 }],
  })
  const next = document({
    agentSessions: [{
      id: 'session-1', title: '海边创作', executionMode: 'manual', contextNodeIds: [], createdAt: 1, updatedAt: 2,
      messages: [{ id: 'message-1', role: 'assistant', kind: 'text', content: '已完成', createdAt: 2 }],
    }],
  })
  assert.deepEqual(collaborationDocumentChange(base, next), {
    kind: 'project', summary: '更新了项目内容', target: { kind: 'project' },
  })
})

test('同一成员的连续同类变更合并并累计，阅读后清除未读', () => {
  const first = appendCollaborationActivity([], {
    id: 'activity-1', actorId: 'member-1', actorName: 'Mia', kind: 'canvas', summary: '更新了画布',
    occurredAt: 1_000, unread: true, count: 1,
  })
  const merged = appendCollaborationActivity(first, {
    id: 'activity-2', actorId: 'member-1', actorName: 'Mia', kind: 'canvas', summary: '更新了画布',
    occurredAt: 5_000, unread: true, count: 1,
  })

  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.count, 2)
  assert.equal(merged[0]?.occurredAt, 5_000)
  assert.equal(markCollaborationActivitiesRead(merged)[0]?.unread, false)
})
