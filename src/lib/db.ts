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
import { reconcileAgentSessionsAfterDocumentSync, stripAgentSessionMessages } from '../domain/agentCollaboration'
import { isRemoteDocumentConflict } from '../domain/remoteDocumentSync'
import { ProductApiError, productRequest, serverPersistenceEnabled } from './productSession'
import { discardLocalDraftAndRefreshRemote, persistAcceptedRemoteRefresh } from './remoteDocumentRefresh'
import type { CanvasSyncMutation, CanvasSyncOutboxStorage } from './canvasSyncOutbox'

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
/** 打开项目时只水合画布可见媒体。Agent / 任务集合走独立实体，整树递归会堵死 IndexedDB 队列。 */
export const canvasDocumentMediaRoots = ['nodes', 'assets', 'history', 'templates', 'deliveries'] as const
const remoteDocumentReadTimeoutMs = 45_000

class BotanicCanvasDatabase extends Dexie {
  documents!: Table<CanvasDocument, string>
  assetLibraries!: Table<GlobalAssetLibrary, string>
  workflowTemplateLibraries!: Table<GlobalWorkflowTemplateLibrary, string>
  documentBackups!: Table<CanvasDocumentBackup, string>
  media!: Table<CanvasMediaRecord, string>
  pendingSync!: Table<CanvasPendingSyncRecord, string>
  canvasGraphOutbox!: Table<CanvasSyncMutation, string>

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
    this.version(6).stores({
      documents: 'id, updatedAt',
      assetLibraries: 'id, updatedAt',
      workflowTemplateLibraries: 'id, updatedAt',
      documentBackups: 'id, updatedAt',
      media: 'id, updatedAt',
      pendingSync: 'id, updatedAt',
      canvasGraphOutbox: 'id, projectId, createdAt',
    })
  }
}

export const canvasDb = new BotanicCanvasDatabase()

export const canvasSyncOutboxStorage: CanvasSyncOutboxStorage = {
  put: (mutation) => enqueuePersistence(() => canvasDb.canvasGraphOutbox.put(mutation).then(() => undefined)),
  list: (projectId) => enqueuePersistence(() => canvasDb.canvasGraphOutbox.where('projectId').equals(projectId).sortBy('createdAt')),
  delete: (id) => enqueuePersistence(() => canvasDb.canvasGraphOutbox.delete(id)),
}

/**
 * 画布写入、全局素材迁移和跨项目删除共用一条队列。
 * 这样全局删除总会读取此前已经排队的最新项目快照，后续写入也不会与
 * IndexedDB 事务交错执行。
 */
let persistenceTail: Promise<void> = Promise.resolve()
const remoteRevisions = new Map<string, number>()
const remoteGraphRevisions = new Map<string, number>()
const remoteSyncProtocolEpochs = new Map<string, number>()
const remoteDocuments = new Map<string, CanvasDocument>()
const remoteConflictRevisions = new Map<string, CanvasConflictRevision>()
const remoteWriteDebounceMs = 500

export type CanvasConflictRevision = {
  localRevision?: number
  remoteRevision: number
  localGraphRevision?: number
  remoteGraphRevision?: number
}

function rememberRemoteRevisions(id: string, response: { revision: number; graphRevision?: number }) {
  const currentRevision = remoteRevisions.get(id)
  if (currentRevision !== undefined && response.revision < currentRevision) return false
  remoteRevisions.set(id, response.revision)
  const currentGraphRevision = remoteGraphRevisions.get(id)
  if (Number.isInteger(response.graphRevision)
    && (currentGraphRevision === undefined || response.graphRevision! >= currentGraphRevision)) {
    remoteGraphRevisions.set(id, response.graphRevision!)
  }
  return true
}

const syncProtocolEpochStoragePrefix = 'botanic-canvas-sync-epoch:v1:'

