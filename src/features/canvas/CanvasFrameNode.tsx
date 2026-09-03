import type { NodeProps } from '@xyflow/react'
import type { CSSProperties } from 'react'
import type { FrameNodeData } from '../../domain/canvas'
import type { ProductLocale } from '../../i18n/core'
import { useProductI18n } from '../../i18n/react'

const stageLabels: Record<ProductLocale, Record<FrameNodeData['stage'], string>> = {
  'zh-CN': { brief: '需求', references: '参考', generation: '生成', review: '审阅', approved: '已批准', delivery: '交付', archive: '归档', custom: '自定义' },
  en: { brief: 'Brief', references: 'References', generation: 'Generation', review: 'Review', approved: 'Approved', delivery: 'Delivery', archive: 'Archive', custom: 'Custom' },
}


export function CanvasFrameNode({ data, selected }: NodeProps) {
  const frame = data as FrameNodeData
  const { locale } = useProductI18n()
  const style = { width: frame.width, height: frame.height } as CSSProperties
  return (
    <section className={`canvas-frame-node${selected ? ' is-selected' : ''}`} style={style} aria-label={locale === 'en' ? `Frame: ${frame.label}` : `画布分区：${frame.label}`}>
      <header>
        <span className="canvas-frame-node__stage">{stageLabels[locale][frame.stage]}</span>
        <strong>{frame.label}</strong>
      </header>
    </section>
  )
}
