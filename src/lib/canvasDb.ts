import Dexie, { type Table } from 'dexie'
import type { CanvasDocument, GlobalAssetLibrary, GlobalWorkflowTemplateLibrary } from '../domain/canvas'
import type { CanvasSyncMutation, CanvasSyncOutboxStorage } from './canvasSyncOutbox'

export type CanvasDocumentBackup = {
  id: string
  document: CanvasDocument
  updatedAt: number
}

export type CanvasMediaRecord = {
  id: string
  blob: Blob
  createdAt: number
  updatedAt: number
}

export type CanvasPendingSyncRecord = {
  id: string
  document: CanvasDocument
  updatedAt: number
}

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

/**
 * 画布写入、全局素材迁移和跨项目删除共用一条队列。
 * 这样全局删除总会读取此前已经排队的最新项目快照，后续写入也不会与
 * IndexedDB 事务交错执行。
 */
let persistenceTail: Promise<void> = Promise.resolve()

export function enqueuePersistence<T>(operation: () => Promise<T>) {
  const run = persistenceTail.then(operation, operation)
  persistenceTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export const canvasSyncOutboxStorage: CanvasSyncOutboxStorage = {
  put: (mutation) => enqueuePersistence(() => canvasDb.canvasGraphOutbox.put(mutation).then(() => undefined)),
  list: (projectId) => enqueuePersistence(() => canvasDb.canvasGraphOutbox.where('projectId').equals(projectId).sortBy('createdAt')),
  delete: (id) => enqueuePersistence(() => canvasDb.canvasGraphOutbox.delete(id)),
}
