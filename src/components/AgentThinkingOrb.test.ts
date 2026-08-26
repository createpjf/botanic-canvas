import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentTimelineOrbState } from '../domain/agentTimeline.ts'

test('思考 pill 固定 breathing（MetalForge style=breathe），不随工具步改态', () => {
  assert.equal(agentTimelineOrbState({ surface: 'thinking' }), 'breathing')
  assert.equal(
    agentTimelineOrbState({ surface: 'thinking', kind: 'search', toolName: 'web_search' }),
    'breathing',
  )
})
