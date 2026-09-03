import { useEffect, useState } from 'react'
import type { BotanicAgentSkill } from '../../domain/agent'
import { createProjectAgentSkillDraft, executeProjectAgentSkillLifecycleAction, listProjectAgentSkills, preflightProjectAgentSkill, submitProjectAgentSkillReview, updateProjectAgentSkillDraft, type AgentSkillPreflight, type AgentSkillLifecycleAction } from '../../lib/agentSkillApi'
import { localizeProductError } from '../../i18n/core'
import { useProductI18n } from '../../i18n/react'

const labels = {
  'zh-CN': { title: '项目治理', description: '草稿通过检查与审核后才能发布。已发布版本才可挂载。', create: '新建草稿', name: '名称', rules: '规则', save: '保存草稿', cancel: '取消', preflight: '运行检查', review: '提交审核', publish: '发布', deprecate: '弃用', restore: '恢复为新草稿', confirmPublish: '确认发布', confirmDeprecate: '确认弃用', confirmRestore: '确认恢复', edit: '编辑', draft: '草稿', reviewState: '审核中', published: '已发布', deprecated: '已弃用', history: '版本历史', confirm: '再次确认', working: '处理中…', empty: '还没有项目 Skill。', passed: '检查通过', failed: '检查未通过', loadError: '无法加载项目 Skill。', actionError: 'Skill 操作失败。' },
  en: { title: 'Project governance', description: 'Drafts must pass preflight and review before publishing. Only published versions can be mounted.', create: 'New draft', name: 'Name', rules: 'Rules', save: 'Save draft', cancel: 'Cancel', preflight: 'Run preflight', review: 'Submit for review', publish: 'Publish', deprecate: 'Deprecate', restore: 'Restore as new draft', confirmPublish: 'Confirm publish', confirmDeprecate: 'Confirm deprecation', confirmRestore: 'Confirm restore', edit: 'Edit', draft: 'Draft', reviewState: 'In review', published: 'Published', deprecated: 'Deprecated', history: 'Version history', confirm: 'Confirm again', working: 'Working…', empty: 'No project Skills yet.', passed: 'Preflight passed', failed: 'Preflight failed', loadError: 'Unable to load project Skills.', actionError: 'Unable to update the Skill.' },
}

