import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentContextObserver } from './agentContextObservability.mjs'

test('Context observer 将 shadow 投影成安全语义事件', () => {
  const lines = []
  const observe = createAgentContextObserver({ logger: { log: (line) => lines.push(line) } })
  observe({
    name: 'agent.context.projection', status: 'succeeded',
    ids: { projectId: 'project-1', sessionId: 'session-1' },
    counts: { operationCount: 1, controlInputTokenCount: 4000, candidateInputTokenCount: 1200 },
    prompt: 'PROMPT_SECRET_SENTINEL',
  })
  assert.equal(lines.length, 1)
  const event = JSON.parse(lines[0])
  assert.equal(event.outcome, 'would_compact')
  assert.equal(event.controlInputTokens, 4000)
  assert.equal(event.candidateInputTokens, 1200)
  assert.doesNotMatch(lines[0], /PROMPT_SECRET_SENTINEL/u)
})

test('Shadow candidate 大于 control 仍保留风险样本', () => {
  const lines = []
  const observe = createAgentContextObserver({ logger: { log: (line) => lines.push(line) } })
  observe({
    name: 'agent.context.projection', status: 'succeeded',
    counts: { operationCount: 0, controlInputTokenCount: 1200, candidateInputTokenCount: 1600 },
  })
  assert.equal(lines.length, 1)
  const event = JSON.parse(lines[0])
  assert.equal(event.controlInputTokens, 1200)
  assert.equal(event.candidateInputTokens, 1600)
})

test('Context observer 把 rollout cohort 与规则形态分开且不记录 selector', () => {
  const lines = []
  const observe = createAgentContextObserver({ logger: { log: (line) => lines.push(line) } })
  observe({
    name: 'agent.context.rollout',
    rollout: { mode: 'shadow', rolloutMode: 'scoped', selector: 'project:private-project' },
  })
  const event = JSON.parse(lines[0])
  assert.deepEqual({ decision: event.decision, cohort: event.cohort, mode: event.mode }, {
    decision: 'enabled', cohort: 'shadow', mode: 'scoped',
  })
  assert.doesNotMatch(lines[0], /private-project|selector/u)
})

test('Context kill switch 使用独立 cohort', () => {
  const lines = []
  const observe = createAgentContextObserver({ logger: { log: (line) => lines.push(line) } })
  observe({ name: 'agent.context.rollout', rollout: { mode: 'killed', rolloutMode: 'off' } })
  const event = JSON.parse(lines[0])
  assert.equal(event.decision, 'disabled')
  assert.equal(event.cohort, 'killed')
})
