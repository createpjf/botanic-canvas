/**
 * Skill 目录的纯状态规则。
 *
 * 这些规则原先散在 AgentWorkspace 的渲染里写成连续 setState（例如改名字时同时
 * `setSkillConfirming(false)` 和 `setSkillError('')`）。那样规则会随调用点漂移：
 * 少写一处，确认态就会带着过期内容留下来。收成纯 reducer 后规则只有一处，
 * 且不需要 DOM 或 React 就能测。
 */

export type AgentSkillFormState = {
  name: string
  instructions: string
  open: boolean
  confirming: boolean
  saving: boolean
  error: string
}

export const emptyAgentSkillForm: AgentSkillFormState = Object.freeze({
  name: '',
  instructions: '',
  open: false,
  confirming: false,
  saving: false,
  error: '',
})

export type AgentSkillFormAction =
  | { type: 'editName'; value: string }
  | { type: 'editInstructions'; value: string }
  | { type: 'openForm' }
  | { type: 'closeForm' }
  | { type: 'requestConfirm' }
  | { type: 'cancelConfirm' }
  | { type: 'panelClosed' }
  | { type: 'submitStarted' }
  | { type: 'submitFailed'; error: string }
  | { type: 'submitSucceeded' }

export function agentSkillFormReducer(
  state: AgentSkillFormState,
  action: AgentSkillFormAction,
): AgentSkillFormState {
  switch (action.type) {
    // 内容一变，上一次的确认与报错都不再成立。
    case 'editName':
      return { ...state, name: action.value, confirming: false, error: '' }
    case 'editInstructions':
      return { ...state, instructions: action.value, confirming: false, error: '' }
    // 打开表单保留已填内容（用户可能只是误关），但清掉确认态与错误。
    case 'openForm':
      return { ...state, open: true, confirming: false, error: '' }
    case 'closeForm':
      return { ...state, open: false, confirming: false, error: '' }
    case 'requestConfirm':
      return canSubmitAgentSkillForm(state) ? { ...state, confirming: true } : state
    case 'cancelConfirm':
      return { ...state, confirming: false }
    // 面板关闭是外部事件：收起表单，但不清内容，重新打开还能接着写。
    case 'panelClosed':
      return { ...state, open: false, confirming: false }
    case 'submitStarted':
      return { ...state, saving: true, error: '' }
    case 'submitFailed':
      return { ...state, saving: false, error: action.error }
    // 成功后整个表单回到初始态：内容已经变成一条 Skill，留着只会被误提交第二次。
    case 'submitSucceeded':
      return { ...emptyAgentSkillForm }
    default:
      return state
  }
}

/** 名称与规则都必须有实际内容；保存中不接受重复提交。 */
export function canSubmitAgentSkillForm(state: AgentSkillFormState) {
  return Boolean(state.name.trim()) && Boolean(state.instructions.trim()) && !state.saving
}

/** 展开是单选：再点同一项收起，点另一项换过去。 */
export function nextExpandedSkillId(current: string, skillId: string) {
  return current === skillId ? '' : skillId
}

/** 挂载去重且保留原有挂载；卸载只移除目标。 */
export function nextMountedSkillIds(current: readonly string[], skillId: string, mounted: boolean) {
  return mounted
    ? [...new Set([...current, skillId])]
    : current.filter((id) => id !== skillId)
}