function readPersistedSyncProtocolEpoch(id: string) {
  try {
    const value = Number(globalThis.localStorage?.getItem(`${syncProtocolEpochStoragePrefix}${id}`))
    return Number.isInteger(value) && value >= 1 ? value : undefined
  } catch {
    return undefined
  }
}

export function rememberRemoteSyncProtocolEpoch(id: string, epoch?: number) {
  const value = Number(epoch)
  if (!Number.isInteger(value) || value < 1) return
  const current = lastKnownCanvasSyncProtocolEpoch(id)
  if (current !== undefined && value <= current) return
  remoteSyncProtocolEpochs.set(id, value)
  // epoch 记忆必须跨刷新存活：只活在内存时，刷新后的首次 Outbox 重放
  // 识别不出旧 epoch 条目，正是 Canary 布局漂移的重放窗口。
  try {
    globalThis.localStorage?.setItem(`${syncProtocolEpochStoragePrefix}${id}`, String(value))
  } catch {
    // 私有窗口等场景不可写；内存记忆仍在，当前会话不受影响。
  }
}

function rememberRemoteDocument(id: string, response: { document: CanvasDocument; revision: number; graphRevision?: number; syncProtocolEpoch?: number }) {
  if (!rememberRemoteRevisions(id, response)) return false
  rememberRemoteSyncProtocolEpoch(id, response.syncProtocolEpoch)
  remoteDocuments.set(id, response.document)
  return true
}

/**
 * 本地画布已完整反映的服务端 revision。远端刷新用它做单调新旧判断：
 * 本机 `updatedAt` 是挂钟，确认计划等本地写会把它推到服务端写库时间之后，
 * 按挂钟比较会把更新的服务端文档当成旧版拒收。
 */
const appliedRemoteRevisions = new Map<string, number>()

export function rememberAppliedRemoteRevision(id: string, revision?: number) {
  if (typeof revision !== 'number' || !Number.isInteger(revision)) return
  const current = appliedRemoteRevisions.get(id)
  if (current === undefined || revision > current) appliedRemoteRevisions.set(id, revision)
}

export function rememberAppliedCanvasGraphRevision(id: string, graphRevision?: number) {
  if (typeof graphRevision !== 'number' || !Number.isInteger(graphRevision) || graphRevision < 1) return
  const current = remoteGraphRevisions.get(id)
  if (current === undefined || graphRevision > current) remoteGraphRevisions.set(id, graphRevision)
}

export function appliedRemoteRevision(id: string) {
  return appliedRemoteRevisions.get(id)
}

export function lastKnownRemoteRevision(id: string) {
  return remoteRevisions.get(id)
}

export function lastKnownCanvasSyncProtocolEpoch(id: string) {
  return remoteSyncProtocolEpochs.get(id) ?? readPersistedSyncProtocolEpoch(id)
}

type CollectionPatch<T extends { id: string }> = {
  upsert?: T[]
  remove?: string[]
}

type CanvasDocumentPatch = {
  fields?: Record<string, unknown>
  nodes?: CollectionPatch<CanvasDocument['nodes'][number]>
  edges?: CollectionPatch<CanvasDocument['edges'][number]>
}

export type RemoteCanvasDocumentRefresh = {
  cachedDocument: CanvasDocument
  remoteDocument: CanvasDocument
}

