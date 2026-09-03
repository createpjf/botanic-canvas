import assert from 'node:assert/strict'
import test from 'node:test'
import { queryCanvasForAgent } from './canvasAgentQuery.mjs'
import { applyCanvasActionSet, prepareCanvasActionSetProposal } from './canvasAgentActionSet.mjs'
import { createActionApprovalToken, assertFreshActionApproval } from '../agent/action/agentActionGovernance.mjs'
import { createBotanicAgentOperationalActionDefinitions } from '../agent/tools/botanicAgentOperationalTools.mjs'

const models = [{ id: 'image-model', aspectRatios: ['1:1'], resolutions: ['1K'] }]
const artifact = { id: 'generation:job-approved:output-1', kind: 'image', label: '批准版本', url: '/api/media/approved', origin: { type: 'generation_output', jobId: 'job-approved', outputId: 'output-1' }, metadata: { status: 'succeeded' }, createdAt: 1, updatedAt: 1 }

test('受治理画布端到端：查询、冻结审批、原子复用组织，并保留工作流发布门禁', () => {
  const document = { id: 'project-1', updatedAt: 1, nodes: [
    { id: 'brief', type: 'text', position: { x: 0, y: 0 }, data: { kind: 'text', label: 'Brief', content: '夏季活动' } },
  ], edges: [] }
  const query = queryCanvasForAgent(document, { nodeIds: ['brief'] })
  assert.equal(query.nodes[0].id, 'brief')
  const proposed = prepareCanvasActionSetProposal(document, { operations: [
    { kind: 'project_artifact', temporaryId: 'approved', artifactId: artifact.id, position: { x: 250, y: 0 } },
    { kind: 'create_generate', temporaryId: 'next', position: { x: 500, y: 0 }, prompt: '改成海边场景', batchCount: 1, settings: { model: 'image-model', aspectRatio: '1:1', resolution: '1K' }, constraints: [{ dimension: 'product', mode: 'preserve' }, { dimension: 'scene', mode: 'change' }] },
    { kind: 'connect_reference', sourceNodeId: 'approved', targetNodeId: 'next' },
    { kind: 'organize_nodes', placements: [{ nodeId: 'brief', position: { x: 0, y: 240 }, label: '活动 Brief' }] },
  ] }, models, 'action-1', new Map([[artifact.id, artifact]]))
  const approvalInput = { secret: 'secret', userId: 'user-1', projectId: document.id, actionName: 'canvas_action_set', toolCallId: 'action-1', argumentsValue: proposed.arguments, idempotencyKey: 'receipt-1', now: 1_000 }
  const approval = createActionApprovalToken(approvalInput)
  assert.doesNotThrow(() => assertFreshActionApproval({ confirmed: true, approval }, approvalInput))
  assert.throws(() => assertFreshActionApproval({ confirmed: true, approval }, { ...approvalInput, argumentsValue: { ...proposed.arguments, operations: [] } }), /不匹配/u)
  const result = applyCanvasActionSet(document, { actionId: 'action-1', ...proposed.arguments }, models, 2, new Map([[artifact.id, artifact]]))
  const generate = result.document.nodes.find((node) => node.type === 'generate')
  assert.match(generate.data.prompt, /PRESERVE product; CHANGE scene/u)
  assert.deepEqual(result.document.nodes.find((node) => node.id === 'brief').position, { x: 0, y: 240 })
  assert.equal(result.document.edges.length, 1)
  const workflow = createBotanicAgentOperationalActionDefinitions({ role: 'editor', publishWorkflow: async () => ({}) }).find((item) => item.name === 'workflow_publish')
  assert.equal(workflow.requiresConfirmation, true)
  assert.deepEqual(workflow.validate({ name: '夏季活动流程', sourceCanvasNodeId: generate.id }), { name: '夏季活动流程', sourceCanvasNodeId: generate.id })
})
