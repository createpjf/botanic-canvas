import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { BotanicAgentSkill, BotanicAgentSkillCatalogItem } from '../../domain/agent'
import { CloseIcon, PlusIcon, SearchIcon, SparkleIcon } from '../../components/BotanicIcons'
import { AgentSkillCard } from './AgentUtilityPanels'
import { BOTANIC_AGENT_MOUNTED_SKILL_LIMIT, type AgentSkillFormState } from './agentSkillForm'

export type AgentSkillSourceFilter = 'all' | 'system' | 'project'

type AgentSkillPanelItem = {
  id: string
  name: string
  instructions: string
  source: 'system' | 'project'
}

type AgentSkillPanelCopy = {
  skillsAria: string
  skillsDescription: string
  skillsUnavailableLocal: string
  availableSkills: string
  mountedSkills: (count: number) => string
  noMountedSkills: string
  skillSearch: string
  skillSourceFilter: string
  skillSourceAll: string
  skillSourceSystem: string
  skillSourceProject: string
  removeSkill: (name: string) => string
  noSkillMatches: string
  newSkill: string
  skillNamePlaceholder: string
  skillName: string
  skillRulesPlaceholder: string
  skillRules: string
  createProjectSkill: string
  createProjectSkillDetail: string
  creating: string
  confirmCreate: string
  createSkill: string
  cancel: string
  noProjectSkills: string
}

