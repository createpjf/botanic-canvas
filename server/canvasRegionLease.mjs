// @ts-check
import { canonicalHash } from './canonicalHash.mjs'

/**
 * 画布区域租约与候选终态守卫（Epic 11 验收第 5 条）。
 *
 * 项目文档整体已经有版本冲突检测（`writeProject` 的 revision），但它解决的是
 * 「两个人同时保存」。多 Agent 并发是另一回事：
 *
 * - 两个 Agent 各自改画布的**不同**区域时，整文档版本冲突会让后一个白跑一遍，
 *   即使它们根本没碰同一批节点。
 * - 两个 Agent 改**同一**区域时，整文档版本能挡住第二次写入，但挡不住
 *   「两个都宣布同一个候选是终稿」—— 终态决定不是文档写入，它是一次判定。
 *
 * 因此这里是两件事：按节点集合的区域租约（细到区域，而不是整个文档），
 * 以及候选终态的一次性判定（同一候选只能被定一次）。
 *
 * 租约是**咨询性**的：它不替代 `writeProject` 的版本条件更新，而是在那之前就把
 * 显然会冲突的并发挡掉。真正的权威仍是持久化层的条件更新 —— 只靠内存里的租约
 * 会在多进程部署下失效。
 */

/** 租约默认有效期。短到一个卡死的 Agent 不会长期占住区域，长到正常一次编排够用。 */
export const DEFAULT_REGION_LEASE_MS = 90_000

export class CanvasRegionLeaseError extends Error {
  /** @param {string} code @param {string} message @param {number} [statusCode] */
  constructor(code, message, statusCode = 409) {
    super(message)
    this.name = 'CanvasRegionLeaseError'
    this.code = code
    this.statusCode = statusCode
  }
}

/**
 * 区域标识。由**排序后**的节点集合派生，因此同一批节点无论以什么顺序声明都得到
 * 同一个区域 —— 否则换个顺序就能拿到「另一个区域」的租约，守卫形同虚设。
 *
 * @param {string[]} nodeIds
 */
export function canvasRegionId(nodeIds) {
  const unique = [...new Set((nodeIds ?? []).filter((id) => typeof id === 'string' && id.trim()))].sort()
  if (!unique.length) throw new CanvasRegionLeaseError('REGION_EMPTY', '画布区域必须至少包含一个节点。', 400)
  return `region_${canonicalHash(unique).slice(0, 32)}`
}

/** 两个区域是否相交。相交即视为冲突：它们会改到同一批节点。 */
export function regionsOverlap(left, right) {
  const set = new Set(left ?? [])
  return (right ?? []).some((id) => set.has(id))
}

function activeLeases(leases, now) {
  return (leases ?? []).filter((lease) => lease && !lease.releasedAt && lease.expiresAt > now)
}

/**
 * 申请区域租约。
 *
 * 同一持有者重复申请同一区域**续期而不是报冲突**：重试是正常路径，让一次网络重试
 * 撞上自己上一次的租约、然后报「区域被占用」，是最容易让人困惑的一种失败。
 *
 * @param {{
 *   leases?: any[], nodeIds: string[], holderId: string, projectId: string,
 *   documentRevision?: number, ttlMs?: number, now?: number,
 * }} input
 */
export function acquireCanvasRegionLease({
  leases = [], nodeIds, holderId, projectId, documentRevision, ttlMs = DEFAULT_REGION_LEASE_MS, now = Date.now(),
}) {
  if (typeof holderId !== 'string' || !holderId.trim()) {
    throw new CanvasRegionLeaseError('LEASE_HOLDER_REQUIRED', '租约必须记录持有者。', 400)
  }
  const region = canvasRegionId(nodeIds)
  const live = activeLeases(leases, now)
  const mine = live.find((lease) => lease.region === region && lease.holderId === holderId)
  if (mine) {
    const renewed = { ...mine, expiresAt: now + ttlMs, renewedAt: now }
    return { lease: renewed, leases: leases.map((lease) => (lease === mine ? renewed : lease)), renewed: true }
  }
  const conflicting = live.find((lease) => lease.projectId === projectId && regionsOverlap(lease.nodeIds, nodeIds))
  if (conflicting) {
    throw new CanvasRegionLeaseError(
      'CANVAS_REGION_LEASED',
      `画布区域正被「${conflicting.holderId}」占用，${Math.ceil((conflicting.expiresAt - now) / 1000)} 秒后到期。`,
    )
  }
  const lease = {
    id: `lease_${region}_${holderId}`,
    region,
    projectId,
    holderId,
    nodeIds: [...new Set(nodeIds)].sort(),
    // 拿租约时记下文档版本：释放时若版本已变，说明期间有别人写过，落地要重新校验。
    ...(Number.isFinite(documentRevision) ? { documentRevision: Number(documentRevision) } : {}),
    acquiredAt: now,
    expiresAt: now + ttlMs,
  }
  return { lease, leases: [...leases, lease], renewed: false }
}