type ReadCanvasDocumentOptions = {
  onRemoteDocument?: (refresh: RemoteCanvasDocumentRefresh) => boolean | CanvasDocument
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
  if (!serverPersistenceEnabled) return { synced: 0, pending: 0, conflicts: 0, conflictIds: [] as string[] }
  if (!browserIsOnline()) {
    const drafts = await readPendingSyncDocuments()
    return { synced: 0, pending: drafts.length, conflicts: 0, conflictIds: [] as string[] }
  }

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
      if (isRemoteDocumentConflict(error)) {
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
  // 与水合同一组根：blob/data URL 只出现在画布可见媒体里，
  // 整树递归会把 Agent 消息、任务集合也拖进每次本地保存。
  const serialized = { ...document }
  await Promise.all(canvasDocumentMediaRoots.map(async (key) => {
    serialized[key] = await serializeMediaValue(document[key], pendingMedia) as never
  }))
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
  const next = { ...document }
  await Promise.all(canvasDocumentMediaRoots.map(async (key) => {
    next[key] = await resolveMediaValue(document[key]) as never
  }))
  return next
}

async function persistLocalDocument(document: CanvasDocument, queueForSync = false) {
  return enqueuePersistence(async () => {
    const [previous, prepared] = await Promise.all([
      canvasDb.documents.get(document.id),
      serializeDocumentMedia(document),
    ])
    await canvasDb.transaction('rw', canvasDb.documents, canvasDb.documentBackups, canvasDb.media, canvasDb.pendingSync, async () => {
      if (prepared.media.length) await canvasDb.media.bulkPut(prepared.media)
      // documents 表里存的已经是媒体引用形态，备份原样落表即可，再序列化一遍是纯浪费。
      if (previous) {
        await canvasDb.documentBackups.put({ id: document.id, document: previous, updatedAt: Date.now() })
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
  await enqueuePersistence(async () => {
    await canvasDb.transaction('rw', canvasDb.pendingSync, canvasDb.canvasGraphOutbox, async () => {
      await canvasDb.pendingSync.delete(id)
      await canvasDb.canvasGraphOutbox.where('projectId').equals(id).delete()
    })
  })
}

/**
 * 冲突处理不能走普通 readCanvasDocument：它会优先返回本地缓存，以保证弱网打开
 * 流畅，因而会让“刷新远端”看起来没有任何变化。此处明确以远端为准并覆盖缓存。
 */
export async function refreshCanvasDocumentFromRemote(id: string) {
  const remote = await discardLocalDraftAndRefreshRemote(
    () => discardPendingCanvasDraft(id),
    () => readRemoteCanvasDocument(id),
    persistLocalDocument,
  )
  if (remote) {
    remoteConflictRevisions.delete(id)
    rememberAppliedRemoteRevision(id, remoteRevisions.get(id))
  }
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

/**
 * 当前用户在各项目里的能力集合（Epic 10）。随项目读模型下发，界面据此隐藏点不动的入口。
 *
 * **隐藏不是鉴权** —— 服务端始终是唯一的鉴权边界；这里只是不给用户看他做不了的事。
 */
const projectCapabilityCache = new Map<string, string[]>()

export function cachedProjectCapabilities(id: string) {
  return projectCapabilityCache.get(id)
}

async function readRemoteCanvasDocument(id: string) {
  try {
    const response = await productRequest<{
      document: CanvasDocument; revision: number; graphRevision: number; syncProtocolEpoch?: number; capabilities?: string[]
    }>(`/api/projects/${encodeURIComponent(id)}/document`, {
      timeoutMs: remoteDocumentReadTimeoutMs,
      timeoutMessage: '项目文档较大，读取超时。请稍后重试。',
    })
    if (Array.isArray(response.capabilities)) projectCapabilityCache.set(id, response.capabilities)
    rememberRemoteSyncProtocolEpoch(id, response.syncProtocolEpoch)
    rememberRemoteDocument(id, response)
    return remoteDocuments.get(id) ?? response.document
  } catch (error) {
    if (error instanceof ProductApiError && error.status === 404) {
      remoteRevisions.delete(id)
      remoteGraphRevisions.delete(id)
      remoteSyncProtocolEpochs.delete(id)
      remoteDocuments.delete(id)
      projectCapabilityCache.delete(id)
      return undefined
    }
    throw error
  }
}

/** 只读预览服务器版本，不修改本地草稿、版本缓存或同步队列。 */
export async function previewRemoteCanvasDocument(id: string) {
  if (!serverPersistenceEnabled) return undefined
  try {
    const response = await productRequest<{ document: CanvasDocument; revision: number; graphRevision?: number; syncProtocolEpoch?: number }>(`/api/projects/${encodeURIComponent(id)}/document`, {
      timeoutMs: remoteDocumentReadTimeoutMs,
      timeoutMessage: '项目文档较大，读取超时。请稍后重试。',
    })
    rememberRemoteSyncProtocolEpoch(id, response.syncProtocolEpoch)
    const conflict = remoteConflictRevisions.get(id)
    return {
      document: response.document,
      conflictRevision: {
        localRevision: conflict?.localRevision ?? remoteRevisions.get(id),
        remoteRevision: response.revision,
        localGraphRevision: conflict?.localGraphRevision,
        remoteGraphRevision: response.graphRevision,
      } satisfies CanvasConflictRevision,
    }
  } catch (error) {
    if (error instanceof ProductApiError && error.status === 404) return undefined
    throw error
  }
}

function refreshRemoteCanvasDocumentInBackground(
  id: string,
  cachedDocument: CanvasDocument,
  onRemoteDocument?: ReadCanvasDocumentOptions['onRemoteDocument'],
) {
  void readLatestCanvasDocument(id)
    .then(({ document: remote, hasPendingDraft }) => {
      if (!remote || hasPendingDraft) return
      return persistAcceptedRemoteRefresh(
        { cachedDocument, remoteDocument: remote },
        onRemoteDocument,
        persistLocalDocument,
      )
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

function createCanvasDocumentPatch(previous: CanvasDocument, next: CanvasDocument, includeGraph = true): CanvasDocumentPatch {
  const fields: Record<string, unknown> = {}
  // 这两个集合只允许专用工作流 API 修改；旧本地快照不能在画布冲突重试时把它们删掉。
  const ignored = new Set(['id', 'nodes', 'edges', 'productionWorkflows', 'productionWorkflowRuns'])
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (ignored.has(key)) continue
    const previousValue = previous[key as keyof CanvasDocument]
    const nextValue = next[key as keyof CanvasDocument]
    if (!unchanged(previousValue, nextValue)) fields[key] = nextValue
  }
  const nodes = includeGraph ? collectionPatch(previous.nodes, next.nodes) : undefined
  const edges = includeGraph ? collectionPatch(previous.edges, next.edges) : undefined
  return {
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(nodes ? { nodes } : {}),
    ...(edges ? { edges } : {}),
  }
}

function withoutCanvasGraph(document: CanvasDocument) {
  const { nodes: _nodes, edges: _edges, ...metadata } = document
  return metadata as CanvasDocument
}

async function writeRemoteCanvasDocument(document: CanvasDocument) {
  const persistable = stripAgentSessionMessages(document)
  // 本地优先打开的项目可能尚未完成后台版本读取。首次写入前补齐 revision，
  // 让 PATCH 仍受 If-Match 保护，而不是用无条件 PUT 覆盖远端版本。
  if (!remoteDocuments.has(document.id) && !remoteRevisions.has(document.id)) {
    await readRemoteCanvasDocument(document.id)
  }
  const v2 = (lastKnownCanvasSyncProtocolEpoch(document.id) ?? 1) >= 2
  const revision = remoteRevisions.get(document.id)
  const graphRevision = remoteGraphRevisions.get(document.id)
  const previous = remoteDocuments.get(document.id)
  const patch = previous ? createCanvasDocumentPatch(previous, persistable, !v2) : undefined
  const payload = v2 ? withoutCanvasGraph(persistable) : persistable
  const send = async (payload: CanvasDocumentPatch | CanvasDocument, method: 'PATCH' | 'PUT', expectedRevision?: number) => {
    const prepared = await serializeRemoteMediaValue(payload)
    return productRequest<{ document: CanvasDocument; revision: number; graphRevision: number; syncProtocolEpoch?: number }>(`/api/projects/${encodeURIComponent(document.id)}/document`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(expectedRevision === undefined ? {} : { 'If-Match': String(expectedRevision) }),
        ...(remoteGraphRevisions.has(document.id) && !v2 ? { 'X-Canvas-Graph-Revision': String(remoteGraphRevisions.get(document.id)) } : {}),
      },
      body: JSON.stringify(prepared),
    })
  }

  let response
  let conflictAttempts = 0
  while (true) {
    try {
      response = await send(patch ?? payload, patch ? 'PATCH' : 'PUT', conflictAttempts ? remoteRevisions.get(document.id) : revision)
      break
    } catch (error) {
      if (error instanceof ProductApiError && error.code === 'CANVAS_SYNC_EPOCH_STALE') {
        rememberRemoteSyncProtocolEpoch(document.id, 2)
      }
      if (!isRemoteDocumentConflict(error) || !patch || conflictAttempts >= 3) {
        if (isRemoteDocumentConflict(error)) remoteConflictRevisions.set(document.id, {
          localRevision: revision,
          remoteRevision: remoteRevisions.get(document.id) ?? revision ?? 0,
          localGraphRevision: graphRevision,
          remoteGraphRevision: remoteGraphRevisions.get(document.id),
        })
        throw error
      }
      conflictAttempts += 1
      // 同一用户的即时保存与离线草稿刚好交错时，仅重放“相对旧快照的增量”。
      // 不重发整份文档，避免把 Worker 已写入的输出节点从远端删掉。
      await readRemoteCanvasDocument(document.id)
    }
  }
  remoteConflictRevisions.delete(document.id)
  rememberRemoteSyncProtocolEpoch(document.id, response.syncProtocolEpoch)
  rememberRemoteDocument(document.id, {
    ...response,
    document: stripAgentSessionMessages(response.document),
  })
  // 写回执包含服务端合并后的权威文档；本地状态从这一刻起可按 revision 判新旧。
  rememberAppliedRemoteRevision(document.id, response.revision)
  const retained = {
    ...response.document,
    agentSessions: reconcileAgentSessionsAfterDocumentSync(document.agentSessions, response.document.agentSessions),
  }
  await persistLocalDocument(retained)
  return retained
}

export async function createCanvasProject(document: CanvasDocument) {
  if (!serverPersistenceEnabled) {
    await writeCanvasDocument(document)
    return document
  }
  const prepared = await serializeRemoteMediaValue(stripAgentSessionMessages(document)) as CanvasDocument
  const response = await productRequest<{ document: CanvasDocument; revision: number; graphRevision: number; syncProtocolEpoch?: number }>('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: prepared }),
  })
  rememberRemoteSyncProtocolEpoch(document.id, response.syncProtocolEpoch)
  rememberRemoteDocument(document.id, response)
  rememberAppliedRemoteRevision(document.id, response.revision)
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
  // 只冲刷本项目：等待其他项目的远端写入会让重命名被无关的慢请求拖住。
  await flushRemoteDocumentWrite(id)
  const send = (revision?: number) => productRequest<{ document: CanvasDocument; revision: number; graphRevision: number; syncProtocolEpoch?: number }>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(revision === undefined ? {} : { 'If-Match': String(revision) }),
      ...(remoteGraphRevisions.has(id) ? { 'X-Canvas-Graph-Revision': String(remoteGraphRevisions.get(id)) } : {}),
    },
    body: JSON.stringify({ name }),
  })
  let response
  let conflictAttempts = 0
  while (true) {
    try {
      response = await send(remoteRevisions.get(id))
      break
    } catch (error) {
      if (!isRemoteDocumentConflict(error) || conflictAttempts >= 3) throw error
      conflictAttempts += 1
      // 画布保存刚好抢先提交时，名称 PATCH 不需要覆盖整份文档；刷新 revision 后仅重放名称即可。
      await readRemoteCanvasDocument(id)
    }
  }
  rememberRemoteSyncProtocolEpoch(id, response.syncProtocolEpoch)
  rememberRemoteDocument(id, {
    ...response,
    document: { ...response.document, name: response.document.name },
  })
  await enqueuePersistence(async () => {
    const stored = await canvasDb.documents.get(id)
    if (!stored || stored.name === response.document.name) return
    await canvasDb.documents.put({
      ...stored,
      name: response.document.name,
      updatedAt: Math.max(stored.updatedAt, response.document.updatedAt),
    })
  })
  return response.document
}

export async function readCanvasDocument(id: string, options: ReadCanvasDocumentOptions = {}) {
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
    refreshRemoteCanvasDocumentInBackground(id, cached, options.onRemoteDocument)
    return cached
  }
  try {
    const remote = await readRemoteCanvasDocument(id)
    // 首次远端打开也先渲染；媒体写入 IndexedDB 可能较重，不能阻塞画布出现。
    if (remote) {
      rememberAppliedRemoteRevision(id, remoteRevisions.get(id))
      void persistLocalDocument(remote).catch(() => undefined)
    }
    return remote
  } catch (error) {
    if (error instanceof ProductApiError && (error.status === 0 || error.status === 404)) return undefined
    throw error
  }
}

/**
 * 当前项目重新获得焦点时读取服务器权威版本。读取前后都检查 pending draft，
 * 防止请求飞行期间产生的新编辑被远端整份快照覆盖。
 */
export async function readLatestCanvasDocument(id: string) {
  if (!serverPersistenceEnabled) {
    return { document: await readCanvasDocument(id), hasPendingDraft: false }
  }
  if (await readPendingSyncDocument(id)) return { document: undefined, hasPendingDraft: true }
  const remote = await readRemoteCanvasDocument(id)
  if (!remote) return { document: undefined, hasPendingDraft: false }
  if (await readPendingSyncDocument(id)) return { document: undefined, hasPendingDraft: true }
  return { document: remote, hasPendingDraft: false, revision: remoteRevisions.get(id) }
}

export async function persistAcceptedRemoteCanvasDocument(document: CanvasDocument) {
  await persistLocalDocument(document)
}

/**
 * 接受同源 API 刚刚持久化的工作流增量。推进远端版本与已应用 revision，
 * 并缓存当前合并视图；不把可能包含未同步编辑的本地文档误记成远端基线，
 * 也不反向 PATCH 服务端。已应用 revision 必须登记，否则同 revision 的
 * 实时推送会再走整份刷新，冲掉补丁刚保住的本机呈现。
 */
export async function persistAcknowledgedRemoteCanvasPatch(
  document: CanvasDocument,
  revision: number,
  graphRevision: number,
) {
  rememberRemoteRevisions(document.id, { revision, graphRevision })
  rememberAppliedRemoteRevision(document.id, revision)
  await persistLocalDocument(document)
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
    await canvasDb.transaction('rw', canvasDb.documents, canvasDb.documentBackups, canvasDb.pendingSync, canvasDb.canvasGraphOutbox, async () => {
      await canvasDb.documents.delete(id)
      await canvasDb.documentBackups.delete(id)
      await canvasDb.pendingSync.delete(id)
      await canvasDb.canvasGraphOutbox.where('projectId').equals(id).delete()
    })
  })

  if (!serverPersistenceEnabled) return deleteLocal()
  try {
    await productRequest<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
    remoteRevisions.delete(id)
    remoteGraphRevisions.delete(id)
    remoteSyncProtocolEpochs.delete(id)
    remoteDocuments.delete(id)
    remoteConflictRevisions.delete(id)
  } catch (error) {
    if (!(error instanceof ProductApiError && error.status === 404)) throw error
    remoteRevisions.delete(id)
    remoteGraphRevisions.delete(id)
    remoteSyncProtocolEpochs.delete(id)
    remoteDocuments.delete(id)
    remoteConflictRevisions.delete(id)
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