export function AgentSkillPanel({
  open,
  serverPersistenceEnabled,
  copy,
  systemSkills,
  skills,
  mountedSkillIds,
  expandedSkillId,
  form,
  nameInputRef,
  createButtonRef,
  onToggleExpanded,
  onToggleMounted,
  onEditName,
  onEditInstructions,
  onOpenForm,
  onCloseForm,
  onRequestConfirm,
  onCancelConfirm,
  onSubmit,
}: {
  open: boolean
  serverPersistenceEnabled: boolean
  copy: AgentSkillPanelCopy
  systemSkills: BotanicAgentSkillCatalogItem[]
  skills: BotanicAgentSkill[]
  mountedSkillIds?: readonly string[]
  expandedSkillId: string
  form: AgentSkillFormState
  nameInputRef: RefObject<HTMLInputElement | null>
  createButtonRef: RefObject<HTMLButtonElement | null>
  onToggleExpanded: (id: string) => void
  onToggleMounted: (id: string, mounted: boolean) => void
  onEditName: (value: string) => void
  onEditInstructions: (value: string) => void
  onOpenForm: () => void
  onCloseForm: () => void
  onRequestConfirm: () => void
  onCancelConfirm: () => void
  onSubmit: () => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<AgentSkillSourceFilter>('all')

  useEffect(() => {
    if (open) return
    setQuery('')
    setSourceFilter('all')
  }, [open])

  const catalogItems = useMemo<AgentSkillPanelItem[]>(() => [...systemSkills, ...skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    instructions: skill.instructions,
    source: 'project' as const,
  }))]
    .filter((skill, index, items) => items.findIndex((candidate) => candidate.id === skill.id) === index), [skills, systemSkills])
  const mountedIds = useMemo(() => new Set(mountedSkillIds ?? []), [mountedSkillIds])
  const mountedItems = useMemo(() => catalogItems.filter((skill) => mountedIds.has(skill.id)), [catalogItems, mountedIds])
  const skillLimitReached = mountedIds.size >= BOTANIC_AGENT_MOUNTED_SKILL_LIMIT
  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return catalogItems
      .filter((skill) => sourceFilter === 'all' || skill.source === sourceFilter)
      .filter((skill) => !normalizedQuery || [skill.name, skill.id, skill.instructions].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
      .sort((left, right) => Number(mountedIds.has(right.id)) - Number(mountedIds.has(left.id)))
  }, [catalogItems, mountedIds, query, sourceFilter])

  return <section className="agent-skill-panel" aria-label={copy.skillsAria}>
    <p>{copy.skillsDescription}</p>
    {!serverPersistenceEnabled ? <p className="agent-panel__empty agent-skill-panel__local-notice" role="status">{copy.skillsUnavailableLocal}</p> : null}
    {serverPersistenceEnabled ? <div className="agent-skill-panel__toolbar">
      <label className="agent-skill-panel__search">
        <SearchIcon />
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.skillSearch} aria-label={copy.skillSearch} />
      </label>
      <select className="agent-skill-panel__source-filter" value={sourceFilter} aria-label={copy.skillSourceFilter} onChange={(event) => setSourceFilter(event.target.value as AgentSkillSourceFilter)}>
        <option value="all">{copy.skillSourceAll}</option>
        <option value="system">{copy.skillSourceSystem}</option>
        <option value="project">{copy.skillSourceProject}</option>
      </select>
      {!form.open ? <button type="button" className="agent-skill-panel__create-entry" aria-expanded="false" onClick={onOpenForm}><PlusIcon />{copy.newSkill}</button> : null}
    </div> : null}
    {mountedItems.length ? <section className="agent-skill-panel__mounted" aria-label={copy.mountedSkills(mountedItems.length)}>
      <header><strong>{copy.mountedSkills(mountedItems.length)}</strong><span>{mountedItems.length}/{BOTANIC_AGENT_MOUNTED_SKILL_LIMIT}</span></header>
      <div className="agent-skill-panel__mounted-list">
        {mountedItems.map((skill) => <span key={skill.id} className="agent-skill-panel__mounted-chip">
          {skill.source === 'system' ? <SparkleIcon /> : null}
          <span>{skill.name}</span>
          <button type="button" aria-label={copy.removeSkill(skill.name)} title={copy.removeSkill(skill.name)} onClick={() => onToggleMounted(skill.id, false)}><CloseIcon /></button>
        </span>)}
      </div>
    </section> : <p className="agent-skill-panel__empty-mounted">{copy.noMountedSkills}</p>}
    {serverPersistenceEnabled && form.open ? <form className="agent-skill-panel__form" onSubmit={(event) => { event.preventDefault(); if (form.confirming) void onSubmit(); else onRequestConfirm() }}>
      <label><span>{copy.skillName}</span><input ref={nameInputRef} required value={form.name} onChange={(event) => onEditName(event.target.value)} maxLength={80} placeholder={copy.skillNamePlaceholder} autoFocus /></label>
      <label><span>{copy.skillRules}</span><textarea required value={form.instructions} onChange={(event) => onEditInstructions(event.target.value)} maxLength={4000} placeholder={copy.skillRulesPlaceholder} /></label>
      {form.confirming ? <div className="agent-skill-panel__confirm">
        <span><strong>{copy.createProjectSkill}</strong><small>{copy.createProjectSkillDetail}</small></span>
        <div><button type="button" autoFocus onClick={onCancelConfirm}>{copy.cancel}</button><button type="submit" disabled={form.saving}>{form.saving ? copy.creating : copy.confirmCreate}</button></div>
      </div> : <div className="agent-skill-panel__form-actions"><button ref={createButtonRef} type="button" className="agent-skill-panel__cancel" onClick={onCloseForm}>{copy.cancel}</button><button type="submit" className="agent-skill-panel__create">{copy.createSkill}</button></div>}
      {form.error ? <p role="alert">{form.error}</p> : null}
    </form> : null}
    <div className="agent-skill-panel__list">
      <header><strong>{copy.availableSkills}</strong><span>{filteredItems.length}</span></header>
      {filteredItems.map((skill) => <AgentSkillCard
        key={skill.id}
        id={skill.id}
        name={skill.name}
        instructions={skill.instructions}
        source={skill.source}
        expanded={expandedSkillId === skill.id}
        mounted={mountedIds.has(skill.id)}
        mountDisabled={skillLimitReached && !mountedIds.has(skill.id)}
        onToggle={onToggleExpanded}
        onToggleMount={onToggleMounted}
      />)}
      {!filteredItems.length ? <div className="agent-panel__empty">{catalogItems.length ? copy.noSkillMatches : copy.noProjectSkills}</div> : null}
    </div>
  </section>
}
