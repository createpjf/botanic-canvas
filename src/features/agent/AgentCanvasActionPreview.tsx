import type { BotanicCanvasActionPreview } from '../../domain/agentActionPreview'
import { projectFrozenCanvasPreview } from '../../domain/agentCanvasPreviewGraph'
import type { ProductLocale } from '../../i18n/core'

type Props = {
  preview: BotanicCanvasActionPreview
  locale: ProductLocale
}

export function AgentCanvasActionPreview({ preview, locale }: Props) {
  const isEnglish = locale === 'en'
  const t = (zh: string, en: string) => isEnglish ? en : zh
  const graph = projectFrozenCanvasPreview(preview)
  const groups = [
    { key: 'created', label: t('新增', 'Create'), items: preview.created.map((item) => item.label) },
    { key: 'updated', label: t('修改', 'Update'), items: preview.updated.map(({ before, after }) => {
      const renamed = before.label === after.label ? after.label : `${before.label} → ${after.label}`
      return !before.position || !after.position || (before.position.x === after.position.x && before.position.y === after.position.y)
        ? renamed : `${renamed} · (${before.position.x}, ${before.position.y}) → (${after.position.x}, ${after.position.y})`
    }) },
    { key: 'removed', label: t('删除', 'Delete'), items: preview.removed.map((item) => item.label) },
    { key: 'connections', label: t('连接', 'Connect'), items: preview.connections.map((item) => `${item.sourceNodeId} → ${item.targetNodeId}`) },
  ].filter((group) => group.items.length)
  return <section className="agent-action-preview" aria-label={t('确认前变更预览', 'Changes to approve')}>
    <h4>{t('确认后将执行', 'After approval')}</h4>
    <p className="agent-action-preview__summary">
      {isEnglish
        ? `Create ${preview.summary.created}, update ${preview.summary.updated}, delete ${preview.summary.removed}, connect ${preview.summary.connected}.`
        : `新增 ${preview.summary.created} 项，修改 ${preview.summary.updated} 项，删除 ${preview.summary.removed} 项，连接 ${preview.summary.connected} 项。`}
    </p>
    {graph ? <svg className="agent-action-preview__graph" viewBox={`0 0 ${graph.width} ${graph.height}`} aria-hidden="true" focusable="false">
      {graph.lines.map((line) => <line key={line.id} className={`is-${line.kind}`} x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y} />)}
      {graph.points.map((point) => <g key={point.id} className={`is-${point.state}`} transform={`translate(${point.x} ${point.y})`}>
        <circle r="8" /><text y="17" textAnchor="middle">{point.label.slice(0, 8)}</text>
      </g>)}
    </svg> : null}
    {groups.map((group) => <div key={group.key} className={`agent-action-preview__group is-${group.key}`}>
      <strong>{group.label}</strong>
      <ul>{group.items.map((item, index) => <li key={`${group.key}-${index}`}>{item}</li>)}</ul>
    </div>)}
  </section>
}
