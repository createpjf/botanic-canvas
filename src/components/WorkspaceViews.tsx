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

export function OperatingDashboard({ onOpenProjects }: { onOpenProjects: () => void }) {
  const decisions = [
    ['01', '夏日香氛系列：是否进入有限放量', '转化率 4.8%，贡献利润率 28.4%；可售库存支持 9 天，建议锁定 1,200 件。', '待批准', 'is-ready'],
    ['02', '无花果之影：补货与活动承接', '库存覆盖 6.8 天，在途 800 件；周末内容投放预计新增 340 单。', '需要判断', 'is-watch'],
    ['03', '旧季礼盒：确定清货路由', '库龄 112 天，建议优先达人高佣 20% 与店内会员专享组合。', '待复盘', 'is-muted'],
  ] as const

  return (
    <main className="workspace-shell operating-dashboard" aria-label="经营驾驶舱">
      <aside className="workspace-sidebar">
        <div className="workspace-brand">Botanic</div>
        <nav className="workspace-sidebar__nav" aria-label="经营模块">
          <button type="button">资料库</button>
          <button type="button">定时任务</button>
          <span>经营工作台</span>
          <button type="button" className="is-active"><i />CEO 经营决策<small>CEO</small></button>
          <span>专业 AGENT</span>
          <button type="button"><i />商品企划</button>
          <button type="button" onClick={onOpenProjects}><i />创意生成</button>
          <button type="button"><i />增长经营</button>
          <button type="button"><i />财务经营</button>
          <button type="button"><i />供应链管理</button>
        </nav>
        <div className="workspace-sidebar__spacer" />
        <section className="workspace-invite">
          <strong>邀请协作者</strong>
          <small>一起核实和确认决策</small>
        </section>
        <div className="workspace-account"><b>L</b><strong>LEO · CEO</strong></div>
      </aside>

      <section className="operating-dashboard__content">
        <header className="operating-dashboard__header">
          <div>
            <span className="workspace-eyebrow"><i />CEO OPERATING VIEW</span>
            <h1>经营驾驶舱</h1>
            <p>周四 · 经营例会 · 18:30</p>
          </div>
          <button type="button" className="workspace-secondary-button">↻ 刷新数据</button>
        </header>

        <section className="dashboard-kpis" aria-label="核心经营指标">
          <article className="is-primary"><span>今日支付额</span><strong>¥126,400</strong><small>较昨日 +18.6% · 淘宝 ¥98,720</small></article>
          <article><span>退款率</span><strong>7.2%</strong><small>较上周 -1.4pp · 退款金额 ¥9,101</small></article>
          <article><span>有效库存覆盖</span><strong>12.4 天</strong><small>低于 15 天目标 · 2 款需补货</small></article>
          <article><span>款式贡献利润</span><strong>¥31,860</strong><small>贡献利润率 25.2% · 较昨日 +3.8pp</small></article>
        </section>

        <section className="dashboard-grid">
          <article className="dashboard-card dashboard-decisions">
            <header><div><h2>CEO 待决事项</h2><p>按「能否放量、是否赚钱、是否供得上」排序</p></div><button type="button">生成审批包 →</button></header>
            <ol>
              {decisions.map(([number, title, detail, state, tone]) => (
                <li key={number}>
                  <b>{number}</b>
                  <div><strong>{title}</strong><p>{detail}</p></div>
                  <span className={tone}>{state}</span>
                </li>
              ))}
            </ol>
          </article>
          <article className="dashboard-card dashboard-pulse">
            <header><div><h2>经营脉搏</h2><p>支付、退款、投放与库存的日内观察</p></div><time>18:30</time></header>
            <strong>+18.6%</strong>
            <svg viewBox="0 0 386 120" role="img" aria-label="经营走势上升图">
              <defs><linearGradient id="pulse-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#80a989" stopOpacity=".28" /><stop offset="100%" stopColor="#80a989" stopOpacity="0" /></linearGradient></defs>
              <path d="M0 104 C34 95 39 80 76 84 S123 54 151 64 S203 75 231 42 S280 58 306 30 S347 41 386 8 V120 H0 Z" fill="url(#pulse-fill)" />
              <path d="M0 104 C34 95 39 80 76 84 S123 54 151 64 S203 75 231 42 S280 58 306 30 S347 41 386 8" fill="none" stroke="#3d7550" strokeWidth="3" />
            </svg>
            <div className="dashboard-pulse__channel"><i />淘宝 <span>GMV ¥98,720 · ROI 3.42</span></div>
            <div className="dashboard-pulse__channel"><i />小红书 <span>内容种草 24 篇 · 归因订单 186</span></div>
          </article>
        </section>

        <button type="button" className="dashboard-composer" onClick={onOpenProjects}>
          <span>尽管问，或描述一个经营任务…</span>
          <small>📎 可拖入图片、文档</small>
          <b>经营 Main</b>
          <i><ArrowUpRightIcon /></i>
        </button>
      </section>
    </main>
  )
}

