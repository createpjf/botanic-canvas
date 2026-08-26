import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentTimelineOrbState } from '../domain/agentTimeline.ts'

test('思考 pill 固定 solving，不随工具步改成 Searching 文案态', () => {
  assert.equal(agentTimelineOrbState({ surface: 'thinking' }), 'solving')
  assert.equal(
    agentTimelineOrbState({ surface: 'thinking', kind: 'search', toolName: 'web_search' }),
    'solving',
  )
})
