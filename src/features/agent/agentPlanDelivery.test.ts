import assert from 'node:assert/strict'
import test from 'node:test'
import { deliverAgentPlan } from './agentPlanDelivery.ts'
import { buildBotanicAgentCompositionPlan, normalizeBotanicAgentComposition } from '../../domain/agentCreativeComposition.ts'
import type { BotanicAgentMessage } from '../../domain/agent.ts'

const plan = buildBotanicAgentCompositionPlan({ instruction: '成套生成', composition: normalizeBotanicAgentComposition({
  theme: '春季', items: [{ title: '主图', prompt: '春日主图' }, { title: '细节', prompt: '春日细节' }],
})!, contextSnapshot: [{ nodeId: 'asset-1', label: '素材', kind: '素材', mediaKind: 'image' }], settings: { model: 'm', aspectRatio: '1:1', resolution: '1K' } })

test('计划先发布再按冻结资格提交，批量/意图/行动确认均不可由共享入口绕过', async () => {
  const delivered: BotanicAgentMessage[] = []
  const submitted: string[] = []
  const adapter = { canDeliver: () => true, publish: (message: BotanicAgentMessage) => { delivered.push(message); return 'plan-message' },
    confirm: async (message: BotanicAgentMessage) => { submitted.push(message.id) }, onPending: () => {},
  }
  const first = await deliverAgentPlan({ plan, execution: { mode: 'auto' }, identity: { id: 'stable', turnId: 'turn-1' } }, adapter)
  assert.deepEqual(first?.decision, { action: 'confirm', reason: 'batch_count' })
  assert.deepEqual(submitted, [])
  assert.equal(delivered[0].id, 'stable')
  assert.equal(delivered[0].turnId, 'turn-1')
  await deliverAgentPlan({ plan, execution: { mode: 'auto', waivers: ['batch_count'] } }, adapter)
  assert.deepEqual(submitted, ['plan-message'])
  const inferred = await deliverAgentPlan({ plan: { ...plan, requiresGenerationConfirmation: true }, execution: { mode: 'auto', waivers: ['manual', 'batch_count'] } }, adapter)
  assert.deepEqual(inferred?.decision, { action: 'confirm', reason: 'intent' })
  assert.equal(submitted.length, 1)
  const action = await deliverAgentPlan({ plan: { ...plan, actions: [{
    id: 'delete-1', kind: 'canvas', toolName: 'canvas_delete_nodes', label: '删除节点', summary: '删除选中节点',
    risk: 'write', arguments: { nodeIds: ['asset-1'] }, status: 'awaiting_confirmation',
  }] }, execution: { mode: 'auto', waivers: ['manual', 'batch_count'] } }, adapter)
  assert.deepEqual(action?.decision, { action: 'confirm', reason: 'pending_actions' })
  assert.equal(submitted.length, 1)
})

test('发布前后 scope 或 Stop 失效时，不向新会话或已取消计划提交', async () => {
  let active = true
  const result = await deliverAgentPlan({ plan, execution: { mode: 'auto', waivers: ['batch_count'] } }, {
    canDeliver: () => active,
    publish: () => { active = false; return 'plan-1' }, onPending: () => {},
    confirm: async () => { throw new Error('失去 scope 不能提交') },
  })
  assert.equal(result?.messageId, 'plan-1')
})