export function ProjectLibrary({
  projects,
  currentUser,
  loading,
  loadError,
  onBack,
  onSignOut,
  onChangePassword,
  onReadMfaStatus,
  onEnrollMfa,
  onVerifyMfa,
  onRemoveMfa,
  onSignOutOtherSessions,
  onListMembers,
  onListAuditEvents,
  onInviteMember,
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
  onBack: () => void
  onSignOut?: () => Promise<void>
  onChangePassword?: (password: string) => Promise<void>
  onReadMfaStatus?: () => Promise<AccountMfaStatus>
  onEnrollMfa?: () => Promise<AccountMfaEnrollment>
  onVerifyMfa?: (factorId: string, code: string) => Promise<void>
  onRemoveMfa?: (factorId: string) => Promise<void>
  onSignOutOtherSessions?: () => Promise<void>
  onListMembers?: () => Promise<WorkspaceMember[]>
  onListAuditEvents?: () => Promise<WorkspaceAuditEvent[]>
  onInviteMember?: (input: { email: string; name?: string; role: 'owner' | 'member' }) => Promise<WorkspaceMember>
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

  useEffect(() => {
    setProjectName(editingProject?.name ?? '')
  }, [editingProject])

  useEffect(() => {
    if (!editingProject && !deletingProject) return
    const closeDialog = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || submitting) return
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
        <button type="button" className="project-library-page__brand" onClick={onBack}><strong>Botanic</strong><span>创意工作室</span></button>
        <div className="project-library-page__account-actions">
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
          <button type="button" className="project-library-page__back" onClick={onBack}>← 返回经营驾驶舱</button>
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
              onClick={(event) => {
                // 封面也是项目入口；卡片内的重命名、删除保留各自的按钮行为。
                if ((event.target as HTMLElement).closest('button')) return
                onOpenProject(project.id)
              }}
            >
              {project.cover
                ? <img src={project.cover} alt="" loading="lazy" decoding="async" />
                : <div className="project-card__cover-placeholder" aria-hidden="true"><span>尚未生成封面</span></div>}
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
        <form className="project-dialog" aria-labelledby="rename-project-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitRename() }}>
          <span className="workspace-eyebrow">PROJECT SETTINGS</span><h2 id="rename-project-title">重命名项目</h2>
          <input autoFocus value={projectName} maxLength={60} onChange={(event) => setProjectName(event.target.value)} aria-label="项目名称" />
          {operationError ? <p className="project-dialog__error" role="alert">{operationError}</p> : null}
          <div><button type="button" onClick={() => setEditingProject(null)} disabled={submitting}>取消</button><button type="submit" className="is-primary" disabled={submitting || !projectName.trim()}>保存</button></div>
        </form>
      </div> : null}
      {deletingPresence.present && visibleDeletingProject ? <div className={`project-dialog-backdrop motion-overlay is-${deletingPresence.phase}`} role="presentation" aria-hidden={deletingPresence.phase === 'exit' ? true : undefined} onMouseDown={() => !submitting && setDeletingProject(null)}>
        <section className="project-dialog project-dialog--danger" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title" onMouseDown={(event) => event.stopPropagation()}>
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
      {accountDialogPresence.present && visibleAccountDialog === 'members' && currentUser?.role === 'owner' && onListMembers && onInviteMember && onUpdateMember ? <WorkspaceMembersDialog currentUser={currentUser} phase={accountDialogPresence.phase} returnFocusTarget={null} onListMembers={onListMembers} onInviteMember={onInviteMember} onUpdateMember={onUpdateMember} onClose={returnToAccountMenu} /> : null}
      {accountDialogPresence.present && visibleAccountDialog === 'audit' && currentUser?.role === 'owner' && onListAuditEvents && onListMembers ? <WorkspaceAuditDialog phase={accountDialogPresence.phase} returnFocusTarget={null} onListEvents={onListAuditEvents} onListMembers={onListMembers} onClose={returnToAccountMenu} /> : null}
    </main>
  )
}
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRightIcon, DeleteIcon, MoreIcon } from './BotanicIcons'
import { AccountDetailsDialog, AccountMenu, WorkspaceAuditDialog, WorkspaceMembersDialog, type AccountMenuAnchor, type AccountMfaEnrollment, type AccountMfaStatus, type AccountUser, type WorkspaceMember as AccountWorkspaceMember } from './AccountCenter'
import type { WorkspaceAuditEvent } from '../domain/auditEvents'
import { useMotionPresence, useRestoreFocus, useRetainedValue } from './motionPresence'
