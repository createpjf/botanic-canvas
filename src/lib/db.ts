import Dexie, { type Table } from 'dexie'
import {
  globalAssetLibraryId,
  type AssetRecord,
  type CanvasDocument,
  type GlobalAssetLibrary,
} from '../domain/canvas'
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

const mediaReferencePrefix = 'media://'
const mediaObjectUrls = new Map<string, string>()
const objectUrlToMediaId = new Map<string, string>()
const dataUrlToMediaId = new Map<string, string>()

class BotanicCanvasDatabase extends Dexie {
  documents!: Table<CanvasDocument, string>
  assetLibraries!: Table<GlobalAssetLibrary, string>
  documentBackups!: Table<CanvasDocumentBackup, string>
  media!: Table<CanvasMediaRecord, string>

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

function enqueuePersistence<T>(operation: () => Promise<T>) {
  const run = persistenceTail.then(operation, operation)
  persistenceTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
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
    return response.document
  } catch (error) {
    if (error instanceof ProductApiError && error.status === 404) return undefined
    throw error
  }
}

async function writeRemoteCanvasDocument(document: CanvasDocument) {
  const prepared = await serializeRemoteMediaValue(document) as CanvasDocument
  const revision = remoteRevisions.get(document.id)
  const response = await productRequest<{ document: CanvasDocument; revision: number }>(`/api/projects/${encodeURIComponent(document.id)}/document`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(revision === undefined ? {} : { 'If-Match': String(revision) }),
    },
    body: JSON.stringify(prepared),
  })
  remoteRevisions.set(document.id, response.revision)
}

export async function readCanvasDocument(id: string) {
  const readLocal = () => enqueuePersistence(async () => {
    const stored = await canvasDb.documents.get(id)
    const backup = stored ? undefined : await canvasDb.documentBackups.get(id)
    const document = stored ?? backup?.document
    return document ? hydrateDocumentMedia(document) : undefined
  })
  if (!serverPersistenceEnabled) return readLocal()
  try {
    const remote = await readRemoteCanvasDocument(id)
    // 已迁移到服务端的项目以服务端为准；服务端尚未存在时保留旧浏览器项目。
    return remote ?? readLocal()
  } catch (error) {
    if (error instanceof ProductApiError && (error.status === 0 || error.status === 404)) return readLocal()
    throw error
  }
}

export async function writeCanvasDocument(document: CanvasDocument) {
  if (serverPersistenceEnabled) return enqueuePersistence(() => writeRemoteCanvasDocument(document))
  await enqueuePersistence(async () => {
    const previous = await canvasDb.documents.get(document.id)
    const prepared = await serializeDocumentMedia(document)
    const preparedBackup = previous ? await serializeDocumentMedia(previous) : undefined
    await canvasDb.transaction('rw', canvasDb.documents, canvasDb.documentBackups, canvasDb.media, async () => {
      const media = [...prepared.media, ...(preparedBackup?.media ?? [])]
      if (media.length) await canvasDb.media.bulkPut(media)
      if (preparedBackup) {
        await canvasDb.documentBackups.put({ id: document.id, document: preparedBackup.document, updatedAt: Date.now() })
      }
      await canvasDb.documents.put(prepared.document)
    })
  })
}

/** 删除项目时同步清理浏览器缓存，避免远端删除后本地旧项目再次出现。 */
export async function deleteCanvasDocument(id: string) {
  const deleteLocal = () => enqueuePersistence(async () => {
    await canvasDb.transaction('rw', canvasDb.documents, canvasDb.documentBackups, async () => {
      await canvasDb.documents.delete(id)
      await canvasDb.documentBackups.delete(id)
    })
  })

  if (!serverPersistenceEnabled) return deleteLocal()
  try {
    await productRequest<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
    remoteRevisions.delete(id)
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

function cloneAsset(asset: AssetRecord): AssetRecord {
  return { ...asset, tags: Array.isArray(asset.tags) ? [...asset.tags] : [] }
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

/**
 * 首次升级时将旧项目中重复保存的品牌素材提升为全局素材，
 * 并从每个项目的私有 assets 中移除它们。画布节点和历史快照保持原样，
 * 因此不会丢失既有视觉记录。
 */
export async function ensureGlobalAssetLibrary(seedAssets: AssetRecord[]) {
  if (serverPersistenceEnabled) {
    const storedLibrary = await readGlobalAssetLibrary()
    if (storedLibrary) return storedLibrary
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
    const globalAssets = normalizeGlobalBrandAssets(storedLibrary
      ? storedLibrary.assets
      : [
          ...seedAssets,
          ...documents.flatMap((document) => (document.assets ?? []).filter((asset) => asset.source === 'brand')),
        ])
    const libraryChanged = !storedLibrary
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
