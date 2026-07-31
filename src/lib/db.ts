import Dexie, { type Table } from 'dexie'
import {
  globalAssetLibraryId,
  globalWorkflowTemplateLibraryId,
  type AssetRecord,
  type CanvasDocument,
  type GlobalAssetLibrary,
  type GlobalWorkflowTemplateLibrary,
} from '../domain/canvas'
import { normalizeAssetRecord } from '../domain/assets'
import { ProductApiError, productRequest, serverPersistenceEnabled } from './productSession'

type CanvasDocumentBackup = {
  id: string
  document: CanvasDocument
  updatedAt: number
}

type CanvasMediaRecord = {
  id: string
  blob: Blob
  createdAt: number
  updatedAt: number
}

type CanvasPendingSyncRecord = {
  id: string
  document: CanvasDocument
  updatedAt: number
}

export type CanvasProjectSummary = {
  id: string
  name: string
  updatedAt: number
  revision?: number
  nodeCount?: number
  resultCount?: number
  coverImage?: string
}

const mediaReferencePrefix = 'media://'
const mediaObjectUrls = new Map<string, string>()
const objectUrlToMediaId = new Map<string, string>()
const dataUrlToMediaId = new Map<string, string>()

class BotanicCanvasDatabase extends Dexie {
  documents!: Table<CanvasDocument, string>
  assetLibraries!: Table<GlobalAssetLibrary, string>
  workflowTemplateLibraries!: Table<GlobalWorkflowTemplateLibrary, string>
  documentBackups!: Table<CanvasDocumentBackup, string>
  media!: Table<CanvasMediaRecord, string>
  pendingSync!: Table<CanvasPendingSyncRecord, string>

  constructor() {
    super('botanic-canvas-ui')
    this.version(1).stores({ documents: 'id, updatedAt' })
    this.version(2).stores({
      documents: 'id, updatedAt',
      assetLibraries: 'id, updatedAt',
    })
    this.version(3).stores({
      documents: 'id, updatedAt',
      assetLibraries: 'id, updatedAt',
      documentBackups: 'id, updatedAt',
      media: 'id, updatedAt',
    })
    this.version(4).stores({
      documents: 'id, updatedAt',
      assetLibraries: 'id, updatedAt',
      documentBackups: 'id, updatedAt',
      media: 'id, updatedAt',
      pendingSync: 'id, updatedAt',
    })
    this.version(5).stores({
      documents: 'id, updatedAt',
      assetLibraries: 'id, updatedAt',
      workflowTemplateLibraries: 'id, updatedAt',
      documentBackups: 'id, updatedAt',
      media: 'id, updatedAt',
      pendingSync: 'id, updatedAt',
    })
  }
}

export const canvasDb = new BotanicCanvasDatabase()

/**
 * 画布写入、全局素材迁移和跨项目删除共用一条队列。
 * 这样全局删除总会读取此前已经排队的最新项目快照，后续写入也不会与
 * IndexedDB 事务交错执行。
 */
let persistenceTail: Promise<void> = Promise.resolve()
const remoteRevisions = new Map<string, number>()
const remoteDocuments = new Map<string, CanvasDocument>()
const remoteWriteDebounceMs = 500

type CollectionPatch<T extends { id: string }> = {
  upsert?: T[]
  remove?: string[]
}

type CanvasDocumentPatch = {
  fields?: Record<string, unknown>
  nodes?: CollectionPatch<CanvasDocument['nodes'][number]>
  edges?: CollectionPatch<CanvasDocument['edges'][number]>
}

type RemoteWriteWaiter = {
  resolve: (document: CanvasDocument) => void
  reject: (error: unknown) => void
}

type PendingRemoteWrite = {
  document: CanvasDocument
  waiters: RemoteWriteWaiter[]
  timerId: number | null
  saving: boolean
  flushPromise: Promise<void> | null
}

const pendingRemoteWrites = new Map<string, PendingRemoteWrite>()
// 刷新远端时，后台同步可能已经读取了旧草稿。用递增版本令这次旧同步在
// 写入或上报冲突前自行失效，避免“刷新后冲突又出现”。
const discardedDraftEpochs = new Map<string, number>()

