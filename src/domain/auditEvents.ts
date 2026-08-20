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

const actionLabels: Record<string, Record<ProductLocale, string>> = {
  'security.password.changed': { 'zh-CN': '更新登录密码', en: 'Changed sign-in password' },
  'security.mfa.enabled': { 'zh-CN': '启用二步验证', en: 'Enabled two-step verification' },
  'security.mfa.disabled': { 'zh-CN': '移除二步验证', en: 'Removed two-step verification' },
  'security.sessions.revoked': { 'zh-CN': '退出其他设备', en: 'Signed out other devices' },
  'member.created': { 'zh-CN': '邀请工作区成员', en: 'Invited a workspace member' },
  'member.updated': { 'zh-CN': '更新工作区成员', en: 'Updated a workspace member' },
  'project.created': { 'zh-CN': '创建项目', en: 'Created a project' },
  'project.updated': { 'zh-CN': '保存项目', en: 'Saved a project' },
  'project.deleted': { 'zh-CN': '删除项目', en: 'Deleted a project' },
  'project.member.upserted': { 'zh-CN': '更新项目成员', en: 'Updated a project member' },
  'brand-library.updated': { 'zh-CN': '更新共享素材库', en: 'Updated the shared asset library' },
  'brand-asset.deleted': { 'zh-CN': '删除共享素材', en: 'Deleted a shared asset' },
  'generation.queued': { 'zh-CN': '提交生成任务', en: 'Submitted a generation task' },
  'generation.running': { 'zh-CN': '开始生成任务', en: 'Started a generation task' },
  'generation.succeeded': { 'zh-CN': '完成生成任务', en: 'Completed a generation task' },
  'generation.failed': { 'zh-CN': '生成任务失败', en: 'Generation task failed' },
  'generation.cancelled': { 'zh-CN': '取消生成任务', en: 'Cancelled a generation task' },
  'generation.interrupted': { 'zh-CN': '生成任务中断', en: 'Generation task interrupted' },
}

export function auditEventCategory(action: string): Exclude<AuditEventCategory, 'all'> {
  if (action.startsWith('security.')) return 'account'
  if (action.startsWith('member.') || action.startsWith('project.member.')) return 'member'
  if (action.startsWith('generation.')) return 'generation'
  return 'project'
}

export function auditEventLabel(action: string, locale: ProductLocale = 'zh-CN') {
  return actionLabels[action]?.[locale] ?? action.replaceAll('.', ' · ')
}

export function filterAuditEvents(events: WorkspaceAuditEvent[], category: AuditEventCategory) {
  return category === 'all' ? events : events.filter((event) => auditEventCategory(event.action) === category)
}

export function auditEventDetail(event: WorkspaceAuditEvent, locale: ProductLocale = 'zh-CN') {
  const parts: string[] = []
  if (event.projectId) parts.push(locale === 'en' ? `Project ${event.projectId}` : `项目 ${event.projectId}`)
  if (event.targetId) parts.push(locale === 'en' ? `Target ${event.targetId}` : `对象 ${event.targetId}`)
  const requestId = typeof event.detail?.requestId === 'string' ? event.detail.requestId : undefined
  if (requestId) parts.push(locale === 'en' ? `Request ${requestId}` : `请求 ${requestId}`)
  return parts.join(' · ') || (locale === 'en' ? 'Workspace activity' : '工作区操作')
}
import type { ProductLocale } from '../i18n/core'
