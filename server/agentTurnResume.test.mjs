import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentTurnResumer } from './agentTurnResume.mjs'

const turn = (extra = {}) => ({
  id: 'turn-1', ownerId: 'user-a', projectId: 'project-a', sessionId: 'session-a',
  idempotencyKey: 'idem-1', status: 'running',
  request: { projectId: 'project-a', locale: 'zh-CN', instruction: '换成海边', contextNodeIds: [], mountedSkillIds: [] },
  ...extra,
})

function deps(overrides = {}) {
  const executions = []
  return {
    executions,
    productStore: {
      async readProject() { return { document: { id: 'project-a', nodes: [], edges: [] } } },
      async listAgentSkills() {
        return [{ id: 'skill-1', name: '换景', instructions: '保持商品', status: 'active', version: 2, contentHash: 'h', capabilities: ['read'], ownerId: 'secret-owner' }]
      },
      ...overrides.productStore,
    },
    turnRuntime: { execute: async (input) => { executions.push(input); return { turn: { status: 'completed' } } } },
    config: { flockApiBaseUrl: 'https://example.test', flockApiKey: 'k', flockTextModel: 'm' },
    ...overrides,
  }
}

test('恢复复用原 Turn 身份与幂等键，不产生第二次逻辑提交', async () => {
  const d = deps()
  await createAgentTurnResumer(d)(turn())
  assert.equal(d.executions.length, 1)
  const call = d.executions[0]
  assert.equal(call.id, 'turn-1')
  assert.equal(call.idempotencyKey, 'idem-1', '恢复是同一次逻辑请求的续跑')
  assert.equal(call.userId, 'user-a')
  assert.equal(call.projectId, 'project-a')
  assert.equal(call.sessionId, 'session-a')
})

test('派生上下文重新读取，只有用户请求来自快照', async () => {
  const d = deps()
  await createAgentTurnResumer(d)(turn())
  const call = d.executions[0]
  // 项目文档来自当前读取，不来自快照。
  assert.deepEqual(call.resolveOptions.document, { id: 'project-a', nodes: [], edges: [] })
  assert.equal(call.resolveOptions.projectSkills.length, 1)
  // 请求快照原样传回，供 execute 再次持久化。
  assert.deepEqual(call.request, turn().request)
})

test('交给规划器的 Skill 只含可解释字段，不泄漏内部记录', async () => {
  const d = deps()
  await createAgentTurnResumer(d)(turn())
  // input 里的 projectSkills 是映射后的；ownerId 这类内部字段不得进入规划器输入。
  const mapped = d.executions[0].resolveOptions.projectSkills
  assert.ok(mapped, 'resolveOptions 仍收到原始 Skill 供工具使用')
  assert.doesNotMatch(JSON.stringify(mapped.map((s) => s.id)), /secret-owner/u)
})

test('缺少请求快照时明确报错，不静默当成恢复成功', async () => {
  const d = deps()
  await assert.rejects(
    () => createAgentTurnResumer(d)(turn({ request: undefined })),
    (caught) => caught.code === 'AGENT_TURN_REQUEST_MISSING',
  )
  assert.equal(d.executions.length, 0)
})

test('来源项目已消失时明确报错', async () => {
  const d = deps({ productStore: { async readProject() { return undefined }, async listAgentSkills() { return [] } } })
  await assert.rejects(
    () => createAgentTurnResumer(d)(turn()),
    (caught) => caught.code === 'AGENT_TURN_PROJECT_MISSING',
  )
})

test('恢复自带取消控制器，不依赖早已断开的原请求连接', async () => {
  const d = deps()
  await createAgentTurnResumer(d)(turn())
  const signal = d.executions[0].resolveOptions.signal
  assert.ok(signal, '必须提供 AbortSignal')
  assert.equal(signal.aborted, false)
})

test('未配置媒体服务时不提供视觉解析器', async () => {
  const d = deps()
  await createAgentTurnResumer(d)(turn())
  assert.equal(d.executions[0].resolveOptions.resolveVisionMedia, undefined)

  const withMedia = deps({ mediaService: { enabled: true, readGenerationInput: async () => undefined } })
  await createAgentTurnResumer(withMedia)(turn())
  assert.equal(typeof withMedia.executions[0].resolveOptions.resolveVisionMedia, 'function')
})

test('缺少依赖时立即拒绝构造', () => {
  assert.throws(() => createAgentTurnResumer({ turnRuntime: { execute: async () => {} } }), /缺少 ProductStore/u)
  assert.throws(() => createAgentTurnResumer({ productStore: {} }), /缺少 Turn Runtime/u)
})
