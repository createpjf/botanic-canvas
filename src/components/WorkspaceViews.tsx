import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import type { WorkspaceAuditEvent } from '../domain/auditEvents'
import { formatProductNumber, formatProductRelativeTime, type LocalizedText, type ProductLocale } from '../i18n/core'
import { useProductI18n, useProductMessages } from '../i18n/react'
import { AccountDetailsDialog, AccountMenu, WorkspaceAuditDialog, WorkspaceMembersDialog, type AccountMenuAnchor, type AccountMfaEnrollment, type AccountMfaStatus, type AccountUser, type WorkspaceMember as AccountWorkspaceMember } from './AccountCenter'
import { DeleteIcon, MoreIcon } from './BotanicIcons'
import { useMotionPresence, useRestoreFocus, useRetainedValue } from './motionPresence'
import { useDialogFocusTrap } from './useDialogFocusTrap'

export type WorkspaceProject = {
  id: string
  name: string
  updatedAt: number
  cover?: string
  summary: string
  summaryByLocale?: LocalizedText
  isSeed?: boolean
}

export type WorkspaceCurrentUser = AccountUser
export type WorkspaceMember = AccountWorkspaceMember

const projectLibraryMessages = {
  'zh-CN': {
    pageAria: '创意项目', studio: '创意工作室', productHome: '产品首页', productNav: '产品页面', statusNav: '状态', openAccount: '打开账户设置', localWorkspace: '本地工作区',
    title: '创意项目', eyebrow: '创意项目', description: '从不同的商品与创作目标，进入各自独立的画布。', updating: '正在更新…',
    loadTitle: '项目列表暂时无法加载', loadError: '请检查网络或稍后重试。', retry: '重试', loadingAria: '正在加载项目',
    newProject: '新建项目', newProjectDescription: '从空白画布开始', noCover: '尚未生成封面',
    renameTitle: '重命名项目', settingsEyebrow: '项目设置', projectName: '项目名称', cancel: '取消', save: '保存', deleteTitle: '删除项目', deleteEyebrow: '删除项目',
    deleteDescription: '项目画布、生成结果和项目私有素材会被永久删除，无法恢复。', confirmDelete: '确认删除',
    renameError: '项目名称未保存，请检查网络后重试。', deleteError: '删除未完成，请稍后重试。', createError: '新建项目失败，请检查网络后重试。',
    count: (count: number) => `${formatProductNumber(count, 'zh-CN')} 个项目`,
    open: (name: string) => `打开项目 ${name}`, rename: (name: string) => `重命名 ${name}`, delete: (name: string) => `删除 ${name}`,
    deleteQuestion: (name: string) => `删除「${name}」？`, lastEdited: (relative: string) => `最近编辑 · ${relative}`, justNow: '刚刚',
  },
  en: {
    pageAria: 'Creative projects', studio: 'Creative studio', productHome: 'Product home', productNav: 'Product pages', statusNav: 'Status', openAccount: 'Open account settings', localWorkspace: 'Local workspace',
    title: 'Creative projects', eyebrow: 'Projects', description: 'One canvas per product and brief.', updating: 'Updating…',
    loadTitle: 'Projects are temporarily unavailable', loadError: 'Check your connection and try again.', retry: 'Try again', loadingAria: 'Loading projects',
    newProject: 'New project', newProjectDescription: 'Blank canvas', noCover: 'No cover yet',
    renameTitle: 'Rename project', settingsEyebrow: 'Settings', projectName: 'Project name', cancel: 'Cancel', save: 'Save', deleteTitle: 'Delete project', deleteEyebrow: 'Delete',
    deleteDescription: 'The project canvas, generated outputs, and private project assets will be permanently deleted.', confirmDelete: 'Delete project',
    renameError: 'The project name was not saved. Check your connection and try again.', deleteError: 'The project could not be deleted. Try again shortly.', createError: 'The project could not be created. Check your connection and try again.',
    count: (count: number) => `${formatProductNumber(count, 'en')} ${count === 1 ? 'project' : 'projects'}`,
    open: (name: string) => `Open project ${name}`, rename: (name: string) => `Rename ${name}`, delete: (name: string) => `Delete ${name}`,
    deleteQuestion: (name: string) => `Delete “${name}”?`, lastEdited: (relative: string) => `Last edited · ${relative}`, justNow: 'just now',
  },
} as const

function goProductHome(event: MouseEvent<HTMLAnchorElement>, goHome: () => void) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
  event.preventDefault()
  goHome()
}