function enqueuePersistence<T>(operation: () => Promise<T>) {
  const run = persistenceTail.then(operation, operation)
  persistenceTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function flushRemoteDocumentWrite(id: string) {
  const pending = pendingRemoteWrites.get(id)
  if (!pending) return
  // 并发触发的页面离开、重命名等操作必须等待同一次远端写入结束，不能各自
  // "看到 saving 就返回"，否则后续 PATCH 仍可能被旧快照覆盖。
  if (pending.flushPromise) return pending.flushPromise

  const flush = (async () => {
    if (pending.timerId !== null) {
      window.clearTimeout(pending.timerId)
      pending.timerId = null
    }

    pending.saving = true
    const document = pending.document
    const waiters = pending.waiters.splice(0)
    try {
      const normalized = await writeRemoteCanvasDocument(document)
      await clearPendingSyncDocument(document.id, document.updatedAt)
      waiters.forEach(({ resolve }) => resolve(normalized))
    } catch (error) {
      waiters.forEach(({ reject }) => reject(error))
    } finally {
      pending.saving = false
      pending.flushPromise = null
      if (pending.document !== document) {
        await flushRemoteDocumentWrite(id)
        return
      }
      if (!pending.waiters.length) pendingRemoteWrites.delete(id)
    }
  })()
  pending.flushPromise = flush
  return flush
}

function browserIsOnline() {
  return typeof navigator === 'undefined' || navigator.onLine
}

function queueRemoteDocumentWrite(document: CanvasDocument, immediate = false) {
  if (!browserIsOnline()) return Promise.reject(new ProductApiError('当前离线，已保存到本地草稿。网络恢复后会自动同步。', 0, 'OFFLINE_DRAFT_SAVED'))
  let pending = pendingRemoteWrites.get(document.id)
  if (!pending) {
    pending = { document, waiters: [], timerId: null, saving: false, flushPromise: null }
    pendingRemoteWrites.set(document.id, pending)
  }
  pending.document = document

  const completion = new Promise<CanvasDocument>((resolve, reject) => {
    pending!.waiters.push({ resolve, reject })
  })

  if (pending.timerId !== null) window.clearTimeout(pending.timerId)
  if (immediate) {
    pending.timerId = null
    void flushRemoteDocumentWrite(document.id)
  } else if (!pending.saving) {
    pending.timerId = window.setTimeout(() => void flushRemoteDocumentWrite(document.id), remoteWriteDebounceMs)
  }
  return completion
}

/** 在切换项目或关闭页面前主动发送已合并的最终快照，缩短 debounce 带来的丢失窗口。 */
export async function flushPendingCanvasDocumentWrites() {
  await Promise.all([...pendingRemoteWrites.keys()].map((id) => flushRemoteDocumentWrite(id)))
}

/**
 * 将 IndexedDB 中尚未确认的草稿重新提交到服务端。此函数只在联网时运行，
 * 失败的草稿会原样保留，下一次 online 事件或打开画布时继续尝试。
 */
export async function syncPendingCanvasDrafts() {
  if (!serverPersistenceEnabled || !browserIsOnline()) return { synced: 0, pending: 0, conflicts: 0, conflictIds: [] as string[] }

  try {
    await flushPendingCanvasDocumentWrites()
  } catch (error) {
    if (error instanceof ProductApiError && error.status === 0) {
      const drafts = await readPendingSyncDocuments()
      return { synced: 0, pending: drafts.length, conflicts: 0, conflictIds: [] as string[] }
    }
  }

  const drafts = await readPendingSyncDocuments()
  let synced = 0
  let conflicts = 0
  const conflictIds: string[] = []
  for (const draft of drafts) {
    const epoch = discardedDraftEpochs.get(draft.id) ?? 0
    try {
      const current = await readPendingSyncDocument(draft.id)
      if (epoch !== (discardedDraftEpochs.get(draft.id) ?? 0) || !current || current.updatedAt !== draft.updatedAt) continue
      // 所有远端写入都必须走同一队列。旧实现直接 PATCH，会与正在进行的
      // 即时保存争抢同一个 revision，形成 409 闪烁并覆盖刚生成的结果节点。
      await queueRemoteDocumentWrite(current.document, true)
      await clearPendingSyncDocument(draft.id, draft.updatedAt)
      synced += 1
    } catch (error) {
      const current = await readPendingSyncDocument(draft.id)
      if (epoch !== (discardedDraftEpochs.get(draft.id) ?? 0) || !current || current.updatedAt !== draft.updatedAt) continue
      if (error instanceof ProductApiError && error.status === 0) break
      if (error instanceof ProductApiError && error.code === 'PROJECT_CONFLICT') {
        conflicts += 1
        conflictIds.push(draft.id)
      }
    }
  }
  const remaining = await readPendingSyncDocuments()
  return { synced, pending: remaining.length, conflicts, conflictIds }
}

function mediaId() {
  return `media-${crypto.randomUUID()}`
}

function dataUrlToBlob(value: string) {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i)
  if (!match) return null

  const base64 = match[2].replace(/\s/g, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: match[1].toLowerCase() })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