/**
 * 释放租约。**只有持有者能释放** —— 允许任意方释放等于没有租约。
 *
 * @param {{ leases?: any[], leaseId: string, holderId: string, now?: number }} input
 */
export function releaseCanvasRegionLease({ leases = [], leaseId, holderId, now = Date.now() }) {
  const target = leases.find((lease) => lease.id === leaseId)
  if (!target) return { leases, released: false }
  if (target.holderId !== holderId) {
    throw new CanvasRegionLeaseError('LEASE_NOT_HELD', '只有租约持有者可以释放它。', 403)
  }
  return { leases: leases.map((lease) => (lease === target ? { ...lease, releasedAt: now } : lease)), released: true }
}

/**
 * 落地前的条件检查：租约仍有效，且文档版本没被别人改过。
 *
 * 版本变了不代表一定冲突（别人可能改的是另一片区域），因此这里返回的是
 * `requiresRevalidation` 而不是直接失败 —— 直接失败会把「有人改了画布另一角」
 * 变成「你这次编排作废」。
 *
 * @param {{ lease: any, documentRevision?: number, holderId: string, now?: number }} input
 */
export function assertLeaseForCommit({ lease, documentRevision, holderId, now = Date.now() }) {
  if (!lease || lease.releasedAt || lease.expiresAt <= now) {
    throw new CanvasRegionLeaseError('CANVAS_REGION_LEASE_EXPIRED', '画布区域租约已过期，请重新获取后再提交。')
  }
  if (lease.holderId !== holderId) {
    throw new CanvasRegionLeaseError('LEASE_NOT_HELD', '只有租约持有者可以提交该区域的变更。', 403)
  }
  const drifted = Number.isFinite(lease.documentRevision) && Number.isFinite(documentRevision)
    && Number(documentRevision) !== Number(lease.documentRevision)
  return { ok: true, requiresRevalidation: drifted }
}

/**
 * 候选终态的一次性判定。
 *
 * 终态决定不是文档写入，因此文档版本条件更新挡不住它：两个 Agent 可以在不写文档的
 * 情况下各自宣布同一个候选是终稿。这里按 (候选, 决定) 幂等 —— 同一个决定重放是
 * 无操作，**不同**的决定则冲突。
 *
 * 「同一决定重放无操作」是必需的：重试与恢复都会重放，把重放判成冲突会让恢复
 * 永远失败。
 *
 * @param {{ decisions?: any[], artifactId: string, decision: string, deciderId: string, now?: number }} input
 */
export function settleCandidateDecision({ decisions = [], artifactId, decision, deciderId, now = Date.now() }) {
  const existing = decisions.find((item) => item?.artifactId === artifactId && !item?.supersededAt)
  if (existing) {
    if (existing.decision === decision) {
      // 同一决定的重放：无操作。重试与恢复都会走到这里。
      return { decisions, decisionRecord: existing, applied: false }
    }
    throw new CanvasRegionLeaseError(
      'CANDIDATE_ALREADY_SETTLED',
      `候选「${artifactId}」已由「${existing.deciderId}」定为「${existing.decision}」，不能再被定为「${decision}」。`,
    )
  }
  const decisionRecord = { artifactId, decision, deciderId, decidedAt: now }
  return { decisions: [...decisions, decisionRecord], decisionRecord, applied: true }
}
