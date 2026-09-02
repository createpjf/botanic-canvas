import assert from 'node:assert/strict'
import test from 'node:test'
import { commitCanvasProjectMutation } from './canvasGraphCommitService.mjs'
import { canvasGraphConflictCode } from '../productStoreContract.mjs'

test('图谱 CAS 重试会重读 tombstone 元数据，不复活并发删除的生成节点', async () => {
  const sourceNode = { id: 'source', type: 'text', position: { x: 10, y: 20 }, data: { label: '描述', content: '描述' } }
  const resultNode = { id: 'result', type: 'result', position: { x: 320, y: 20 }, data: { label: '结果', jobId: 'job-1', candidateId: 'output-1' } }
  const baseDocument = {
    id: 'project-1', name: 'Demo', nodes: [sourceNode], edges: [], updatedAt: 10,
    generationJobs: [{ id: 'job-1', updatedAt: 10, outputs: [{ id: 'output-1' }] }],
  }
  const deletedDocument = {
    ...baseDocument,
    updatedAt: 20,
    generationJobs: [{
      id: 'job-1', updatedAt: 20, outputs: [], dismissedOutputIds: ['output-1'], projectionDismissedAt: 20,
    }],
  }
  let conflicted = false
  let appendCount = 0
  const project = (document) => ({ document: structuredClone(document), revision: 1, graphRevision: conflicted ? 2 : 1 })
  const productStore = {
    async readProject() { return project(conflicted ? deletedDocument : baseDocument) },
    async updateProjectDocument(_userId, _projectId, update) { return project(update(structuredClone(baseDocument))) },
    async loadCanvasCollaboration() {
      return {
        graph: { nodes: [structuredClone(sourceNode)], edges: [] },
        graphRevision: conflicted ? 2 : 1,
        syncProtocolEpoch: 2,
        updates: [],
      }
    },
    async appendCanvasGraphUpdate() {
      appendCount += 1
      if (!conflicted) {
        conflicted = true
        const error = new Error('stale graph revision')
        error.code = canvasGraphConflictCode
        throw error
      }
      throw new Error('删除后的图谱不应再次追加结果节点。')
    },
    async compactCanvasGraphUpdates() {},
  }

  const committed = await commitCanvasProjectMutation({
    productStore,
    userId: 'user-1',
    projectId: 'project-1',
    mutationId: 'generation:result',
    mutate(document) {
      const dismissed = document.generationJobs?.some((job) => job.dismissedOutputIds?.includes('output-1'))
      return {
        ...document,
        nodes: dismissed
          ? document.nodes.filter((node) => node.id !== resultNode.id)
          : document.nodes.some((node) => node.id === resultNode.id) ? document.nodes : [...document.nodes, resultNode],
      }
    },
  })

  assert.equal(appendCount, 1)
  assert.deepEqual(committed.graphCommit.graph.nodes.map((node) => node.id), ['source'])
  assert.equal(committed.baseGraphRevision, 2)
  assert.equal(committed.graphRevision, 2)
})

test('提交回执使用实际写入的 revision 区间，不认领前后并发版本', async () => {
  const sourceNode = { id: 'source', type: 'text', position: { x: 0, y: 0 }, data: { label: '描述', content: '描述' } }
  const resultNode = { id: 'result', type: 'result', position: { x: 320, y: 0 }, data: { label: '结果' } }
  const initialDocument = { id: 'project-1', name: 'Demo', nodes: [sourceNode], edges: [], generationJobs: [], updatedAt: 10 }
  const concurrentDocument = { ...initialDocument, name: '并发命名', updatedAt: 20 }
  let committedDocument
  let readCount = 0
  const productStore = {
    async readProject() {
      readCount += 1
      if (readCount === 1) return { document: structuredClone(initialDocument), revision: 1, graphRevision: 1 }
      return { document: { ...structuredClone(committedDocument), name: '后续命名', updatedAt: 40 }, revision: 4, graphRevision: 2 }
    },
    async updateProjectDocument(_userId, _projectId, update) {
      committedDocument = update(structuredClone(concurrentDocument))
      return { document: structuredClone(committedDocument), revision: 3, graphRevision: 1 }
    },
    async loadCanvasCollaboration() {
      return { graph: { nodes: [structuredClone(sourceNode)], edges: [] }, graphRevision: 1, syncProtocolEpoch: 2, updates: [] }
    },
    async appendCanvasGraphUpdate(_userId, _projectId, payload) {
      assert.equal(payload.expectedGraphRevision, 1)
      return { graphRevision: 2, mutationRevision: 2, updatedAt: 30, updateCount: 1, duplicate: false }
    },
    async compactCanvasGraphUpdates() {},
  }

  const committed = await commitCanvasProjectMutation({
    productStore,
    userId: 'user-1',
    projectId: 'project-1',
    mutationId: 'agent-workflow:result',
    mutate: (document) => ({ ...document, nodes: [...document.nodes, resultNode], updatedAt: 30 }),
  })

  assert.equal(committed.saved.revision, 4)
  assert.equal(committed.baseRevision, 2)
  assert.equal(committed.revision, 3)
  assert.equal(committed.baseGraphRevision, 1)
  assert.equal(committed.graphRevision, 2)
})
