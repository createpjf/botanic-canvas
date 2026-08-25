import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CanvasRegionLeaseError,
  acquireCanvasRegionLease,
  assertLeaseForCommit,
  canvasRegionId,
  regionsOverlap,
  releaseCanvasRegionLease,
  settleCandidateDecision,
} from './canvasRegionLease.mjs'

test('区域标识与节点书写顺序无关', () => {
  // 否则换个顺序就能拿到「另一个区域」的租约，守卫形同虚设。
  assert.equal(canvasRegionId(['b', 'a']), canvasRegionId(['a', 'b', 'a']))
  assert.notEqual(canvasRegionId(['a']), canvasRegionId(['a', 'b']))
  assert.throws(() => canvasRegionId([]), (error) => error.code === 'REGION_EMPTY')
  assert.equal(regionsOverlap(['a', 'b'], ['b', 'c']), true)
  assert.equal(regionsOverlap(['a'], ['b']), false)
})

test('相交区域被占用时申请失败，不相交的可以同时持有', () => {
  const first = acquireCanvasRegionLease({ nodeIds: ['n1', 'n2'], holderId: 'agent-a', projectId: 'p-1', now: 0 })
  assert.throws(
    () => acquireCanvasRegionLease({ leases: first.leases, nodeIds: ['n2', 'n9'], holderId: 'agent-b', projectId: 'p-1', now: 10 }),
    (error) => error instanceof CanvasRegionLeaseError && error.code === 'CANVAS_REGION_LEASED',
  )
  // 不相交的区域互不影响：整文档版本冲突会让它白跑，区域租约不会。
  const second = acquireCanvasRegionLease({ leases: first.leases, nodeIds: ['n7'], holderId: 'agent-b', projectId: 'p-1', now: 10 })
  assert.equal(second.leases.length, 2)
  // 另一个项目的同名节点不冲突。
  assert.doesNotThrow(() => acquireCanvasRegionLease({
    leases: first.leases, nodeIds: ['n1'], holderId: 'agent-c', projectId: 'p-2', now: 10,
  }))
})

test('同一持有者重复申请是续期，不是冲突', () => {
  // 重试是正常路径；让一次网络重试撞上自己上一次的租约再报「区域被占用」，
  // 是最容易让人困惑的一种失败。
  const first = acquireCanvasRegionLease({ nodeIds: ['n1'], holderId: 'agent-a', projectId: 'p-1', now: 0, ttlMs: 1_000 })
  const again = acquireCanvasRegionLease({ leases: first.leases, nodeIds: ['n1'], holderId: 'agent-a', projectId: 'p-1', now: 500, ttlMs: 1_000 })
  assert.equal(again.renewed, true)
  assert.equal(again.leases.length, 1)
  assert.equal(again.lease.expiresAt, 1_500)
})

test('过期租约不再阻塞他人', () => {
  // 一个卡死的 Agent 不该长期占住区域。
  const first = acquireCanvasRegionLease({ nodeIds: ['n1'], holderId: 'agent-a', projectId: 'p-1', now: 0, ttlMs: 1_000 })
  assert.doesNotThrow(() => acquireCanvasRegionLease({
    leases: first.leases, nodeIds: ['n1'], holderId: 'agent-b', projectId: 'p-1', now: 1_001,
  }))
})

test('只有持有者能释放租约', () => {
  const first = acquireCanvasRegionLease({ nodeIds: ['n1'], holderId: 'agent-a', projectId: 'p-1', now: 0 })
  assert.throws(() => releaseCanvasRegionLease({ leases: first.leases, leaseId: first.lease.id, holderId: 'agent-b' }),
    (error) => error.code === 'LEASE_NOT_HELD')
  const released = releaseCanvasRegionLease({ leases: first.leases, leaseId: first.lease.id, holderId: 'agent-a', now: 5 })
  assert.equal(released.released, true)
  // 释放之后别人可以立刻拿到。
  assert.doesNotThrow(() => acquireCanvasRegionLease({
    leases: released.leases, nodeIds: ['n1'], holderId: 'agent-b', projectId: 'p-1', now: 6,
  }))
  assert.equal(releaseCanvasRegionLease({ leases: [], leaseId: 'nope', holderId: 'agent-a' }).released, false)
})

test('落地前检查租约有效性与文档版本漂移', () => {
  const { lease } = acquireCanvasRegionLease({
    nodeIds: ['n1'], holderId: 'agent-a', projectId: 'p-1', documentRevision: 7, now: 0, ttlMs: 1_000,
  })
  assert.deepEqual(assertLeaseForCommit({ lease, documentRevision: 7, holderId: 'agent-a', now: 10 }),
    { ok: true, requiresRevalidation: false })
  // 版本变了不代表一定冲突（别人可能改的是另一片区域），因此是「需要复核」而不是直接失败。
  assert.equal(assertLeaseForCommit({ lease, documentRevision: 8, holderId: 'agent-a', now: 10 }).requiresRevalidation, true)
  assert.throws(() => assertLeaseForCommit({ lease, documentRevision: 7, holderId: 'agent-a', now: 2_000 }),
    (error) => error.code === 'CANVAS_REGION_LEASE_EXPIRED')
  assert.throws(() => assertLeaseForCommit({ lease, documentRevision: 7, holderId: 'agent-b', now: 10 }),
    (error) => error.code === 'LEASE_NOT_HELD')
})

test('同一候选不能被两个 Agent 定成不同终态', () => {
  // 终态决定不是文档写入，因此文档版本条件更新挡不住它。
  const first = settleCandidateDecision({ artifactId: 'a-1', decision: 'accepted', deciderId: 'agent-a', now: 1 })
  assert.equal(first.applied, true)
  assert.throws(
    () => settleCandidateDecision({ decisions: first.decisions, artifactId: 'a-1', decision: 'rejected', deciderId: 'agent-b' }),
    (error) => error instanceof CanvasRegionLeaseError && error.code === 'CANDIDATE_ALREADY_SETTLED',
  )
  // 别的候选不受影响。
  assert.equal(settleCandidateDecision({ decisions: first.decisions, artifactId: 'a-2', decision: 'accepted', deciderId: 'agent-b' }).applied, true)
})

test('同一决定重放是无操作，不是冲突', () => {
  // 重试与恢复都会重放；把重放判成冲突会让恢复永远失败。
  const first = settleCandidateDecision({ artifactId: 'a-1', decision: 'accepted', deciderId: 'agent-a', now: 1 })
  const replay = settleCandidateDecision({ decisions: first.decisions, artifactId: 'a-1', decision: 'accepted', deciderId: 'agent-a', now: 9 })
  assert.equal(replay.applied, false)
  assert.equal(replay.decisions.length, 1)
  assert.equal(replay.decisionRecord.decidedAt, 1, '重放不改写原决定的时间')
})