async function serializeMediaValue(value: unknown, pendingMedia: Map<string, CanvasMediaRecord>): Promise<unknown> {
  if (typeof value === 'string') {
    const knownMediaId = objectUrlToMediaId.get(value)
    if (knownMediaId) return `${mediaReferencePrefix}${knownMediaId}`
    if (!value.startsWith('data:image/')) return value

    const existingMediaId = dataUrlToMediaId.get(value)
    if (existingMediaId) return `${mediaReferencePrefix}${existingMediaId}`

    const blob = dataUrlToBlob(value)
    if (!blob) return value
    const id = mediaId()
    dataUrlToMediaId.set(value, id)
    pendingMedia.set(id, { id, blob, createdAt: Date.now(), updatedAt: Date.now() })
    return `${mediaReferencePrefix}${id}`
  }

  if (Array.isArray(value)) return Promise.all(value.map((item) => serializeMediaValue(item, pendingMedia)))
  if (!isRecord(value)) return value

  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) next[key] = await serializeMediaValue(child, pendingMedia)
  return next
}

async function serializeDocumentMedia(document: CanvasDocument) {
  const pendingMedia = new Map<string, CanvasMediaRecord>()
  const serialized = await serializeMediaValue(document, pendingMedia) as CanvasDocument
  return { document: serialized, media: [...pendingMedia.values()] }
}

async function resolveMediaValue(value: unknown): Promise<unknown> {
  if (typeof value === 'string' && value.startsWith(mediaReferencePrefix)) {
    const id = value.slice(mediaReferencePrefix.length)
    const cachedUrl = mediaObjectUrls.get(id)
    if (cachedUrl) return cachedUrl

    const record = await canvasDb.media.get(id)
    if (!record) return ''
    const objectUrl = URL.createObjectURL(record.blob)
    mediaObjectUrls.set(id, objectUrl)
    objectUrlToMediaId.set(objectUrl, id)
    return objectUrl
  }

  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveMediaValue(item)))
  if (!isRecord(value)) return value

  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) next[key] = await resolveMediaValue(child)
  return next
}

async function hydrateDocumentMedia(document: CanvasDocument) {
  return resolveMediaValue(document) as Promise<CanvasDocument>
}

async function persistLocalDocument(document: CanvasDocument, queueForSync = false) {
  return enqueuePersistence(async () => {
    const previous = await canvasDb.documents.get(document.id)
    const prepared = await serializeDocumentMedia(document)
    const preparedBackup = previous ? await serializeDocumentMedia(previous) : undefined
    await canvasDb.transaction('rw', canvasDb.documents, canvasDb.documentBackups, canvasDb.media, canvasDb.pendingSync, async () => {
      const media = [...prepared.media, ...(preparedBackup?.media ?? [])]
      if (media.length) await canvasDb.media.bulkPut(media)
      if (preparedBackup) {
        await canvasDb.documentBackups.put({ id: document.id, document: preparedBackup.document, updatedAt: Date.now() })
      }
      await canvasDb.documents.put(prepared.document)
      if (queueForSync) {
        await canvasDb.pendingSync.put({ id: document.id, document: prepared.document, updatedAt: document.updatedAt })
      }
    })
    return prepared.document
  })
}

async function readPendingSyncDocument(id: string) {
  return enqueuePersistence(async () => {
    const record = await canvasDb.pendingSync.get(id)
    return record ? { ...record, document: await hydrateDocumentMedia(record.document) } : undefined
  })
}

async function clearPendingSyncDocument(id: string, savedUpdatedAt: number) {
  await enqueuePersistence(async () => {
    const pending = await canvasDb.pendingSync.get(id)
    // 发送期间用户若又有新编辑，保留更新后的草稿，等待下一次同步。
    if (pending && pending.updatedAt <= savedUpdatedAt) await canvasDb.pendingSync.delete(id)
  })
}

