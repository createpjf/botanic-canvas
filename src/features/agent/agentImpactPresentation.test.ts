import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentActionProposal, BotanicAgentPlan } from '../../domain/agent'
import { presentAgentActionImpact, presentAgentPlanImpact } from './agentImpactPresentation.ts'

test('计划影响明确区分保持、改变、写入与恢复语义', () => {
  const plan = {
    constraints: [{ dimension: 'person', mode: 'preserve' }, { dimension: 'scene', mode: 'vary' }],
    output: { count: 2 },
    actions: [{ toolName: 'canvas_action_set', status: 'pending' }, { toolName: 'skill_apply', status: 'succeeded' }],
  } as unknown as BotanicAgentPlan
  assert.deepEqual(presentAgentPlanImpact(plan, 'zh-CN', (value) => ({ person: '人物', scene: '场景' }[value] ?? value)), {
    preserved: '人物', changed: '场景', write: '新增 2 个结果节点，并执行 1 项已确认行动',
  })
})

test('画布 Action 使用冻结 Preview 说明真实影响，不再误标为 Skill', () => {
  const action = { kind: 'canvas', toolName: 'canvas_action_set', arguments: {}, preview: { summary: { created: 1, updated: 2, removed: 0, connected: 1 } } } as unknown as BotanicAgentActionProposal
  assert.deepEqual(presentAgentActionImpact(action, 'zh-CN'), { input: '当前画布', output: '新增 1，修改 2，删除 0，连接 1' })
})
