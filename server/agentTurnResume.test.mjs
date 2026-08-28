import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentTurnResumer } from './agentTurnResume.mjs'

const turn = (extra = {}) => ({
  id: 'turn-1', ownerId: 'user-a', projectId: 'project-a', sessionId: 'session-a',
  idempotencyKey: 'idem-1', status: 'running',
  request: { projectId: 'project-a', locale: 'zh-CN', instruction: '换成海边', contextNodeIds: [], mountedSkillIds: [] },
  ...extra,
})

const receiptCall = (extra = {}) => ({
  id: 'call-submit', name: 'generation_submit', risk: 'costly', recovery: 'receipt', terminal: true,
  receiptId: 'receipt-1', intentHash: 'intent-1',
  ...extra,
})

const receiptCheckpoint = (call = receiptCall()) => ({
  version: 1,
  attempt: { id: 'text', model: 'model-a', snapshotHash: 'snapshot-a' },
  completedSteps: [],
  pendingStep: { step: 0, calls: [call] },
})

function deps(overrides = {}) {
  const executions = []
  const { productStore: productStoreOverrides, turnRuntime: turnRuntimeOverride, ...rest } = overrides
  return {
    executions,
    productStore: {
      async readProject() { return { document: { id: 'project-a', nodes: [], edges: [] } } },
      async listAgentSkills() {
        return [{ id: 'skill-1', name: '换景', instructions: '保持商品', status: 'active', version: 2, contentHash: 'h', capabilities: ['read'], ownerId: 'secret-owner' }]
      },
      ...productStoreOverrides,
    },
    turnRuntime: turnRuntimeOverride ?? { execute: async (input) => { executions.push(input); return { turn: { status: 'completed' } } } },
    config: { flockApiBaseUrl: 'https://example.test', flockApiKey: 'k', flockTextModel: 'm' },
    ...rest,
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
  assert.equal(call.allowTakeover, true, '只有清扫恢复路径可以接管过期租约')
})

test('派生上下文重新读取，只有用户请求来自快照', async () => {
  const d = deps()
  await createAgentTurnResumer(d)(turn())
  const call = d.executions[0]
  // 项目文档来自当前读取，不来自快照。
  assert.deepEqual(call.resolveOptions.document, { id: 'project-a', nodes: [], edges: [] })
  assert.equal(call.resolveOptions.projectSkills.length, 1)
  assert.equal(typeof call.resolveOptions.operations.readRun, 'function')
  assert.equal(typeof call.resolveOptions.operations.searchArtifacts, 'function')
  // 请求快照原样传回，供 execute 再次持久化。
  assert.deepEqual(call.request, turn().request)
})

test('Worker 恢复兼容 operation 时保留 envelope，并从嵌套快照读取线程摘要', async () => {
  const threadSummary = {
    version: 1, goals: ['继续规划'], decisions: [], constraints: [], openQuestions: [],
    entityIds: [], coveredMessageIds: ['m-1'], coveredThrough: 1, updatedAt: 10,
  }
  const request = {
    runtimeOperation: 'intent',
    input: {
      projectId: 'project-a', locale: 'zh-CN', messages: [{ role: 'user', content: '继续' }],
      threadContextSnapshot: { version: 1, messages: [], threadSummary },
    },
  }
  const d = deps()

  await createAgentTurnResumer(d)(turn({ request }))

  assert.deepEqual(d.executions[0].request, request)
  assert.deepEqual(d.executions[0].resolveOptions.threadSummary, threadSummary)
})

test('Worker 恢复联网工具复用共享配额；缺依赖时显式 fail closed', async () => {
  const consumed = []
  const configured = deps({
    consumeWebResearchQuota: async (userId) => {
      consumed.push(userId)
      return { allowed: true }
    },
  })
  await createAgentTurnResumer(configured)(turn())
  assert.deepEqual(await configured.executions[0].resolveOptions.consumeWebResearchQuota(), { allowed: true })
  assert.deepEqual(consumed, ['user-a'])

  const missing = deps()
  await createAgentTurnResumer(missing)(turn())
  assert.deepEqual(await missing.executions[0].resolveOptions.consumeWebResearchQuota(), { allowed: false })
})