/** 用户选择刷新远端版本时，丢弃该项目尚未同步的本地草稿。 */
export async function discardPendingCanvasDraft(id: string) {
  discardedDraftEpochs.set(id, (discardedDraftEpochs.get(id) ?? 0) + 1)
  await enqueuePersistence(() => canvasDb.pendingSync.delete(id))
}

/**
 * 冲突处理不能走普通 readCanvasDocument：它会优先返回本地缓存，以保证弱网打开
 * 流畅，因而会让“刷新远端”看起来没有任何变化。此处明确以远端为准并覆盖缓存。
 */
export async function refreshCanvasDocumentFromRemote(id: string) {
  await discardPendingCanvasDraft(id)
  const remote = await readRemoteCanvasDocument(id)
  if (!remote) return undefined
  await persistLocalDocument(remote)
  return remote
}

async function readPendingSyncDocuments() {
  return enqueuePersistence(async () => {
    const records = await canvasDb.pendingSync.orderBy('updatedAt').toArray()
    return Promise.all(records.map(async (record) => ({ ...record, document: await hydrateDocumentMedia(record.document) })))
  })
}

function blobAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('素材序列化失败。'))
    reader.onerror = () => reject(reader.error ?? new Error('素材序列化失败。'))
    reader.readAsDataURL(blob)
  })
}

/** 服务端存储不能引用浏览器 blob URL；保存前将新上传素材变为可传输的数据。 */
async function serializeRemoteMediaValue(value: unknown): Promise<unknown> {
  if (typeof value === 'string' && value.startsWith('blob:')) {
    const response = await fetch(value)
    if (!response.ok) throw new Error('无法读取本地上传素材，请重新添加后保存。')
    return blobAsDataUrl(await response.blob())
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => serializeRemoteMediaValue(item)))
  if (!isRecord(value)) return value

  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) next[key] = await serializeRemoteMediaValue(child)
  return next
}

async function readRemoteCanvasDocument(id: string) {
  try {
    const response = await productRequest<{ document: CanvasDocument; revision: number }>(`/api/projects/${encodeURIComponent(id)}/document`)
    remoteRevisions.set(id, response.revision)
    remoteDocuments.set(id, response.document)
    return response.document
  } catch (error) {
    if (error instanceof ProductApiError && error.status === 404) {
      remoteRevisions.delete(id)
      remoteDocuments.delete(id)
      return undefined
    }
    throw error
  }
}

function refreshRemoteCanvasDocumentInBackground(id: string, cachedDocument: CanvasDocument, hasPendingDraft: boolean) {
  void readRemoteCanvasDocument(id)
    .then(async (remote) => {
      // 本地草稿尚未同步时绝不能用远端版本覆盖缓存；仅更新 revision 即可。
      if (!remote || hasPendingDraft) return
      const pending = await readPendingSyncDocument(id)
      if (pending || remote.updatedAt < cachedDocument.updatedAt) return
      await persistLocalDocument(remote)
    })
    .catch(() => undefined)
}

function unchanged(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function collectionPatch<T extends { id: string }>(previous: T[], next: T[]): CollectionPatch<T> | undefined {
  const previousById = new Map(previous.map((item) => [item.id, item]))
  const nextIds = new Set(next.map((item) => item.id))
  const upsert = next.filter((item) => !unchanged(previousById.get(item.id), item))
  const remove = previous.filter((item) => !nextIds.has(item.id)).map((item) => item.id)
  return upsert.length || remove.length ? {
    ...(upsert.length ? { upsert } : {}),
    ...(remove.length ? { remove } : {}),
  } : undefined
}

function createCanvasDocumentPatch(previous: CanvasDocument, next: CanvasDocument): CanvasDocumentPatch {
  const fields: Record<string, unknown> = {}
  const ignored = new Set(['id', 'nodes', 'edges'])
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (ignored.has(key)) continue
    const previousValue = previous[key as keyof CanvasDocument]
    const nextValue = next[key as keyof CanvasDocument]
    if (!unchanged(previousValue, nextValue)) fields[key] = nextValue
  }
  const nodes = collectionPatch(previous.nodes, next.nodes)
  const edges = collectionPatch(previous.edges, next.edges)
  return {
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(nodes ? { nodes } : {}),
    ...(edges ? { edges } : {}),
  }
}

