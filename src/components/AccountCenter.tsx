import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useRestoreFocus, type MotionPhase } from './motionPresence'
import { auditEventCategory, auditEventDetail, auditEventLabel, filterAuditEvents, type AuditEventCategory, type WorkspaceAuditEvent } from '../domain/auditEvents'
import { accountMenuPlacement, type AccountMenuAnchor } from '../domain/accountCenterPresentation'
import { formatProductDateTime, localizeProductError } from '../i18n/core'
import { useProductI18n, useProductMessages } from '../i18n/react'
import { useDialogFocusTrap } from './useDialogFocusTrap'

export type { AccountMenuAnchor } from '../domain/accountCenterPresentation'

export type AccountUser = {
  id: string
  email: string
  name: string
  role: 'owner' | 'member'
}

export type WorkspaceMember = AccountUser & {
  status: 'invited' | 'active' | 'disabled'
  createdAt?: number
}

export type AccountMfaStatus = { currentLevel: 'aal1' | 'aal2' | null; enabled: boolean; factors: Array<{ id: string; name: string }> }
export type AccountMfaEnrollment = { factorId: string; qrCode: string; secret: string; uri: string }

const accountMessages = {
  'zh-CN': {
    accountWorkspace: '账号与工作区', localWorkspace: '本地工作区', localPreview: '本地预览模式',
    roles: { owner: '所有者', member: '成员' },
    personal: '个人', language: '语言', switchLanguage: '切换为英文',
    profile: '个人资料', profileDescription: '姓名、邮箱与工作区角色',
    security: '登录与安全', securityDescription: '密码、二步验证与登录设备', workspace: '工作区',
    members: '成员与权限', membersDescription: '邀请成员并管理访问', activity: '活动记录', activityDescription: '查看账户、项目与生成操作', signOut: '退出登录',
    auditCategories: { all: '全部', account: '账户', member: '成员', project: '项目', generation: '生成' },
    unknownTime: '时间未知', auditLoadFailed: '安全日志加载失败。', auditTitle: '安全日志',
    auditDescription: '所有者可查看工作区内的成员、项目和生成操作。', backToAccount: '返回账户菜单', logTypes: '日志类型',
    refreshing: '刷新中…', refresh: '刷新', retry: '重试', loadingAudit: '正在读取安全日志…', emptyAudit: '当前分类暂无记录。',
    memberWithId: (id: string) => `成员 ${id}`, auditFooter: '日志为只读记录，不会修改项目或生成任务。',
    accountSettings: '账户设置', accountSettingsCategories: '账户设置分类', identityRole: '身份与角色', passwordVerification: '密码与验证',
    workspaceRole: (role: 'owner' | 'member') => `Botanic 工作区${role === 'owner' ? '所有者' : '成员'}`,
    name: '姓名', signInEmail: '登录邮箱', workspaceRoleLabel: '工作区角色',
    profileNote: '邮箱与角色由工作区统一管理，修改账户设置不会影响已有项目和生成结果。',
    password: '登录密码', passwordDescription: '使用独立密码登录 Botanic。', collapse: '收起', edit: '修改',
    newPassword: '新密码', newPasswordPlaceholder: '至少 8 个字符', confirmPassword: '确认密码', confirmPasswordPlaceholder: '再次输入新密码',
    passwordMismatch: '两次输入的密码不一致。', cancel: '取消', saving: '正在保存…', savePassword: '保存密码',
    passwordUpdated: '密码已更新。', passwordUpdateFailed: '密码未更新。',
    mfa: '二步验证', mfaVerified: '已保护，本次会话已验证。', mfaNeedsVerification: '已保护，敏感操作前需验证。',
    mfaDescription: '使用身份验证器保护敏感操作。', protected: '已保护', mfaQrAlt: '二步验证二维码',
    mfaScan: '扫描二维码后，输入身份验证器中的 6 位验证码。', mfaCode: '二步验证码', verifyEnable: '验证并启用', authenticator: '身份验证器',
    mfaCodePlaceholder: '输入 6 位验证码', verifySession: '验证本次会话', confirmRemoveMfa: '确认移除二步验证？账户保护会降低。',
    confirmRemove: '确认移除', removeMfa: '移除二步验证', enableMfa: '启用二步验证', loadingSecurity: '正在读取安全状态…',
    mfaLoadFailed: '无法读取二步验证状态。', mfaEnableFailed: '无法启用二步验证。', invalidCode: '验证码无效。',
    mfaEnabled: '二步验证已启用，本次会话已提升为 AAL2。', mfaSessionVerified: '本次会话已通过二步验证。',
    mfaRemoved: '二步验证已移除。', mfaRemoveFailed: '无法移除二步验证。',
    devices: '登录设备', devicesDescription: '保留当前设备，退出其他浏览器中的登录。', manage: '管理',
    otherSessionsWarning: '其他设备需要重新登录，当前设备不会退出。', signingOut: '正在退出…', signOutOthers: '退出其他设备',
    sessionsRevoked: '其他设备的登录会话已退出。', sessionsRevokeFailed: '无法退出其他设备。',
    accessTitle: '成员与权限', accessDescription: '邀请成员，并管理他们的工作区访问。', email: '邮箱', optional: '选填', role: '角色',
    sending: '发送中…', sendInvite: '发送邀请', membersLoading: '正在加载成员…', you: '你',
    statuses: { invited: '待接受', active: '已启用', disabled: '已停用' },
    setRole: (name: string) => `设置 ${name} 的角色`, processing: '处理中…', resendInvite: '重发邀请', restore: '恢复', disable: '停用',
    membersFooter: '停用不会删除该成员的项目、任务或媒体。', membersLoadFailed: '成员列表加载失败。', inviteFailed: '邀请未发送。',
    resendSuccess: (email: string) => `已向 ${email} 重新发送邀请。`, resendFailed: '重新发送邀请失败。', memberUpdateFailed: '成员权限未更新。',
  },
  en: {
    accountWorkspace: 'Account & workspace', localWorkspace: 'Local workspace', localPreview: 'Local preview mode',
    roles: { owner: 'Owner', member: 'Member' },
    personal: 'Personal', language: 'Language', switchLanguage: 'Switch to Chinese',
    profile: 'Profile', profileDescription: 'Name, email, and workspace role',
    security: 'Sign-in & security', securityDescription: 'Password, two-step verification, and devices', workspace: 'Workspace',
    members: 'Members & permissions', membersDescription: 'Invite members and manage access', activity: 'Activity log', activityDescription: 'Review account, project, and generation activity', signOut: 'Sign out',
    auditCategories: { all: 'All', account: 'Account', member: 'Members', project: 'Projects', generation: 'Generation' },
    unknownTime: 'Time unavailable', auditLoadFailed: 'Unable to load the security log.', auditTitle: 'Security log',
    auditDescription: 'Owners can review member, project, and generation activity in this workspace.', backToAccount: 'Back to account menu', logTypes: 'Log types',
    refreshing: 'Refreshing…', refresh: 'Refresh', retry: 'Try again', loadingAudit: 'Loading security activity…', emptyAudit: 'No activity in this category yet.',
    memberWithId: (id: string) => `Member ${id}`, auditFooter: 'This log is read-only and never changes projects or generation tasks.',
    accountSettings: 'Account settings', accountSettingsCategories: 'Account settings sections', identityRole: 'Identity & role', passwordVerification: 'Password & verification',
    workspaceRole: (role: 'owner' | 'member') => `Botanic workspace ${role === 'owner' ? 'owner' : 'member'}`,
    name: 'Name', signInEmail: 'Sign-in email', workspaceRoleLabel: 'Workspace role',
    profileNote: 'Email and role are managed by the workspace. Account changes do not affect existing projects or generated work.',
    password: 'Sign-in password', passwordDescription: 'Use a dedicated password to sign in to Botanic.', collapse: 'Collapse', edit: 'Change',
    newPassword: 'New password', newPasswordPlaceholder: 'At least 8 characters', confirmPassword: 'Confirm password', confirmPasswordPlaceholder: 'Enter the new password again',
    passwordMismatch: 'The passwords do not match.', cancel: 'Cancel', saving: 'Saving…', savePassword: 'Save password',
    passwordUpdated: 'Password updated.', passwordUpdateFailed: 'Unable to update the password.',
    mfa: 'Two-step verification', mfaVerified: 'Protected. This session is verified.', mfaNeedsVerification: 'Protected. Verify before sensitive actions.',
    mfaDescription: 'Protect sensitive actions with an authenticator app.', protected: 'Protected', mfaQrAlt: 'Two-step verification QR code',
    mfaScan: 'Scan the QR code, then enter the 6-digit code from your authenticator app.', mfaCode: 'Verification code', verifyEnable: 'Verify and enable', authenticator: 'Authenticator',
    mfaCodePlaceholder: 'Enter 6-digit code', verifySession: 'Verify this session', confirmRemoveMfa: 'Remove two-step verification? This lowers account protection.',
    confirmRemove: 'Remove', removeMfa: 'Remove two-step verification', enableMfa: 'Enable two-step verification', loadingSecurity: 'Loading security status…',
    mfaLoadFailed: 'Unable to load two-step verification status.', mfaEnableFailed: 'Unable to enable two-step verification.', invalidCode: 'That verification code is invalid.',
    mfaEnabled: 'Two-step verification is enabled and this session is now AAL2.', mfaSessionVerified: 'This session passed two-step verification.',
    mfaRemoved: 'Two-step verification removed.', mfaRemoveFailed: 'Unable to remove two-step verification.',
    devices: 'Signed-in devices', devicesDescription: 'Keep this device signed in and sign out other browsers.', manage: 'Manage',
    otherSessionsWarning: 'Other devices will need to sign in again. This device stays signed in.', signingOut: 'Signing out…', signOutOthers: 'Sign out other devices',
    sessionsRevoked: 'Other devices have been signed out.', sessionsRevokeFailed: 'Unable to sign out other devices.',
    accessTitle: 'Members & permissions', accessDescription: 'Invite members and manage their workspace access.', email: 'Email', optional: 'Optional', role: 'Role',
    sending: 'Sending…', sendInvite: 'Send invite', membersLoading: 'Loading members…', you: 'You',
    statuses: { invited: 'Invite pending', active: 'Active', disabled: 'Disabled' },
    setRole: (name: string) => `Set ${name}'s role`, processing: 'Working…', resendInvite: 'Resend invite', restore: 'Restore', disable: 'Disable',
    membersFooter: 'Disabling access does not delete this member’s projects, tasks, or media.', membersLoadFailed: 'Unable to load members.', inviteFailed: 'Unable to send the invite.',
    resendSuccess: (email: string) => `Invitation resent to ${email}.`, resendFailed: 'Unable to resend the invite.', memberUpdateFailed: 'Unable to update member access.',
  },
} as const

