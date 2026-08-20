import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceAuditEvent } from '../domain/auditEvents'
import { AccountDetailsDialog, AccountMenu, WorkspaceAuditDialog, WorkspaceMembersDialog, type AccountMenuAnchor, type AccountMfaEnrollment, type AccountMfaStatus, type AccountUser, type WorkspaceMember as AccountWorkspaceMember } from './AccountCenter'
import { DeleteIcon, HomeIcon, MoreIcon } from './BotanicIcons'
import { useMotionPresence, useRestoreFocus, useRetainedValue } from './motionPresence'
import { useDialogFocusTrap } from './useDialogFocusTrap'

export type WorkspaceProject = {
  id: string
  name: string
  updatedAt: number
  cover?: string
  summary: string
  isSeed?: boolean
}

export type WorkspaceCurrentUser = AccountUser
export type WorkspaceMember = AccountWorkspaceMember

function projectUpdatedLabel(updatedAt: number) {
  const elapsed = Math.max(0, Date.now() - updatedAt)
  const hours = Math.floor(elapsed / 3_600_000)
  if (hours < 1) return '最近编辑 · 刚刚'
  if (hours < 24) return `最近编辑 · ${hours} 小时前`
  return `最近编辑 · ${Math.floor(hours / 24)} 天前`
}