test('恢复只注入 Turn 中不可变的 thread context snapshot，不读取最新线程摘要', async () => {
  const threadSummary = {
    version: 1, goals: ['首次执行目标'], decisions: [], constraints: ['scene:preserve'],
    openQuestions: [], entityIds: [], coveredMessageIds: ['m-1'], coveredThrough: 1, updatedAt: 10,
  }
  const request = {
    ...turn().request,
    messages: [{ role: 'user', content: '首次窗口' }],
    threadContextSnapshot: {
      version: 1,
      messages: [{ role: 'user', content: '首次窗口' }],
      threadSummary,
    },
  }
  const d = deps()

  await createAgentTurnResumer(d)(turn({ request }))

  const call = d.executions[0]
  assert.deepEqual(call.request.threadContextSnapshot.threadSummary, threadSummary)
  assert.deepEqual(call.resolveOptions.threadSummary, threadSummary)
  assert.equal(call.resolveOptions.persistAgentContextUsageAnchor, undefined)
})

test('Snapshot V2 恢复注入同一 Session 的 usage anchor 持久化 seam', async () => {
  const writes = []
  const request = {
    ...turn().request,
    plannerModel: 'model-a',
    threadContextSnapshot: {
      version: 2,
      modelPolicy: { model: 'model-a', hash: 'policy-hash' },
      messages: [{ id: 'm-1', revision: 'r-1', role: 'user', content: '继续' }],
    },
  }
  const state = {
    version: 2, sessionId: 'session-a', projectId: 'project-a', revision: 0, updatedAt: 0,
  }
  const d = deps({
    productStore: {
      async readAgentContextState() { return structuredClone(state) },
      async listAgentContextCompactions() { return { compactions: [] } },
      async compareAndSetAgentContextState(userId, command) {
        writes.push({ userId, command })
        return { kind: 'updated', changed: true, state }
      },
    },
  })

  await createAgentTurnResumer(d)(turn({ request }))
  const persist = d.executions[0].resolveOptions.persistAgentContextUsageAnchor
  assert.equal(typeof persist, 'function')
  await persist({ version: 1, surfaceHash: 'surface-1', inputTokens: 10 })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].userId, 'user-a')
  assert.equal(writes[0].command.projectId, 'project-a')
  assert.equal(writes[0].command.sessionId, 'session-a')
  assert.equal(writes[0].command.usageAnchor.surfaceHash, 'surface-1')
})

test('Context V2 总闸门关闭时孤儿 Turn 保持待恢复且不进入执行器', async () => {
  const request = {
    ...turn().request,
    threadContextSnapshot: {
      version: 2,
      modelPolicy: { model: 'model-a', hash: 'policy-hash' },
      messages: [{ id: 'm-1', revision: 'r-1', role: 'user', content: '继续' }],
    },
  }
  const d = deps({
    config: {
      agentFeatureFlags: { runtimeV2: true, contextCompactionV2: false },
    },
  })

  await assert.rejects(
    () => createAgentTurnResumer(d)(turn({ request })),
    (caught) => caught.code === 'AGENT_CONTEXT_KILL_SWITCH_BLOCKED' && caught.statusCode === 503,
  )
  assert.equal(d.executions.length, 0)
})