function AccountGlyph({ kind }: { kind: 'language' | 'profile' | 'security' | 'members' | 'audit' | 'sign-out' }) {
  const paths: Record<typeof kind, ReactNode> = {
    language: <><circle cx="12" cy="12" r="8.25" /><path d="M3.75 12h16.5M12 3.75c2.6 2.4 3.9 5.3 3.9 8.25S14.6 17.85 12 20.25C9.4 17.85 8.1 14.95 8.1 12S9.4 6.15 12 3.75" /></>,
    profile: <><circle cx="12" cy="8" r="3.25" /><path d="M5.5 20c.65-4.05 2.82-6.08 6.5-6.08S17.85 15.95 18.5 20" /></>,
    security: <><path d="M5.5 10.25V8.5a6.5 6.5 0 0 1 13 0v1.75" /><rect x="4" y="10.25" width="16" height="10.25" rx="2.5" /><path d="M12 14.25v2.5" /></>,
    members: <><circle cx="8.25" cy="9" r="3" /><circle cx="16.75" cy="10.25" r="2.25" /><path d="M2.75 19c.5-3.45 2.33-5.18 5.5-5.18s5 1.73 5.5 5.18M14 14.25c3.7-.42 5.78 1.17 6.25 4.75" /></>,
    audit: <><circle cx="12" cy="12" r="8.25" /><path d="M12 7.5v5l3.25 2" /></>,
    'sign-out': <><path d="M10 4H5.75A1.75 1.75 0 0 0 4 5.75v12.5C4 19.22 4.78 20 5.75 20H10" /><path d="M14.5 7.5 19 12l-4.5 4.5M8.5 12H19" /></>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[kind]}</svg>
}