type Pending = { name: AgentSkillLifecycleAction; skill: BotanicAgentSkill; version?: number }
export function AgentSkillManagement({ projectId, enabled, startCreating, onCreatingHandled, onChanged }: { projectId: string; enabled: boolean; startCreating: boolean; onCreatingHandled: () => void; onChanged: (skill: BotanicAgentSkill) => void }) {
  const { locale } = useProductI18n(), copy = labels[locale]
  const [skills, setSkills] = useState<BotanicAgentSkill[]>([]), [editing, setEditing] = useState<BotanicAgentSkill | null>(null)
  const [draft, setDraft] = useState({ name: '', instructions: '' }), [preflights, setPreflights] = useState<Record<string, AgentSkillPreflight>>({})
  const [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(''), [error, setError] = useState('')
  // 切项目或卸载后到达的旧响应不得覆盖当前列表，否则后续行动会打到别的项目的 Skill 上。
  useEffect(() => {
    if (!enabled) return
    let active = true
    void (async () => {
      try {
        const items = await listProjectAgentSkills(projectId, { includeAll: true })
        if (!active) return
        setSkills(items); setError('')
      } catch (caught) {
        if (active) setError(localizeProductError(caught, locale, { 'zh-CN': copy.loadError, en: copy.loadError }))
      }
    })()
    return () => { active = false }
  }, [copy.loadError, enabled, locale, projectId])
  useEffect(() => { if (!startCreating) return; setEditing({ id: '', projectId, name: '', instructions: '', status: 'archived', lifecycle: 'draft', createdAt: 0, updatedAt: 0 } as BotanicAgentSkill); setDraft({ name: '', instructions: '' }); setPending(null); onCreatingHandled() }, [onCreatingHandled, projectId, startCreating])
  const replace = (skill: BotanicAgentSkill) => { setSkills((items) => [skill, ...items.filter((item) => item.id !== skill.id)]); setPreflights((items) => { const next = { ...items }; delete next[skill.id]; return next }); onChanged(skill) }
  const perform = async (key: string, task: () => Promise<BotanicAgentSkill>) => { setBusy(key); setError(''); try { const skill = await task(); replace(skill); setEditing(null); setDraft({ name: '', instructions: '' }); setPending(null) } catch (caught) { setError(localizeProductError(caught, locale, { 'zh-CN': copy.actionError, en: copy.actionError })) } finally { setBusy('') } }
  const edit = (skill?: BotanicAgentSkill) => { setEditing(skill ?? ({ id: '', projectId, name: '', instructions: '', status: 'archived', lifecycle: 'draft', createdAt: 0, updatedAt: 0 } as BotanicAgentSkill)); setDraft({ name: skill?.name ?? '', instructions: skill?.instructions ?? '' }); setPending(null) }
  const runPreflight = async (skill: BotanicAgentSkill) => { setBusy('check' + skill.id); try { const result = await preflightProjectAgentSkill(projectId, skill.id); setPreflights((items) => ({ ...items, [skill.id]: result })) } catch (caught) { setError(localizeProductError(caught, locale, { 'zh-CN': copy.actionError, en: copy.actionError })) } finally { setBusy('') } }
  const action = async (value: Pending) => { if (pending?.name !== value.name || pending.skill.id !== value.skill.id || pending.version !== value.version) { setPending(value); return } await perform(value.name + value.skill.id, () => executeProjectAgentSkillLifecycleAction(projectId, value.skill, value.name, value.version)) }
  if (!enabled) return null
  return <section className="agent-skill-management" aria-labelledby="skill-management-title">
    <header><span><strong id="skill-management-title">{copy.title}</strong><small>{copy.description}</small></span><button type="button" onClick={() => edit()}>{copy.create}</button></header>
    {editing ? <form onSubmit={(event) => { event.preventDefault(); void perform('save', () => editing.id ? updateProjectAgentSkillDraft(projectId, editing, draft) : createProjectAgentSkillDraft(projectId, draft)) }}>
      <label><span>{copy.name}</span><input required maxLength={80} value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} /></label>
      <label><span>{copy.rules}</span><textarea required maxLength={4000} value={draft.instructions} onChange={(event) => setDraft((value) => ({ ...value, instructions: event.target.value }))} /></label>
      <div><button type="button" onClick={() => setEditing(null)}>{copy.cancel}</button><button type="submit" disabled={Boolean(busy)}>{busy === 'save' ? copy.working : copy.save}</button></div>
    </form> : null}
    <div className="agent-skill-management__list">{skills.map((skill) => { const lifecycle = skill.lifecycle ?? (skill.status === 'active' ? 'published' : 'deprecated'), preflight = preflights[skill.id]; return <article key={skill.id}>
      <header><span><strong>{skill.name}</strong><small>{copy[lifecycle === 'review' ? 'reviewState' : lifecycle]} · v{skill.version ?? 1}</small></span>{lifecycle !== 'deprecated' ? <button type="button" onClick={() => edit(skill)}>{copy.edit}</button> : null}</header>
      <p>{skill.instructions}</p>
      {preflight ? <p role="status" className={preflight.ok ? 'is-success' : 'is-warning'}>{preflight.ok ? copy.passed : copy.failed}{preflight.issues.length ? ' · ' + preflight.issues.map((issue) => issue.code).join(', ') : ''}</p> : null}
      <div className="agent-skill-management__actions">
        {lifecycle === 'draft' ? <><button type="button" onClick={() => void runPreflight(skill)}>{busy === 'check' + skill.id ? copy.working : copy.preflight}</button><button type="button" disabled={!preflight?.ok || Boolean(busy)} onClick={() => void perform('review' + skill.id, () => submitProjectAgentSkillReview(projectId, skill))}>{copy.review}</button></> : null}
        {lifecycle === 'review' ? <button type="button" onClick={() => void action({ name: 'skill_publish', skill })}>{pending?.name === 'skill_publish' && pending.skill.id === skill.id ? copy.confirmPublish : copy.publish}</button> : null}
        {lifecycle === 'published' ? <button type="button" onClick={() => void action({ name: 'skill_deprecate', skill })}>{pending?.name === 'skill_deprecate' && pending.skill.id === skill.id ? copy.confirmDeprecate : copy.deprecate}</button> : null}
      </div>
      {skill.versions?.some((version) => version.version < (skill.version ?? 1)) ? <details><summary>{copy.history} · {skill.versions?.length}</summary>{skill.versions?.filter((version) => version.version < (skill.version ?? 1)).map((version) => <div key={version.version}><span>v{version.version}</span><button type="button" onClick={() => void action({ name: 'skill_restore', skill, version: version.version })}>{pending?.name === 'skill_restore' && pending.skill.id === skill.id && pending.version === version.version ? copy.confirmRestore : copy.restore}</button></div>)}</details> : null}
    </article> })}{!skills.length ? <p className="agent-panel__empty">{copy.empty}</p> : null}</div>
    {error ? <p role="alert" className="agent-skill-management__error">{error}</p> : null}
  </section>
}
