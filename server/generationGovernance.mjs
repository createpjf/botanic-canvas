import { maximumReferencesForModel } from './generationVocabulary.mjs'

const TRANSIENT_PROVIDER_CODES = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'GENERATION_FAILED',
  'REQUEST_TIMEOUT',
])

function positiveNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

export function estimateGenerationCostUnits(input, { mediaKind = 'image' } = {}) {
  const outputs = Math.max(1, Math.floor(positiveNumber(input?.batchCount, 1)))
  const resolution = String(input?.settings?.resolution ?? '1K').toUpperCase()
  const resolutionFactor = resolution === '4K' ? 4 : resolution === '2K' ? 2 : 1
  if (mediaKind === 'video') {
    const duration = Math.max(5, positiveNumber(input?.settings?.duration, 5))
    return outputs * resolutionFactor * Math.ceil(duration / 5) * 4
  }
  return outputs * resolutionFactor
}

export function buildGenerationUsage(input, {
  jobId,
  workspaceId = 'workspace-default',
  memberId,
  mediaKind = 'image',
  provider,
} = {}) {
  return {
    version: 1,
    jobId,
    workspaceId,
    projectId: input.projectId,
    memberId,
    model: input.settings?.model,
    provider,
    mediaKind,
    outputCount: Math.max(1, Math.floor(positiveNumber(input.batchCount, 1))),
    costUnits: estimateGenerationCostUnits(input, { mediaKind }),
  }
}

export function summarizeGenerationUsage(jobs = []) {
  const unique = new Map()
  for (const job of jobs) {
    const usage = job?.usage
    const id = usage?.jobId ?? job?.id
    if (id && usage && !unique.has(id)) unique.set(id, usage)
  }
  const summary = { totalCostUnits: 0, taskCount: unique.size, byModel: {} }
  for (const usage of unique.values()) {
    const cost = positiveNumber(usage.costUnits)
    summary.totalCostUnits += cost
    const model = usage.model ?? 'unknown'
    summary.byModel[model] = (summary.byModel[model] ?? 0) + cost
  }
  return summary
}

export function generationBudgetDecision({ used = 0, requested = 0, limit = Number.POSITIVE_INFINITY, warningRatio = 0.8 }) {
  const safeLimit = positiveNumber(limit, Number.POSITIVE_INFINITY)
  const safeUsed = positiveNumber(used)
  const safeRequested = positiveNumber(requested)
  const next = safeUsed + safeRequested
  return {
    allowed: next <= safeLimit,
    warning: Number.isFinite(safeLimit) && (next / safeLimit >= warningRatio || next > safeLimit),
    remaining: Number.isFinite(safeLimit)
      ? Math.max(0, safeLimit - (next > safeLimit ? safeUsed : next))
      : Number.POSITIVE_INFINITY,
  }
}

export async function reserveGenerationBudget({ securityControls, usage, limits = {}, windowMs = 24 * 60 * 60_000 }) {
  const dimensions = [
    ['workspace-budget', usage.workspaceId, limits.workspace],
    ['project-budget', usage.projectId, limits.project],
    ['member-budget', usage.memberId, limits.member],
  ].filter(([, subject, limit]) => subject && Number.isFinite(Number(limit)))
  if (!dimensions.length) return { allowed: true, reused: false, warning: false }
  const result = await securityControls.reserveMany({
    reservationId: usage.jobId,
    windowMs,
    entries: dimensions.map(([scope, subject, limit]) => ({ scope, subject, limit: Number(limit), cost: usage.costUnits })),
  })
  const relevantLimit = Math.min(...dimensions.map((entry) => Number(entry[2])))
  return {
    ...result,
    warning: result.allowed && Number.isFinite(result.remaining) && result.remaining / relevantLimit <= 0.2,
  }
}

