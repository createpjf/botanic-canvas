import type {
  GenerationJob,
  GenerationKind,
  GenerationRecipe,
  GenerationSettings,
} from '../domain/canvas'
import { productAuthorizationHeader } from './productSession'

type ImageReferencePayload = {
  nodeId: string
  assetId: string
  name: string
  role: string
  primary?: boolean
  priority?: number
  dataUrl: string
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
}

type SubmitGenerationPayload = Omit<SubmitGenerationInput, 'recipe' | 'parent'> & {
  recipe: Omit<GenerationRecipe, 'references'> & {
    references: ImageReferencePayload[]
  }
  parent?: {
    nodeId: string
    name: string
    dataUrl: string
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
}

function readableApiError(payload: ApiErrorPayload | null, fallback: string) {
  return payload?.error?.message || fallback
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    const headers = new Headers(init?.headers)
    headers.set('Accept', 'application/json')
    for (const [key, value] of Object.entries(await productAuthorizationHeader())) headers.set(key, value)
    response = await fetch(path, {
      ...init,
      headers,
    })
  } catch {
    throw new GenerationApiError('真实生图服务不可用：请先启动 npm run server。', { status: 0 })
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
    throw new Error('真实生图服务已启动，但尚未配置 OPENAI_API_KEY。请填写 .env 后重启 npm run server。')
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

async function imageToDataUrl(image: string) {
  if (image.startsWith('data:image/')) return image

  const response = await fetch(image)
  if (!response.ok) throw new Error('无法读取画布参考素材，请重新加入后再生成。')
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) throw new Error('仅支持图片作为真实生成参考。')
  return readBlobAsDataUrl(blob)
}

async function buildPayload(input: SubmitGenerationInput): Promise<SubmitGenerationPayload> {
  const references = await Promise.all(input.recipe.references.map(async (reference) => ({
    nodeId: reference.nodeId,
    assetId: reference.assetId,
    name: reference.name,
    role: reference.role,
    primary: reference.primary,
    priority: reference.priority,
    dataUrl: await imageToDataUrl(reference.image),
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
          dataUrl: await imageToDataUrl(input.parent.image),
        }
      : undefined,
  }
}

export async function submitGenerationJob(input: SubmitGenerationInput) {
  const payload = await buildPayload(input)
  return requestJson<GenerationJob>('/api/generation-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function getGenerationJob(jobId: string) {
  return requestJson<GenerationJob>(`/api/generation-jobs/${encodeURIComponent(jobId)}`)
}

export function cancelGenerationJob(jobId: string) {
  return requestJson<GenerationJob>(`/api/generation-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  })
}