async function writeRemoteCanvasDocument(document: CanvasDocument) {
  // 本地优先打开的项目可能尚未完成后台版本读取。首次写入前补齐 revision，
  // 让 PATCH 仍受 If-Match 保护，而不是用无条件 PUT 覆盖远端版本。
  if (!remoteDocuments.has(document.id) && !remoteRevisions.has(document.id)) {
    await readRemoteCanvasDocument(document.id)
  }
  const revision = remoteRevisions.get(document.id)
  const previous = remoteDocuments.get(document.id)
  const patch = previous ? createCanvasDocumentPatch(previous, document) : undefined
  const send = async (payload: CanvasDocumentPatch | CanvasDocument, method: 'PATCH' | 'PUT', expectedRevision?: number) => {
    const prepared = await serializeRemoteMediaValue(payload)
    return productRequest<{ document: CanvasDocument; revision: number }>(`/api/projects/${encodeURIComponent(document.id)}/document`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(expectedRevision === undefined ? {} : { 'If-Match': String(expectedRevision) }),
      },
      body: JSON.stringify(prepared),
    })
  }

  let response
  try {
    response = await send(patch ?? document, patch ? 'PATCH' : 'PUT', revision)
  } catch (error) {
    if (!(error instanceof ProductApiError) || error.code !== 'PROJECT_CONFLICT' || !patch) throw error
    // 同一用户的即时保存与离线草稿刚好交错时，仅重放“相对旧快照的增量”。
    // 不重发整份文档，避免把 Worker 已写入的输出节点从远端删掉。
    await readRemoteCanvasDocument(document.id)
    response = await send(patch, 'PATCH', remoteRevisions.get(document.id))
  }
  remoteRevisions.set(document.id, response.revision)
  remoteDocuments.set(document.id, response.document)
  await persistLocalDocument(response.document)
  return response.document
}

export async function createCanvasProject(document: CanvasDocument) {
  if (!serverPersistenceEnabled) {
    await writeCanvasDocument(document)
    return document
  }
  const prepared = await serializeRemoteMediaValue(document) as CanvasDocument
  const response = await productRequest<{ document: CanvasDocument; revision: number }>('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: prepared }),
  })
  remoteRevisions.set(document.id, response.revision)
  remoteDocuments.set(document.id, response.document)
  await persistLocalDocument(response.document)
  return response.document
}

export async function renameCanvasProject(id: string, name: string) {
  if (!serverPersistenceEnabled) {
    const current = await readCanvasDocument(id)
    if (!current) throw new ProductApiError('项目不存在或已被删除。', 404, 'PROJECT_NOT_FOUND')
    const document = { ...current, name, updatedAt: Date.now() }
    await writeCanvasDocument(document)
    return document
  }

  // 重命名是一个独立的 PATCH。先清空该项目已有的延迟画布写入，避免旧快照在
  // PATCH 成功后才携带新 revision 写回，把刚保存的名称覆盖成旧名称。
  await flushPendingCanvasDocumentWrites()
  const send = (revision?: number) => productRequest<{ document: CanvasDocument; revision: number }>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(revision === undefined ? {} : { 'If-Match': String(revision) }),
    },
    body: JSON.stringify({ name }),
  })
  let response
  try {
    response = await send(remoteRevisions.get(id))
  } catch (error) {
    if (!(error instanceof ProductApiError) || error.code !== 'PROJECT_CONFLICT') throw error
    // 画布保存刚好抢先提交时，名称 PATCH 不需要覆盖整份文档；刷新 revision 后仅重放名称即可。
    await readRemoteCanvasDocument(id)
    response = await send(remoteRevisions.get(id))
  }
  remoteRevisions.set(id, response.revision)
  remoteDocuments.set(id, response.document)
  return response.document
}

export async function readCanvasDocument(id: string) {
  const readLocal = () => enqueuePersistence(async () => {
    const stored = await canvasDb.documents.get(id)
    const backup = stored ? undefined : await canvasDb.documentBackups.get(id)
    const document = stored ?? backup?.document
    return document ? hydrateDocumentMedia(document) : undefined
  })
  if (!serverPersistenceEnabled) return readLocal()
  const [local, pending] = await Promise.all([readLocal(), readPendingSyncDocument(id)])
  const cached = pending?.document ?? local
  if (cached) {
    // 已打开过的项目优先使用本机快照，项目切换不再等待 Railway 往返。
    // 后台仍会读取远端，更新 revision 与下一次打开可用的缓存。
    refreshRemoteCanvasDocumentInBackground(id, cached, Boolean(pending))
    return cached
  }
  try {
    const remote = await readRemoteCanvasDocument(id)
    // 首次远端打开也先渲染；媒体写入 IndexedDB 可能较重，不能阻塞画布出现。
    if (remote) void persistLocalDocument(remote).catch(() => undefined)
    return remote
  } catch (error) {
    if (error instanceof ProductApiError && (error.status === 0 || error.status === 404)) return undefined
    throw error
  }
}

