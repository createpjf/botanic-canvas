import type {
  GenerationJob,
  GenerationKind,
  GenerationRecipe,
  RefinementMode,
  GenerationSettings,
  GenerationModelOption,
} from '../domain/canvas'
import { productAuthorizationHeader } from './productSession'

type MediaReferencePayload = {
  nodeId: string
  assetId: string
  name: string
  role: string
  primary?: boolean
  priority?: number
  mediaKind?: 'image' | 'video'
  inputRole?: 'first_frame' | 'last_frame' | 'reference_image' | 'reference_video'
  dataUrl?: string
  mediaId?: string
}

export type SubmitGenerationInput = {
  projectId: string
  kind: GenerationKind
  prompt: string
  batchCount: number
  settings: GenerationSettings
  recipe: GenerationRecipe
  parent?: {
    nodeId: string
    name: string
    image: string
  }
  refinementMode?: RefinementMode
  agentRun?: { runId: string; branchId: string }
}

type SubmitGenerationPayload = Omit<SubmitGenerationInput, 'recipe' | 'parent'> & {
  recipe: Omit<GenerationRecipe, 'references'> & {
    references: MediaReferencePayload[]
  }
  parent?: {
    nodeId: string
    name: string
    dataUrl?: string
    mediaId?: string
  }
}

type ApiErrorPayload = {
  error?: {
    code?: string
    message?: string
  }
}

export class GenerationApiError extends Error {
  code?: string
  status: number

  constructor(message: string, options: { code?: string; status: number }) {
    super(message)
    this.name = 'GenerationApiError'
    this.code = options.code
    this.status = options.status
  }
}

export type GenerationServiceHealth = {
  status: 'ok'
  provider: string
  configured: boolean
  maxBatchCount?: number
  models?: string[]
  modelOptions?: GenerationModelOption[]
  promptRefinement?: {
    provider: 'flock-api'
    configured: boolean
    model?: string
  }
  agentPlanner?: {
    provider: 'flock-api'
    configured: boolean
    model?: string
    models?: string[]
  }
}

function readableApiError(payload: ApiErrorPayload | null, fallback: string) {
  return payload?.error?.message || fallback
}

// 任务提交、轮询与读取旧参考素材共用同一上限，避免画布永久停在“正在整理参考素材”。
const generationRequestTimeoutMs = 5 * 60_000

function submissionIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `${Date.now()}${Math.random().toString(36).slice(2)}`
}

function shouldRetrySubmission(error: unknown) {
  return error instanceof GenerationApiError && (error.status === 0 || error.status >= 500 || error.code === 'WORKSPACE_STORE_TIMEOUT')
}

async function requestJson<T>(path: string, init?: RequestInit, timeoutMs = generationRequestTimeoutMs): Promise<T> {
  let response: Response
  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = () => controller.abort()
  if (init?.signal?.aborted) controller.abort()
  else init?.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const headers = new Headers(init?.headers)
    headers.set('Accept', 'application/json')
    for (const [key, value] of Object.entries(await productAuthorizationHeader())) headers.set(key, value)
    response = await fetch(path, {
      ...init,
      headers,
      signal: controller.signal,
    })
  } catch {
    if (timedOut) {
      throw new GenerationApiError('任务等待超过 5 分钟，已停止等待。请重试。', { code: 'REQUEST_TIMEOUT', status: 0 })
    }
    throw new GenerationApiError('真实生图服务不可用，请稍后重试。', { status: 0 })
  } finally {
    window.clearTimeout(timeoutId)
    init?.signal?.removeEventListener('abort', onCallerAbort)
  }

  const payload = await response.json().catch(() => null) as T | ApiErrorPayload | null
  if (!response.ok) {
    const error = payload as ApiErrorPayload | null
    throw new GenerationApiError(readableApiError(error, '真实生图服务返回异常，请稍后重试。'), {
      code: error?.error?.code,
      status: response.status,
    })
  }

  return payload as T
}

/**
 * 真实任务的可用性与模型能力均由服务端声明；前端不根据本地默认值推断服务已就绪。
 */
export async function getGenerationServiceHealth(): Promise<GenerationServiceHealth> {
  const health = await requestJson<GenerationServiceHealth>('/api/health')
  if (health.status !== 'ok') throw new Error('真实生图服务状态异常，请稍后重新检查。')
  return health
}