function projectUpdatedLabel(updatedAt: number, locale: ProductLocale, copy: (typeof projectLibraryMessages)[ProductLocale]) {
  const elapsed = Math.max(0, Date.now() - updatedAt)
  const hours = Math.floor(elapsed / 3_600_000)
  if (hours < 1) return copy.lastEdited(copy.justNow)
  if (hours < 24) return copy.lastEdited(formatProductRelativeTime(-hours, 'hour', locale))
  return copy.lastEdited(formatProductRelativeTime(-Math.floor(hours / 24), 'day', locale))
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
  const { locale } = useProductI18n()
  const copy = useProductMessages(projectLibraryMessages)
  const homeLabel = locale === 'en' ? copy.productHome : productHomeLabel || copy.productHome
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
    const target = editingProject
    const nextName = projectName.trim()
    setSubmitting(true)
    setOperationError('')
    // 与删除一致：先关对话框，卡片名由协调器乐观更新，不让 PATCH 阻塞项目页。
    setEditingProject(null)
    try {
      if (!await onRenameProject(target.id, nextName)) setOperationError(copy.renameError)
    } catch {
      setOperationError(copy.renameError)
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
      setOperationError(copy.deleteError)
    } finally {
      setSubmitting(false)
    }
  }

  const createProject = async () => {
    if (creating) return
    setCreating(true)
    setOperationError('')
    try {
      if (!await onCreateProject()) setOperationError(copy.createError)
    } catch {
      setOperationError(copy.createError)
    } finally {
      setCreating(false)
    }
  }

  return (
    <main className="project-library-page" aria-label={copy.pageAria} lang={locale}>
      <header className="project-library-page__header">
        <a className="project-library-page__brand" href="/" aria-label={`Botanic ${homeLabel}`} onClick={(event) => goProductHome(event, onReturnToLanding)}>
          <strong>Botanic</strong>
          <span>{copy.studio}</span>
        </a>
        <nav className="project-library-page__nav" aria-label={copy.productNav}>
          <a href="/" onClick={(event) => goProductHome(event, onReturnToLanding)}>{homeLabel}</a>
          <a href="/status">{copy.statusNav}</a>
        </nav>
        <div className="project-library-page__account-actions">
          <button
            ref={accountTriggerRef}
            type="button"
            className="project-library-page__account"
            aria-label={copy.openAccount}
            data-account-menu-trigger
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
          </button>
        </div>
      </header>
      <section className="project-library-page__content">
        <header>
          <div><span className="workspace-eyebrow"><i />{copy.eyebrow}</span><h1>{copy.title}</h1><p>{copy.description}</p></div>
          <strong><b>{formatProductNumber(projects.length, locale)}</b> {copy.count(projects.length).replace(/^\S+\s*/, '')}{loading && projects.length > 0 ? <em role="status">{copy.updating}</em> : null}</strong>
        </header>
        {loadError ? <section className="project-library-state project-library-state--error" role="alert">
          <div><strong>{copy.loadTitle}</strong><span>{locale === 'zh-CN' ? loadError : copy.loadError}</span></div>
          <button type="button" onClick={onRetry} disabled={loading}>{copy.retry}</button>
        </section> : null}
        {loading && projects.length === 0 ? <div className="project-library-page__grid project-library-page__grid--loading" role="status" aria-label={copy.loadingAria}>
          {[0, 1, 2].map((index) => <div className="project-card project-card--skeleton" key={index} />)}
        </div> : <div className="project-library-page__grid">
          <button type="button" className="project-card project-card--new" onClick={() => void createProject()} disabled={creating}>
            <i>＋</i><strong>{copy.newProject}</strong><span>{copy.newProjectDescription}</span>
          </button>
          {projects.map((project) => (
            <article
              className="project-card"
              key={project.id}
            >
              <button type="button" className="project-card__cover-open" onClick={() => onOpenProject(project.id)} aria-label={copy.open(project.name)}>
                {project.cover
                  ? <img src={project.cover} alt="" loading="lazy" decoding="async" />
                  : <span className="project-card__cover-placeholder" aria-hidden="true"><span>{copy.noCover}</span></span>}
              </button>
              <button type="button" className="project-card__open" onClick={() => onOpenProject(project.id)} aria-label={copy.open(project.name)}>
                <strong>{project.name}</strong><span>{projectUpdatedLabel(project.updatedAt, locale, copy)}</span><small>{project.summaryByLocale?.[locale] ?? project.summary}</small>
              </button>
              <button type="button" className="project-card__menu" onClick={() => setEditingProject(project)} aria-label={copy.rename(project.name)} title={copy.renameTitle}><MoreIcon /></button>
              <button type="button" className="project-card__delete" onClick={() => setDeletingProject(project)} aria-label={copy.delete(project.name)} title={copy.deleteTitle}><DeleteIcon /></button>
            </article>
          ))}
        </div>}
        {operationError && !editingProject && !deletingProject ? <p className="project-library-operation-error" role="alert">{operationError}</p> : null}
      </section>
      {editingPresence.present && visibleEditingProject ? <div className={`project-dialog-backdrop motion-overlay is-${editingPresence.phase}`} role="presentation" aria-hidden={editingPresence.phase === 'exit' ? true : undefined} onMouseDown={() => !submitting && setEditingProject(null)}>
        <form ref={(element) => { projectDialogRef.current = element }} className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-project-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitRename() }}>
          <span className="workspace-eyebrow">{copy.settingsEyebrow}</span><h2 id="rename-project-title">{copy.renameTitle}</h2>
          <input autoFocus value={projectName} maxLength={60} onChange={(event) => setProjectName(event.target.value)} aria-label={copy.projectName} />
          {operationError ? <p className="project-dialog__error" role="alert">{operationError}</p> : null}
          <div><button type="button" onClick={() => setEditingProject(null)} disabled={submitting}>{copy.cancel}</button><button type="submit" className="is-primary" disabled={submitting || !projectName.trim()}>{copy.save}</button></div>
        </form>
      </div> : null}
      {deletingPresence.present && visibleDeletingProject ? <div className={`project-dialog-backdrop motion-overlay is-${deletingPresence.phase}`} role="presentation" aria-hidden={deletingPresence.phase === 'exit' ? true : undefined} onMouseDown={() => !submitting && setDeletingProject(null)}>
        <section ref={projectDialogRef} className="project-dialog project-dialog--danger" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title" onMouseDown={(event) => event.stopPropagation()}>
          <span className="workspace-eyebrow">{copy.deleteEyebrow}</span><h2 id="delete-project-title">{copy.deleteQuestion(visibleDeletingProject.name)}</h2>
          <p>{copy.deleteDescription}</p>
          {operationError ? <p className="project-dialog__error" role="alert">{operationError}</p> : null}
          <div><button type="button" onClick={() => setDeletingProject(null)} disabled={submitting}>{copy.cancel}</button><button type="button" className="is-danger" onClick={() => void confirmDelete()} disabled={submitting}>{copy.confirmDelete}</button></div>
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