export async function writeCanvasDocument(document: CanvasDocument, options: { immediate?: boolean } = {}) {
  if (serverPersistenceEnabled) {
    // 先写入 IndexedDB 草稿，再把同一变更排入云端队列；断网也不会丢失编辑。
    await persistLocalDocument(document, true)
    return queueRemoteDocumentWrite(document, options.immediate)
  }
  await persistLocalDocument(document)
}

/** 删除项目时同步清理浏览器缓存，避免远端删除后本地旧项目再次出现。 */
export async function deleteCanvasDocument(id: string) {
  const deleteLocal = () => enqueuePersistence(async () => {
    await canvasDb.transaction('rw', canvasDb.documents, canvasDb.documentBackups, canvasDb.pendingSync, async () => {
      await canvasDb.documents.delete(id)
      await canvasDb.documentBackups.delete(id)
      await canvasDb.pendingSync.delete(id)
    })
  })

  if (!serverPersistenceEnabled) return deleteLocal()
  try {
    await productRequest<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
    remoteRevisions.delete(id)
    remoteDocuments.delete(id)
  } catch (error) {
    if (!(error instanceof ProductApiError && error.status === 404)) throw error
  }
  await deleteLocal()
}

export async function readCanvasDocuments() {
  const readLocal = () => enqueuePersistence(() => canvasDb.documents.orderBy('updatedAt').reverse().toArray())
  if (!serverPersistenceEnabled) return readLocal()

  const localDocuments = await readLocal()
  try {
    const response = await productRequest<{ projects: Array<{ id: string }> }>('/api/projects')
    // 单个服务端项目读取失败不应让整个项目列表消失。
    const settled = await Promise.allSettled(response.projects.map((project) => readRemoteCanvasDocument(project.id)))
    const remoteDocuments = settled.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : [])
    const remoteIds = new Set(remoteDocuments.map((document) => document.id))
    // 服务端启用前保存在 IndexedDB 的旧项目继续可见；打开并再次保存时会自然迁移到服务端。
    return [...remoteDocuments, ...localDocuments.filter((document) => !remoteIds.has(document.id))]
      .sort((left, right) => right.updatedAt - left.updatedAt)
  } catch (error) {
    if (error instanceof ProductApiError && error.status === 0) return localDocuments
    throw error
  }
}

/**
 * 项目页只需要轻量摘要。服务端模式下绝不能为了卡片信息逐个下载完整画布，
 * 否则项目数会直接放大为 N+1 请求。
 */
export async function readCanvasProjectSummaries(): Promise<CanvasProjectSummary[]> {
  const readLocal = async () => {
    const documents = await enqueuePersistence(() => canvasDb.documents.orderBy('updatedAt').reverse().toArray())
    return documents.map((document) => {
      const resultNodes = document.nodes.filter((node) => node.type === 'result' && typeof (node.data as { image?: unknown }).image === 'string')
      const coverImage = resultNodes.at(-1) ? (resultNodes.at(-1)!.data as { image: string }).image : undefined
      return {
        id: document.id,
        name: document.name,
        updatedAt: document.updatedAt,
        nodeCount: document.nodes.length,
        resultCount: resultNodes.length,
        coverImage,
      }
    })
  }

  if (!serverPersistenceEnabled) return readLocal()

  try {
    const response = await productRequest<{
      projects: Array<{ id: string; name: string; updatedAt: number; revision?: number; nodeCount?: number; resultCount?: number; coverImage?: string }>
    }>('/api/projects')
    return response.projects.map((project) => ({
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      revision: project.revision,
      nodeCount: project.nodeCount,
      resultCount: project.resultCount,
      coverImage: project.coverImage,
    }))
  } catch (error) {
    // 网络暂时不可用时允许展示本机的旧项目；权限错误仍由调用方处理，不能泄漏缓存内容。
    if (error instanceof ProductApiError && error.status === 0) return readLocal()
    throw error
  }
}

