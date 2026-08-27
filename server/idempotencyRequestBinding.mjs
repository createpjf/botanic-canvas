// @ts-check
import { canonicalHash } from './canonicalHash.mjs'

export const idempotencyRequestBindingVersion = 1

/**
 * 幂等实体的不可变请求绑定。实体 ID 只证明「用了同一个 key」，不能证明请求相同；
 * scope + projectId + canonical request hash 才是可安全重放的完整身份。
 *
 * @param {{ scope: string, projectId: string, request: unknown }} input
 */
export function createIdempotencyRequestBinding(input) {
  const scope = typeof input?.scope === 'string' ? input.scope.trim() : ''
  const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : ''
  if (!scope || !projectId) throw new TypeError('幂等请求绑定缺少 scope 或 projectId。')
  return {
    version: idempotencyRequestBindingVersion,
    scope,
    projectId,
    requestHash: canonicalHash(input.request ?? null),
  }
}

/** @param {unknown} left @param {unknown} right */
export function matchingIdempotencyRequestBinding(left, right) {
  if (!left || typeof left !== 'object' || Array.isArray(left)
    || !right || typeof right !== 'object' || Array.isArray(right)) return false
  const stored = /** @type {Record<string, any>} */ (left)
  const candidate = /** @type {Record<string, any>} */ (right)
  return stored.version === idempotencyRequestBindingVersion
    && candidate.version === idempotencyRequestBindingVersion
    && stored.scope === candidate.scope
    && stored.projectId === candidate.projectId
    && typeof stored.requestHash === 'string'
    && stored.requestHash === candidate.requestHash
}

/**
 * Adapter 行锁内的 sticky merge：旧 writer 可省略绑定，但不能清空或偷换已建立绑定。
 * Legacy 实体首次由新服务安全识别后允许补写 candidate binding。
 * @param {unknown} existingEntity @param {unknown} incomingEntity
 */
export function idempotencyRequestBindingWriteDecision(existingEntity, incomingEntity) {
  const existing = existingEntity && typeof existingEntity === 'object' && !Array.isArray(existingEntity)
    ? /** @type {Record<string, any>} */ (existingEntity)
    : undefined
  const incoming = incomingEntity && typeof incomingEntity === 'object' && !Array.isArray(incomingEntity)
    ? /** @type {Record<string, any>} */ (incomingEntity)
    : undefined
  const storedBinding = existing?.idempotencyBinding
  const candidateBinding = incoming?.idempotencyBinding
  if (storedBinding && candidateBinding
    && !matchingIdempotencyRequestBinding(storedBinding, candidateBinding)) {
    return { kind: 'conflict', binding: storedBinding }
  }
  return { kind: 'compatible', binding: storedBinding ?? candidateBinding }
}