export function ProjectLibrary({
  projects,
  currentUser,
  loading,
  loadError,
  onSignOut,
  onReturnToLanding,
  productHomeLabel,
  onChangePassword,
  onReadMfaStatus,
  onEnrollMfa,
  onVerifyMfa,
  onRemoveMfa,
  onSignOutOtherSessions,
  onListMembers,
  onListAuditEvents,
  onInviteMember,
  onResendInvite,
  onUpdateMember,
  onOpenProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onRetry,
}: {
  projects: WorkspaceProject[]
  currentUser?: WorkspaceCurrentUser
  loading: boolean
  loadError: string | null
  onSignOut?: () => Promise<void>
  onReturnToLanding: () => void
  productHomeLabel: string
  onChangePassword?: (password: string) => Promise<void>
  onReadMfaStatus?: () => Promise<AccountMfaStatus>
  onEnrollMfa?: () => Promise<AccountMfaEnrollment>
  onVerifyMfa?: (factorId: string, code: string) => Promise<void>
  onRemoveMfa?: (factorId: string) => Promise<void>
  onSignOutOtherSessions?: () => Promise<void>
  onListMembers?: () => Promise<WorkspaceMember[]>
  onListAuditEvents?: () => Promise<WorkspaceAuditEvent[]>
  onInviteMember?: (input: { email: string; name?: string; role: 'owner' | 'member' }) => Promise<WorkspaceMember>
  onResendInvite?: (userId: string) => Promise<WorkspaceMember>
  onUpdateMember?: (userId: string, updates: { role?: 'owner' | 'member'; status?: 'active' | 'disabled' }) => Promise<WorkspaceMember>
  onOpenProject: (projectId: string) => void
  onCreateProject: () => Promise<boolean>
  onRenameProject: (projectId: string, name: string) => Promise<boolean>
  onDeleteProject: (projectId: string) => Promise<void>
  onRetry: () => void
}) {
  const [editingProject, setEditingProject] = useState<WorkspaceProject | null>(null)
  const [projectName, setProjectName] = useState('')
  const [deletingProject, setDeletingProject] = useState<WorkspaceProject | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [operationError, setOperationError] = useState('')
  const [accountMenuAnchor, setAccountMenuAnchor] = useState<AccountMenuAnchor | null>(null)
  const [accountDialog, setAccountDialog] = useState<'profile' | 'security' | 'members' | 'audit' | null>(null)
  const accountTriggerRef = useRef<HTMLButtonElement>(null)
  const accountMenuPresence = useMotionPresence(Boolean(accountMenuAnchor), 180)
  const visibleAccountMenuAnchor = useRetainedValue(accountMenuAnchor)
  const accountDialogPresence = useMotionPresence(Boolean(accountDialog), 220)
  const visibleAccountDialog = useRetainedValue(accountDialog)
  const returnToAccountMenu = useCallback(() => {
    setAccountDialog(null)
    const rect = accountTriggerRef.current?.getBoundingClientRect()
    if (rect) setAccountMenuAnchor({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
  }, [])
  const editingPresence = useMotionPresence(Boolean(editingProject), 140)
  const visibleEditingProject = useRetainedValue(editingProject)
  const deletingPresence = useMotionPresence(Boolean(deletingProject), 140)
  const visibleDeletingProject = useRetainedValue(deletingProject)
  useRestoreFocus(Boolean(editingProject || deletingProject))
  const projectDialogRef = useDialogFocusTrap(Boolean(editingProject || deletingProject))

  useEffect(() => {
    setProjectName(editingProject?.name ?? '')
  }, [editingProject])

  useEffect(() => {
    if (!editingProject && !deletingProject) return
    const closeDialog = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || submitting) return
      event.preventDefault()
      event.stopPropagation()
      setEditingProject(null)
      setDeletingProject(null)
    }
    document.addEventListener('keydown', closeDialog)
    return () => document.removeEventListener('keydown', closeDialog)
  }, [deletingProject, editingProject, submitting])

  const submitRename = async () => {
    if (!editingProject || !projectName.trim()) return
    setSubmitting(true)
    setOperationError('')
    try {
      const renamed = await onRenameProject(editingProject.id, projectName)
      if (renamed) setEditingProject(null)
      else setOperationError('项目名称未保存，请检查网络后重试。')
    } catch {
      setOperationError('项目名称未保存，请检查网络后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  const confirmDelete = async () => {
    if (!deletingProject) return
    const target = deletingProject
    setSubmitting(true)
    setOperationError('')
    // 父层会同步乐观移除卡片；这里立即关闭确认框，不让删除请求阻塞项目页。
    setDeletingProject(null)
    try {
      await onDeleteProject(target.id)
    } catch {
      setOperationError('删除未完成，请稍后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  const createProject = async () => {
    if (creating) return
    setCreating(true)
    setOperationError('')
    try {
      if (!await onCreateProject()) setOperationError('新建项目失败，请检查网络后重试。')
    } catch {
      setOperationError('新建项目失败，请检查网络后重试。')
    } finally {
      setCreating(false)
    }
  }

  return (
    <main className="project-library-page" aria-label="创意项目">
      <header className="project-library-page__header">
        <div className="project-library-page__brand"><strong>Botanic</strong><span>创意工作室</span></div>
        <div className="project-library-page__account-actions">
          <button type="button" className="project-library-page__home" onClick={onReturnToLanding} aria-label={productHomeLabel}>
            <HomeIcon />
            <span>{productHomeLabel}</span>
          </button>
          <button
            ref={accountTriggerRef}
            type="button"
            className="project-library-page__account"
            aria-label="打开账户设置"
            aria-expanded={Boolean(accountMenuAnchor)}
            onClick={(event) => {
              if (accountMenuAnchor) {
                setAccountMenuAnchor(null)
                return
              }
              const rect = event.currentTarget.getBoundingClientRect()
              setAccountMenuAnchor({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
            }}
          >
            <span>{currentUser?.name?.slice(0, 1).toUpperCase() || 'B'}</span>
            <strong>{currentUser?.name || '本地工作区'}</strong>
          </button>
        </div>
      </header>
      <section className="project-library-page__content">
        <header>
          <div><span className="workspace-eyebrow"><i />CREATIVE PROJECTS</span><h1>创意项目</h1><p>从不同的商品与创作目标，进入各自独立的画布。</p></div>
          <strong><b>{projects.length}</b> 个项目{loading && projects.length > 0 ? <em role="status">正在更新…</em> : null}</strong>
        </header>
        {loadError ? <section className="project-library-state project-library-state--error" role="alert">
          <div><strong>项目列表暂时无法加载</strong><span>{loadError}</span></div>
          <button type="button" onClick={onRetry} disabled={loading}>重试</button>
        </section> : null}
        {loading && projects.length === 0 ? <div className="project-library-page__grid project-library-page__grid--loading" role="status" aria-label="正在加载项目">
          {[0, 1, 2].map((index) => <div className="project-card project-card--skeleton" key={index} />)}
        </div> : <div className="project-library-page__grid">
          <button type="button" className="project-card project-card--new" onClick={() => void createProject()} disabled={creating}>
            <i>＋</i><strong>新建项目</strong><span>从空白画布开始</span>
          </button>
          {projects.map((project) => (
            <article
              className="project-card"
              key={project.id}
            >
              <button type="button" className="project-card__cover-open" onClick={() => onOpenProject(project.id)} aria-label={`打开项目 ${project.name}`}>
                {project.cover
                  ? <img src={project.cover} alt="" loading="lazy" decoding="async" />
                  : <span className="project-card__cover-placeholder" aria-hidden="true"><span>尚未生成封面</span></span>}
              </button>
              <button type="button" className="project-card__open" onClick={() => onOpenProject(project.id)} aria-label={`打开项目 ${project.name}`}>
                <strong>{project.name}</strong><span>{projectUpdatedLabel(project.updatedAt)}</span><small>{project.summary}</small>
              </button>
              <button type="button" className="project-card__menu" onClick={() => setEditingProject(project)} aria-label={`重命名 ${project.name}`} title="重命名项目"><MoreIcon /></button>
              <button type="button" className="project-card__delete" onClick={() => setDeletingProject(project)} aria-label={`删除 ${project.name}`} title="删除项目"><DeleteIcon /></button>
            </article>
          ))}
        </div>}
        {operationError && !editingProject && !deletingProject ? <p className="project-library-operation-error" role="alert">{operationError}</p> : null}
      </section>
      {editingPresence.present && visibleEditingProject ? <div className={`project-dialog-backdrop motion-overlay is-${editingPresence.phase}`} role="presentation" aria-hidden={editingPresence.phase === 'exit' ? true : undefined} onMouseDown={() => !submitting && setEditingProject(null)}>
        <form ref={(element) => { projectDialogRef.current = element }} className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-project-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitRename() }}>
          <span className="workspace-eyebrow">PROJECT SETTINGS</span><h2 id="rename-project-title">重命名项目</h2>
          <input autoFocus value={projectName} maxLength={60} onChange={(event) => setProjectName(event.target.value)} aria-label="项目名称" />
          {operationError ? <p className="project-dialog__error" role="alert">{operationError}</p> : null}
          <div><button type="button" onClick={() => setEditingProject(null)} disabled={submitting}>取消</button><button type="submit" className="is-primary" disabled={submitting || !projectName.trim()}>保存</button></div>
        </form>
      </div> : null}
      {deletingPresence.present && visibleDeletingProject ? <div className={`project-dialog-backdrop motion-overlay is-${deletingPresence.phase}`} role="presentation" aria-hidden={deletingPresence.phase === 'exit' ? true : undefined} onMouseDown={() => !submitting && setDeletingProject(null)}>
        <section ref={projectDialogRef} className="project-dialog project-dialog--danger" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title" onMouseDown={(event) => event.stopPropagation()}>
          <span className="workspace-eyebrow">DELETE PROJECT</span><h2 id="delete-project-title">删除「{visibleDeletingProject.name}」？</h2>
          <p>项目画布、生成结果和项目私有素材会被永久删除，无法恢复。</p>
          {operationError ? <p className="project-dialog__error" role="alert">{operationError}</p> : null}
          <div><button type="button" onClick={() => setDeletingProject(null)} disabled={submitting}>取消</button><button type="button" className="is-danger" onClick={() => void confirmDelete()} disabled={submitting}>确认删除</button></div>
        </section>
      </div> : null}
      {accountMenuPresence.present && visibleAccountMenuAnchor ? <AccountMenu
        user={currentUser}
        anchor={visibleAccountMenuAnchor}
        phase={accountMenuPresence.phase}
        onOpenProfile={() => { setAccountMenuAnchor(null); if (currentUser) setAccountDialog('profile') }}
        onOpenSecurity={() => { setAccountMenuAnchor(null); if (currentUser && onChangePassword) setAccountDialog('security') }}
        onOpenMembers={() => { setAccountMenuAnchor(null); setAccountDialog('members') }}
        onOpenAudit={() => { setAccountMenuAnchor(null); setAccountDialog('audit') }}
        onSignOut={onSignOut}
        onClose={() => setAccountMenuAnchor(null)}
      /> : null}
      {currentUser && onChangePassword && onReadMfaStatus && onEnrollMfa && onVerifyMfa && onRemoveMfa && onSignOutOtherSessions && accountDialogPresence.present && (visibleAccountDialog === 'profile' || visibleAccountDialog === 'security') ? <AccountDetailsDialog mode={visibleAccountDialog} user={currentUser} phase={accountDialogPresence.phase} returnFocusTarget={null} onChangePassword={onChangePassword} onReadMfaStatus={onReadMfaStatus} onEnrollMfa={onEnrollMfa} onVerifyMfa={onVerifyMfa} onRemoveMfa={onRemoveMfa} onSignOutOtherSessions={onSignOutOtherSessions} onModeChange={setAccountDialog} onClose={returnToAccountMenu} /> : null}
      {accountDialogPresence.present && visibleAccountDialog === 'members' && currentUser?.role === 'owner' && onListMembers && onInviteMember && onResendInvite && onUpdateMember ? <WorkspaceMembersDialog currentUser={currentUser} phase={accountDialogPresence.phase} returnFocusTarget={null} onListMembers={onListMembers} onInviteMember={onInviteMember} onResendInvite={onResendInvite} onUpdateMember={onUpdateMember} onClose={returnToAccountMenu} /> : null}
      {accountDialogPresence.present && visibleAccountDialog === 'audit' && currentUser?.role === 'owner' && onListAuditEvents && onListMembers ? <WorkspaceAuditDialog phase={accountDialogPresence.phase} returnFocusTarget={null} onListEvents={onListAuditEvents} onListMembers={onListMembers} onClose={returnToAccountMenu} /> : null}
    </main>
  )
}