function cloneAsset(asset: AssetRecord): AssetRecord {
  return normalizeAssetRecord(asset)
}

function normalizeGlobalBrandAssets(assets: AssetRecord[]) {
  const ids = new Set<string>()
  return assets.flatMap((asset) => {
    if (!asset || asset.source !== 'brand' || !asset.id || ids.has(asset.id)) return []
    ids.add(asset.id)
    return [cloneAsset(asset)]
  })
}

function globalLibraryFromAssets(assets: AssetRecord[], updatedAt = Date.now()): GlobalAssetLibrary {
  return {
    id: globalAssetLibraryId,
    schemaVersion: 1,
    assets: normalizeGlobalBrandAssets(assets),
    updatedAt,
  }
}

function normalizeWorkflowTemplates(templates: GlobalWorkflowTemplateLibrary['templates']) {
  const ids = new Set<string>()
  return (Array.isArray(templates) ? templates : []).flatMap((template) => {
    if (!template?.id || !template.name || !template.snapshot || ids.has(template.id)) return []
    ids.add(template.id)
    return [structuredClone(template)]
  })
}

function globalWorkflowTemplateLibraryFromTemplates(
  templates: GlobalWorkflowTemplateLibrary['templates'],
  updatedAt = Date.now(),
): GlobalWorkflowTemplateLibrary {
  return {
    id: globalWorkflowTemplateLibraryId,
    schemaVersion: 1,
    templates: normalizeWorkflowTemplates(templates),
    updatedAt,
  }
}

/** 构建产物采用带 Hash 的静态资源名；发布后需用当前种子图片修复已保存的内置素材路径。 */
function refreshSeedAssetImages(assets: AssetRecord[], seedAssets: AssetRecord[]) {
  const seedById = new Map(seedAssets.map((asset) => [asset.id, asset]))
  let changed = false
  const nextAssets = assets.map((asset) => {
    const seed = seedById.get(asset.id)
    if (!seed || asset.source !== 'brand' || asset.image === seed.image) return asset
    changed = true
    return { ...asset, image: seed.image }
  })
  return { assets: nextAssets, changed }
}

/** 读取全局内置/品牌素材库；项目上传和项目生成素材不在此表中。 */
export async function readGlobalAssetLibrary() {
  if (serverPersistenceEnabled) {
    const response = await productRequest<{ library?: GlobalAssetLibrary }>('/api/global-assets')
    return response.library
  }
  return enqueuePersistence(() => canvasDb.assetLibraries.get(globalAssetLibraryId))
}

export async function writeGlobalAssetLibrary(library: GlobalAssetLibrary) {
  if (serverPersistenceEnabled) {
    await productRequest<{ library: GlobalAssetLibrary }>('/api/global-assets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library: globalLibraryFromAssets(library.assets, library.updatedAt) }),
    })
    return
  }
  await enqueuePersistence(() => canvasDb.assetLibraries.put(globalLibraryFromAssets(library.assets, library.updatedAt)))
}

/** 跨项目共享的工作流模板库；与品牌素材库同属工作区权限范围。 */
export async function readGlobalWorkflowTemplateLibrary() {
  if (serverPersistenceEnabled) {
    const response = await productRequest<{ library?: GlobalWorkflowTemplateLibrary }>('/api/workflow-templates')
    return response.library
  }
  return enqueuePersistence(() => canvasDb.workflowTemplateLibraries.get(globalWorkflowTemplateLibraryId))
}

export async function writeGlobalWorkflowTemplateLibrary(library: GlobalWorkflowTemplateLibrary) {
  const normalized = globalWorkflowTemplateLibraryFromTemplates(library.templates, library.updatedAt)
  if (serverPersistenceEnabled) {
    await productRequest<{ library: GlobalWorkflowTemplateLibrary }>('/api/workflow-templates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library: normalized }),
    })
    return
  }
  await enqueuePersistence(() => canvasDb.workflowTemplateLibraries.put(normalized))
}

/**
 * 首次升级时将旧项目中重复保存的品牌素材提升为全局素材，
 * 并从每个项目的私有 assets 中移除它们。画布节点和历史快照保持原样，
 * 因此不会丢失既有视觉记录。
 */