export async function assertGenerationServiceReady(): Promise<GenerationServiceHealth> {
  const health = await getGenerationServiceHealth()
  if (!health.configured) {
    throw new Error('真实生成服务已启动，但尚未配置 OPENAI_API_KEY 或 MINIMAX_API_KEY。')
  }
  return health
}

function readBlobAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('参考素材读取失败。'))
    reader.onerror = () => reject(reader.error ?? new Error('参考素材读取失败。'))
    reader.readAsDataURL(blob)
  })
}

async function mediaToDataUrl(source: string, mediaKind: 'image' | 'video') {
  if (source.startsWith(`data:${mediaKind}/`)) return source

  const controller = new AbortController()
  let timedOut = false
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, generationRequestTimeoutMs)
  try {
    const response = await fetch(source, { signal: controller.signal })
    if (!response.ok) throw new Error('无法读取画布参考素材，请重新加入后再生成。')
    const blob = await response.blob()
    if (mediaKind === 'video' ? blob.type !== 'video/mp4' : !blob.type.startsWith('image/')) {
      throw new Error(mediaKind === 'video' ? '视频参考仅支持 MP4。' : '仅支持图片作为真实生成参考。')
    }
    return readBlobAsDataUrl(blob)
  } catch (error) {
    if (timedOut) throw new Error('参考素材读取超过 5 分钟，请重新加入后重试。')
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function mediaIdFromSource(source: string) {
  try {
    const pathname = new URL(source, window.location.origin).pathname
    const match = pathname.match(/^\/api\/media\/([^/]+)$/)
    return match ? decodeURIComponent(match[1]) : undefined
  } catch {
    return undefined
  }
}

async function mediaInputPayload(source: string, mediaKind: 'image' | 'video' = 'image') {
  const mediaId = mediaIdFromSource(source)
  return mediaId ? { mediaId } : { dataUrl: await mediaToDataUrl(source, mediaKind) }
}

async function buildPayload(input: SubmitGenerationInput): Promise<SubmitGenerationPayload> {
  const references = await Promise.all(input.recipe.references.map(async (reference) => ({
    nodeId: reference.nodeId,
    assetId: reference.assetId,
    name: reference.name,
    role: reference.role,
    primary: reference.primary,
    priority: reference.priority,
    mediaKind: reference.mediaKind ?? 'image',
    inputRole: reference.inputRole,
    ...(await mediaInputPayload(reference.image, reference.mediaKind ?? 'image')),
  })))

  return {
    projectId: input.projectId,
    kind: input.kind,
    prompt: input.prompt,
    batchCount: input.batchCount,
    settings: input.settings,
    recipe: {
      ...input.recipe,
      references,
    },
    parent: input.parent
      ? {
          nodeId: input.parent.nodeId,
          name: input.parent.name,
          ...(await mediaInputPayload(input.parent.image)),
        }
      : undefined,
    refinementMode: input.refinementMode,
    agentRun: input.agentRun,
  }
}

export async function submitGenerationJob(input: SubmitGenerationInput) {
  const payload = await buildPayload(input)
  const idempotencyKey = submissionIdempotencyKey()
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await requestJson<GenerationJob>('/api/generation-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(payload),
      })
    } catch (error) {
      if (!shouldRetrySubmission(error) || attempt === 2) throw error
      await new Promise((resolve) => window.setTimeout(resolve, 500))
    }
  }
  throw new GenerationApiError('真实生图任务提交失败，请重试。', { status: 0 })
}

export function getGenerationJob(jobId: string) {
  // 状态轮询不是实际生图请求；数据库暂时抖动时，15 秒即可交还 UI，而不是空转 5 分钟。
  return requestJson<GenerationJob>(`/api/generation-jobs/${encodeURIComponent(jobId)}`, undefined, 15_000)
}

export async function listProjectGenerationJobs(projectId: string) {
  const response = await requestJson<{ jobs: GenerationJob[] }>(`/api/projects/${encodeURIComponent(projectId)}/generation-jobs`, undefined, 15_000)
  return response.jobs
}

export async function reconcileProjectGenerationResults(projectId: string) {
  return requestJson<{ document: import('../domain/canvas').CanvasDocument; revision: number; changed: boolean }>(
    `/api/projects/${encodeURIComponent(projectId)}/reconcile-generation-results`,
    { method: 'POST' },
    30_000,
  )
}

export function cancelGenerationJob(jobId: string) {
  return requestJson<GenerationJob>(`/api/generation-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  })
}
