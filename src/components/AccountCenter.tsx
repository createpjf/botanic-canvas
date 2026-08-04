import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useRestoreFocus, type MotionPhase } from './motionPresence'
import { auditEventCategory, auditEventDetail, auditEventLabel, filterAuditEvents, type AuditEventCategory, type WorkspaceAuditEvent } from '../domain/auditEvents'
import { accountMenuPlacement, type AccountMenuAnchor } from '../domain/accountCenterPresentation'

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

function AccountGlyph({ kind }: { kind: 'profile' | 'security' | 'members' | 'audit' | 'sign-out' }) {
  const paths: Record<typeof kind, ReactNode> = {
    profile: <><circle cx="12" cy="8" r="3.25" /><path d="M5.5 20c.65-4.05 2.82-6.08 6.5-6.08S17.85 15.95 18.5 20" /></>,
    security: <><path d="M5.5 10.25V8.5a6.5 6.5 0 0 1 13 0v1.75" /><rect x="4" y="10.25" width="16" height="10.25" rx="2.5" /><path d="M12 14.25v2.5" /></>,
    members: <><circle cx="8.25" cy="9" r="3" /><circle cx="16.75" cy="10.25" r="2.25" /><path d="M2.75 19c.5-3.45 2.33-5.18 5.5-5.18s5 1.73 5.5 5.18M14 14.25c3.7-.42 5.78 1.17 6.25 4.75" /></>,
    audit: <><circle cx="12" cy="12" r="8.25" /><path d="M12 7.5v5l3.25 2" /></>,
    'sign-out': <><path d="M10 4H5.75A1.75 1.75 0 0 0 4 5.75v12.5C4 19.22 4.78 20 5.75 20H10" /><path d="M14.5 7.5 19 12l-4.5 4.5M8.5 12H19" /></>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[kind]}</svg>
}

export function useDialogFocusTrap(active: boolean) {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!active) return
    const dialog = dialogRef.current
    if (!dialog) return
    const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter((element) => !element.hidden)
    const frame = window.requestAnimationFrame(() => {
      const preferred = dialog.querySelector<HTMLElement>('[autofocus]') ?? focusables()[0]
      preferred?.focus({ preventScroll: true })
    })
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', trap)
    return () => { window.cancelAnimationFrame(frame); dialog.removeEventListener('keydown', trap) }
  }, [active])
  return dialogRef
}

export function AccountMenu({
  user,
  anchor,
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
  onOpenProfile: () => void
  onOpenSecurity: () => void
  onOpenMembers: () => void
  onOpenAudit: () => void
  onSignOut?: () => Promise<void>
  onClose: () => void
  phase?: MotionPhase
}) {
  const menuRef = useRef<HTMLElement>(null)
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
    <aside ref={menuRef} className={`account-menu is-${phase}`} style={style} role="menu" aria-labelledby="account-menu-title" inert={phase === 'exit' || undefined} onKeyDown={moveFocus}>
      <header>
        <span className="account-menu__avatar">{user?.name?.slice(0, 1).toUpperCase() || 'B'}</span>
        <div><small>账号与工作区</small><strong id="account-menu-title">{user?.name || '本地工作区'}</strong><small>{user?.email || '本地预览模式'}</small></div>
        {user ? <i>{user.role === 'owner' ? '所有者' : '成员'}</i> : null}
      </header>
      <div className="account-menu__actions">
        <span className="account-menu__section-label">个人</span>
        <button type="button" role="menuitem" onClick={onOpenProfile} disabled={!user}><em><AccountGlyph kind="profile" /></em><span>个人资料</span><small>姓名、邮箱与工作区角色</small><b>›</b></button>
        <button type="button" role="menuitem" onClick={onOpenSecurity} disabled={!user}><em><AccountGlyph kind="security" /></em><span>登录与安全</span><small>密码、二步验证与登录设备</small><b>›</b></button>
        {user?.role === 'owner' ? <span className="account-menu__section-label">工作区</span> : null}
        {user?.role === 'owner' ? <button type="button" role="menuitem" onClick={onOpenMembers}><em><AccountGlyph kind="members" /></em><span>成员与权限</span><small>邀请成员并管理访问</small><b>›</b></button> : null}
        {user?.role === 'owner' ? <button type="button" role="menuitem" onClick={onOpenAudit}><em><AccountGlyph kind="audit" /></em><span>活动记录</span><small>查看账户、项目与生成操作</small><b>›</b></button> : null}
      </div>
      {onSignOut ? <button className="account-menu__sign-out" type="button" role="menuitem" onClick={() => void onSignOut()}><AccountGlyph kind="sign-out" /><span>退出登录</span></button> : null}
    </aside>,
    document.body,
  )
}

