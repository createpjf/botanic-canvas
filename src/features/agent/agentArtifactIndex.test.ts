import assert from 'node:assert/strict'
import test from 'node:test'
import { agentArtifactIndexNextPage, mergeAgentArtifactIndexPage, type AgentArtifactIndexState } from './agentWorkspace.types.ts'

test('结果分页接受同 ID 的较新内容，迟到旧页不回退，首页刷新保留已载入历史', () => {
  const current: AgentArtifactIndexState = {
    projectId: 'project-a', status: 'ready', nextBefore: 'older-page',
    artifacts: [{
      id: 'image-a', kind: 'image', label: '旧名称', url: '/api/media/a',
      provenance: { actionId: 'action-a', toolName: 'image_generation', runId: 'run-a' },
      origin: { type: 'generation_output' }, createdAt: 10, updatedAt: 10,
    }, {
      id: 'history', kind: 'image', label: '历史图片', url: '/api/media/history',
      provenance: { actionId: 'action-old', toolName: 'image_generation', runId: 'run-old' },
      origin: { type: 'generation_output' }, createdAt: 1, updatedAt: 1,
    }],
  }
  const updated = { ...current.artifacts[0], label: '已保存', updatedAt: 20, metadata: { savedToLibrary: true } }
  const refreshed = mergeAgentArtifactIndexPage(current, { artifacts: [updated], nextBefore: 'refreshed-page' })
  assert.deepEqual(refreshed.artifacts.map((item) => item.id), ['image-a', 'history'])
  assert.equal(refreshed.artifacts[0].metadata?.savedToLibrary, true)
  assert.equal(refreshed.nextBefore, 'refreshed-page')
  const latePage = mergeAgentArtifactIndexPage(refreshed, { artifacts: [current.artifacts[0]] })
  assert.equal(latePage.artifacts[0].label, '已保存')
  assert.equal(latePage.nextBefore, undefined)
  assert.equal(current.artifacts[0].label, '旧名称')
})

test('更多页失败重试原游标，首页刷新失败从首页重读，在途和穷尽时不重复读取', () => {
  const index: AgentArtifactIndexState = { projectId: 'project-a', artifacts: [], status: 'error-more', nextBefore: 'failed-page' }
  assert.deepEqual(agentArtifactIndexNextPage(index), { before: 'failed-page' })
  assert.deepEqual(agentArtifactIndexNextPage({ ...index, status: 'error' }), {})
  assert.equal(agentArtifactIndexNextPage({ ...index, status: 'loading' }), null)
  assert.equal(agentArtifactIndexNextPage({ ...index, status: 'loading-more' }), null)
  assert.equal(agentArtifactIndexNextPage({ ...index, status: 'ready', nextBefore: undefined }), null)
})
