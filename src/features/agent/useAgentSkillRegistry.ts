import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { BotanicAgentSession, BotanicAgentSkill, BotanicAgentSkillCatalogItem } from '../../domain/agent'
import { createProjectAgentSkill, listBotanicAgentSystemSkills, listProjectAgentSkills } from '../../lib/agentApi'
import { localizeProductError, type ProductLocale } from '../../i18n/core'
import {
  agentSkillFormReducer,
  canSubmitAgentSkillForm,
  emptyAgentSkillForm,
  nextExpandedSkillId,
  nextMountedSkillIds,
} from './agentSkillForm'

/**
 * Skill 目录的行为所有者。表单规则本身在 `agentSkillForm.ts`（纯、可单测）；
 * 这里只负责 React 无法纯化的三件事：目录拉取、焦点管理、异步提交编排。
 *
 * 不负责两件事，它们不属于目录：
 * - `/` 提及里选中 Skill —— 那是 Composer 的 mention 行为，与选中画布节点同构；
 * - 打开 Skill 面板 —— 那是面板导航。调用方完成导航后再调 `openForm()`。
 */
export function useAgentSkillRegistry(input: {
  projectId: string
  session?: BotanicAgentSession
  locale: ProductLocale
  /** 面板关闭时收起表单；面板重新打开时重新拉取目录。 */
  panelOpen: boolean
  serverPersistenceEnabled: boolean
  /** 项目在异步期间被切走时丢弃结果，避免把上个项目的 Skill 写进当前面板。 */
  isCurrentAgentProject: () => boolean
  onSkillsChange: (sessionId: string, skillIds: string[]) => void
  createFailedMessage: string
}) {
  const {
    projectId, session, locale, panelOpen,
    serverPersistenceEnabled, isCurrentAgentProject, onSkillsChange, createFailedMessage,
  } = input

  const [skills, setSkills] = useState<BotanicAgentSkill[]>([])
  const [systemSkills, setSystemSkills] = useState<BotanicAgentSkillCatalogItem[]>([])
  const [form, dispatch] = useReducer(agentSkillFormReducer, emptyAgentSkillForm)
  const [expandedSkillId, setExpandedSkillId] = useState('')
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const createButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (panelOpen) return
    dispatch({ type: 'panelClosed' })
    setExpandedSkillId('')
  }, [panelOpen])

  useEffect(() => {
    let active = true
    if (!serverPersistenceEnabled) {
      // 本地预览没有 Node API；不发起目录请求，避免浏览器控制台出现误导性的 500。
      setSystemSkills([])
      setSkills([])
      return () => { active = false }
    }
    void listBotanicAgentSystemSkills()
      .then((items) => { if (active) setSystemSkills(items) })
      .catch(() => { if (active) setSystemSkills([]) })
    void listProjectAgentSkills(projectId).then((items) => {
      if (active) setSkills(items)
    }).catch((reason) => {
      if (active) dispatch({ type: 'submitFailed', error: localizeProductError(reason, locale, {
        'zh-CN': '项目 Skill 列表加载失败。',
        en: 'Unable to load project Skills.',
      }) })
    })
    return () => { active = false }
  }, [locale, projectId, panelOpen, serverPersistenceEnabled])

  const editName = useCallback((value: string) => dispatch({ type: 'editName', value }), [])
  const editInstructions = useCallback((value: string) => dispatch({ type: 'editInstructions', value }), [])
  const closeForm = useCallback(() => dispatch({ type: 'closeForm' }), [])
  const requestConfirm = useCallback(() => dispatch({ type: 'requestConfirm' }), [])

  const openForm = useCallback(() => {
    dispatch({ type: 'openForm' })
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }, [])

  /** 退出确认态时把焦点还给创建按钮，键盘用户不会被留在已消失的确认区。 */
  const cancelConfirm = useCallback(() => {
    dispatch({ type: 'cancelConfirm' })
    requestAnimationFrame(() => createButtonRef.current?.focus())
  }, [])

  const toggleExpanded = useCallback((skillId: string) => {
    setExpandedSkillId((current) => nextExpandedSkillId(current, skillId))
  }, [])

  const toggleMounted = useCallback((skillId: string, mounted: boolean) => {
    if (!session) return
    onSkillsChange(session.id, nextMountedSkillIds(session.mountedSkillIds ?? [], skillId, mounted))
  }, [onSkillsChange, session])

  const submit = useCallback(async () => {
    if (!canSubmitAgentSkillForm(form)) return
    dispatch({ type: 'submitStarted' })
    try {
      const result = await createProjectAgentSkill({
        projectId,
        name: form.name.trim(),
        instructions: form.instructions.trim(),
      })
      if (!isCurrentAgentProject()) return
      setSkills((items) => [result.output.skill, ...items.filter((item) => item.id !== result.output.skill.id)])
      // 新建的项目 Skill 自动挂载到当前对话，用户不必再手动挂一次。
      if (session) {
        onSkillsChange(session.id, nextMountedSkillIds(session.mountedSkillIds ?? [], result.output.skill.id, true))
      }
      dispatch({ type: 'submitSucceeded' })
    } catch (caught) {
      if (!isCurrentAgentProject()) return
      dispatch({ type: 'submitFailed', error: localizeProductError(caught, locale, {
        'zh-CN': createFailedMessage,
        en: createFailedMessage,
      }) })
    }
  }, [createFailedMessage, form, isCurrentAgentProject, locale, onSkillsChange, projectId, session])

  return {
    skills,
    systemSkills,
    form,
    expandedSkillId,
    nameInputRef,
    createButtonRef,
    editName,
    editInstructions,
    openForm,
    closeForm,
    requestConfirm,
    cancelConfirm,
    toggleExpanded,
    toggleMounted,
    submit,
  }
}
