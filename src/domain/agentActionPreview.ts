export type BotanicCanvasActionPreviewNode = { id: string; type: string; label: string; position?: { x: number; y: number } }

export type BotanicCanvasActionPreview = {
  /** 冻结时连线需要但本身未变化的安全节点投影；旧 Proposal 可缺省。 */
  context?: BotanicCanvasActionPreviewNode[]
  created: BotanicCanvasActionPreviewNode[]
  updated: Array<{ before: BotanicCanvasActionPreviewNode; after: BotanicCanvasActionPreviewNode }>
  removed: BotanicCanvasActionPreviewNode[]
  connections: Array<{ id: string; sourceNodeId: string; targetNodeId: string; role: string }>
  summary: { created: number; updated: number; removed: number; connected: number }
}
