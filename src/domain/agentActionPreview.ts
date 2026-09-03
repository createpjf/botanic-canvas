export type BotanicCanvasActionPreviewNode = { id: string; type: string; label: string; position?: { x: number; y: number } }

export type BotanicCanvasActionPreview = {
  created: BotanicCanvasActionPreviewNode[]
  updated: Array<{ before: BotanicCanvasActionPreviewNode; after: BotanicCanvasActionPreviewNode }>
  removed: BotanicCanvasActionPreviewNode[]
  connections: Array<{ id: string; sourceNodeId: string; targetNodeId: string; role: string }>
  summary: { created: number; updated: number; removed: number; connected: number }
}
