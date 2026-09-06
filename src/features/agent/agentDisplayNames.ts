import type { BotanicAgentArtifact, BotanicAgentRun } from '../../domain/agent.ts'

const genericName = /^(?:新图\d*|新版本\d*|生成候选|生成图片|生成视频|生成批次|生成结果|生成任务|首次生成|继续生成|换场景|换人物|换商品|换风格|换动作|局部重绘|Generate|Continue|Scene|Model|Product|Pose|Style|Redraw|Generated (?:image|video|result|candidate)|New (?:image|version))(?:\s*\d+)?$/iu

function contentSummary(value?: string) {
  const first = value?.trim().replace(/\s+/gu, ' ').split(/[。！？!?]|\.(?:\s|$)/u)[0]?.trim() ?? ''
  const chars = Array.from(first)
  return chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : first
}

export function agentTaskDisplayName(run: BotanicAgentRun, locale = 'zh-CN') {
  const title = run.plan.title?.trim()
  if (title && !genericName.test(title)) return title
  const description = contentSummary(run.plan.prompt) || contentSummary(run.plan.instruction)
  if (description) return description
  const time = Number.isFinite(run.createdAt) ? new Intl.DateTimeFormat(locale, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(run.createdAt) : ''
  return `${locale === 'en' ? 'Generation task' : '生成任务'}${time ? ` · ${time}` : ''}`
}

export function agentArtifactDisplayName(artifact: BotanicAgentArtifact, run?: BotanicAgentRun, locale = 'zh-CN') {
  const label = artifact.label.trim()
  // 只替换已知占位名；没有改名来源字段时，不猜测或覆盖其他用户名称。
  if (label && !genericName.test(label)) return label
  const prompt = typeof artifact.metadata?.prompt === 'string' ? artifact.metadata.prompt : undefined
  const base = run ? agentTaskDisplayName(run, locale) : contentSummary(prompt) || (locale === 'en' ? 'Generated result' : '生成结果')
  // 使用生成输出的稳定序号，不依赖当前页、筛选结果或到达顺序。
  const ordinal = artifact.id.match(/-output-([1-9]\d*)$/u)?.[1]
  const branch = run?.branches.findIndex(item => item.id === artifact.metadata?.branchId) ?? -1
  const retry = branch >= 0 ? run?.branches[branch].jobIds.indexOf(String(artifact.metadata?.jobId)) ?? -1 : -1
  const suffix = ordinal ? `${run && run.branches.length > 1 && branch >= 0 ? `${branch + 1}.` : ''}${ordinal.padStart(2, '0')}` : ''
  return `${base}${retry > 0 ? ` · ${locale === 'en' ? 'Retry' : '补图'} ${retry}` : ''}${suffix ? ` · ${suffix}` : ''}`
}
