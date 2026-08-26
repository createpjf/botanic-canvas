import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveAgentThinkingOrbState } from './agentThinkingOrbState.ts'
import type { AgentTimelineState } from '../domain/agentTimeline.ts'

test('无时间线时默认 composing', () => {
  assert.equal(resolveAgentThinkingOrbState(), 'composing')
  assert.equal(resolveAgentThinkingOrbState({ blocks: [] }), 'composing')
})

test('有 running 的 search/fetch 步时用 searching，否则 composing', () => {
  const searching: AgentTimelineState = {
    blocks: [
      { id: 'thinking', type: 'thinking', status: 'running', startedAt: 1, text: '' },
      {
        id: 'step-1', type: 'step', status: 'running', kind: 'search',
        title: '搜索', sourceToolIds: ['t1'],
      },
    ],
  }
  assert.equal(resolveAgentThinkingOrbState(searching), 'searching')

  const fetching: AgentTimelineState = {
    blocks: [
      { id: 'thinking', type: 'thinking', status: 'running', startedAt: 1, text: '' },
      {
        id: 'step-2', type: 'step', status: 'running', kind: 'fetch',
        title: '获取', sourceToolIds: ['t2'],
      },
    ],
  }
  assert.equal(resolveAgentThinkingOrbState(fetching), 'searching')

  const writing: AgentTimelineState = {
    blocks: [
      { id: 'thinking', type: 'thinking', status: 'running', startedAt: 1, text: '' },
      {
        id: 'step-3', type: 'step', status: 'running', kind: 'write',
        title: '写入', sourceToolIds: ['t3'],
      },
    ],
  }
  assert.equal(resolveAgentThinkingOrbState(writing), 'composing')

  const doneSearch: AgentTimelineState = {
    blocks: [
      { id: 'thinking', type: 'thinking', status: 'running', startedAt: 1, text: '' },
      {
        id: 'step-4', type: 'step', status: 'succeeded', kind: 'search',
        title: '搜索', sourceToolIds: ['t4'],
      },
    ],
  }
  assert.equal(resolveAgentThinkingOrbState(doneSearch), 'composing')
})