export async function ensureGlobalAssetLibrary(seedAssets: AssetRecord[]) {
  if (serverPersistenceEnabled) {
    const storedLibrary = await readGlobalAssetLibrary()
    if (storedLibrary) {
      const refreshed = refreshSeedAssetImages(storedLibrary.assets, seedAssets)
      if (!refreshed.changed) return storedLibrary
      const library = globalLibraryFromAssets(refreshed.assets)
      await writeGlobalAssetLibrary(library)
      return library
    }
    const library = globalLibraryFromAssets(seedAssets)
    await writeGlobalAssetLibrary(library)
    return library
  }
  return enqueuePersistence(() => canvasDb.transaction('rw', canvasDb.assetLibraries, canvasDb.documents, async () => {
    const [storedLibrary, documents] = await Promise.all([
      canvasDb.assetLibraries.get(globalAssetLibraryId),
      canvasDb.documents.toArray(),
    ])
    // 仅在首建库时导入种子与旧项目里的品牌素材。之后以全局库为唯一真相，
    // 否则用户主动删除的内置素材会在下次刷新时被种子数据“复活”。
    const storedAssets = normalizeGlobalBrandAssets(storedLibrary
      ? storedLibrary.assets
      : [
          ...seedAssets,
          ...documents.flatMap((document) => (document.assets ?? []).filter((asset) => asset.source === 'brand')),
        ])
    const refreshed = refreshSeedAssetImages(storedAssets, seedAssets)
    const globalAssets = refreshed.assets
    const libraryChanged = !storedLibrary
      || refreshed.changed
      || storedLibrary.assets.length !== globalAssets.length
      || storedLibrary.assets.some((asset, index) => asset.id !== globalAssets[index]?.id)
    const library = globalLibraryFromAssets(globalAssets, libraryChanged ? Date.now() : storedLibrary.updatedAt)

    const migratedDocuments = documents.map((document) => {
      const assets = (document.assets ?? []).filter((asset) => asset.source !== 'brand').map(cloneAsset)
      return assets.length === (document.assets ?? []).length ? document : { ...document, assets }
    })
    const hasMigratedDocument = migratedDocuments.some((document, index) => document !== documents[index])

    if (libraryChanged) await canvasDb.assetLibraries.put(library)
    if (hasMigratedDocument) await canvasDb.documents.bulkPut(migratedDocuments)
    return library
  }))
}

/**
 * 删除全局品牌素材时，在同一个 IndexedDB 事务内同步清理全部项目引用。
 * 调用方负责定义项目领域内的清理规则，数据库层负责原子写入。
 */
export async function deleteGlobalAssetAndScrubDocuments(
  assetId: string,
  scrubDocument: (document: CanvasDocument, assetId: string) => CanvasDocument,
) {
  if (serverPersistenceEnabled) {
    const sourceDocuments = await readCanvasDocuments()
    const now = Date.now()
    const documents = sourceDocuments.map((document) => ({
      ...scrubDocument(document, assetId),
      updatedAt: now,
    }))
    await Promise.all(documents.map((document) => writeRemoteCanvasDocument(document)))
    const response = await productRequest<{ deleted: boolean; library?: GlobalAssetLibrary }>(`/api/global-assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' })
    return { deleted: response.deleted, library: response.library ?? globalLibraryFromAssets([]), documents }
  }
  return enqueuePersistence(() => canvasDb.transaction('rw', canvasDb.assetLibraries, canvasDb.documents, async () => {
    const storedLibrary = await canvasDb.assetLibraries.get(globalAssetLibraryId)
    const library = storedLibrary ?? globalLibraryFromAssets([])
    const assets = library.assets.filter((asset) => asset.id !== assetId)
    const deleted = assets.length !== library.assets.length

    // 事务开始时再读取全部项目。不要用触发删除时的内存快照覆盖它们，
    // 以免用户切换项目、拖动节点或任务回写时丢失最新内容。
    const sourceDocuments = await canvasDb.documents.toArray()
    const now = Date.now()
    const nextDocuments = sourceDocuments.map((document) => ({
      ...scrubDocument(document, assetId),
      updatedAt: now,
    }))
    const nextLibrary = deleted ? globalLibraryFromAssets(assets, now) : library

    if (deleted) await canvasDb.assetLibraries.put(nextLibrary)
    await canvasDb.documents.bulkPut(nextDocuments)
    return { deleted, library: nextLibrary, documents: nextDocuments }
  }))
}
