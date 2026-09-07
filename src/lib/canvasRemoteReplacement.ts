import type { CanvasDocument } from '../domain/canvas'
import { canvasJsonEqual } from '../domain/canvasDocumentPatch'
import { canvasDb, enqueuePersistence, type CanvasMediaRecord } from './canvasDb'

/** 读取前记录本地基线；替换、备份与清理在同一个事务中完成。 */
export async function prepareCanvasRemoteReplacement(id: string, canReplace: () => boolean) {
  const readLocal = async () => ({
    document: await canvasDb.documents.get(id),
    pending: await canvasDb.pendingSync.get(id),
    outbox: await canvasDb.canvasGraphOutbox.where('projectId').equals(id).sortBy('id'),
  })
  const baseline = await enqueuePersistence(readLocal)
  return (prepared: { document: CanvasDocument; media: CanvasMediaRecord[] }) => enqueuePersistence(async () => {
    await canvasDb.transaction('rw', [canvasDb.documents, canvasDb.documentBackups, canvasDb.media, canvasDb.pendingSync, canvasDb.canvasGraphOutbox], async () => {
      const current = await readLocal()
      if (!canReplace() || !canvasJsonEqual(current, baseline)) {
        throw Object.assign(new Error('读取期间本地画布已变化，请重新核对后再试。'), { code: 'CANVAS_DRAFT_CHANGED' })
      }
      const previous = current.pending?.document ?? current.document
      if (previous) await canvasDb.documentBackups.put({ id, document: previous, updatedAt: Date.now() })
      if (prepared.media.length) await canvasDb.media.bulkPut(prepared.media)
      await canvasDb.documents.put(prepared.document)
      await canvasDb.pendingSync.delete(id)
      await canvasDb.canvasGraphOutbox.where('projectId').equals(id).delete()
    })
  })
}