export function AccountMenu({
  user,
  anchor,
  releaseLabel,
  onOpenProfile,
  onOpenSecurity,
  onOpenMembers,
  onOpenAudit,
  onSignOut,
  onClose,
  phase = 'open',
}: {
  user?: AccountUser
  anchor: AccountMenuAnchor
  releaseLabel?: string
  onOpenProfile: () => void
  onOpenSecurity: () => void
  onOpenMembers: () => void
  onOpenAudit: () => void
  onSignOut?: () => Promise<void>
  onClose: () => void
  phase?: MotionPhase
}) {
  const { toggleLocale } = useProductI18n()
  const copy = useProductMessages(accountMessages)
  const menuRef = useRef<HTMLDivElement>(null)
  useRestoreFocus(phase !== 'exit')

  useEffect(() => {
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof PointerEvent && event.target instanceof Element && event.target.closest('.account-menu')) return
      if (event instanceof KeyboardEvent) {
        event.preventDefault()
        event.stopPropagation()
      }
      onClose()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [onClose])

  useEffect(() => {
    if (phase === 'exit') return
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(frame)
  }, [phase])

  const placement = accountMenuPlacement(anchor, { width: window.innerWidth, height: window.innerHeight })
  const style = {
    left: placement.left,
    top: placement.top,
    '--account-origin-x': `${placement.originX}px`,
    '--account-origin-y': `${placement.originY}px`,
  } as CSSProperties
  const moveFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length
    items[index]?.focus()
  }

  return createPortal(
    <div ref={menuRef} className={`account-menu is-${phase}`} style={style} role="menu" aria-labelledby="account-menu-title" inert={phase === 'exit' || undefined} onKeyDown={moveFocus}>
      <header>
        <span className="account-menu__avatar">{user?.name?.slice(0, 1).toUpperCase() || 'B'}</span>
        <div><small>{copy.accountWorkspace}</small><strong id="account-menu-title">{user?.name || copy.localWorkspace}</strong><small>{user?.email || copy.localPreview}</small></div>
        {user ? <i>{copy.roles[user.role]}</i> : null}
      </header>
      <div className="account-menu__actions">
        <span className="account-menu__section-label">{copy.personal}</span>
        <button type="button" role="menuitem" onClick={toggleLocale}><em><AccountGlyph kind="language" /></em><span>{copy.language}</span><small>{copy.switchLanguage}</small></button>
        <button type="button" role="menuitem" onClick={onOpenProfile} disabled={!user}><em><AccountGlyph kind="profile" /></em><span>{copy.profile}</span><small>{copy.profileDescription}</small><b>›</b></button>
        <button type="button" role="menuitem" onClick={onOpenSecurity} disabled={!user}><em><AccountGlyph kind="security" /></em><span>{copy.security}</span><small>{copy.securityDescription}</small><b>›</b></button>
        {user?.role === 'owner' ? <span className="account-menu__section-label">{copy.workspace}</span> : null}
        {user?.role === 'owner' ? <button type="button" role="menuitem" onClick={onOpenMembers}><em><AccountGlyph kind="members" /></em><span>{copy.members}</span><small>{copy.membersDescription}</small><b>›</b></button> : null}
        {user?.role === 'owner' ? <button type="button" role="menuitem" onClick={onOpenAudit}><em><AccountGlyph kind="audit" /></em><span>{copy.activity}</span><small>{copy.activityDescription}</small><b>›</b></button> : null}
      </div>
      {onSignOut ? <button className="account-menu__sign-out" type="button" role="menuitem" onClick={() => void onSignOut()}><AccountGlyph kind="sign-out" /><span>{copy.signOut}</span></button> : null}
      {releaseLabel ? <p className="account-menu__release">{releaseLabel}</p> : null}
    </div>,
    document.body,
  )
}

