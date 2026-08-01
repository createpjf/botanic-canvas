import { useEffect, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useRestoreFocus } from './motionPresence'

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

export type AccountMenuAnchor = { left: number; right: number; top: number; bottom: number }
export type AccountMfaStatus = { currentLevel: 'aal1' | 'aal2' | null; enabled: boolean; factors: Array<{ id: string; name: string }> }
export type AccountMfaEnrollment = { factorId: string; qrCode: string; secret: string; uri: string }

export function AccountMenu({
  user,
  anchor,
  onOpenProfile,
  onOpenSecurity,
  onOpenMembers,
  onSignOut,
  onClose,
}: {
  user?: AccountUser
  anchor: AccountMenuAnchor
  onOpenProfile: () => void
  onOpenSecurity: () => void
  onOpenMembers: () => void
  onSignOut?: () => Promise<void>
  onClose: () => void
}) {
  useRestoreFocus(true)

  useEffect(() => {
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof PointerEvent && (event.target as Element).closest('.account-menu')) return
      onClose()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [onClose])

  const left = Math.min(window.innerWidth - 286, Math.max(12, anchor.right + 12))
  const top = Math.min(window.innerHeight - 330, Math.max(12, anchor.bottom - 258))

  return createPortal(
    <aside className="account-menu" style={{ left, top }} aria-label="账户菜单">
      <header>
        <span className="account-menu__avatar">{user?.name?.slice(0, 1).toUpperCase() || 'B'}</span>
        <div><strong>{user?.name || '本地工作区'}</strong><small>{user?.email || '本地预览模式'}</small></div>
        {user ? <i>{user.role === 'owner' ? '所有者' : '成员'}</i> : null}
      </header>
      <div className="account-menu__actions">
        <button type="button" onClick={onOpenProfile} disabled={!user}><span>个人资料</span><small>姓名、邮箱与角色</small><b>›</b></button>
        <button type="button" onClick={onOpenSecurity} disabled={!user}><span>账户安全</span><small>更新登录密码</small><b>›</b></button>
        {user?.role === 'owner' ? <button type="button" onClick={onOpenMembers}><span>成员与权限</span><small>邀请、停用与角色管理</small><b>›</b></button> : null}
      </div>
      {onSignOut ? <button className="account-menu__sign-out" type="button" onClick={() => void onSignOut()}>退出登录</button> : null}
    </aside>,
    document.body,
  )
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
  onClose,
}: {
  mode: 'profile' | 'security'
  user: AccountUser
  onChangePassword: (password: string) => Promise<void>
  onReadMfaStatus: () => Promise<AccountMfaStatus>
  onEnrollMfa: () => Promise<AccountMfaEnrollment>
  onVerifyMfa: (factorId: string, code: string, enabling?: boolean) => Promise<void>
  onRemoveMfa: (factorId: string) => Promise<void>
  onSignOutOtherSessions: () => Promise<void>
  onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [mfaStatus, setMfaStatus] = useState<AccountMfaStatus | null>(null)
  const [mfaEnrollment, setMfaEnrollment] = useState<AccountMfaEnrollment | null>(null)
  const [mfaCode, setMfaCode] = useState('')
  const [mfaMessage, setMfaMessage] = useState('')
  useRestoreFocus(true)

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [busy, onClose])

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
    if (busy || !window.confirm('移除二步验证后，账户安全性会降低。确定继续？')) return
    setBusy(true); setMfaMessage('')
    try {
      await onRemoveMfa(factorId)
      setMfaEnrollment(null); setMfaCode('')
      setMfaStatus(await onReadMfaStatus())
      setMfaMessage('二步验证已移除。')
    } catch (error) { setMfaMessage(error instanceof Error ? error.message : '无法移除二步验证。') } finally { setBusy(false) }
  }

  const signOutOthers = async () => {
    if (busy) return
    setBusy(true); setMfaMessage('')
    try { await onSignOutOtherSessions(); setMfaMessage('其他设备的登录会话已退出。') } catch (error) { setMfaMessage(error instanceof Error ? error.message : '无法退出其他设备。') } finally { setBusy(false) }
  }

  return createPortal(
    <div className="account-dialog-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
      <section className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span>BOTANIC ACCOUNT</span><h2 id="account-dialog-title">{mode === 'profile' ? '个人资料' : '账户安全'}</h2></div><button type="button" onClick={onClose} aria-label="关闭账户设置">×</button></header>
        {mode === 'profile' ? <div className="account-profile">
          <span className="account-profile__mark">{user.name.slice(0, 1).toUpperCase() || 'B'}</span>
          <dl><div><dt>姓名</dt><dd>{user.name}</dd></div><div><dt>邮箱</dt><dd>{user.email}</dd></div><div><dt>工作区角色</dt><dd>{user.role === 'owner' ? '所有者' : '成员'}</dd></div></dl>
          <p>邮箱和角色由工作区管理，不会影响已有项目与生成结果。</p>
        </div> : <div className="account-security">
          <form className="account-security__password" onSubmit={(event) => void submitPassword(event)}>
            <h3>登录密码</h3><p>设置一个至少 8 个字符的新密码。</p>
            <label><span>新密码</span><input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <label><span>确认密码</span><input type="password" autoComplete="new-password" minLength={8} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
            {confirmation && password !== confirmation ? <small role="alert">两次输入的密码不一致。</small> : message ? <small className={message.includes('已更新') ? 'is-success' : ''} role="status">{message}</small> : null}
            <button type="submit" disabled={busy || password.length < 8 || password !== confirmation}>{busy ? '正在保存…' : '更新密码'}</button>
          </form>
          <section className="account-security__mfa">
            <div><span><h3>二步验证</h3><p>{mfaStatus?.enabled ? (mfaStatus.currentLevel === 'aal2' ? '已启用 · 本次会话已验证' : '已启用 · 敏感操作前需验证') : '使用身份验证器保护 Owner 敏感操作。'}</p></span>{mfaStatus?.enabled ? <i>已保护</i> : null}</div>
            {mfaEnrollment ? <div className="account-security__enrollment">
              <img src={mfaEnrollment.qrCode} alt="二步验证二维码" />
              <p>使用身份验证器扫描二维码，再输入 6 位验证码。</p>
              <code>{mfaEnrollment.secret}</code>
              <div><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="二步验证码" placeholder="000000" /><button type="button" disabled={busy || mfaCode.length !== 6} onClick={() => void verifyMfa(mfaEnrollment.factorId)}>验证并启用</button></div>
            </div> : mfaStatus?.enabled ? <div className="account-security__factor">
              <strong>{mfaStatus.factors[0]?.name || '身份验证器'}</strong>
              {mfaStatus.currentLevel !== 'aal2' ? <div><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="二步验证码" placeholder="输入 6 位验证码" /><button type="button" disabled={busy || mfaCode.length !== 6} onClick={() => void verifyMfa(mfaStatus.factors[0].id)}>验证本次会话</button></div> : null}
              <button type="button" className="is-danger" disabled={busy} onClick={() => void removeMfa(mfaStatus.factors[0].id)}>移除二步验证</button>
            </div> : mfaStatus ? <button type="button" className="account-security__enable" disabled={busy} onClick={() => void beginMfaEnrollment()}>启用二步验证</button> : <p>正在读取安全状态…</p>}
            {mfaMessage ? <small className={mfaMessage.includes('已') ? 'is-success' : ''} role="status">{mfaMessage}</small> : null}
          </section>
          <section className="account-security__sessions"><span><h3>其他设备</h3><p>保留当前设备，退出其他浏览器中的登录。</p></span><button type="button" disabled={busy} onClick={() => void signOutOthers()}>退出其他设备</button></section>
        </div>}
      </section>
    </div>,
    document.body,
  )
}