export async function releaseGenerationBudget({ securityControls, usage, limits = {}, reservedAt, windowMs = 24 * 60 * 60_000 }) {
  const entries = [
    ['workspace-budget', usage.workspaceId, limits.workspace],
    ['project-budget', usage.projectId, limits.project],
    ['member-budget', usage.memberId, limits.member],
  ].filter(([, subject, limit]) => subject && Number.isFinite(Number(limit)))
    .map(([scope, subject, limit]) => ({ scope, subject, limit: Number(limit), cost: usage.costUnits }))
  if (!entries.length) return { released: false }
  return securityControls.releaseMany({ reservationId: usage.jobId, entries, windowMs, reservedAt })
}

function declaredInputRoles(model) {
  return new Set(model.inputRoles ?? ['reference_image', 'first_frame', 'last_frame', 'reference_video'])
}

export function compatibleFallbackModel({ catalog = [], input, candidateIds = [] }) {
  const source = catalog.find((model) => model.id === input?.settings?.model)
  if (!source) return undefined
  const references = input?.recipe?.references ?? input?.references ?? []
  const requiredRoles = new Set(references
    .map((reference) => reference.inputRole)
    .filter(Boolean))
  const referenceCount = references.length + (input?.parent ? 1 : 0)
  const usesMask = Boolean(input?.mask || input?.maskRegion || input?.recipe?.mask || input?.recipe?.maskImage || input?.recipe?.maskRegion)
  const usesCustomSize = input?.settings?.outputWidth !== undefined || input?.settings?.outputHeight !== undefined
  for (const candidateId of candidateIds) {
    const candidate = catalog.find((model) => model.id === candidateId)
    if (!candidate || candidate.provider === source.provider || candidate.mediaKind !== source.mediaKind) continue
    if (!(candidate.aspectRatios ?? []).includes(input.settings.aspectRatio)) continue
    if (!(candidate.resolutions ?? []).includes(input.settings.resolution)) continue
    const roles = declaredInputRoles(candidate)
    if ([...requiredRoles].some((role) => !roles.has(role))) continue
    if (referenceCount > maximumReferencesForModel(candidate)) continue
    if (usesMask && candidate.supportsMask !== true) continue
    if (usesCustomSize && candidate.supportsCustomSize !== true) continue
    if (typeof input.settings.searchGrounding === 'boolean' && candidate.supportsSearchGrounding !== true) continue
    if (typeof input.settings.thinkingLevel === 'string'
      && !(candidate.thinkingLevels ?? []).includes(input.settings.thinkingLevel)) continue
    if (source.mediaKind === 'video' && !(candidate.durations ?? []).includes(Number(input.settings.duration))) continue
    return candidate
  }
  return undefined
}

export class ProviderCircuitBreaker {
  #states = new Map()
  constructor({ failureThreshold = 3, cooldownMs = 30_000, now = Date.now } = {}) {
    this.failureThreshold = Math.max(1, failureThreshold)
    this.cooldownMs = Math.max(1, cooldownMs)
    this.now = now
  }

  snapshot(provider) {
    const current = this.#states.get(provider) ?? { state: 'closed', failures: 0, openedAt: 0 }
    if (current.state === 'open' && this.now() - current.openedAt >= this.cooldownMs) {
      return { ...current, state: 'half-open' }
    }
    return { ...current }
  }

  canRequest(provider) {
    const state = this.snapshot(provider)
    if (state.state === 'open') return { allowed: false, state: 'open' }
    if (state.state === 'half-open') {
      this.#states.set(provider, { ...state, state: 'half-open', probeInFlight: true })
      return { allowed: true, state: 'half-open' }
    }
    return { allowed: true, state: 'closed' }
  }

  recordFailure(provider, error = {}) {
    if (!TRANSIENT_PROVIDER_CODES.has(error.code)) return this.snapshot(provider)
    const current = this.snapshot(provider)
    const failures = current.failures + 1
    const next = failures >= this.failureThreshold
      ? { state: 'open', failures, openedAt: this.now(), lastErrorCode: error.code }
      : { state: 'closed', failures, openedAt: 0, lastErrorCode: error.code }
    this.#states.set(provider, next)
    return { ...next }
  }

  recordSuccess(provider) {
    const next = { state: 'closed', failures: 0, openedAt: 0 }
    this.#states.set(provider, next)
    return { ...next }
  }
}
