import { ReactFlow, type Edge, type Node, type ReactFlowProps } from '@xyflow/react'
import { cn } from '@/components/ui/utils'

/**
 * AI Elements Canvas 的 Botanic 适配层。
 * React Flow 的交互参数仍由画布工作区拥有，避免改变现有协作与权限语义。
 */
export function Canvas<NodeType extends Node = Node, EdgeType extends Edge = Edge>({ className, ...props }: ReactFlowProps<NodeType, EdgeType>) {
  return <ReactFlow<NodeType, EdgeType> className={cn('ai-canvas', className)} {...props} />
}