export function WorkspaceMembersDialog({ currentUser, onListMembers, onInviteMember, onUpdateMember, onClose }: {
  currentUser: AccountUser
  onListMembers: () => Promise<WorkspaceMember[]>
  onInviteMember: (input: { email: string; name?: string; role: 'owner' | 'member' }) => Promise<WorkspaceMember>
  onUpdateMember: (userId: string, updates: { role?: 'owner' | 'member'; status?: 'active' | 'disabled' }) => Promise<WorkspaceMember>
  onClose: () => void
}) {
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<'owner' | 'member'>('member')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  useRestoreFocus(true)

  useEffect(() => {
    let active = true
    void onListMembers().then((next) => { if (active) setMembers(next) }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : '成员列表加载失败。') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [onListMembers])

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busyId) onClose() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [busyId, onClose])

  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!email.trim() || busyId) return
    setBusyId('invite'); setError('')
    try {
      const invited = await onInviteMember({ email: email.trim(), name: name.trim() || undefined, role })
      setMembers((current) => [...current.filter((member) => member.id !== invited.id), invited])
      setEmail(''); setName(''); setRole('member')
    } catch (caught) { setError(caught instanceof Error ? caught.message : '邀请未发送。') } finally { setBusyId(null) }
  }

  const updateMember = async (member: WorkspaceMember, updates: { role?: 'owner' | 'member'; status?: 'active' | 'disabled' }) => {
    if (busyId) return
    setBusyId(member.id); setError('')
    try {
      const updated = await onUpdateMember(member.id, updates)
      setMembers((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (caught) { setError(caught instanceof Error ? caught.message : '成员权限未更新。') } finally { setBusyId(null) }
  }

  const statusLabel = (status: WorkspaceMember['status']) => status === 'active' ? '已启用' : status === 'invited' ? '待接受' : '已停用'

  return createPortal(<div className="workspace-members-backdrop" role="presentation" onMouseDown={() => !busyId && onClose()}>
    <section className="workspace-members-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-members-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="workspace-eyebrow">WORKSPACE ACCESS</span><h2 id="workspace-members-title">成员与权限</h2><p>邀请成员，并管理他们的工作区访问。</p></div><button type="button" onClick={onClose} aria-label="关闭成员管理">×</button></header>
      <form className="workspace-members-dialog__invite" onSubmit={(event) => void invite(event)}>
        <label><span>邮箱</span><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" /></label>
        <label><span>姓名</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="选填" /></label>
        <label><span>角色</span><select value={role} onChange={(event) => setRole(event.target.value as 'owner' | 'member')}><option value="member">成员</option><option value="owner">所有者</option></select></label>
        <button type="submit" disabled={busyId === 'invite' || !email.trim()}>{busyId === 'invite' ? '发送中…' : '发送邀请'}</button>
      </form>
      {error ? <p className="workspace-members-dialog__error" role="alert">{error}</p> : null}
      <div className="workspace-members-dialog__list" aria-busy={loading}>
        {loading ? <p role="status">正在加载成员…</p> : members.map((member) => <article key={member.id}>
          <div className="workspace-members-dialog__identity"><b>{member.name?.slice(0, 1).toUpperCase() || member.email.slice(0, 1).toUpperCase()}</b><span><strong>{member.name || member.email}</strong><small>{member.email}{member.id === currentUser.id ? ' · 你' : ''}</small></span></div>
          <span className={`workspace-members-dialog__status is-${member.status}`}>{statusLabel(member.status)}</span>
          <select aria-label={`设置 ${member.name || member.email} 的角色`} value={member.role} disabled={busyId === member.id || member.status === 'disabled'} onChange={(event) => void updateMember(member, { role: event.target.value as 'owner' | 'member' })}><option value="member">成员</option><option value="owner">所有者</option></select>
          <button type="button" disabled={busyId === member.id || member.id === currentUser.id} onClick={() => void updateMember(member, { status: member.status === 'disabled' ? 'active' : 'disabled' })}>{busyId === member.id ? '处理中…' : member.status === 'disabled' ? '恢复' : '停用'}</button>
        </article>)}
      </div>
      <footer>停用不会删除该成员的项目、任务或媒体。</footer>
    </section>
  </div>, document.body)
}
