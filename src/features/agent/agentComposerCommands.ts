export type AgentComposerLocalCommandId = 'new' | 'history' | 'skills' | 'tasks' | 'results' | 'memory'
export type AgentComposerLocalCommandIcon = 'plus' | 'clock' | 'sparkle' | 'tasks' | 'image' | 'bookmark'

export type AgentComposerLocalCommand = {
  id: AgentComposerLocalCommandId
  name: string
  label: string
  detail: string
  icon: AgentComposerLocalCommandIcon
}

export function agentComposerLocalCommands(locale: 'zh-CN' | 'en'): AgentComposerLocalCommand[] {
  const en = locale === 'en'
  return [
    { id: 'new', name: 'new', label: en ? 'New chat' : '新对话', detail: '/new', icon: 'plus' },
    { id: 'history', name: 'history', label: en ? 'Conversation history' : '对话历史', detail: '/history', icon: 'clock' },
    { id: 'skills', name: 'skills', label: en ? 'Skills' : '技能', detail: '/skills', icon: 'sparkle' },
    { id: 'tasks', name: 'tasks', label: en ? 'Tasks' : '任务', detail: '/tasks', icon: 'tasks' },
    { id: 'results', name: 'results', label: en ? 'Results' : '结果', detail: '/results', icon: 'image' },
    { id: 'memory', name: 'memory', label: en ? 'Memory' : '记忆', detail: '/memory', icon: 'bookmark' },
  ]
}

export function executeAgentComposerLocalCommand(
  id: AgentComposerLocalCommandId,
  actions: {
    newSession: () => void
    openHistory: () => void
    openPanel: (panel: 'skill' | 'task' | 'result' | 'memory') => void
  },
) {
  if (id === 'new') actions.newSession()
  else if (id === 'history') actions.openHistory()
  else actions.openPanel(({ skills: 'skill', tasks: 'task', results: 'result', memory: 'memory' } as const)[id])
}