const auditCategoryIds: AuditEventCategory[] = ['all', 'account', 'member', 'project', 'generation']

function auditTimeLabel(createdAt: number, locale: 'zh-CN' | 'en', unknownTime: string) {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return unknownTime
  return formatProductDateTime(date, locale, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export function WorkspaceAuditDialog({ onListEvents, onListMembers, onClose, phase = 'open', returnFocusTarget }: {
  onListEvents: () => Promise<WorkspaceAuditEvent[]>
  onListMembers: () => Promise<WorkspaceMember[]>
  onClose: () => void
  phase?: MotionPhase
  returnFocusTarget?: HTMLElement | null
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages(accountMessages)
  const [events, setEvents] = useState<WorkspaceAuditEvent[]>([])
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [category, setCategory] = useState<AuditEventCategory>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useRestoreFocus(phase !== 'exit', returnFocusTarget === undefined ? document.querySelector<HTMLButtonElement>('button[data-account-menu-trigger]') : returnFocusTarget)
  const dialogRef = useDialogFocusTrap(phase !== 'exit')

  const load = async () => {
    setLoading(true); setError('')
    try {
      const [nextEvents, nextMembers] = await Promise.all([onListEvents(), onListMembers()])
      setEvents(nextEvents); setMembers(nextMembers)
    } catch (caught) {
      setError(localizeProductError(caught, locale, { 'zh-CN': copy.auditLoadFailed, en: copy.auditLoadFailed }))
    } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose])

  const memberById = new Map(members.map((member) => [member.id, member]))
  const visibleEvents = filterAuditEvents(events, category)

  return createPortal(<div className={`workspace-audit-backdrop account-overlay is-${phase}`} role="presentation" inert={phase === 'exit' || undefined} onMouseDown={onClose}>
    <section ref={dialogRef} className="workspace-audit-dialog account-surface" role="dialog" aria-modal="true" aria-labelledby="workspace-audit-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="workspace-eyebrow">SECURITY ACTIVITY</span><h2 id="workspace-audit-title">{copy.auditTitle}</h2><p>{copy.auditDescription}</p></div><button type="button" onClick={onClose} aria-label={copy.backToAccount}>←</button></header>
      <div className="workspace-audit-dialog__toolbar">
        <div role="tablist" aria-label={copy.logTypes}>{auditCategoryIds.map((id) => <button key={id} type="button" role="tab" aria-selected={category === id} className={category === id ? 'is-active' : ''} onClick={() => setCategory(id)}>{copy.auditCategories[id]}</button>)}</div>
        <button type="button" onClick={() => void load()} disabled={loading}>{loading ? copy.refreshing : copy.refresh}</button>
      </div>
      {error ? <div className="workspace-audit-dialog__state is-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>{copy.retry}</button></div> : loading ? <div className="workspace-audit-dialog__state" role="status">{copy.loadingAudit}</div> : visibleEvents.length === 0 ? <div className="workspace-audit-dialog__state">{copy.emptyAudit}</div> : <ol className="workspace-audit-dialog__list">
        {visibleEvents.map((event) => {
          const actor = memberById.get(event.actorId)
          const eventCategory = auditEventCategory(event.action)
          return <li key={event.id}>
            <i className={`is-${eventCategory}`} aria-hidden="true" />
            <div><strong>{auditEventLabel(event.action, locale)}</strong><span>{actor?.name || actor?.email || copy.memberWithId(event.actorId)}</span><small>{auditEventDetail(event, locale)}</small></div>
            <time dateTime={Number.isFinite(event.createdAt) ? new Date(event.createdAt).toISOString() : undefined}>{auditTimeLabel(event.createdAt, locale, copy.unknownTime)}</time>
          </li>
        })}
      </ol>}
      <footer>{copy.auditFooter}</footer>
    </section>
  </div>, document.body)
}

export function AccountDetailsDialog({
  mode,
  user,
  onChangePassword,
  onReadMfaStatus,
  onEnrollMfa,
  onVerifyMfa,
  onRemoveMfa,
  onSignOutOtherSessions,
  onModeChange,
  onClose,
  phase = 'open',
  returnFocusTarget,
}: {
  mode: 'profile' | 'security'
  user: AccountUser
  onChangePassword: (password: string) => Promise<void>
  onReadMfaStatus: () => Promise<AccountMfaStatus>
  onEnrollMfa: () => Promise<AccountMfaEnrollment>
  onVerifyMfa: (factorId: string, code: string, enabling?: boolean) => Promise<void>
  onRemoveMfa: (factorId: string) => Promise<void>
  onSignOutOtherSessions: () => Promise<void>
  onModeChange?: (mode: 'profile' | 'security') => void
  onClose: () => void
  phase?: MotionPhase
  returnFocusTarget?: HTMLElement | null
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages(accountMessages)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'success' | 'error' | null>(null)
  const [mfaStatus, setMfaStatus] = useState<AccountMfaStatus | null>(null)
  const [mfaEnrollment, setMfaEnrollment] = useState<AccountMfaEnrollment | null>(null)
  const [mfaCode, setMfaCode] = useState('')
  const [mfaMessage, setMfaMessage] = useState('')
  const [mfaMessageKind, setMfaMessageKind] = useState<'success' | 'error' | null>(null)
  const [passwordEditorOpen, setPasswordEditorOpen] = useState(false)
  const [confirmingMfaRemoval, setConfirmingMfaRemoval] = useState(false)
  const [confirmingOtherSessions, setConfirmingOtherSessions] = useState(false)
  useRestoreFocus(phase !== 'exit', returnFocusTarget === undefined ? document.querySelector<HTMLButtonElement>('button[data-account-menu-trigger]') : returnFocusTarget)
  const dialogRef = useDialogFocusTrap(phase !== 'exit')

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy || phase === 'exit') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [busy, onClose, phase])

  useEffect(() => {
    setMessage('')
    setMessageKind(null)
    setMfaMessage('')
    setMfaMessageKind(null)
    setConfirmingMfaRemoval(false)
    setConfirmingOtherSessions(false)
  }, [mode])

  useEffect(() => {
    if (mode !== 'security') return
    let active = true
    void onReadMfaStatus()
      .then((status) => { if (active) setMfaStatus(status) })
      .catch((error) => {
        if (!active) return
        setMfaMessage(localizeProductError(error, locale, { 'zh-CN': copy.mfaLoadFailed, en: copy.mfaLoadFailed }))
        setMfaMessageKind('error')
      })
    return () => { active = false }
  }, [copy.mfaLoadFailed, locale, mode, onReadMfaStatus])

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password.length < 8 || password !== confirmation || busy) return
    setBusy(true)
    setMessage('')
    setMessageKind(null)
    try {
      await onChangePassword(password)
      setMessage(copy.passwordUpdated)
      setMessageKind('success')
      setPassword('')
      setConfirmation('')
      setPasswordEditorOpen(false)
    } catch (error) {
      setMessage(localizeProductError(error, locale, { 'zh-CN': copy.passwordUpdateFailed, en: copy.passwordUpdateFailed }))
      setMessageKind('error')
    } finally {
      setBusy(false)
    }
  }

  const beginMfaEnrollment = async () => {
    if (busy) return
    setBusy(true); setMfaMessage(''); setMfaMessageKind(null)
    try { setMfaEnrollment(await onEnrollMfa()) } catch (error) {
      setMfaMessage(localizeProductError(error, locale, { 'zh-CN': copy.mfaEnableFailed, en: copy.mfaEnableFailed })); setMfaMessageKind('error')
    } finally { setBusy(false) }
  }

  const verifyMfa = async (factorId: string) => {
    if (busy || !/^\d{6}$/.test(mfaCode)) return
    setBusy(true); setMfaMessage(''); setMfaMessageKind(null)
    try {
      const enabling = mfaEnrollment?.factorId === factorId
      await onVerifyMfa(factorId, mfaCode, enabling)
      setMfaEnrollment(null); setMfaCode('')
      setMfaStatus(await onReadMfaStatus())
      setMfaMessage(enabling ? copy.mfaEnabled : copy.mfaSessionVerified)
      setMfaMessageKind('success')
    } catch (error) {
      setMfaMessage(localizeProductError(error, locale, { 'zh-CN': copy.invalidCode, en: copy.invalidCode })); setMfaMessageKind('error')
    } finally { setBusy(false) }
  }

  const removeMfa = async (factorId: string) => {
    if (busy) return
    if (!confirmingMfaRemoval) { setConfirmingMfaRemoval(true); return }
    setBusy(true); setMfaMessage(''); setMfaMessageKind(null)
    try {
      await onRemoveMfa(factorId)
      setMfaEnrollment(null); setMfaCode('')
      setMfaStatus(await onReadMfaStatus())
      setMfaMessage(copy.mfaRemoved)
      setMfaMessageKind('success')
    } catch (error) {
      setMfaMessage(localizeProductError(error, locale, { 'zh-CN': copy.mfaRemoveFailed, en: copy.mfaRemoveFailed })); setMfaMessageKind('error')
    } finally { setBusy(false); setConfirmingMfaRemoval(false) }
  }

  const signOutOthers = async () => {
    if (busy) return
    if (!confirmingOtherSessions) { setConfirmingOtherSessions(true); return }
    setBusy(true); setMfaMessage(''); setMfaMessageKind(null)
    try { await onSignOutOtherSessions(); setMfaMessage(copy.sessionsRevoked); setMfaMessageKind('success') } catch (error) {
      setMfaMessage(localizeProductError(error, locale, { 'zh-CN': copy.sessionsRevokeFailed, en: copy.sessionsRevokeFailed })); setMfaMessageKind('error')
    } finally { setBusy(false); setConfirmingOtherSessions(false) }
  }

  const activeFactor = mfaStatus?.factors[0]

  return createPortal(
    <div className={`account-dialog-backdrop account-overlay is-${phase}`} role="presentation" inert={phase === 'exit' || undefined} onMouseDown={() => !busy && onClose()}>
      <section ref={dialogRef} className="account-dialog account-surface" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" aria-busy={busy} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>BOTANIC ACCOUNT</span><h2 id="account-dialog-title">{copy.accountSettings}</h2><p>{user.email}</p></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label={copy.backToAccount}>←</button>
        </header>
        <div className="account-dialog__layout">
          <nav aria-label={copy.accountSettingsCategories}>
            <button type="button" disabled={busy} className={mode === 'profile' ? 'is-active' : ''} aria-current={mode === 'profile' ? 'page' : undefined} onClick={() => onModeChange?.('profile')}><AccountGlyph kind="profile" /><span><strong>{copy.profile}</strong><small>{copy.identityRole}</small></span></button>
            <button type="button" disabled={busy} className={mode === 'security' ? 'is-active' : ''} aria-current={mode === 'security' ? 'page' : undefined} onClick={() => onModeChange?.('security')}><AccountGlyph kind="security" /><span><strong>{copy.security}</strong><small>{copy.passwordVerification}</small></span></button>
          </nav>
          <div className="account-dialog__content" key={mode}>
            {mode === 'profile' ? <section className="account-profile" aria-labelledby="account-profile-heading">
              <div className="account-profile__hero"><span className="account-profile__mark">{user.name.slice(0, 1).toUpperCase() || 'B'}</span><span><h3 id="account-profile-heading">{user.name}</h3><p>{copy.workspaceRole(user.role)}</p></span><i>{copy.roles[user.role]}</i></div>
              <dl><div><dt>{copy.name}</dt><dd>{user.name}</dd></div><div><dt>{copy.signInEmail}</dt><dd>{user.email}</dd></div><div><dt>{copy.workspaceRoleLabel}</dt><dd>{copy.roles[user.role]}</dd></div></dl>
              <p className="account-profile__note">{copy.profileNote}</p>
            </section> : <div className="account-security">
              <section className={`account-security__card account-security__password${passwordEditorOpen ? ' is-expanded' : ''}`}>
                <div className="account-security__summary"><span><h3>{copy.password}</h3><p>{copy.passwordDescription}</p></span><button type="button" disabled={busy} aria-expanded={passwordEditorOpen} onClick={() => { setPasswordEditorOpen((open) => !open); setMessage(''); setMessageKind(null) }}>{passwordEditorOpen ? copy.collapse : copy.edit}</button></div>
                {passwordEditorOpen ? <form className="account-security__editor" onSubmit={(event) => void submitPassword(event)}>
                  <input className="visually-hidden" type="email" autoComplete="username" value={user.email} readOnly tabIndex={-1} aria-hidden="true" />
                  <label><span>{copy.newPassword}</span><input type="password" autoComplete="new-password" minLength={8} disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={copy.newPasswordPlaceholder} /></label>
                  <label><span>{copy.confirmPassword}</span><input type="password" autoComplete="new-password" minLength={8} disabled={busy} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={copy.confirmPasswordPlaceholder} /></label>
                  {confirmation && password !== confirmation ? <small role="alert">{copy.passwordMismatch}</small> : null}
                  <div><button type="button" disabled={busy} onClick={() => { setPasswordEditorOpen(false); setPassword(''); setConfirmation(''); setMessage(''); setMessageKind(null) }}>{copy.cancel}</button><button type="submit" className="is-primary" disabled={busy || password.length < 8 || password !== confirmation}>{busy ? copy.saving : copy.savePassword}</button></div>
                </form> : null}
                {message ? <small className={messageKind === 'success' ? 'is-success' : ''} role={messageKind === 'error' ? 'alert' : 'status'}>{message}</small> : null}
              </section>
              <section className="account-security__card account-security__mfa">
                <div className="account-security__summary"><span><h3>{copy.mfa}</h3><p>{mfaStatus?.enabled ? (mfaStatus.currentLevel === 'aal2' ? copy.mfaVerified : copy.mfaNeedsVerification) : copy.mfaDescription}</p></span>{mfaStatus?.enabled ? <i>{copy.protected}</i> : null}</div>
                {mfaEnrollment ? <div className="account-security__enrollment">
                  <img src={mfaEnrollment.qrCode} alt={copy.mfaQrAlt} />
                  <p>{copy.mfaScan}</p>
                  <code>{mfaEnrollment.secret}</code>
                  <div><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={busy} value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-label={copy.mfaCode} placeholder="000000" /><button type="button" className="is-primary" disabled={busy || mfaCode.length !== 6} onClick={() => void verifyMfa(mfaEnrollment.factorId)}>{copy.verifyEnable}</button></div>
                </div> : mfaStatus?.enabled && activeFactor ? <div className="account-security__factor">
                  <strong>{activeFactor.name || copy.authenticator}</strong>
                  {mfaStatus.currentLevel !== 'aal2' ? <div><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={busy} value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-label={copy.mfaCode} placeholder={copy.mfaCodePlaceholder} /><button type="button" className="is-primary" disabled={busy || mfaCode.length !== 6} onClick={() => void verifyMfa(activeFactor.id)}>{copy.verifySession}</button></div> : null}
                  {confirmingMfaRemoval ? <div className="account-security__confirm" role="alert"><span>{copy.confirmRemoveMfa}</span><div><button type="button" disabled={busy} onClick={() => setConfirmingMfaRemoval(false)}>{copy.cancel}</button><button type="button" className="is-danger" disabled={busy} onClick={() => void removeMfa(activeFactor.id)}>{copy.confirmRemove}</button></div></div> : <button type="button" className="is-danger is-quiet" disabled={busy} onClick={() => setConfirmingMfaRemoval(true)}>{copy.removeMfa}</button>}
                </div> : mfaStatus ? <button type="button" className="account-security__enable is-primary" disabled={busy} onClick={() => void beginMfaEnrollment()}>{copy.enableMfa}</button> : <p className="account-security__loading" role="status">{copy.loadingSecurity}</p>}
                {mfaMessage ? <small className={mfaMessageKind === 'success' ? 'is-success' : ''} role={mfaMessageKind === 'error' ? 'alert' : 'status'}>{mfaMessage}</small> : null}
              </section>
              <section className="account-security__card account-security__sessions">
                <div className="account-security__summary"><span><h3>{copy.devices}</h3><p>{copy.devicesDescription}</p></span>{!confirmingOtherSessions ? <button type="button" disabled={busy} onClick={() => setConfirmingOtherSessions(true)}>{copy.manage}</button> : null}</div>
                {confirmingOtherSessions ? <div className="account-security__confirm" role="alert"><span>{copy.otherSessionsWarning}</span><div><button type="button" disabled={busy} onClick={() => setConfirmingOtherSessions(false)}>{copy.cancel}</button><button type="button" className="is-danger" disabled={busy} onClick={() => void signOutOthers()}>{busy ? copy.signingOut : copy.signOutOthers}</button></div></div> : null}
              </section>
            </div>}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}

