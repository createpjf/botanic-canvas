import type { NodeProps } from '@xyflow/react'
import type { CSSProperties } from 'react'
import type { FrameNodeData } from '../../domain/canvas'

const stageLabels: Record<FrameNodeData['stage'], string> = {
  brief: '需求', references: '参考', generation: '生成', review: '审阅', approved: '已批准', delivery: '交付', archive: '归档', custom: '自定义',
}

export function CanvasFrameNode({ data, selected }: NodeProps) {
  const frame = data as FrameNodeData
  const style = { width: frame.width, height: frame.height } as CSSProperties
  return (
    <section className={`canvas-frame-node${selected ? ' is-selected' : ''}`} style={style} aria-label={`Frame：${frame.label}`}>
      <header>
        <span className="canvas-frame-node__stage">{stageLabels[frame.stage]}</span>
        <strong>{frame.label}</strong>
      </header>
    </section>
  )
}
