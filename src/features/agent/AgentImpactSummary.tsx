import type { BotanicAgentActionProposal, BotanicAgentPlan } from '../../domain/agent'
import type { ProductLocale } from '../../i18n/core'
import { presentAgentActionImpact, presentAgentPlanImpact } from './agentImpactPresentation'

type PlanProps = { plan: BotanicAgentPlan; submitted: boolean; locale: ProductLocale; dimensionLabel: (dimension: string) => string }

export function AgentPlanImpactSummary({ plan, submitted, locale, dimensionLabel }: PlanProps) {
  const en = locale === 'en'
  const impact = presentAgentPlanImpact(plan, locale, dimensionLabel)
  return <section className="agent-impact-summary" aria-label={submitted ? (en ? 'Execution impact and recovery' : '执行影响与恢复') : (en ? 'Impact before execution' : '执行前影响')}>
    <header><strong>{submitted ? (en ? 'Result and recovery' : '结果与恢复') : (en ? 'Before you run' : '执行前确认')}</strong><small>{submitted ? (en ? 'The submitted plan remains traceable.' : '已提交计划仍可追溯。') : (en ? 'Review what stays fixed and what changes.' : '核对保持项与变化项。')}</small></header>
    <dl>
      <div><dt>{en ? 'Keep' : '保持'}</dt><dd>{impact.preserved}</dd></div>
      <div><dt>{en ? 'Change' : '改变'}</dt><dd>{impact.changed}</dd></div>
      <div><dt>{en ? 'Write' : '写入'}</dt><dd>{impact.write}</dd></div>
      <div><dt>{en ? 'Recover' : '恢复'}</dt><dd>{submitted ? (en ? 'Locate finished results here. Failed branches keep retry and edit-settings actions in Tasks.' : '可在此定位完成结果；失败分支会在任务中保留重试与修改参数入口。') : (en ? 'Original references stay available. Failed branches can be retried or adjusted from Tasks.' : '原始参考仍保留；失败分支可在任务中重试或调整参数。')}</dd></div>
    </dl>
  </section>
}

export function AgentActionImpact({ action, locale }: { action: BotanicAgentActionProposal; locale: ProductLocale }) {
  const en = locale === 'en'
  const { input, output } = presentAgentActionImpact(action, locale)
  return <div className="agent-action-card__impact"><span>{en ? 'Input' : '输入'}</span><b>{input}</b><span>{en ? 'Output' : '输出'}</span><b>{output}</b></div>
}