export function WorkspaceMembersDialog({ currentUser, onListMembers, onInviteMember, onResendInvite, onUpdateMember, onClose, phase = 'open', returnFocusTarget }: {
  currentUser: AccountUser
  onListMembers: () => Promise<WorkspaceMember[]>
  onInviteMember: (input: { email: string; name?: string; role: 'owner' | 'member' }) => Promise<WorkspaceMember>
  onResendInvite: (userId: string) => Promise<WorkspaceMember>
  onUpdateMember: (userId: string, updates: { role?: 'owner' | 'member'; status?: 'active' | 'disabled' }) => Promise<WorkspaceMember>
  onClose: () => void
  phase?: MotionPhase
  returnFocusTarget?: HTMLElement | null
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages(accountMessages)
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<'owner' | 'member'>('member')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useRestoreFocus(phase !== 'exit', returnFocusTarget === undefined ? document.querySelector<HTMLButtonElement>('button[data-account-menu-trigger]') : returnFocusTarget)
  const dialogRef = useDialogFocusTrap(phase !== 'exit')

  useEffect(() => {
    let active = true
    void onListMembers().then((next) => { if (active) setMembers(next) }).catch((caught) => {
      if (active) setError(localizeProductError(caught, locale, { 'zh-CN': copy.membersLoadFailed, en: copy.membersLoadFailed }))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [copy.membersLoadFailed, locale, onListMembers])

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busyId) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [busyId, onClose])

  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!email.trim() || busyId) return
    setBusyId('invite'); setError(''); setMessage('')
    try {
      const invited = await onInviteMember({ email: email.trim(), name: name.trim() || undefined, role })
      setMembers((current) => [...current.filter((member) => member.id !== invited.id), invited])
      setEmail(''); setName(''); setRole('member')
    } catch (caught) { setError(localizeProductError(caught, locale, { 'zh-CN': copy.inviteFailed, en: copy.inviteFailed })) } finally { setBusyId(null) }
  }

  const resendInvite = async (member: WorkspaceMember) => {
    if (busyId || member.status !== 'invited') return
    setBusyId(member.id); setError(''); setMessage('')
    try {
      await onResendInvite(member.id)
      setMessage(copy.resendSuccess(member.email))
    } catch (caught) { setError(localizeProductError(caught, locale, { 'zh-CN': copy.resendFailed, en: copy.resendFailed })) } finally { setBusyId(null) }
  }

  const updateMember = async (member: WorkspaceMember, updates: { role?: 'owner' | 'member'; status?: 'active' | 'disabled' }) => {
    if (busyId) return
    setBusyId(member.id); setError(''); setMessage('')
    try {
      const updated = await onUpdateMember(member.id, updates)
      setMembers((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (caught) { setError(localizeProductError(caught, locale, { 'zh-CN': copy.memberUpdateFailed, en: copy.memberUpdateFailed })) } finally { setBusyId(null) }
  }

  return createPortal(<div className={`workspace-members-backdrop account-overlay is-${phase}`} role="presentation" inert={phase === 'exit' || undefined} onMouseDown={() => !busyId && onClose()}>
    <section ref={dialogRef} className="workspace-members-dialog account-surface" role="dialog" aria-modal="true" aria-labelledby="workspace-members-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="workspace-eyebrow">WORKSPACE ACCESS</span><h2 id="workspace-members-title">{copy.accessTitle}</h2><p>{copy.accessDescription}</p></div><button type="button" onClick={onClose} disabled={Boolean(busyId)} aria-label={copy.backToAccount}>←</button></header>
      <form className="workspace-members-dialog__invite" onSubmit={(event) => void invite(event)}>
        <label><span>{copy.email}</span><input type="email" required disabled={Boolean(busyId)} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" /></label>
        <label><span>{copy.name}</span><input disabled={Boolean(busyId)} value={name} onChange={(event) => setName(event.target.value)} placeholder={copy.optional} /></label>
        <label><span>{copy.role}</span><select disabled={Boolean(busyId)} value={role} onChange={(event) => setRole(event.target.value as 'owner' | 'member')}><option value="member">{copy.roles.member}</option><option value="owner">{copy.roles.owner}</option></select></label>
        <button type="submit" disabled={Boolean(busyId) || !email.trim()}>{busyId === 'invite' ? copy.sending : copy.sendInvite}</button>
      </form>
      {error ? <p className="workspace-members-dialog__error" role="alert">{error}</p> : null}
      {message ? <p className="workspace-members-dialog__notice" role="status">{message}</p> : null}
      <div className="workspace-members-dialog__list" aria-busy={loading || Boolean(busyId)}>
        {loading ? <p role="status">{copy.membersLoading}</p> : members.map((member) => <article key={member.id}>
          <div className="workspace-members-dialog__identity"><b>{member.name?.slice(0, 1).toUpperCase() || member.email.slice(0, 1).toUpperCase()}</b><span><strong>{member.name || member.email}</strong><small>{member.email}{member.id === currentUser.id ? ` · ${copy.you}` : ''}</small></span></div>
          <span className={`workspace-members-dialog__status is-${member.status}`}>{copy.statuses[member.status]}</span>
          <select aria-label={copy.setRole(member.name || member.email)} value={member.role} disabled={Boolean(busyId) || member.status === 'disabled'} onChange={(event) => void updateMember(member, { role: event.target.value as 'owner' | 'member' })}><option value="member">{copy.roles.member}</option><option value="owner">{copy.roles.owner}</option></select>
          <button type="button" disabled={Boolean(busyId) || member.id === currentUser.id} onClick={() => member.status === 'invited' ? void resendInvite(member) : void updateMember(member, { status: member.status === 'disabled' ? 'active' : 'disabled' })}>{busyId === member.id ? copy.processing : member.status === 'invited' ? copy.resendInvite : member.status === 'disabled' ? copy.restore : copy.disable}</button>
        </article>)}
      </div>
      <footer>{copy.membersFooter}</footer>
    </section>
  </div>, document.body)
}
