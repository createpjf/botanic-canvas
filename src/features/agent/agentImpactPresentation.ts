import type { BotanicAgentActionProposal, BotanicAgentPlan } from '../../domain/agent'
import type { ProductLocale } from '../../i18n/core'

export function presentAgentPlanImpact(plan: BotanicAgentPlan, locale: ProductLocale, dimensionLabel: (dimension: string) => string) {
  const en = locale === 'en'
  const preserved = plan.constraints.filter((item) => item.mode === 'preserve').map((item) => dimensionLabel(item.dimension))
  const changed = plan.constraints.filter((item) => item.mode === 'vary').map((item) => dimensionLabel(item.dimension))
  const actionCount = plan.actions?.filter((action) => action.toolName !== 'skill_apply' && action.status !== 'dismissed').length ?? 0
  return {
    preserved: preserved.length ? preserved.join(en ? ', ' : '、') : (en ? 'No fixed dimensions declared' : '未声明固定维度'),
    changed: changed.length ? changed.join(en ? ', ' : '、') : (en ? 'No variable dimensions declared' : '未声明变化维度'),
    write: en
      ? plan.output.count + ' new result ' + (plan.output.count === 1 ? 'node' : 'nodes') + (actionCount ? ' and ' + actionCount + ' approved ' + (actionCount === 1 ? 'action' : 'actions') : '')
      : '新增 ' + plan.output.count + ' 个结果节点' + (actionCount ? '，并执行 ' + actionCount + ' 项已确认行动' : ''),
  }
}

export function presentAgentActionImpact(action: BotanicAgentActionProposal, locale: ProductLocale) {
  const en = locale === 'en'
  let input = en ? 'Project data' : '项目数据'
  let output = en ? 'Updated project state' : '更新后的项目状态'
  if (action.toolName === 'mcp_call') {
    input = String(action.arguments.server) + '.' + String(action.arguments.tool); output = en ? 'Files / results panel' : '文件 / 结果面板'
  } else if (action.kind === 'canvas') {
    input = en ? 'Current canvas' : '当前画布'
    const summary = action.preview?.summary
    output = summary ? (en ? 'Create ' + summary.created + ', update ' + summary.updated + ', delete ' + summary.removed + ', connect ' + summary.connected : '新增 ' + summary.created + '，修改 ' + summary.updated + '，删除 ' + summary.removed + '，连接 ' + summary.connected) : (en ? 'Canvas nodes and connections' : '画布节点与连接')
  } else if (action.toolName === 'skill_create') {
    input = en ? 'Reusable rules' : '可复用规则'; output = en ? 'Project Skill' : '项目 Skill'
  } else if (action.toolName === 'skill_publish') {
    input = en ? 'Reviewed Skill' : '审核中的 Skill'; output = en ? 'Published, mountable Skill' : '已发布、可挂载的 Skill'
  } else if (action.toolName === 'skill_deprecate') {
    input = en ? 'Published Skill' : '已发布 Skill'; output = en ? 'Deprecated, unmountable Skill' : '已弃用、不可挂载的 Skill'
  } else if (action.toolName === 'skill_restore') {
    input = en ? 'Historical Skill version' : 'Skill 历史版本'; output = en ? 'New project Skill draft' : '新的项目 Skill 草稿'
  }
  return { input, output }
}