const auditCategories: Array<{ id: AuditEventCategory; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'account', label: '账户' },
  { id: 'member', label: '成员' },
  { id: 'project', label: '项目' },
  { id: 'generation', label: '生成' },
]

function auditTimeLabel(createdAt: number) {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

export function WorkspaceAuditDialog({ onListEvents, onListMembers, onClose, phase = 'open', returnFocusTarget }: {
  onListEvents: () => Promise<WorkspaceAuditEvent[]>
  onListMembers: () => Promise<WorkspaceMember[]>
  onClose: () => void
  phase?: MotionPhase
  returnFocusTarget?: HTMLElement | null
}) {
  const [events, setEvents] = useState<WorkspaceAuditEvent[]>([])
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [category, setCategory] = useState<AuditEventCategory>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useRestoreFocus(phase !== 'exit', returnFocusTarget === undefined ? document.querySelector<HTMLButtonElement>('button[aria-label="打开账户设置"]') : returnFocusTarget)
  const dialogRef = useDialogFocusTrap(phase !== 'exit')

  const load = async () => {
    setLoading(true); setError('')
    try {
      const [nextEvents, nextMembers] = await Promise.all([onListEvents(), onListMembers()])
      setEvents(nextEvents); setMembers(nextMembers)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '安全日志加载失败。')
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
      <header><div><span className="workspace-eyebrow">SECURITY ACTIVITY</span><h2 id="workspace-audit-title">安全日志</h2><p>Owner 可查看工作区内的成员、项目和生成操作。</p></div><button type="button" onClick={onClose} aria-label="返回账户菜单">←</button></header>
      <div className="workspace-audit-dialog__toolbar">
        <div role="tablist" aria-label="日志类型">{auditCategories.map((item) => <button key={item.id} type="button" role="tab" aria-selected={category === item.id} className={category === item.id ? 'is-active' : ''} onClick={() => setCategory(item.id)}>{item.label}</button>)}</div>
        <button type="button" onClick={() => void load()} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
      </div>
      {error ? <div className="workspace-audit-dialog__state is-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div> : loading ? <div className="workspace-audit-dialog__state" role="status">正在读取安全日志…</div> : visibleEvents.length === 0 ? <div className="workspace-audit-dialog__state">当前分类暂无记录。</div> : <ol className="workspace-audit-dialog__list">
        {visibleEvents.map((event) => {
          const actor = memberById.get(event.actorId)
          const eventCategory = auditEventCategory(event.action)
          return <li key={event.id}>
            <i className={`is-${eventCategory}`} aria-hidden="true" />
            <div><strong>{auditEventLabel(event.action)}</strong><span>{actor?.name || actor?.email || `成员 ${event.actorId}`}</span><small>{auditEventDetail(event)}</small></div>
            <time dateTime={Number.isFinite(event.createdAt) ? new Date(event.createdAt).toISOString() : undefined}>{auditTimeLabel(event.createdAt)}</time>
          </li>
        })}
      </ol>}
      <footer>日志为只读记录，不会修改项目或生成任务。</footer>
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
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [mfaStatus, setMfaStatus] = useState<AccountMfaStatus | null>(null)
  const [mfaEnrollment, setMfaEnrollment] = useState<AccountMfaEnrollment | null>(null)
  const [mfaCode, setMfaCode] = useState('')
  const [mfaMessage, setMfaMessage] = useState('')
  const [passwordEditorOpen, setPasswordEditorOpen] = useState(false)
  const [confirmingMfaRemoval, setConfirmingMfaRemoval] = useState(false)
  const [confirmingOtherSessions, setConfirmingOtherSessions] = useState(false)
  useRestoreFocus(phase !== 'exit', returnFocusTarget === undefined ? document.querySelector<HTMLButtonElement>('button[aria-label="打开账户设置"]') : returnFocusTarget)
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
    setMfaMessage('')
    setConfirmingMfaRemoval(false)
    setConfirmingOtherSessions(false)
  }, [mode])

  useEffect(() => {
    if (mode !== 'security') return
    let active = true
    void onReadMfaStatus()
      .then((status) => { if (active) setMfaStatus(status) })
      .catch((error) => { if (active) setMfaMessage(error instanceof Error ? error.message : '无法读取二步验证状态。') })
    return () => { active = false }
  }, [mode, onReadMfaStatus])

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password.length < 8 || password !== confirmation || busy) return
    setBusy(true)
    setMessage('')
    try {
      await onChangePassword(password)
      setMessage('密码已更新。')
      setPassword('')
      setConfirmation('')
      setPasswordEditorOpen(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '密码未更新。')
    } finally {
      setBusy(false)
    }
  }

  const beginMfaEnrollment = async () => {
    if (busy) return
    setBusy(true); setMfaMessage('')
    try { setMfaEnrollment(await onEnrollMfa()) } catch (error) { setMfaMessage(error instanceof Error ? error.message : '无法启用二步验证。') } finally { setBusy(false) }
  }

  const verifyMfa = async (factorId: string) => {
    if (busy || !/^\d{6}$/.test(mfaCode)) return
    setBusy(true); setMfaMessage('')
    try {
      const enabling = mfaEnrollment?.factorId === factorId
      await onVerifyMfa(factorId, mfaCode, enabling)
      setMfaEnrollment(null); setMfaCode('')
      setMfaStatus(await onReadMfaStatus())
      setMfaMessage(enabling ? '二步验证已启用，本次会话已提升为 AAL2。' : '本次会话已通过二步验证。')
    } catch (error) { setMfaMessage(error instanceof Error ? error.message : '验证码无效。') } finally { setBusy(false) }
  }

  const removeMfa = async (factorId: string) => {
    if (busy) return
    if (!confirmingMfaRemoval) { setConfirmingMfaRemoval(true); return }
    setBusy(true); setMfaMessage('')
    try {
      await onRemoveMfa(factorId)
      setMfaEnrollment(null); setMfaCode('')
      setMfaStatus(await onReadMfaStatus())
      setMfaMessage('二步验证已移除。')
    } catch (error) { setMfaMessage(error instanceof Error ? error.message : '无法移除二步验证。') } finally { setBusy(false); setConfirmingMfaRemoval(false) }
  }

  const signOutOthers = async () => {
    if (busy) return
    if (!confirmingOtherSessions) { setConfirmingOtherSessions(true); return }
    setBusy(true); setMfaMessage('')
    try { await onSignOutOtherSessions(); setMfaMessage('其他设备的登录会话已退出。') } catch (error) { setMfaMessage(error instanceof Error ? error.message : '无法退出其他设备。') } finally { setBusy(false); setConfirmingOtherSessions(false) }
  }

  const activeFactor = mfaStatus?.factors[0]

  return createPortal(
    <div className={`account-dialog-backdrop account-overlay is-${phase}`} role="presentation" inert={phase === 'exit' || undefined} onMouseDown={() => !busy && onClose()}>
      <section ref={dialogRef} className="account-dialog account-surface" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" aria-busy={busy} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>BOTANIC ACCOUNT</span><h2 id="account-dialog-title">账户设置</h2><p>{user.email}</p></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="返回账户菜单">←</button>
        </header>
        <div className="account-dialog__layout">
          <nav aria-label="账户设置分类">
            <button type="button" disabled={busy} className={mode === 'profile' ? 'is-active' : ''} aria-current={mode === 'profile' ? 'page' : undefined} onClick={() => onModeChange?.('profile')}><AccountGlyph kind="profile" /><span><strong>个人资料</strong><small>身份与角色</small></span></button>
            <button type="button" disabled={busy} className={mode === 'security' ? 'is-active' : ''} aria-current={mode === 'security' ? 'page' : undefined} onClick={() => onModeChange?.('security')}><AccountGlyph kind="security" /><span><strong>登录与安全</strong><small>密码与验证</small></span></button>
          </nav>
          <div className="account-dialog__content" key={mode}>
            {mode === 'profile' ? <section className="account-profile" aria-labelledby="account-profile-heading">
              <div className="account-profile__hero"><span className="account-profile__mark">{user.name.slice(0, 1).toUpperCase() || 'B'}</span><span><h3 id="account-profile-heading">{user.name}</h3><p>{user.role === 'owner' ? 'Botanic 工作区所有者' : 'Botanic 工作区成员'}</p></span><i>{user.role === 'owner' ? '所有者' : '成员'}</i></div>
              <dl><div><dt>姓名</dt><dd>{user.name}</dd></div><div><dt>登录邮箱</dt><dd>{user.email}</dd></div><div><dt>工作区角色</dt><dd>{user.role === 'owner' ? '所有者' : '成员'}</dd></div></dl>
              <p className="account-profile__note">邮箱与角色由工作区统一管理，修改账户设置不会影响已有项目和生成结果。</p>
            </section> : <div className="account-security">
              <section className={`account-security__card account-security__password${passwordEditorOpen ? ' is-expanded' : ''}`}>
                <div className="account-security__summary"><span><h3>登录密码</h3><p>使用独立密码登录 Botanic。</p></span><button type="button" disabled={busy} aria-expanded={passwordEditorOpen} onClick={() => { setPasswordEditorOpen((open) => !open); setMessage('') }}>{passwordEditorOpen ? '收起' : '修改'}</button></div>
                {passwordEditorOpen ? <form className="account-security__editor" onSubmit={(event) => void submitPassword(event)}>
                  <input className="visually-hidden" type="email" autoComplete="username" value={user.email} readOnly tabIndex={-1} aria-hidden="true" />
                  <label><span>新密码</span><input type="password" autoComplete="new-password" minLength={8} disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 个字符" /></label>
                  <label><span>确认密码</span><input type="password" autoComplete="new-password" minLength={8} disabled={busy} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="再次输入新密码" /></label>
                  {confirmation && password !== confirmation ? <small role="alert">两次输入的密码不一致。</small> : null}
                  <div><button type="button" disabled={busy} onClick={() => { setPasswordEditorOpen(false); setPassword(''); setConfirmation(''); setMessage('') }}>取消</button><button type="submit" className="is-primary" disabled={busy || password.length < 8 || password !== confirmation}>{busy ? '正在保存…' : '保存密码'}</button></div>
                </form> : null}
                {message ? <small className={message.includes('已更新') ? 'is-success' : ''} role="status">{message}</small> : null}
              </section>
              <section className="account-security__card account-security__mfa">
                <div className="account-security__summary"><span><h3>二步验证</h3><p>{mfaStatus?.enabled ? (mfaStatus.currentLevel === 'aal2' ? '已保护，本次会话已验证。' : '已保护，敏感操作前需验证。') : '使用身份验证器保护敏感操作。'}</p></span>{mfaStatus?.enabled ? <i>已保护</i> : null}</div>
                {mfaEnrollment ? <div className="account-security__enrollment">
                  <img src={mfaEnrollment.qrCode} alt="二步验证二维码" />
                  <p>扫描二维码后，输入身份验证器中的 6 位验证码。</p>
                  <code>{mfaEnrollment.secret}</code>
                  <div><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={busy} value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="二步验证码" placeholder="000000" /><button type="button" className="is-primary" disabled={busy || mfaCode.length !== 6} onClick={() => void verifyMfa(mfaEnrollment.factorId)}>验证并启用</button></div>
                </div> : mfaStatus?.enabled && activeFactor ? <div className="account-security__factor">
                  <strong>{activeFactor.name || '身份验证器'}</strong>
                  {mfaStatus.currentLevel !== 'aal2' ? <div><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={busy} value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="二步验证码" placeholder="输入 6 位验证码" /><button type="button" className="is-primary" disabled={busy || mfaCode.length !== 6} onClick={() => void verifyMfa(activeFactor.id)}>验证本次会话</button></div> : null}
                  {confirmingMfaRemoval ? <div className="account-security__confirm" role="alert"><span>确认移除二步验证？账户保护会降低。</span><div><button type="button" disabled={busy} onClick={() => setConfirmingMfaRemoval(false)}>取消</button><button type="button" className="is-danger" disabled={busy} onClick={() => void removeMfa(activeFactor.id)}>确认移除</button></div></div> : <button type="button" className="is-danger is-quiet" disabled={busy} onClick={() => setConfirmingMfaRemoval(true)}>移除二步验证</button>}
                </div> : mfaStatus ? <button type="button" className="account-security__enable is-primary" disabled={busy} onClick={() => void beginMfaEnrollment()}>启用二步验证</button> : <p className="account-security__loading" role="status">正在读取安全状态…</p>}
                {mfaMessage ? <small className={mfaMessage.includes('已') ? 'is-success' : ''} role="status">{mfaMessage}</small> : null}
              </section>
              <section className="account-security__card account-security__sessions">
                <div className="account-security__summary"><span><h3>登录设备</h3><p>保留当前设备，退出其他浏览器中的登录。</p></span>{!confirmingOtherSessions ? <button type="button" disabled={busy} onClick={() => setConfirmingOtherSessions(true)}>管理</button> : null}</div>
                {confirmingOtherSessions ? <div className="account-security__confirm" role="alert"><span>其他设备需要重新登录，当前设备不会退出。</span><div><button type="button" disabled={busy} onClick={() => setConfirmingOtherSessions(false)}>取消</button><button type="button" className="is-danger" disabled={busy} onClick={() => void signOutOthers()}>{busy ? '正在退出…' : '退出其他设备'}</button></div></div> : null}
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
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<'owner' | 'member'>('member')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useRestoreFocus(phase !== 'exit', returnFocusTarget === undefined ? document.querySelector<HTMLButtonElement>('button[aria-label="打开账户设置"]') : returnFocusTarget)
  const dialogRef = useDialogFocusTrap(phase !== 'exit')

  useEffect(() => {
    let active = true
    void onListMembers().then((next) => { if (active) setMembers(next) }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : '成员列表加载失败。') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [onListMembers])

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
    } catch (caught) { setError(caught instanceof Error ? caught.message : '邀请未发送。') } finally { setBusyId(null) }
  }

  const resendInvite = async (member: WorkspaceMember) => {
    if (busyId || member.status !== 'invited') return
    setBusyId(member.id); setError(''); setMessage('')
    try {
      await onResendInvite(member.id)
      setMessage(`已向 ${member.email} 重新发送邀请。`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '重新发送邀请失败。') } finally { setBusyId(null) }
  }

  const updateMember = async (member: WorkspaceMember, updates: { role?: 'owner' | 'member'; status?: 'active' | 'disabled' }) => {
    if (busyId) return
    setBusyId(member.id); setError(''); setMessage('')
    try {
      const updated = await onUpdateMember(member.id, updates)
      setMembers((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (caught) { setError(caught instanceof Error ? caught.message : '成员权限未更新。') } finally { setBusyId(null) }
  }

  const statusLabel = (status: WorkspaceMember['status']) => status === 'active' ? '已启用' : status === 'invited' ? '待接受' : '已停用'

  return createPortal(<div className={`workspace-members-backdrop account-overlay is-${phase}`} role="presentation" inert={phase === 'exit' || undefined} onMouseDown={() => !busyId && onClose()}>
    <section ref={dialogRef} className="workspace-members-dialog account-surface" role="dialog" aria-modal="true" aria-labelledby="workspace-members-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="workspace-eyebrow">WORKSPACE ACCESS</span><h2 id="workspace-members-title">成员与权限</h2><p>邀请成员，并管理他们的工作区访问。</p></div><button type="button" onClick={onClose} disabled={Boolean(busyId)} aria-label="返回账户菜单">←</button></header>
      <form className="workspace-members-dialog__invite" onSubmit={(event) => void invite(event)}>
        <label><span>邮箱</span><input type="email" required disabled={Boolean(busyId)} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" /></label>
        <label><span>姓名</span><input disabled={Boolean(busyId)} value={name} onChange={(event) => setName(event.target.value)} placeholder="选填" /></label>
        <label><span>角色</span><select disabled={Boolean(busyId)} value={role} onChange={(event) => setRole(event.target.value as 'owner' | 'member')}><option value="member">成员</option><option value="owner">所有者</option></select></label>
        <button type="submit" disabled={Boolean(busyId) || !email.trim()}>{busyId === 'invite' ? '发送中…' : '发送邀请'}</button>
      </form>
      {error ? <p className="workspace-members-dialog__error" role="alert">{error}</p> : null}
      {message ? <p className="workspace-members-dialog__notice" role="status">{message}</p> : null}
      <div className="workspace-members-dialog__list" aria-busy={loading || Boolean(busyId)}>
        {loading ? <p role="status">正在加载成员…</p> : members.map((member) => <article key={member.id}>
          <div className="workspace-members-dialog__identity"><b>{member.name?.slice(0, 1).toUpperCase() || member.email.slice(0, 1).toUpperCase()}</b><span><strong>{member.name || member.email}</strong><small>{member.email}{member.id === currentUser.id ? ' · 你' : ''}</small></span></div>
          <span className={`workspace-members-dialog__status is-${member.status}`}>{statusLabel(member.status)}</span>
          <select aria-label={`设置 ${member.name || member.email} 的角色`} value={member.role} disabled={Boolean(busyId) || member.status === 'disabled'} onChange={(event) => void updateMember(member, { role: event.target.value as 'owner' | 'member' })}><option value="member">成员</option><option value="owner">所有者</option></select>
          <button type="button" disabled={Boolean(busyId) || member.id === currentUser.id} onClick={() => member.status === 'invited' ? void resendInvite(member) : void updateMember(member, { status: member.status === 'disabled' ? 'active' : 'disabled' })}>{busyId === member.id ? '处理中…' : member.status === 'invited' ? '重发邀请' : member.status === 'disabled' ? '恢复' : '停用'}</button>
        </article>)}
      </div>
      <footer>停用不会删除该成员的项目、任务或媒体。</footer>
    </section>
  </div>, document.body)
}