test('旧 Turn 没有 thread context snapshot 时按 legacy 无摘要恢复，不借用当前 Session', async () => {
  const d = deps()

  await createAgentTurnResumer(d)(turn())

  assert.equal(d.executions[0].resolveOptions.threadSummary, undefined)
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

test('succeeded Receipt 严格按 owner/project/id/intent 恢复安全业务引用', async () => {
  const reads = []
  let recovered
  const call = receiptCall()
  const d = deps({
    productStore: {
      async readAgentActionReceipt(userId, receiptId) {
        reads.push({ userId, receiptId })
        return {
          id: receiptId,
          ownerId: 'user-a',
          projectId: 'project-a',
          intentHash: 'intent-1',
          status: 'succeeded',
          result: {
            output: {
              message: '已创建生成任务',
              runId: 'run-1',
              jobIds: ['job-1', 'job-2'],
              artifacts: [{ id: 'artifact-1', imageUrl: 'https://private.example/secret.png', rawOutput: 'provider-secret' }],
              prompt: '机密提示词',
              reasoning: '完整推理',
              providerResponse: { bytes: 'media-bytes' },
            },
            toolCall: { arguments: { prompt: '机密提示词' } },
          },
        }
      },
    },
    turnRuntime: {
      async execute(input) {
        d.executions.push(input)
        recovered = await input.resolveOptions.recoverToolCall({ step: 0, toolCall: call, context: {} })
        return { turn: { status: 'completed' } }
      },
    },
  })

  await createAgentTurnResumer(d)(turn({ checkpoint: receiptCheckpoint(call) }))

  assert.deepEqual(reads, [{ userId: 'user-a', receiptId: 'receipt-1' }])
  assert.deepEqual(recovered, {
    message: '已创建生成任务',
    runId: 'run-1',
    jobIds: ['job-1', 'job-2'],
    artifacts: [{ id: 'artifact-1' }],
  })
  assert.doesNotMatch(
    JSON.stringify(recovered),
    /private\.example|provider-secret|机密提示词|完整推理|media-bytes|imageUrl|rawOutput|reasoning|providerResponse/u,
  )
})

test('Receipt 身份任一 owner/project/id/intent 不匹配都明确拒绝', async (t) => {
  const cases = [
    ['owner', { ownerId: 'user-other' }],
    ['project', { projectId: 'project-other' }],
    ['receiptId', { id: 'receipt-other' }],
    ['intentHash', { intentHash: 'intent-other' }],
  ]
  for (const [name, mismatch] of cases) {
    await t.test(name, async () => {
      const call = receiptCall()
      const d = deps({
        productStore: {
          async readAgentActionReceipt() {
            return {
              id: 'receipt-1', ownerId: 'user-a', projectId: 'project-a', intentHash: 'intent-1',
              status: 'succeeded', result: { runId: 'run-1' }, ...mismatch,
            }
          },
        },
        turnRuntime: {
          async execute(input) {
            d.executions.push(input)
            return input.resolveOptions.recoverToolCall({ step: 0, toolCall: call, context: {} })
          },
        },
      })
      await assert.rejects(
        () => createAgentTurnResumer(d)(turn({ checkpoint: receiptCheckpoint(call) })),
        (caught) => caught.code === 'AGENT_ACTION_RECEIPT_SCOPE_MISMATCH',
      )
    })
  }
})

test('running Receipt 在取得 Turn 执行权前安全等待，不触发恢复执行', async () => {
  const d = deps({
    productStore: {
      async readAgentActionReceipt() {
        return {
          id: 'receipt-1', ownerId: 'user-a', projectId: 'project-a', intentHash: 'intent-1',
          status: 'running',
        }
      },
    },
  })
  await assert.rejects(
    () => createAgentTurnResumer(d)(turn({ checkpoint: receiptCheckpoint() })),
    (caught) => caught.code === 'AGENT_ACTION_IN_PROGRESS',
  )
  assert.equal(d.executions.length, 0, '等待中的行动不能让 Runtime 把 Turn 收敛成 failed')
})

test('uncertain/failed/缺失 Receipt 分别返回稳定明确错误', async (t) => {
  const cases = [
    ['uncertain', { status: 'uncertain' }, 'AGENT_ACTION_OUTCOME_UNKNOWN'],
    ['failed', { status: 'failed', error: { code: 'RAW_PROVIDER_ERROR', message: 'provider secret' } }, 'AGENT_ACTION_FAILED'],
    ['missing', undefined, 'AGENT_ACTION_RECEIPT_NOT_FOUND'],
  ]
  for (const [name, receiptState, expectedCode] of cases) {
    await t.test(name, async () => {
      const call = receiptCall()
      const d = deps({
        productStore: {
          async readAgentActionReceipt() {
            return receiptState && {
              id: 'receipt-1', ownerId: 'user-a', projectId: 'project-a', intentHash: 'intent-1',
              ...receiptState,
            }
          },
        },
        turnRuntime: {
          async execute(input) {
            d.executions.push(input)
            return input.resolveOptions.recoverToolCall({ step: 0, toolCall: call, context: {} })
          },
        },
      })
      await assert.rejects(
        () => createAgentTurnResumer(d)(turn({ checkpoint: receiptCheckpoint(call) })),
        (caught) => caught.code === expectedCode && !/provider secret/u.test(caught.message),
      )
      assert.equal(d.executions.length, 1, '明确失败应进入 Runtime，由 fenced catch 持久化失败终态')
    })
  }
})
