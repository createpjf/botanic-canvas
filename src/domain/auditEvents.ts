export type WorkspaceAuditEvent = {
  id: string
  actorId: string
  action: string
  projectId?: string | null
  targetId?: string | null
  detail?: Record<string, unknown>
  createdAt: number
}

export type AuditEventCategory = 'all' | 'account' | 'member' | 'project' | 'generation'

const actionLabels: Record<string, string> = {
  'security.password.changed': '更新登录密码',
  'security.mfa.enabled': '启用二步验证',
  'security.mfa.disabled': '移除二步验证',
  'security.sessions.revoked': '退出其他设备',
  'member.created': '邀请工作区成员',
  'member.updated': '更新工作区成员',
  'project.created': '创建项目',
  'project.updated': '保存项目',
  'project.deleted': '删除项目',
  'project.member.upserted': '更新项目成员',
  'brand-library.updated': '更新共享素材库',
  'brand-asset.deleted': '删除共享素材',
  'generation.queued': '提交生成任务',
  'generation.running': '开始生成任务',
  'generation.succeeded': '完成生成任务',
  'generation.failed': '生成任务失败',
  'generation.cancelled': '取消生成任务',
  'generation.interrupted': '生成任务中断',
}

export function auditEventCategory(action: string): Exclude<AuditEventCategory, 'all'> {
  if (action.startsWith('security.')) return 'account'
  if (action.startsWith('member.') || action.startsWith('project.member.')) return 'member'
  if (action.startsWith('generation.')) return 'generation'
  return 'project'
}

export function auditEventLabel(action: string) {
  return actionLabels[action] ?? action.replaceAll('.', ' · ')
}

export function filterAuditEvents(events: WorkspaceAuditEvent[], category: AuditEventCategory) {
  return category === 'all' ? events : events.filter((event) => auditEventCategory(event.action) === category)
}

export function auditEventDetail(event: WorkspaceAuditEvent) {
  const parts: string[] = []
  if (event.projectId) parts.push(`项目 ${event.projectId}`)
  if (event.targetId) parts.push(`对象 ${event.targetId}`)
  const requestId = typeof event.detail?.requestId === 'string' ? event.detail.requestId : undefined
  if (requestId) parts.push(`请求 ${requestId}`)
  return parts.join(' · ') || '工作区操作'
}
