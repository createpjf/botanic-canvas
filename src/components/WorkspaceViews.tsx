export type WorkspaceProject = {
  id: string
  name: string
  updatedAt: number
  cover: string
  summary: string
  isSeed?: boolean
}

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
          <i>↗</i>
        </button>
      </section>
    </main>
  )
}

export function ProjectLibrary({
  projects,
  onBack,
  onOpenProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
}: {
  projects: WorkspaceProject[]
  onBack: () => void
  onOpenProject: (projectId: string) => void
  onCreateProject: () => void
  onRenameProject: (projectId: string, name: string) => Promise<boolean>
  onDeleteProject: (projectId: string) => Promise<void>
}) {
  const [editingProject, setEditingProject] = useState<WorkspaceProject | null>(null)
  const [projectName, setProjectName] = useState('')
  const [deletingProject, setDeletingProject] = useState<WorkspaceProject | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setProjectName(editingProject?.name ?? '')
  }, [editingProject])

  const submitRename = async () => {
    if (!editingProject || !projectName.trim()) return
    setSubmitting(true)
    try {
      const renamed = await onRenameProject(editingProject.id, projectName)
      if (renamed) setEditingProject(null)
    } finally {
      setSubmitting(false)
    }
  }

  const confirmDelete = async () => {
    if (!deletingProject) return
    setSubmitting(true)
    try {
      await onDeleteProject(deletingProject.id)
      setDeletingProject(null)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="project-library-page" aria-label="创意项目">
      <header className="project-library-page__header">
        <button type="button" className="project-library-page__brand" onClick={onBack}><strong>Botanic</strong><span>创意工作室</span></button>
        <button type="button" className="project-library-page__back" onClick={onBack}>← 返回经营驾驶舱</button>
      </header>
      <section className="project-library-page__content">
        <header>
          <div><span className="workspace-eyebrow"><i />CREATIVE PROJECTS</span><h1>创意项目</h1><p>从不同的商品与创作目标，进入各自独立的画布。</p></div>
          <strong><b>{projects.length}</b> 个项目</strong>
        </header>
        <div className="project-library-page__grid">
          <button type="button" className="project-card project-card--new" onClick={onCreateProject}>
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
              <img src={project.cover} alt="" />
              <button type="button" className="project-card__open" onClick={() => onOpenProject(project.id)} aria-label={`打开项目 ${project.name}`}>
                <strong>{project.name}</strong><span>{projectUpdatedLabel(project.updatedAt)}</span><small>{project.summary}</small>
              </button>
              <button type="button" className="project-card__menu" onClick={() => setEditingProject(project)} aria-label={`重命名 ${project.name}`} title="重命名项目">⋯</button>
              <button type="button" className="project-card__delete" onClick={() => setDeletingProject(project)} aria-label={`删除 ${project.name}`} title="删除项目">⌫</button>
            </article>
          ))}
        </div>
      </section>
      {editingProject ? <div className="project-dialog-backdrop" role="presentation" onMouseDown={() => !submitting && setEditingProject(null)}>
        <form className="project-dialog" aria-labelledby="rename-project-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitRename() }}>
          <span className="workspace-eyebrow">PROJECT SETTINGS</span><h2 id="rename-project-title">重命名项目</h2>
          <input autoFocus value={projectName} maxLength={60} onChange={(event) => setProjectName(event.target.value)} aria-label="项目名称" />
          <div><button type="button" onClick={() => setEditingProject(null)} disabled={submitting}>取消</button><button type="submit" className="is-primary" disabled={submitting || !projectName.trim()}>保存</button></div>
        </form>
      </div> : null}
      {deletingProject ? <div className="project-dialog-backdrop" role="presentation" onMouseDown={() => !submitting && setDeletingProject(null)}>
        <section className="project-dialog project-dialog--danger" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title" onMouseDown={(event) => event.stopPropagation()}>
          <span className="workspace-eyebrow">DELETE PROJECT</span><h2 id="delete-project-title">删除「{deletingProject.name}」？</h2>
          <p>项目画布、生成结果和项目私有素材会被永久删除，无法恢复。</p>
          <div><button type="button" onClick={() => setDeletingProject(null)} disabled={submitting}>取消</button><button type="button" className="is-danger" onClick={() => void confirmDelete()} disabled={submitting}>确认删除</button></div>
        </section>
      </div> : null}
    </main>
  )
}
import { useEffect, useState } from 'react'
