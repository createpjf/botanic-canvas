import assert from 'node:assert/strict'
import test from 'node:test'
import { agentComposerLocalCommands, executeAgentComposerLocalCommand } from './agentComposerCommands.ts'

test('本地 slash 命令目录稳定且只路由现有Workspace动作', () => {
  assert.deepEqual(agentComposerLocalCommands('zh-CN').map((command) => command.name), ['new', 'history', 'skills', 'tasks', 'results', 'memory'])
  const actions: string[] = []
  const adapters = {
    newSession: () => actions.push('new'),
    openHistory: () => actions.push('history'),
    openPanel: (panel: 'skill' | 'task' | 'result' | 'memory') => actions.push(panel),
  }
  executeAgentComposerLocalCommand('new', adapters)
  executeAgentComposerLocalCommand('history', adapters)
  executeAgentComposerLocalCommand('tasks', adapters)
  assert.deepEqual(actions, ['new', 'history', 'task'])
})
