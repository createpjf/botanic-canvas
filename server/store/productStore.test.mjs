import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentThreadContext } from '../agentThreadContext.mjs'
import { canonicalHash } from '../canonicalHash.mjs'
import { agentTurnRequestHash } from '../agent/turn/agentTurnRequestIdentity.mjs'
import { createAgentSkill, deprecateAgentSkill, updateAgentSkill } from '../botanicAgentSkill.mjs'
import { createAgentTurnRecord } from '../agent/turn/botanicAgentTurnRuntime.mjs'
import { createProductStore } from './productStore.mjs'

function document(id, name = '测试项目') {
  return {
    schemaVersion: 16,
    id,
    name,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [],
    templates: [],
    history: [],
    deliveries: [],
    generationJobs: [],
    updatedAt: Date.now(),
  }
}

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-product-store-'))
  return {
    path: join(directory, 'product.json'),
    store: createProductStore({ dataPath: join(directory, 'product.json'), bootstrapAccessToken: 'owner-token' }),
  }
}

test('updateProjectDocument 在锁内读最新文档并原子写回，无变更不 bump revision', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-atomic'), undefined)

  const saved = store.updateProjectDocument(owner.id, 'project-atomic', (current) => ({
    ...current,
    generationJobs: [{ id: 'job-atomic-1', status: 'succeeded', outputs: [] }],
    nodes: [...current.nodes, { id: 'agent-result-atomic', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'result', jobId: 'job-atomic-1' } }],
  }))
  assert.equal(saved.revision, 2)
  assert.equal(saved.document.generationJobs[0].id, 'job-atomic-1')
  assert.ok(saved.document.nodes.some((node) => node.id === 'agent-result-atomic'))
  const reread = store.readProject(owner.id, 'project-atomic')
  assert.equal(reread.revision, 2)
  assert.ok(reread.document.nodes.some((node) => node.id === 'agent-result-atomic'))

  // mutate 返回 undefined 表示无需写入：revision 不动，也不返回写结果。
  assert.equal(store.updateProjectDocument(owner.id, 'project-atomic', () => undefined), undefined)
  assert.equal(store.readProject(owner.id, 'project-atomic').revision, 2)
  assert.equal(store.updateProjectDocument(owner.id, 'missing-project', () => undefined), undefined)
})

test('项目、成员授权和审计会持久化到服务端数据文件', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)

  const created = store.writeProject(owner.id, document('project-a'), undefined)
  assert.equal(created.created, true)
  assert.equal(created.revision, 1)

  const member = store.createUser(owner.id, {
    email: 'designer@example.com',
    name: 'Designer',
    accessToken: 'designer-token',
  })
  store.addProjectMember(owner.id, 'project-a', member.id, 'editor')

  const designer = store.authenticate('designer-token')
  assert.ok(designer)
  const saved = store.writeProject(designer.id, { ...document('project-a'), name: '已授权项目' }, 2)
  assert.equal(saved.revision, 3)

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  const recovered = reloaded.readProject(designer.id, 'project-a')
  assert.equal(recovered?.document.name, '已授权项目')
  assert.equal(recovered?.revision, 3)
  assert.ok(reloaded.listAuditEvents(owner.id, 'project-a').some((event) => event.action === 'project.updated'))
})

test('项目 Skill 版本由领域快照权威生成，幂等重放不造新版本且弃用后仍可读历史', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-skill-a'), undefined)
  store.writeProject(owner.id, document('project-skill-b'), undefined)

  const domainSkill = createAgentSkill({
    projectId: 'project-skill-a',
    name: '夏日场景系列',
    instructions: '锁定人物和服装，只替换场景与环境光线。',
    capabilities: ['read'],
    manifest: { version: 1, toolAllowlist: ['canvas_read'], dependencies: [{ skillId: 'controlled_edit' }] },
  }, {
    id: 'skill-scene-campaign', ownerId: owner.id, approvedBy: owner.id, now: 100,
    riskOf: (name) => (name === 'canvas_read' ? 'read' : undefined),
  })
  const created = store.putAgentSkill(owner.id, domainSkill)
  const replayed = store.putAgentSkill(owner.id, domainSkill)

  assert.equal(created.name, '夏日场景系列')
  assert.equal(replayed.version, 1)
  assert.equal(replayed.versions.length, 1, '同一领域快照重放不得追加版本')
  // Manifest 必须真的落库：它决定 skill_run 要不要弹用户确认。字段在持久化边界上被
  // 悄悄丢掉的话，单元测试仍然全绿，而线上会退回「只按自称算风险」。
  assert.deepEqual(created.manifest.toolAllowlist, ['canvas_read'])
  assert.deepEqual(store.listAgentSkills(owner.id, 'project-skill-a').map((skill) => skill.id), ['skill-scene-campaign'])
  assert.deepEqual(store.listAgentSkills(owner.id, 'project-skill-b'), [])

  const revised = updateAgentSkill(created, {
    instructions: '锁定人物、服装与商品，只替换场景。',
  }, {
    actorId: owner.id, approvedBy: owner.id, now: 200,
    riskOf: (name) => (name === 'canvas_read' ? 'read' : undefined),
  })
  const storedRevision = store.putAgentSkill(owner.id, revised)
  store.putAgentSkill(owner.id, deprecateAgentSkill(storedRevision, { actorId: owner.id, now: 300 }))

  assert.deepEqual(store.listAgentSkills(owner.id, 'project-skill-a'), [], '弃用 Skill 不再进入活动目录')
  assert.equal(store.readAgentSkillVersion(owner.id, 'project-skill-a', created.id, 1)?.instructions, created.instructions)
  assert.equal(store.readAgentSkillVersion(owner.id, 'project-skill-a', created.id, 2)?.instructions, revised.instructions)
  assert.equal(store.readAgentSkillVersion(owner.id, 'project-skill-a', created.id, 3), undefined)
  assert.equal(store.readAgentSkillVersion(owner.id, 'project-skill-b', created.id, 1), undefined)

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(reloaded.readAgentSkillVersion(owner.id, 'project-skill-a', created.id, 1)?.instructions, created.instructions)
  assert.deepEqual(
    reloaded.readAgentSkillVersion(owner.id, 'project-skill-a', created.id, 2),
    { projectId: 'project-skill-a', skillId: created.id, ...revised.versions[1] },
    '完整历史版本跨重启仍在',
  )
  assert.ok(reloaded.listAuditEvents(owner.id, 'project-skill-a').some((event) => event.action === 'agent-skill.created'))
})

test('Agent Turn 与事件按幂等边界持久化，跨重启可恢复', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-turn'), undefined)
  const turn = {
    id: 'turn_project_1', version: 2, ownerId: owner.id, projectId: 'project-turn',
    idempotencyKey: 'request-1', status: 'running', createdAt: 100, updatedAt: 100,
  }
  store.putAgentTurn(owner.id, turn)
  store.appendAgentTurnEvent(owner.id, 'project-turn', {
    id: 'turn-event-1', turnId: turn.id, projectId: 'project-turn', sequence: 1,
    type: 'turn.started', createdAt: 101, payload: { status: 'running' },
  })
  const completed = { ...turn, status: 'completed', updatedAt: 102, result: { kind: 'chat', answer: '完成' } }
  store.putAgentTurn(owner.id, completed)
  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(reloaded.readAgentTurn(owner.id, turn.id)?.status, 'completed')
  assert.deepEqual(reloaded.listAgentTurnEvents(owner.id, 'project-turn', turn.id).map((event) => event.type), ['turn.started'])
  assert.equal(reloaded.listAgentTurnsForProject(owner.id, 'project-turn')[0]?.id, turn.id)
})

function durableSubagentDescriptor(overrides = {}) {
  return {
    role: 'brand_research',
    model: 'subagent-model',
    instructionsVersion: 'botanic-subagent-v2',
    outputKind: 'proposal',
    outputSchema: {
      type: 'object',
      required: ['summary'],
      properties: { summary: { type: 'string', maxLength: 2_000 } },
    },
    allowedTools: ['web_search'],
    budget: { maxSteps: 4, maxToolCalls: 8, timeoutMs: 60_000, maxActivations: 3 },
    capabilityHash: 'B'.repeat(43),
    ...overrides,
  }
}

function durableSubagentStartCommand(projectId, suffix = '1', overrides = {}) {
  const content = overrides.input?.content ?? '研究品牌在年轻市场的视觉机会。'
  return {
    kind: 'start',
    projectId,
    rootTurnId: `root-turn-${suffix}`,
    sourceTurnId: `root-turn-${suffix}`,
    parentSessionId: `primary-session-${suffix}`,
    idempotencyKey: `subagent-start-${suffix}`,
    input: { content },
    descriptor: durableSubagentDescriptor(),
    turn: {
      idempotencyKey: `subagent-turn-start-${suffix}`,
      request: { runtimeOperation: 'subagent', input: {} },
    },
    ...overrides,
  }
}

function putDurableSubagentRootTurn(store, ownerId, projectId, suffix = '1') {
  const turn = {
    id: `root-turn-${suffix}`,
    version: 2,
    ownerId,
    projectId,
    idempotencyKey: `root-turn-request-${suffix}`,
    status: 'completed',
    request: { runtimeOperation: 'plan', input: {} },
    createdAt: 90,
    updatedAt: 100,
  }
  store.putAgentTurn(ownerId, turn)
  return turn
}

function completeStoredTurn(store, ownerId, turn, suffix = '1') {
  const claimed = store.claimAgentTurnExecution(ownerId, {
    turn,
    leaseToken: `turn-lease-${suffix}`,
    leaseDurationMs: 30_000,
  })
  assert.equal(claimed.kind, 'claimed')
  const completed = store.commitAgentTurnExecution(ownerId, {
    id: turn.id,
    projectId: turn.projectId,
    leaseToken: `turn-lease-${suffix}`,
    executionGeneration: claimed.turn.execution.generation,
    status: 'completed',
    result: { answer: `Subagent 结果 ${suffix}` },
  })
  assert.equal(completed.kind, 'committed')
  return completed.turn
}

test('Durable Subagent start 原子创建 descriptor/FIFO/Session/Message/Turn，public 与 worker 读面隔离', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-subagent-a'), undefined)
  store.writeProject(owner.id, document('project-subagent-b'), undefined)
  putDurableSubagentRootTurn(store, owner.id, 'project-subagent-a')

  const started = store.enqueueAgentSubagentActivation(
    owner.id,
    durableSubagentStartCommand('project-subagent-a'),
  )
  assert.equal(started.kind, 'enqueued')
  assert.equal(started.activation.sequence, 1)
  assert.equal(started.subagent.ownerId, undefined)
  assert.equal(started.subagent.requestHash, undefined)
  assert.equal(started.activation.requestHash, undefined)

  const raw = store.readAgentSubagentForWorker(started.subagent.id)
  assert.equal(raw.ownerId, owner.id)
  assert.equal(typeof raw.requestHash, 'string')
  assert.equal(store.readAgentSubagent(owner.id, raw.id).requestHash, undefined)
  assert.deepEqual(store.listAgentSessions(owner.id, 'project-subagent-a'), [])
  assert.equal(store.listAgentSessions(owner.id, 'project-subagent-a', { includeSubagents: true })[0].kind, 'subagent')
  assert.equal(store.readAgentState(owner.id, 'project-subagent-a').sessions.length, 0)
  assert.equal(store.readAgentState(owner.id, 'project-subagent-a', { includeSubagents: true }).sessions.length, 1)

  const workerItems = store.listAgentSubagentActivationsForWorker(raw.id)
  assert.equal(workerItems.length, 1)
  assert.equal(workerItems[0].activation.sequence, 1)
  assert.equal(workerItems[0].turn.request.input.activationSequence, 1)
  assert.equal(workerItems[0].turn.request.input.cancelGeneration, 0)
  assert.equal(workerItems[0].turn.request.input.sessionId, raw.sessionId)
  assert.equal(workerItems[0].turn.request.input.inputMessage.id, workerItems[0].activation.inputMessageId)
  assert.equal(workerItems[0].turn.request.input.inputMessage.content, '研究品牌在年轻市场的视觉机会。')
  assert.equal(store.listAgentSubagentActivations(owner.id, raw.id)[0].execution, undefined)

  const member = store.createUser(owner.id, {
    email: 'subagent-member@example.com', name: 'Subagent Member', accessToken: 'subagent-member-token',
  })
  store.addProjectMember(owner.id, 'project-subagent-a', member.id, 'editor')
  assert.equal(store.readAgentSubagent(member.id, raw.id).id, raw.id, '项目成员可读取 public descriptor')
  const memberFollowup = store.enqueueAgentSubagentActivation(member.id, {
    kind: 'followup', projectId: 'project-subagent-a', subagentId: raw.id,
    sourceTurnId: 'root-turn-member-followup', idempotencyKey: 'member-followup',
    input: { content: '由项目 Editor 继续补充调研。' },
    turn: { idempotencyKey: 'member-followup-turn', request: { runtimeOperation: 'subagent', input: {} } },
  })
  assert.equal(memberFollowup.kind, 'enqueued')
  assert.equal(memberFollowup.activation.sequence, 2)
  assert.equal(store.listAgentSubagentActivations(member.id, raw.id).length, 2)
  assert.equal(store.readAgentSubagentForWorker(raw.id).ownerId, owner.id, 'Editor 操作不转移 descriptor owner')
  assert.deepEqual(
    store.listAgentSubagentsForRootTurnPage(owner.id, 'project-subagent-a', 'root-turn-1').map((item) => item.id),
    [raw.id],
  )
  assert.equal(store.enqueueAgentSubagentActivation(owner.id, {
    kind: 'followup', projectId: 'project-subagent-b', subagentId: raw.id,
    sourceTurnId: 'root-turn-other', idempotencyKey: 'cross-project-followup',
    input: { content: '跨项目继续。' },
    turn: { idempotencyKey: 'cross-project-turn', request: { runtimeOperation: 'subagent', input: {} } },
  }).kind, 'missing')

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(reloaded.readAgentSubagentForWorker(raw.id).lastEnqueuedSequence, 2)
  assert.equal(reloaded.listAgentSubagentActivationsForWorker(raw.id)[0].turn.id, workerItems[0].turn.id)
})

test('Durable Subagent root execution fence 拒绝旧 executor，takeover 后新 executor 可幂等重放', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-subagent-root-fence'
  store.writeProject(owner.id, document(projectId), undefined)
  const source = createAgentTurnRecord({
    id: 'root-turn-fence',
    ownerId: owner.id,
    projectId,
    idempotencyKey: 'root-turn-fence-request',
    request: { runtimeOperation: 'plan', input: {} },
    now: 100,
  })
  store.putAgentTurn(owner.id, {
    ...source,
    status: 'running',
    execution: {
      generation: 3,
      leaseToken: 'root-lease-old',
      leaseDurationMs: 30_000,
      leaseExpiresAt: 0,
      claimedAt: 100,
      lastHeartbeatAt: 100,
    },
  })
  const command = durableSubagentStartCommand(projectId, 'fence', {
    rootExecution: { generation: 3, leaseToken: 'root-lease-old' },
  })
  const started = store.enqueueAgentSubagentActivation(owner.id, command)
  assert.equal(started.kind, 'enqueued')

  const takeover = store.claimAgentTurnExecution(owner.id, {
    turn: source,
    leaseToken: 'root-lease-new',
    allowTakeover: true,
  })
  assert.equal(takeover.kind, 'claimed')
  assert.equal(takeover.turn.execution.generation, 4)
  assert.throws(
    () => store.enqueueAgentSubagentActivation(owner.id, command),
    (caught) => caught?.code === 'AGENT_SUBAGENT_ROOT_EXECUTION_STALE',
  )
  assert.equal(store.enqueueAgentSubagentActivation(owner.id, {
    ...command,
    rootExecution: { generation: 4, leaseToken: 'root-lease-new' },
  }).kind, 'replay')

  store.writeProject(owner.id, document('project-subagent-root-completed'), undefined)
  putDurableSubagentRootTurn(store, owner.id, 'project-subagent-root-completed', 'completed-external')
  assert.equal(store.enqueueAgentSubagentActivation(owner.id, durableSubagentStartCommand(
    'project-subagent-root-completed',
    'completed-external',
  )).kind, 'enqueued')
  assert.throws(
    () => store.enqueueAgentSubagentActivation(owner.id, durableSubagentStartCommand(
      'project-subagent-root-completed',
      'completed-external',
      { rootExecution: { generation: 4, leaseToken: 'root-lease-new' } },
    )),
    (caught) => caught?.code === 'AGENT_SUBAGENT_ROOT_EXECUTION_STALE',
  )

  store.writeProject(owner.id, document('project-subagent-root-queued'), undefined)
  const queuedRoot = createAgentTurnRecord({
    id: 'root-turn-queued', ownerId: owner.id, projectId: 'project-subagent-root-queued',
    idempotencyKey: 'root-turn-queued-request', request: { runtimeOperation: 'plan', input: {} }, now: 100,
  })
  store.putAgentTurn(owner.id, queuedRoot)
  assert.throws(
    () => store.enqueueAgentSubagentActivation(owner.id, durableSubagentStartCommand(
      'project-subagent-root-queued',
      'queued',
    )),
    (caught) => caught?.code === 'AGENT_SUBAGENT_ROOT_TURN_NOT_READY',
  )
})

test('Durable Subagent followup 重放/冲突保持 gapless，settle 原子写 assistant Message 并 handoff 下一项', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-subagent-followup'), undefined)
  putDurableSubagentRootTurn(store, owner.id, 'project-subagent-followup', 'followup')
  const started = store.enqueueAgentSubagentActivation(
    owner.id,
    durableSubagentStartCommand('project-subagent-followup', 'followup'),
  )
  const followupCommand = {
    kind: 'followup',
    projectId: 'project-subagent-followup',
    subagentId: started.subagent.id,
    sourceTurnId: 'root-turn-followup-2',
    idempotencyKey: 'subagent-followup-2',
    input: { content: '继续比较竞品 B。' },
    turn: {
      idempotencyKey: 'subagent-turn-followup-2',
      request: { runtimeOperation: 'subagent', input: {} },
    },
  }
  const followup = store.enqueueAgentSubagentActivation(owner.id, followupCommand)
  assert.equal(followup.kind, 'enqueued')
  assert.equal(followup.activation.sequence, 2)
  assert.equal(store.enqueueAgentSubagentActivation(owner.id, followupCommand).kind, 'replay')
  assert.equal(store.enqueueAgentSubagentActivation(owner.id, {
    ...followupCommand,
    input: { content: '同一个 key 改成不同输入。' },
  }).kind, 'conflict')
  assert.deepEqual(
    store.listAgentSubagentActivationsForWorker(started.subagent.id).map((item) => item.activation.sequence),
    [1, 2],
  )

  const claimed = store.claimAgentSubagentActivation({
    subagentId: started.subagent.id,
    activationId: started.activation.id,
    leaseToken: 'activation-lease-1',
    leaseDurationMs: 30_000,
  })
  assert.equal(claimed.kind, 'claimed')
  completeStoredTurn(store, owner.id, claimed.turn, 'followup-1')
  const settled = store.settleAgentSubagentActivation({
    subagentId: started.subagent.id,
    activationId: started.activation.id,
    leaseToken: 'activation-lease-1',
    executionGeneration: claimed.activation.execution.generation,
    cancelGeneration: claimed.subagent.cancelGeneration,
  })
  assert.equal(settled.kind, 'settled')
  assert.equal(settled.subagent.settledThroughSequence, 1)
  assert.equal(settled.nextActivation.activation.sequence, 2)
  assert.equal(settled.nextActivation.turn.id, followup.turn.id)

  const messages = store.listAgentSessionMessages(
    owner.id,
    'project-subagent-followup',
    store.readAgentSubagentForWorker(started.subagent.id).sessionId,
    { includeSubagents: true },
  ).messages
  assert.deepEqual(messages.map((message) => message.role), ['user', 'user', 'assistant'])
  assert.equal(messages.at(-1).id, `agent-turn-result-${claimed.turn.id}`)

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(reloaded.readAgentSubagentForWorker(started.subagent.id).settledThroughSequence, 1)
  assert.equal(reloaded.listAgentSessionMessages(
    owner.id,
    'project-subagent-followup',
    reloaded.readAgentSubagentForWorker(started.subagent.id).sessionId,
    { includeSubagents: true },
  ).messages.at(-1).content, 'Subagent 结果 followup-1')
})

test('Durable Subagent 取消 generation fence 可恢复，finalize 原子收口 terminal Turn 投影', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-subagent-cancel'), undefined)
  putDurableSubagentRootTurn(store, owner.id, 'project-subagent-cancel', 'cancel')
  const started = store.enqueueAgentSubagentActivation(
    owner.id,
    durableSubagentStartCommand('project-subagent-cancel', 'cancel'),
  )
  const claimed = store.claimAgentSubagentActivation({
    subagentId: started.subagent.id,
    activationId: started.activation.id,
    leaseToken: 'activation-cancel-lease',
  })
  completeStoredTurn(store, owner.id, claimed.turn, 'cancel-race')

  const requested = store.requestAgentSubagentCancellation(owner.id, {
    subagentId: started.subagent.id,
    projectId: 'project-subagent-cancel',
    signalId: 'cancel-signal-local',
    expectedCancelGeneration: 0,
  })
  assert.equal(requested.kind, 'requested')
  const rawCancelling = store.readAgentSubagentForWorker(started.subagent.id)
  assert.equal(rawCancelling.cancelGeneration, 1)
  assert.equal(rawCancelling.dispatch, undefined)
  assert.equal(store.listRunnableAgentSubagents().some((entry) => entry.subagent.id === started.subagent.id), true,
    '崩溃后 cancelling descriptor 仍可被恢复队列捞起')
  assert.equal(store.settleAgentSubagentActivation({
    subagentId: started.subagent.id,
    activationId: started.activation.id,
    leaseToken: 'activation-cancel-lease',
    executionGeneration: claimed.activation.execution.generation,
    cancelGeneration: 0,
  }).kind, 'cancelling')

  const finalized = store.finalizeAgentSubagentCancellation(owner.id, {
    subagentId: started.subagent.id,
    projectId: 'project-subagent-cancel',
    signalId: 'cancel-signal-local',
    cancelGeneration: 1,
  })
  assert.equal(finalized.kind, 'finalized')
  assert.equal(finalized.subagent.status, 'cancelled')
  assert.equal(finalized.subagent.settledThroughSequence, 1)
  assert.equal(store.listRunnableAgentSubagents().some((entry) => entry.subagent.id === started.subagent.id), false)
  const workerItem = store.listAgentSubagentActivationsForWorker(started.subagent.id)[0]
  assert.equal(workerItem.activation.status, 'completed')
  assert.equal(workerItem.activation.cancelGeneration, 1)
})

test('Agent 评审结论与人工决策跨重启保留，且按项目隔离', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-review'), undefined)
  store.putAgentRun(owner.id, {
    id: 'run-review', ownerId: owner.id, projectId: 'project-review', status: 'completed',
    plan: { intent: 'continue_generation', prompt: '测试', constraints: [], output: { mode: 'single', count: 1, candidatesPerItem: 1 } },
    branches: [], completedBranchCount: 0, failedBranchCount: 0, createdAt: 1, updatedAt: 1,
  })
  const review = store.putAgentReview(owner.id, {
    id: 'agent-review-run-review-zh-CN', projectId: 'project-review', runId: 'run-review', locale: 'zh-CN', version: 2,
    summary: '结果符合要求。', bestNodeId: 'result-a', items: [{ nodeId: 'result-a', branchLabel: '首图', verdict: 'pass', note: '主体稳定' }], status: 'pending', createdAt: 2, updatedAt: 2,
  })
  assert.equal(review.status, 'pending')
  const decided = store.putAgentReviewDecision(owner.id, 'project-review', review.id, 'accepted', '已确认')
  assert.equal(decided.status, 'accepted')
  assert.equal(decided.decidedBy, owner.id)
  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(reloaded.readAgentReview(owner.id, 'project-review', 'run-review')?.status, 'accepted')
})

test('Agent 行动回执按用户和项目持久化，重试可直接复用已完成结果', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-action'), undefined)
  const receipt = {
    id: 'agent_action_receipt_1', projectId: 'project-action', toolCallId: 'call-mcp-1',
    output: { message: '已完成', artifacts: [] },
    toolCall: { id: 'call-mcp-1', name: 'mcp_call', status: 'succeeded' },
    createdAt: 100,
  }

  assert.equal(store.readAgentActionReceipt(owner.id, receipt.id), undefined)
  store.putAgentActionReceipt(owner.id, receipt)
  assert.deepEqual(store.readAgentActionReceipt(owner.id, receipt.id), { ...receipt, ownerId: owner.id })

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(reloaded.readAgentActionReceipt(owner.id, receipt.id)?.output.message, '已完成')
})

test('Agent 行动回执在副作用前原子 claim，并用租约 Token 收口唯一结果', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-action-claim'), undefined)
  const claim = {
    id: 'agent_action_claim_1', projectId: 'project-action-claim', toolCallId: 'call-claim-1',
    actionName: 'mcp_call', intentHash: 'intent-1', replayPolicy: 'never', status: 'running',
    leaseToken: 'lease-1', leaseExpiresAt: 200, createdAt: 100, updatedAt: 100,
  }

  assert.equal(store.claimAgentActionReceipt(owner.id, claim).kind, 'claimed')
  assert.throws(
    () => store.claimAgentActionReceipt(owner.id, { ...claim, id: 'agent_action_missing_lease', leaseToken: '' }),
    (caught) => caught?.code === 'AGENT_ACTION_RECEIPT_INVALID',
  )
  assert.equal(store.claimAgentActionReceipt(owner.id, { ...claim, leaseToken: 'lease-2', updatedAt: 110 }).kind, 'in_progress')
  assert.equal(store.claimAgentActionReceipt(owner.id, { ...claim, intentHash: 'intent-other', updatedAt: 110 }).kind, 'conflict')

  const contextual = {
    ...claim, id: 'agent_action_contextual', actionBindingHash: 'binding-message-a',
    leaseToken: 'lease-contextual',
  }
  assert.equal(store.claimAgentActionReceipt(owner.id, contextual).kind, 'claimed')
  assert.equal(store.readAgentActionReceipt(owner.id, contextual.id).actionBindingHash, 'binding-message-a')
  assert.equal(store.claimAgentActionReceipt(owner.id, {
    ...contextual, actionBindingHash: 'binding-message-b', leaseToken: 'lease-forged',
  }).kind, 'conflict')
  assert.equal(store.claimAgentActionReceipt(owner.id, {
    ...contextual, actionBindingHash: undefined, leaseToken: 'lease-legacy',
  }).kind, 'conflict')
  assert.throws(
    () => store.settleAgentActionReceipt(owner.id, {
      id: claim.id, projectId: claim.projectId, leaseToken: 'lease-other', status: 'succeeded', result: { ok: true }, updatedAt: 120,
    }),
    (caught) => caught?.code === 'AGENT_ACTION_LEASE_STALE',
  )
  assert.throws(
    () => store.settleAgentActionReceipt(owner.id, {
      id: claim.id, projectId: claim.projectId, leaseToken: '', status: 'succeeded', result: { ok: true }, updatedAt: 120,
    }),
    (caught) => caught?.code === 'AGENT_ACTION_RECEIPT_INVALID',
  )

  const legacyDuringRun = store.putAgentActionReceipt(owner.id, {
    id: claim.id, projectId: claim.projectId, toolCallId: claim.toolCallId,
    result: { output: { pageId: 'legacy-overwrite' } }, createdAt: 120,
  })
  assert.equal(legacyDuringRun.status, 'running')
  assert.equal(store.readAgentActionReceipt(owner.id, claim.id).leaseToken, claim.leaseToken)

  const settled = store.settleAgentActionReceipt(owner.id, {
    id: claim.id, projectId: claim.projectId, leaseToken: claim.leaseToken,
    status: 'succeeded', result: { output: { pageId: 'page-1' } }, updatedAt: 130,
  })
  assert.equal(settled.status, 'succeeded')
  assert.equal(store.claimAgentActionReceipt(owner.id, { ...claim, leaseToken: 'lease-3', updatedAt: 140 }).kind, 'replay')
  assert.equal(store.readAgentActionReceipt(owner.id, claim.id).result.output.pageId, 'page-1')
  const immutableSuccess = store.putAgentActionReceipt(owner.id, {
    id: claim.id, projectId: claim.projectId, toolCallId: claim.toolCallId,
    result: { output: { pageId: 'legacy-overwrite' } }, createdAt: 150,
  })
  assert.equal(immutableSuccess.result.output.pageId, 'page-1')

  const expired = { ...claim, id: 'agent_action_expired', leaseToken: 'lease-expired', leaseExpiresAt: 150 }
  assert.equal(store.claimAgentActionReceipt(owner.id, expired).kind, 'claimed')
  const uncertain = store.claimAgentActionReceipt(owner.id, { ...expired, leaseToken: 'lease-new', updatedAt: 151 })
  assert.equal(uncertain.kind, 'uncertain')
  assert.equal(uncertain.receipt.status, 'uncertain')
  assert.equal(uncertain.receipt.error.code, 'AGENT_ACTION_OUTCOME_UNKNOWN')

  const safe = { ...claim, id: 'agent_action_safe_retry', replayPolicy: 'safe' }
  assert.equal(store.claimAgentActionReceipt(owner.id, safe).kind, 'claimed')
  store.settleAgentActionReceipt(owner.id, {
    id: safe.id, projectId: safe.projectId, leaseToken: safe.leaseToken,
    status: 'failed', error: { code: 'VALIDATION_FAILED', message: '明确失败' }, updatedAt: 120,
  })
  const retried = store.claimAgentActionReceipt(owner.id, {
    ...safe, leaseToken: 'lease-retry', leaseExpiresAt: 260, updatedAt: 160,
  })
  assert.equal(retried.kind, 'claimed')
  assert.equal(retried.receipt.leaseToken, 'lease-retry')
  assert.equal(retried.receipt.error, undefined)

  const editor = store.createUser(owner.id, {
    email: 'action-editor@example.com', name: 'Action Editor', accessToken: 'action-editor-token',
  })
  store.addProjectMember(owner.id, claim.projectId, editor.id, 'editor')
  const revoked = { ...claim, id: 'agent_action_revoked_after_claim', leaseToken: 'lease-revoked' }
  assert.equal(store.claimAgentActionReceipt(editor.id, revoked).kind, 'claimed')
  store.addProjectMember(owner.id, claim.projectId, editor.id, 'viewer')
  assert.equal(store.settleAgentActionReceipt(editor.id, {
    id: revoked.id, projectId: revoked.projectId, leaseToken: revoked.leaseToken,
    status: 'succeeded', result: { output: { ok: true } }, updatedAt: 180,
  }).status, 'succeeded', 'claim 后撤权仍必须允许原租约持有者收口已发生的副作用')
})

test('Agent 行动 uncertain 决议与一次性重试授权在本地 Store 原子持久化', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-action-reconcile'
  store.writeProject(owner.id, document(projectId), undefined)
  const claim = {
    id: 'receipt-reconcile-1', projectId, toolCallId: 'call-1', actionName: 'mcp_call',
    intentHash: 'intent-1', replayPolicy: 'never', leaseToken: 'lease-1', leaseDurationMs: 60_000,
  }
  store.claimAgentActionReceipt(owner.id, claim)
  store.settleAgentActionReceipt(owner.id, {
    id: claim.id, projectId, leaseToken: claim.leaseToken, status: 'uncertain',
    error: { code: 'AGENT_ACTION_OUTCOME_UNKNOWN', message: '未知' },
  })
  const resolution = {
    id: claim.id, projectId, toolCallId: claim.toolCallId, actionName: claim.actionName,
    intentHash: claim.intentHash, actionBindingHash: 'binding-1', decision: 'confirmed_not_applied',
    manualRetryAuthorization: {
      version: 1, id: 'auth-1', receiptId: claim.id, intentHash: claim.intentHash,
      actionBindingHash: 'binding-1', userId: owner.id, projectId, actionId: 'action-1',
      tokenHash: 'token-hash-1', tokenHint: 'abcd', issuedAt: 100, expiresAt: 1_100,
    },
  }

  const resolved = store.resolveAgentActionReceipt(owner.id, resolution)
  assert.equal(resolved.kind, 'resolved')
  assert.equal(resolved.receipt.status, 'failed')
  assert.equal(store.resolveAgentActionReceipt(owner.id, resolution).kind, 'replay')
  const consumption = {
    id: claim.id, projectId, actionId: 'action-1', toolCallId: claim.toolCallId,
    actionName: claim.actionName, intentHash: claim.intentHash, actionBindingHash: 'binding-1',
    tokenHash: 'token-hash-1', retryReceiptId: 'receipt-retry-1',
  }
  assert.equal(store.consumeAgentActionManualRetryAuthorization(owner.id, consumption).kind, 'consumed')
  assert.equal(store.consumeAgentActionManualRetryAuthorization(owner.id, consumption).kind, 'replay')
  assert.equal(store.consumeAgentActionManualRetryAuthorization(owner.id, {
    ...consumption, retryReceiptId: 'receipt-retry-2',
  }).kind, 'already_consumed')

  const malformedClaim = { ...claim, id: 'receipt-reconcile-malformed', leaseToken: 'lease-malformed' }
  store.claimAgentActionReceipt(owner.id, malformedClaim)
  store.settleAgentActionReceipt(owner.id, {
    id: malformedClaim.id, projectId, leaseToken: malformedClaim.leaseToken, status: 'uncertain',
    error: { code: 'AGENT_ACTION_OUTCOME_UNKNOWN', message: '未知' },
  })
  const malformedAuthorization = { ...resolution.manualRetryAuthorization, receiptId: malformedClaim.id }
  delete malformedAuthorization.issuedAt
  assert.equal(store.resolveAgentActionReceipt(owner.id, {
    ...resolution, id: malformedClaim.id, manualRetryAuthorization: malformedAuthorization,
  }).kind, 'invalid', 'Adapter 不能用默认 TTL 把缺 issuedAt 的授权修成合法授权')

  const audit = store.listAuditEvents(owner.id, projectId)
  assert.equal(audit.some((event) => event.action === 'agent-action.reconciled'), true)
  assert.equal(audit.some((event) => event.action === 'agent-action.manual-retry-consumed'), true)
  assert.equal(JSON.stringify(audit).includes('token-hash-1'), false, 'Audit 不得保存授权摘要')
})

test('Agent 行动 v2 重试授权由 Store 时钟预绑定新 Receipt 并支持 tokenless 恢复', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-action-reconcile-v2'
  store.writeProject(owner.id, document(projectId), undefined)
  const claim = {
    id: 'receipt-reconcile-v2', projectId, toolCallId: 'call-v2', actionName: 'mcp_call',
    intentHash: 'intent-v2', actionBindingHash: 'binding-v2', replayPolicy: 'never',
    leaseToken: 'lease-v2', leaseDurationMs: 60_000,
  }
  store.claimAgentActionReceipt(owner.id, claim)
  store.settleAgentActionReceipt(owner.id, {
    id: claim.id, projectId, leaseToken: claim.leaseToken, status: 'uncertain',
    error: { code: 'AGENT_ACTION_OUTCOME_UNKNOWN', message: '未知' },
  })
  const requestedTtlMs = 10_000
  const resolved = store.resolveAgentActionReceipt(owner.id, {
    id: claim.id, projectId, toolCallId: claim.toolCallId, actionName: claim.actionName,
    intentHash: claim.intentHash, actionBindingHash: claim.actionBindingHash,
    decision: 'confirmed_not_applied',
    manualRetryAuthorization: {
      version: 2, id: 'auth-v2', receiptId: claim.id, intentHash: claim.intentHash,
      actionBindingHash: claim.actionBindingHash, userId: owner.id, projectId,
      actionId: 'action-v2', boundRetryReceiptId: 'receipt-retry-v2',
      reservedAt: 100, expiresAt: 100 + requestedTtlMs,
    },
  })
  assert.equal(resolved.kind, 'resolved')
  const authorization = resolved.receipt.manualRetryAuthorization
  assert.equal(authorization.version, 2)
  assert.equal(authorization.boundRetryReceiptId, 'receipt-retry-v2')
  assert.equal(authorization.expiresAt - authorization.reservedAt, requestedTtlMs)
  assert.equal(authorization.issuedAt, undefined)
  assert.equal(authorization.tokenHash, undefined)

  const consumption = {
    id: claim.id, projectId, actionId: 'action-v2', toolCallId: claim.toolCallId,
    actionName: claim.actionName, intentHash: claim.intentHash,
    actionBindingHash: claim.actionBindingHash, retryReceiptId: 'receipt-retry-v2',
  }
  assert.equal(store.consumeAgentActionManualRetryAuthorization(owner.id, consumption).kind, 'consumed')
  assert.equal(store.consumeAgentActionManualRetryAuthorization(owner.id, consumption).kind, 'replay')
  assert.equal(store.consumeAgentActionManualRetryAuthorization(owner.id, {
    ...consumption, retryReceiptId: 'receipt-retry-v2-other',
  }).kind, 'already_consumed')
  assert.equal(JSON.stringify(store.listAuditEvents(owner.id, projectId)).includes('tokenHash'), false)
})

test('Agent Turn 用原子 claim 与 fenced commit 保存 checkpoint、事件和唯一终态', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-turn-claim'), undefined)
  const turn = {
    id: 'turn-claim-1', version: 2, ownerId: owner.id, projectId: 'project-turn-claim',
    idempotencyKey: 'turn-intent-1', requestHash: 'request-1', status: 'queued',
    createdAt: 100, updatedAt: 100,
  }
  const first = store.claimAgentTurnExecution(owner.id, {
    turn, leaseToken: 'turn-lease-1', leaseDurationMs: 120_000,
  })
  assert.equal(first.kind, 'claimed')
  assert.equal(first.turn.execution.generation, 1)
  assert.equal(store.claimAgentTurnExecution(owner.id, {
    turn, leaseToken: 'turn-lease-2', leaseDurationMs: 120_000,
  }).kind, 'in_progress')

  const event = {
    id: 'turn-event-1', turnId: turn.id, projectId: turn.projectId,
    type: 'turn.tool', createdAt: 200,
    payload: { toolName: 'project_read', status: 'succeeded', risk: 'read' },
  }
  const checkpointed = store.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId: turn.projectId, leaseToken: 'turn-lease-1', executionGeneration: 1,
    status: 'running', checkpoint: { version: 1, nextStep: 1 }, event,
  })
  assert.equal(checkpointed.kind, 'committed')
  assert.equal(checkpointed.turn.checkpoint.nextStep, 1)
  assert.equal(checkpointed.event.sequence, 1)
  assert.equal(store.listAgentTurnEvents(owner.id, turn.projectId, turn.id)[0].id, event.id)

  const outputPreview = { version: 1, attemptId: 'text', revision: 1, step: 0, text: '运行中', updatedAt: 201 }
  const previewEvent = {
    id: 'turn-preview-1', turnId: turn.id, projectId: turn.projectId,
    type: 'turn.output_preview.updated', createdAt: 201,
    payload: { revision: 1, attemptId: 'text', step: 0, charCount: 3 },
  }
  const previewed = store.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId: turn.projectId, leaseToken: 'turn-lease-1', executionGeneration: 1,
    status: 'running', outputPreview, event: previewEvent,
  })
  assert.equal(previewed.kind, 'committed')
  assert.equal(previewed.turn.outputPreview.text, '运行中')
  assert.equal(previewed.event.sequence, 2)
  assert.equal(store.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId: turn.projectId, leaseToken: 'turn-lease-1', executionGeneration: 1,
    status: 'running', outputPreview, event: previewEvent,
  }).kind, 'replay')

  const stale = store.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId: turn.projectId, leaseToken: 'turn-lease-old', executionGeneration: 1,
    status: 'completed', result: { kind: 'chat' },
  })
  assert.equal(stale.kind, 'stale')
  assert.equal(store.readAgentTurn(owner.id, turn.id).status, 'running')

  const completed = store.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId: turn.projectId, leaseToken: 'turn-lease-1', executionGeneration: 1,
    status: 'completed', result: { kind: 'chat', answer: '完成' },
  })
  assert.equal(completed.kind, 'committed')
  assert.equal(store.readAgentTurn(owner.id, turn.id).result.answer, '完成')
  assert.equal(store.readAgentTurn(owner.id, turn.id).outputPreview, undefined)
  assert.equal(store.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId: turn.projectId, leaseToken: 'turn-lease-1', executionGeneration: 1,
    status: 'completed', result: { kind: 'chat', answer: '不能覆盖' },
  }).turn.result.answer, '完成', '终态重试只能重放第一次提交')
})

test('本地 Adapter 在 claim 内从 legacy Turn 请求回填摘要并拒绝新意图', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-turn-legacy-hash'
  store.writeProject(owner.id, document(projectId), undefined)
  const storedRequest = {
    projectId, sessionId: 'session-1',
    inputMessage: { id: 'message-1', content: '原始输入' },
    messages: [{ role: 'user', content: '首次窗口' }],
  }
  const legacy = {
    id: 'turn-local-legacy-hash', version: 2, ownerId: owner.id, projectId,
    idempotencyKey: 'legacy-key', request: storedRequest,
    status: 'queued', createdAt: 100, updatedAt: 100,
  }
  store.putAgentTurn(owner.id, legacy)
  const replayRequest = { ...storedRequest, messages: [{ role: 'assistant', content: '后续窗口' }] }
  const candidate = {
    ...legacy,
    request: replayRequest,
    requestHash: agentTurnRequestHash(replayRequest, 2),
    requestHashVersion: 2,
  }

  const claimed = store.claimAgentTurnExecution(owner.id, { turn: candidate, leaseToken: 'lease-1' })
  assert.equal(claimed.kind, 'claimed')
  assert.equal(store.readAgentTurn(owner.id, legacy.id).requestHash, candidate.requestHash)
  assert.deepEqual(store.readAgentTurn(owner.id, legacy.id).request, storedRequest)

  const conflictingRequest = {
    ...storedRequest,
    inputMessage: { ...storedRequest.inputMessage, content: '另一条新输入' },
  }
  assert.equal(store.claimAgentTurnExecution(owner.id, {
    turn: {
      ...candidate,
      request: conflictingRequest,
      requestHash: agentTurnRequestHash(conflictingRequest, 2),
    },
    leaseToken: 'lease-2',
  }).kind, 'conflict')
})

test('Agent Turn waiting_user 可取消并由独立原子方法收口 cancelled', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-turn-finalize-cancel'
  store.writeProject(owner.id, document(projectId), undefined)
  const turn = {
    id: 'turn-finalize-cancel-1', version: 2, projectId, idempotencyKey: 'turn-finalize-1',
    requestHash: 'turn-finalize-request', requestHashVersion: 2,
    status: 'queued', createdAt: 100, updatedAt: 100,
  }
  const claimed = store.claimAgentTurnExecution(owner.id, { turn, leaseToken: 'lease-1' })
  store.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId, leaseToken: 'lease-1', executionGeneration: claimed.turn.execution.generation,
    status: 'running',
    outputPreview: { version: 1, attemptId: 'plan', revision: 1, step: 0, text: '待确认前预览', updatedAt: 101 },
    event: {
      id: 'turn-preview-waiting-1', turnId: turn.id, projectId,
      type: 'turn.output_preview.updated', payload: { revision: 1, attemptId: 'plan', step: 0, charCount: 6 },
    },
  })
  const waiting = store.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId, leaseToken: 'lease-1', executionGeneration: claimed.turn.execution.generation,
    status: 'waiting_user', result: { kind: 'clarification', question: '请选择' },
  })
  assert.equal(waiting.turn.status, 'waiting_user')
  assert.equal(waiting.turn.outputPreview, undefined)
  assert.equal(store.claimAgentTurnExecution(owner.id, { turn, leaseToken: 'lease-2' }).kind, 'waiting_user')

  store.requestAgentTurnCancellation(owner.id, {
    id: turn.id, projectId,
    event: { id: 'turn-cancelling-1', turnId: turn.id, projectId, type: 'turn.cancelling' },
  })
  const finalized = store.finalizeAgentTurnCancellation(owner.id, {
    id: turn.id, projectId,
    event: { id: 'turn-cancelled-1', turnId: turn.id, projectId, type: 'turn.cancelled' },
  })
  assert.equal(finalized.kind, 'finalized')
  assert.equal(finalized.turn.status, 'cancelled')
  assert.equal(finalized.event.sequence, 3)
  assert.equal(store.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId, leaseToken: 'lease-1', executionGeneration: claimed.turn.execution.generation,
    status: 'completed', result: { kind: 'chat', answer: '迟到结果' },
  }).kind, 'stale')
  const eventCount = store.listAgentTurnEvents(owner.id, projectId, turn.id).length
  const replay = store.finalizeAgentTurnCancellation(owner.id, {
    id: turn.id, projectId,
    event: { id: 'turn-cancelled-other', turnId: turn.id, projectId, type: 'turn.cancelled' },
  })
  assert.equal(replay.kind, 'replay')
  assert.equal(replay.event, undefined)
  assert.equal(store.listAgentTurnEvents(owner.id, projectId, turn.id).length, eventCount)
})

test('本地 Adapter durable 保存 cancelling heartbeat 与 worker_exit ack，错误 fence 不写且 ack 后才收口', async () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-turn-cancellation-ack'
  store.writeProject(owner.id, document(projectId), undefined)
  const turn = {
    id: 'turn-cancellation-ack-1', version: 2, projectId,
    idempotencyKey: 'turn-cancellation-ack-key', requestHash: 'turn-cancellation-ack-request',
    requestHashVersion: 2, status: 'queued', createdAt: 100, updatedAt: 100,
  }
  const claimed = store.claimAgentTurnExecution(owner.id, {
    turn, leaseToken: 'turn-cancellation-lease', leaseDurationMs: 30_000,
  })
  const generation = claimed.turn.execution.generation
  const requested = store.requestAgentTurnCancellation(owner.id, {
    id: turn.id, projectId,
    event: { id: 'turn-cancelling-ack-1', turnId: turn.id, projectId, type: 'turn.cancelling' },
  })
  const signalId = requested.turn.cancellation.signalId
  const beforeInvalidCommits = store.readAgentTurn(owner.id, turn.id)

  for (const invalidFence of [
    { signalId: 'wrong-signal', leaseToken: 'turn-cancellation-lease', executionGeneration: generation },
    { signalId, leaseToken: 'wrong-token', executionGeneration: generation },
    { signalId, leaseToken: 'turn-cancellation-lease', executionGeneration: generation + 1 },
  ]) {
    assert.equal(store.commitAgentTurnExecution(owner.id, {
      id: turn.id, projectId, status: 'running', ...invalidFence,
    }).kind, 'stale')
    assert.deepEqual(store.readAgentTurn(owner.id, turn.id), beforeInvalidCommits)
  }

  await new Promise((resolve) => setTimeout(resolve, 2))
  const heartbeat = store.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId, status: 'running', signalId,
    leaseToken: 'turn-cancellation-lease', executionGeneration: generation,
    event: { id: 'turn-heartbeat-must-not-persist', turnId: turn.id, projectId, type: 'turn.tool' },
  })
  assert.equal(heartbeat.kind, 'cancellation_heartbeat')
  assert.ok(heartbeat.turn.execution.leaseExpiresAt > beforeInvalidCommits.execution.leaseExpiresAt)
  const afterHeartbeat = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(afterHeartbeat.readAgentTurn(owner.id, turn.id).execution.leaseExpiresAt, heartbeat.turn.execution.leaseExpiresAt)
  assert.equal(afterHeartbeat.readAgentTurn(owner.id, turn.id).cancellation.lastHeartbeatAt, heartbeat.turn.cancellation.lastHeartbeatAt)
  assert.deepEqual(afterHeartbeat.listAgentTurnEvents(owner.id, projectId, turn.id).map((event) => event.id), ['turn-cancelling-ack-1'])

  const pending = afterHeartbeat.finalizeAgentTurnCancellation(owner.id, {
    id: turn.id, projectId,
    event: { id: 'turn-cancelled-too-early', turnId: turn.id, projectId, type: 'turn.cancelled' },
  })
  assert.equal(pending.kind, 'pending')
  assert.equal(afterHeartbeat.readAgentTurn(owner.id, turn.id).status, 'cancelling')
  const auditsBeforeAck = afterHeartbeat.listAuditEvents(owner.id, projectId).length

  const acknowledged = afterHeartbeat.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId, status: 'running', signalId, releaseBasis: 'worker_exit',
    leaseToken: 'turn-cancellation-lease', executionGeneration: generation,
    event: { id: 'turn-ack-must-not-persist', turnId: turn.id, projectId, type: 'turn.tool' },
  })
  assert.equal(acknowledged.kind, 'cancellation_acknowledged')
  const afterAck = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(afterAck.readAgentTurn(owner.id, turn.id).cancellation.workerReleased, true)
  assert.equal(afterAck.readAgentTurn(owner.id, turn.id).cancellation.releaseBasis, 'worker_exit')
  assert.equal(afterAck.listAuditEvents(owner.id, projectId).length, auditsBeforeAck)
  assert.deepEqual(afterAck.listAgentTurnEvents(owner.id, projectId, turn.id).map((event) => event.id), ['turn-cancelling-ack-1'])
  const acknowledgedSnapshot = afterAck.readAgentTurn(owner.id, turn.id)
  assert.equal(afterAck.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId, status: 'running', signalId, releaseBasis: 'worker_exit',
    leaseToken: 'turn-cancellation-lease', executionGeneration: generation,
  }).kind, 'replay')
  assert.equal(afterAck.commitAgentTurnExecution(owner.id, {
    id: turn.id, projectId, status: 'running', signalId,
    leaseToken: 'turn-cancellation-lease', executionGeneration: generation,
  }).kind, 'stale')
  assert.deepEqual(afterAck.readAgentTurn(owner.id, turn.id), acknowledgedSnapshot)

  const finalized = afterAck.finalizeAgentTurnCancellation(owner.id, {
    id: turn.id, projectId,
    event: { id: 'turn-cancelled-after-ack', turnId: turn.id, projectId, type: 'turn.cancelled' },
  })
  assert.equal(finalized.kind, 'finalized')
  const recovered = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(recovered.readAgentTurn(owner.id, turn.id).status, 'cancelled')
  assert.deepEqual(
    recovered.listAgentTurnEvents(owner.id, projectId, turn.id).map((event) => event.id),
    ['turn-cancelling-ack-1', 'turn-cancelled-after-ack'],
  )
})

test('工作区所有者可管理成员，停用后会话立即失效但项目保留', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  store.writeProject(owner.id, document('project-members'), undefined)
  const member = store.createUser(owner.id, {
    email: 'member@example.com',
    name: 'Member',
    accessToken: 'member-token',
  })
  store.addProjectMember(owner.id, 'project-members', member.id, 'editor')

  assert.deepEqual(
    store.listUsers(owner.id).map((user) => ({ email: user.email, role: user.role, status: user.status })),
    [
      { email: owner.email, role: 'owner', status: 'active' },
      { email: 'member@example.com', role: 'member', status: 'active' },
    ],
  )
  assert.throws(() => store.listUsers(member.id), (error) => error?.code === 'USER_MANAGE_FORBIDDEN')

  const disabled = store.updateUser(owner.id, member.id, { status: 'disabled' })
  assert.equal(disabled.status, 'disabled')
  assert.equal(store.authenticate('member-token'), undefined)
  assert.equal(store.readProject(owner.id, 'project-members')?.document.id, 'project-members')
})

test('工作区必须保留至少一名启用的所有者', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)

  assert.throws(
    () => store.updateUser(owner.id, owner.id, { status: 'disabled' }),
    (error) => error?.code === 'LAST_OWNER_REQUIRED',
  )
  assert.throws(
    () => store.updateUser(owner.id, owner.id, { role: 'member' }),
    (error) => error?.code === 'LAST_OWNER_REQUIRED',
  )
})

test('对象级授权能区分项目不存在与跨账号访问', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-private'), undefined)
  const outsider = store.createUser(owner.id, {
    email: 'outsider@example.com',
    name: 'Outsider',
    accessToken: 'outsider-token',
  })

  assert.deepEqual(store.projectAccess(outsider.id, 'project-private'), { exists: true, role: undefined })
  assert.deepEqual(store.projectAccess(outsider.id, 'missing-project'), { exists: false, role: undefined })
  assert.throws(
    () => store.writeProject(outsider.id, { ...document('project-private'), name: '越权修改' }, 1),
    (error) => error?.code === 'PROJECT_WRITE_FORBIDDEN',
  )
})

test('Viewer 只能读取，Editor 可编辑但不能管理成员或读取敏感审计', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-rbac'), undefined)
  const editor = store.createUser(owner.id, { email: 'editor@example.com', accessToken: 'editor-token' })
  const viewer = store.createUser(owner.id, { email: 'viewer@example.com', accessToken: 'viewer-token' })
  store.addProjectMember(owner.id, 'project-rbac', editor.id, 'editor')
  store.addProjectMember(owner.id, 'project-rbac', viewer.id, 'viewer')

  assert.equal(store.readProject(viewer.id, 'project-rbac')?.document.id, 'project-rbac')
  assert.equal(store.canEditProject(viewer.id, 'project-rbac'), false)
  assert.equal(store.canEditProject(editor.id, 'project-rbac'), true)
  assert.throws(
    () => store.addProjectMember(editor.id, 'project-rbac', viewer.id, 'editor'),
    (error) => error?.code === 'PROJECT_MEMBER_FORBIDDEN',
  )
  assert.throws(
    () => store.listAuditEvents(editor.id, 'project-rbac'),
    (error) => error?.code === 'PROJECT_AUDIT_FORBIDDEN',
  )
  assert.ok(store.listAuditEvents(owner.id, 'project-rbac').length > 0)
})

test('工作区成员不能修改全局素材库，Owner 可查看敏感操作审计', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-workspace'), undefined)
  const member = store.createUser(owner.id, { email: 'member-library@example.com', accessToken: 'member-library-token' })
  store.addProjectMember(owner.id, 'project-workspace', member.id, 'editor')
  const library = { id: 'global-brand-assets', assets: [{ id: 'asset-a' }], updatedAt: Date.now() }

  assert.throws(
    () => store.writeGlobalAssetLibrary(member.id, library),
    (error) => error?.code === 'LIBRARY_WRITE_FORBIDDEN',
  )
  store.writeGlobalAssetLibrary(owner.id, library)
  store.deleteGlobalAsset(owner.id, 'asset-a')
  store.recordSecurityAuditEvent(owner.id, 'security.mfa.enabled')

  const actions = store.listWorkspaceAuditEvents(owner.id).map((event) => event.action)
  assert.ok(actions.includes('brand-asset.deleted'))
  assert.ok(actions.includes('security.mfa.enabled'))
  assert.throws(
    () => store.listWorkspaceAuditEvents(member.id),
    (error) => error?.code === 'WORKSPACE_AUDIT_FORBIDDEN',
  )
})

test('项目列表返回真实结果封面与画布摘要', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  store.writeProject(owner.id, {
    ...document('project-summary', '有封面项目'),
    nodes: [
      { id: 'asset-1', type: 'asset', data: {} },
      { id: 'result-1', type: 'result', data: { image: 'https://example.com/first.png' } },
      { id: 'result-2', type: 'result', data: { image: 'https://example.com/latest.png' } },
    ],
  }, undefined)

  const [summary] = store.listProjects(owner.id)
  assert.equal(summary.document, undefined)
  assert.deepEqual({
    id: summary.id,
    name: summary.name,
    nodeCount: summary.nodeCount,
    resultCount: summary.resultCount,
    coverImage: summary.coverImage,
  }, {
    id: 'project-summary',
    name: '有封面项目',
    nodeCount: 3,
    resultCount: 2,
    coverImage: 'https://example.com/latest.png',
  })
})

test('仅项目所有者可以永久删除项目及其任务', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  store.writeProject(owner.id, document('project-remove'), undefined)
  store.putGenerationJob(owner.id, {
    id: 'remove-job', projectId: 'project-remove', status: 'queued', kind: 'generation', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, rawInput: { projectId: 'project-remove' }, outputs: [], createdAt: Date.now(),
  })

  assert.equal(store.deleteProject(owner.id, 'project-remove'), true)
  assert.equal(store.readProject(owner.id, 'project-remove'), undefined)
  assert.equal(store.readGenerationJob(owner.id, 'remove-job'), undefined)
})

test('项目任务清单仅返回当前用户在当前项目的真实任务', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  store.writeProject(owner.id, document('project-jobs'), undefined)
  store.writeProject(owner.id, document('project-other'), undefined)
  store.putGenerationJob(owner.id, {
    id: 'job-current', projectId: 'project-jobs', status: 'succeeded', kind: 'generation', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, rawInput: { projectId: 'project-jobs' },
    outputs: [{ id: 'output-current', image: '/api/media/current' }], createdAt: Date.now(),
  })
  store.putGenerationJob(owner.id, {
    id: 'job-other', projectId: 'project-other', status: 'succeeded', kind: 'generation', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, rawInput: { projectId: 'project-other' },
    outputs: [{ id: 'output-other', image: '/api/media/other' }], createdAt: Date.now(),
  })

  assert.deepEqual(store.listGenerationJobsForProject(owner.id, 'project-jobs')?.map((job) => job.id), ['job-current'])
  assert.equal(store.listGenerationJobsForProject(owner.id, 'missing-project'), undefined)
})

test('Agent Run 独立于画布文档持久化并由生成 Job 推进', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  store.writeProject(owner.id, document('project-agent'), undefined)
  store.putAgentRun(owner.id, {
    id: 'run-agent', ownerId: owner.id, projectId: 'project-agent', status: 'queued',
    plan: { intent: 'replace_scene', instruction: '换场景', summary: '换场景', selectedResultNodeId: 'result-1', output: { mode: 'single', count: 1, candidatesPerItem: 1 } },
    branches: [{ id: 'branch-1', label: '新场景', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 10 }],
    completedBranchCount: 0, failedBranchCount: 0, createdAt: 10, updatedAt: 10,
  })
  store.putGenerationJob(owner.id, {
    id: 'job-agent', projectId: 'project-agent', status: 'succeeded', kind: 'refinement', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, rawInput: { projectId: 'project-agent' },
    agentRun: { runId: 'run-agent', branchId: 'branch-1' }, outputs: [{ id: 'output-1', image: '/api/media/output-1' }], createdAt: 20, updatedAt: 30,
  })

  assert.equal(store.readAgentRun(owner.id, 'run-agent')?.status, 'completed')
  assert.equal(store.listAgentRunsForProject(owner.id, 'project-agent')?.[0].branches[0].activeJobId, 'job-agent')
  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(reloaded.readAgentRun(owner.id, 'run-agent')?.completedBranchCount, 1)
})

test('Agent Run 独立实体不被新旧兼容文档回退，首次迁移仍可建立实体', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  const legacyPlan = {
    intent: 'replace_scene', instruction: '换场景', summary: '换场景', selectedResultNodeId: 'result-1',
    rootRecipe: { prompt: '保留的完整配方' },
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
  }
  const legacyRun = {
    id: 'run-compat-authority', status: 'awaiting_confirmation', plan: legacyPlan,
    branches: [], createdAt: 10, updatedAt: 10,
  }
  store.writeProject(owner.id, {
    ...document('project-agent-run-authority'), agentSessions: [], agentMemory: [], agentRuns: [legacyRun],
  }, undefined)
  assert.equal(store.readAgentRun(owner.id, legacyRun.id)?.status, 'awaiting_confirmation')

  store.putAgentRun(owner.id, {
    ...legacyRun, ownerId: owner.id, projectId: 'project-agent-run-authority', status: 'running', updatedAt: 100,
  })
  const saved = store.readProject(owner.id, 'project-agent-run-authority')
  store.writeProject(owner.id, {
    ...saved.document,
    agentRuns: [{ ...legacyRun, status: 'awaiting_confirmation', updatedAt: 500 }],
    updatedAt: 500,
  }, saved.revision, saved.graphRevision)

  assert.equal(store.readAgentRun(owner.id, legacyRun.id)?.status, 'running')
  const hydratedRun = store.readProject(owner.id, 'project-agent-run-authority').document.agentRuns[0]
  assert.equal(hydratedRun.status, 'running')
  assert.equal(hydratedRun.plan.rootRecipe.prompt, '保留的完整配方')
})

test('putAgentRun 拒绝迟到旧快照和待确认状态回退', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  store.writeProject(owner.id, { ...document('project-agent-run-lww'), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  const base = {
    id: 'run-lww', ownerId: owner.id, projectId: 'project-agent-run-lww',
    plan: { intent: 'replace_scene', instruction: '换场景', summary: '换场景', selectedResultNodeId: 'result-1', output: { mode: 'single', count: 1, candidatesPerItem: 1 } },
    branches: [], createdAt: 10,
  }
  store.putAgentRun(owner.id, { ...base, status: 'running', updatedAt: 200 })
  assert.equal(store.putAgentRun(owner.id, { ...base, status: 'queued', updatedAt: 100 }).status, 'running')
  assert.equal(store.putAgentRun(owner.id, { ...base, status: 'awaiting_confirmation', updatedAt: 500 }).status, 'running')
  assert.equal(store.readAgentRun(owner.id, base.id)?.status, 'running')
})

test('putAgentRun 行内按分支合并：重试 A 不覆盖并发完成的 B', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  store.writeProject(owner.id, { ...document('project-agent-run-merge'), agentRuns: [] }, undefined)
  const base = {
    id: 'run-branch-merge', ownerId: owner.id, projectId: 'project-agent-run-merge',
    status: 'running', plan: { id: 'plan-merge' }, createdAt: 1, updatedAt: 200,
    completedBranchCount: 0, failedBranchCount: 1,
    branches: [
      { id: 'branch-a', status: 'failed', attempt: 0, activeJobId: 'job-a-1', jobIds: ['job-a-1'], outputCount: 0, updatedAt: 200 },
      { id: 'branch-b', status: 'running', attempt: 0, activeJobId: 'job-b-1', jobIds: ['job-b-1'], outputCount: 0, updatedAt: 200 },
    ],
  }
  store.putAgentRun(owner.id, base)
  const staleRetryWrite = {
    ...structuredClone(base),
    status: 'queued',
    updatedAt: 400,
    branches: [
      { ...base.branches[0], status: 'queued', attempt: 1, activeJobId: 'job-a-2', jobIds: ['job-a-1', 'job-a-2'], updatedAt: 400 },
      structuredClone(base.branches[1]),
    ],
  }
  store.putAgentRun(owner.id, {
    ...structuredClone(base),
    status: 'partial',
    updatedAt: 300,
    completedBranchCount: 1,
    branches: [
      structuredClone(base.branches[0]),
      { ...base.branches[1], status: 'succeeded', outputCount: 1, updatedAt: 300 },
    ],
  })

  const merged = store.putAgentRun(owner.id, staleRetryWrite)

  assert.equal(merged.branches[0].attempt, 1)
  assert.equal(merged.branches[0].activeJobId, 'job-a-2')
  assert.equal(merged.branches[0].status, 'queued')
  assert.equal(merged.branches[1].activeJobId, 'job-b-1')
  assert.equal(merged.branches[1].status, 'succeeded')
  assert.equal(merged.branches[1].outputCount, 1)
  assert.equal(merged.status, 'queued')
})

test('Agent Session、Message 与 Memory 从旧文档双写到独立实体并跨重启恢复', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  const legacy = {
    ...document('project-agent-state'),
    agentSessions: [{
      id: 'session-a', title: '首个会话', executionMode: 'manual', contextNodeIds: ['node-a'],
      messages: [{ id: 'message-a', role: 'user', kind: 'text', content: '第一条', createdAt: 10 }],
      readingAnchorMessageId: 'message-a', readingAnchorUpdatedAt: 10,
      createdAt: 10, updatedAt: 10,
    }],
    agentMemory: [{ id: 'memory-a', kind: 'rule', content: '保持品牌色', sourceNodeIds: ['node-a'], createdAt: 10, updatedAt: 10 }],
    agentRuns: [],
    activeAgentSessionId: 'session-a',
  }
  store.writeProject(owner.id, legacy, undefined)

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  const [reloadedSession] = reloaded.readAgentState(owner.id, legacy.id).sessions
  assert.deepEqual(reloadedSession.messages.map((item) => item.id), ['message-a'])
  assert.equal(reloadedSession.readingAnchorMessageId, 'message-a')
  assert.equal(reloadedSession.readingAnchorUpdatedAt, 10)
  assert.equal(reloaded.readAgentState(owner.id, legacy.id).memory[0].content, '保持品牌色')
  assert.equal(reloaded.readProject(owner.id, legacy.id).document.activeAgentSessionId, 'session-a')
})

test('Agent 阅读位置按成员隔离，并在跨设备重启后分别恢复', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  store.writeProject(owner.id, { ...document('project-agent-reading'), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentSession(owner.id, 'project-agent-reading', {
    id: 'session-reading', title: '协作会话', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 10,
  })
  store.putAgentMessage(owner.id, 'project-agent-reading', 'session-reading', {
    id: 'message-first', role: 'assistant', kind: 'text', content: '第一条', createdAt: 20,
  })
  store.putAgentMessage(owner.id, 'project-agent-reading', 'session-reading', {
    id: 'message-latest', role: 'assistant', kind: 'text', content: '最新一条', createdAt: 30,
  })
  const member = store.createUser(owner.id, {
    email: 'reader@example.com', name: 'Reader', accessToken: 'reader-token',
  })
  store.addProjectMember(owner.id, 'project-agent-reading', member.id, 'viewer')

  store.putAgentSessionReadReceipt(owner.id, 'project-agent-reading', 'session-reading', {
    messageId: 'message-latest', updatedAt: 40,
  })

  assert.equal(store.readAgentState(owner.id, 'project-agent-reading').sessions[0].readingAnchorMessageId, 'message-latest')
  assert.equal(store.readAgentState(member.id, 'project-agent-reading').sessions[0].readingAnchorMessageId, undefined)

  store.putAgentSessionReadReceipt(member.id, 'project-agent-reading', 'session-reading', {
    messageId: 'message-first', updatedAt: 50,
  })
  assert.equal(store.readAgentState(owner.id, 'project-agent-reading').sessions[0].readingAnchorMessageId, 'message-latest')
  assert.equal(store.readAgentState(member.id, 'project-agent-reading').sessions[0].readingAnchorMessageId, 'message-first')

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(reloaded.readProject(owner.id, 'project-agent-reading').document.agentSessions[0].readingAnchorMessageId, 'message-latest')
  assert.equal(reloaded.readProject(member.id, 'project-agent-reading').document.agentSessions[0].readingAnchorMessageId, 'message-first')
})

test('协作历史跨重启保留，已读与清空状态按成员隔离', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-collaboration-history'), undefined)
  const member = store.createUser(owner.id, {
    email: 'collaborator@example.com', name: 'Mia', accessToken: 'collaborator-token',
  })
  store.addProjectMember(owner.id, 'project-collaboration-history', member.id, 'editor')

  const activity = store.putCollaborationActivity(member.id, 'project-collaboration-history', {
    id: 'activity-node-added',
    kind: 'canvas',
    summary: '新增了「海边版本」',
    target: { kind: 'node', nodeId: 'node-seaside' },
  })
  assert.equal(activity.actorName, 'Mia')
  assert.equal(store.listCollaborationActivities(owner.id, 'project-collaboration-history')[0].unread, true)
  assert.equal(store.listCollaborationActivities(member.id, 'project-collaboration-history')[0].unread, false)

  store.putCollaborationActivityReceipt(owner.id, 'project-collaboration-history', { action: 'read' })
  assert.equal(store.listCollaborationActivities(owner.id, 'project-collaboration-history')[0].unread, false)
  assert.equal(store.listCollaborationActivities(member.id, 'project-collaboration-history').length, 1)

  store.putCollaborationActivityReceipt(member.id, 'project-collaboration-history', { action: 'clear' })
  assert.equal(store.listCollaborationActivities(member.id, 'project-collaboration-history').length, 0)
  assert.equal(store.listCollaborationActivities(owner.id, 'project-collaboration-history').length, 1)

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(reloaded.listCollaborationActivities(owner.id, 'project-collaboration-history')[0].id, 'activity-node-added')
  assert.equal(reloaded.listCollaborationActivities(member.id, 'project-collaboration-history').length, 0)
})

test('Agent 消息按 ID 增量追加，旧文档快照不会覆盖另一设备的新消息', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, { ...document('project-agent-concurrent'), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentSession(owner.id, 'project-agent-concurrent', {
    id: 'session-concurrent', title: '并发会话', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 10,
  })
  store.putAgentMessage(owner.id, 'project-agent-concurrent', 'session-concurrent', {
    id: 'message-device-a', role: 'user', kind: 'text', content: '设备 A', createdAt: 11,
  })
  store.putAgentMessage(owner.id, 'project-agent-concurrent', 'session-concurrent', {
    id: 'message-device-b', role: 'user', kind: 'text', content: '设备 B', createdAt: 12,
  })

  const state = store.readAgentState(owner.id, 'project-agent-concurrent')
  assert.deepEqual(state.sessions[0].messages.map((item) => item.id), ['message-device-a', 'message-device-b'])
})

test('Agent 消息按 updatedAt 幂等合并，迟到的旧版本不覆盖新内容', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, { ...document('project-agent-message-version'), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentSession(owner.id, 'project-agent-message-version', {
    id: 'session-versioned', title: '并发会话', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 10,
  })
  store.putAgentMessage(owner.id, 'project-agent-message-version', 'session-versioned', {
    id: 'message-versioned', role: 'assistant', kind: 'text', content: '设备 B 新内容', createdAt: 20, updatedAt: 300,
  })
  store.putAgentMessage(owner.id, 'project-agent-message-version', 'session-versioned', {
    id: 'message-versioned', role: 'assistant', kind: 'text', content: '设备 A 迟到旧内容', createdAt: 20, updatedAt: 100,
  })

  const [message] = store.readAgentState(owner.id, 'project-agent-message-version').sessions[0].messages
  assert.equal(message.content, '设备 B 新内容')
  assert.equal(message.updatedAt, 300)
})

test('readProject 不再嵌套 Agent 消息，分页接口才返回历史', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, { ...document('project-agent-read-model'), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentSession(owner.id, 'project-agent-read-model', {
    id: 'session-read-model', title: '分页会话', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 10,
  })
  store.putAgentMessage(owner.id, 'project-agent-read-model', 'session-read-model', {
    id: 'message-older', role: 'user', kind: 'text', content: '更早', createdAt: 11, updatedAt: 11,
  })
  store.putAgentMessage(owner.id, 'project-agent-read-model', 'session-read-model', {
    id: 'message-newer', role: 'user', kind: 'text', content: '更新', createdAt: 12, updatedAt: 12,
  })

  const project = store.readProject(owner.id, 'project-agent-read-model')
  assert.deepEqual(project.document.agentSessions[0].messages, [])
  const page = store.listAgentSessionMessages(owner.id, 'project-agent-read-model', 'session-read-model', { limit: 1 })
  assert.deepEqual(page.messages.map((item) => item.id), ['message-newer'])
  assert.ok(page.nextBefore)
  const older = store.listAgentSessionMessages(owner.id, 'project-agent-read-model', 'session-read-model', {
    limit: 1,
    before: { updatedAt: 12, id: 'message-newer' },
  })
  assert.deepEqual(older.messages.map((item) => item.id), ['message-older'])

  const saved = store.writeProject(owner.id, {
    ...project.document,
    agentSessions: [{
      ...project.document.agentSessions[0],
      messages: [{ id: 'message-local', role: 'user', kind: 'text', content: '不应回传', createdAt: 13 }],
    }],
  }, project.revision)
  assert.deepEqual(saved.document.agentSessions[0].messages, [])
})

test('Agent 会话按 updatedAt 幂等合并，迟到的旧设备标题不回退', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, { ...document('project-agent-session-version'), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentSession(owner.id, 'project-agent-session-version', {
    id: 'session-versioned', title: '设备 B 新标题', executionMode: 'auto', contextNodeIds: ['node-b'], createdAt: 10, updatedAt: 300,
  })
  store.putAgentSession(owner.id, 'project-agent-session-version', {
    id: 'session-versioned', title: '设备 A 迟到旧标题', executionMode: 'manual', contextNodeIds: ['node-a'], createdAt: 10, updatedAt: 100,
  })

  const [session] = store.readAgentState(owner.id, 'project-agent-session-version').sessions
  assert.equal(session.title, '设备 B 新标题')
  assert.equal(session.executionMode, 'auto')
  assert.deepEqual(session.contextNodeIds, ['node-b'])
  assert.equal(session.updatedAt, 300)
})

test('Agent Session 设置用 revision CAS 拒绝旧设备，兼容文档也不能绕过', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-agent-session-cas'
  const sessionId = 'session-cas'
  store.writeProject(owner.id, { ...document(projectId), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)

  const created = store.compareAndSetAgentSessionSettings(owner.id, projectId, {
    sessionId,
    expectedRevision: 0,
    createdAt: 10,
    changes: {
      title: '初始对话', executionMode: 'auto', confirmationWaivers: ['manual'],
      plannerModel: 'kimi-k3', mountedSkillIds: ['skill-a'], contextNodeIds: ['node-a'],
    },
  })
  assert.equal(created.kind, 'created')
  assert.equal(created.session.revision, 1)

  const deviceB = store.compareAndSetAgentSessionSettings(owner.id, projectId, {
    sessionId,
    expectedRevision: 1,
    changes: {
      executionMode: 'manual', confirmationWaivers: [], mountedSkillIds: [], contextNodeIds: ['node-b'],
    },
  })
  assert.equal(deviceB.kind, 'updated')
  assert.equal(deviceB.session.revision, 2)
  assert.equal('confirmationWaivers' in deviceB.session, false)
  assert.deepEqual(deviceB.session.mountedSkillIds, [])

  const staleDeviceA = store.compareAndSetAgentSessionSettings(owner.id, projectId, {
    sessionId,
    expectedRevision: 1,
    changes: { executionMode: 'auto', confirmationWaivers: ['manual'], mountedSkillIds: ['skill-a'] },
  })
  assert.equal(staleDeviceA.kind, 'conflict')
  assert.equal(staleDeviceA.session.revision, 2)

  const project = store.readProject(owner.id, projectId)
  const staleDocument = {
    ...project.document,
    updatedAt: project.document.updatedAt + 1,
    agentSessions: project.document.agentSessions.map((session) => session.id === sessionId
      ? {
          ...session,
          executionMode: 'auto', confirmationWaivers: ['manual'], mountedSkillIds: ['skill-a'],
          revision: 1, updatedAt: session.updatedAt + 10_000,
        }
      : session),
  }
  store.writeProject(owner.id, staleDocument, project.revision)

  const [stored] = store.readAgentState(owner.id, projectId).sessions
  assert.equal(stored.executionMode, 'manual')
  assert.equal('confirmationWaivers' in stored, false)
  assert.deepEqual(stored.mountedSkillIds, [])
  assert.equal(stored.revision, 2)
})

test('Agent 会话设置更新不会删除服务端线程摘要', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, { ...document('project-agent-session-summary'), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  const threadSummary = {
    version: 1,
    goals: ['制作夏季 Campaign'],
    decisions: [],
    constraints: [],
    openQuestions: [],
    entityIds: [],
    coveredMessageIds: ['message-1'],
    coveredThrough: 20,
    updatedAt: 20,
  }
  store.putAgentSession(owner.id, 'project-agent-session-summary', {
    id: 'session-summary', title: '原始标题', executionMode: 'manual', contextNodeIds: [],
    threadSummary, createdAt: 10, updatedAt: 20,
  })
  store.putAgentSession(owner.id, 'project-agent-session-summary', {
    id: 'session-summary', title: '新标题', executionMode: 'auto', contextNodeIds: ['node-a'],
    createdAt: 10, updatedAt: 30,
  })

  const [session] = store.readAgentState(owner.id, 'project-agent-session-summary').sessions
  assert.equal(session.title, '新标题')
  assert.deepEqual(session.threadSummary, threadSummary)
})

test('Thread Summary CAS 在并发设置更新后只 patch 摘要，并阻止第二个 compactor 回退', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-agent-session-summary-cas'
  store.writeProject(owner.id, { ...document(projectId), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentSession(owner.id, projectId, {
    id: 'session-summary-cas', title: '初始标题', executionMode: 'manual', contextNodeIds: [],
    createdAt: 10, updatedAt: 20,
  })
  // Compactor 读完旧 Session 后，设置写先落库。
  store.putAgentSession(owner.id, projectId, {
    id: 'session-summary-cas', title: '并发新标题', executionMode: 'auto', contextNodeIds: ['node-new'],
    createdAt: 10, updatedAt: 30,
  })
  const summary = {
    version: 1, goals: ['稳定摘要'], decisions: [], constraints: [], openQuestions: [], entityIds: [],
    coveredMessageIds: ['message-1'], coveredThrough: 25, updatedAt: 100,
  }

  const first = store.compareAndSetAgentThreadSummary(owner.id, {
    sessionId: 'session-summary-cas', expectedUpdatedAt: null, summary,
  })
  const stale = store.compareAndSetAgentThreadSummary(owner.id, {
    sessionId: 'session-summary-cas', expectedUpdatedAt: null,
    summary: { ...summary, goals: ['迟到摘要'], updatedAt: 90 },
  })
  const [session] = store.listAgentSessions(owner.id, projectId)

  assert.equal(first.kind, 'updated')
  assert.equal(stale.kind, 'conflict')
  assert.equal(session.title, '并发新标题')
  assert.equal(session.executionMode, 'auto')
  assert.deepEqual(session.contextNodeIds, ['node-new'])
  assert.equal(session.updatedAt, 30, '摘要写入不得改变 Session 列表排序')
  assert.deepEqual(session.threadSummary, summary)
})

test('非 CAS Session 保留摘要且 CanvasDocument 兼容写不能覆盖 Session 设置', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-agent-summary-writer-race'
  const sessionId = 'session-summary-writer-race'
  store.writeProject(owner.id, { ...document(projectId), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentSession(owner.id, projectId, {
    id: sessionId, title: '初始标题', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 20,
  })
  const currentSummary = {
    version: 1, goals: ['当前摘要'], decisions: [], constraints: [], openQuestions: [], entityIds: [],
    coveredMessageIds: [], coveredThrough: 20, updatedAt: 100,
  }
  const staleSummary = { ...currentSummary, goals: ['迟到摘要'], updatedAt: 90 }
  assert.equal(store.compareAndSetAgentThreadSummary(owner.id, {
    sessionId, expectedUpdatedAt: null, summary: currentSummary,
  }).kind, 'updated')

  // Compactor 提交后，两个非 CAS writer 手上仍是旧 Session 快照。
  store.putAgentSession(owner.id, projectId, {
    id: sessionId, title: '设置写', executionMode: 'auto', contextNodeIds: [],
    threadSummary: staleSummary, createdAt: 10, updatedAt: 200,
  })
  store.writeProject(owner.id, {
    ...document(projectId),
    agentSessions: [{
      id: sessionId, title: '画布兼容写', executionMode: 'auto', contextNodeIds: [],
      threadSummary: staleSummary, messages: [], createdAt: 10, updatedAt: 300,
    }],
    agentMemory: [], agentRuns: [],
  }, 1)

  const [stored] = store.listAgentSessions(owner.id, projectId)
  assert.equal(stored.title, '设置写')
  assert.deepEqual(stored.threadSummary, currentSummary)
})

test('Message turnId 一旦绑定就不能被迟到 PUT 或 CanvasDocument 写入清空与改绑', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-agent-message-turn-binding'
  const sessionId = 'session-message-turn-binding'
  const messageId = 'message-turn-binding'
  store.writeProject(owner.id, { ...document(projectId), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentSession(owner.id, projectId, {
    id: sessionId, title: '会话', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 10,
  })
  const base = { id: messageId, role: 'user', kind: 'text', content: '继续', createdAt: 20 }
  store.putAgentMessage(owner.id, projectId, sessionId, { ...base, turnId: 'turn-authoritative', updatedAt: 20 })
  store.putAgentMessage(owner.id, projectId, sessionId, {
    ...base, content: '请求取消', turnCancellationRequestedAt: 50, updatedAt: 30,
  })
  store.putAgentMessage(owner.id, projectId, sessionId, { ...base, content: '迟到缺字段更新', updatedAt: 40 })
  store.putAgentMessage(owner.id, projectId, sessionId, {
    ...base, content: '迟到更晚取消', turnCancellationRequestedAt: 80, updatedAt: 50,
  })
  store.putAgentMessage(owner.id, projectId, sessionId, {
    ...base, content: '先发生的取消补到', turnCancellationRequestedAt: 40, updatedAt: 60,
  })
  store.putAgentMessage(owner.id, projectId, sessionId, {
    ...base, content: '更旧的正文不应回退', turnCancellationRequestedAt: 35, updatedAt: 25,
  })
  let storedMessage = store.listAgentSessionMessages(owner.id, projectId, sessionId).messages[0]
  assert.equal(storedMessage.turnId, 'turn-authoritative')
  assert.equal(storedMessage.content, '先发生的取消补到', '旧快照只能合并 sticky 字段')
  assert.equal(storedMessage.updatedAt, 60, '旧快照不得回退 Message 版本')
  assert.equal(storedMessage.turnCancellationRequestedAt, 35, '取消意图独立于正文 LWW，取最早有效时间')

  assert.throws(() => store.putAgentMessage(owner.id, projectId, sessionId, {
    ...base, turnId: 'turn-conflict', updatedAt: 40,
  }), (error) => error?.code === 'AGENT_MESSAGE_TURN_ID_CONFLICT')

  store.writeProject(owner.id, {
    ...document(projectId),
    agentSessions: [{
      id: sessionId, title: '会话', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 50,
      messages: [{ ...base, content: '画布迟到更新', turnCancellationRequestedAt: 70, updatedAt: 70 }],
    }],
    agentMemory: [], agentRuns: [],
  }, 1)
  storedMessage = store.listAgentSessionMessages(owner.id, projectId, sessionId).messages[0]
  assert.equal(storedMessage.turnId, 'turn-authoritative')
  assert.equal(storedMessage.turnCancellationRequestedAt, 35)

  store.writeProject(owner.id, {
    ...document(projectId),
    agentSessions: [{
      id: sessionId, title: '会话', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 80,
      messages: [{ ...base, content: '画布补到更早取消', turnCancellationRequestedAt: 30, updatedAt: 80 }],
    }],
    agentMemory: [], agentRuns: [],
  }, 2)
  storedMessage = store.listAgentSessionMessages(owner.id, projectId, sessionId).messages[0]
  assert.equal(storedMessage.turnCancellationRequestedAt, 30)

  store.writeProject(owner.id, {
    ...document(projectId),
    agentSessions: [{
      id: sessionId, title: '会话', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 90,
      messages: [{ ...base, content: '画布旧正文不应回退', turnCancellationRequestedAt: 20, updatedAt: 25 }],
    }],
    agentMemory: [], agentRuns: [],
  }, 3)
  storedMessage = store.listAgentSessionMessages(owner.id, projectId, sessionId).messages[0]
  assert.equal(storedMessage.content, '画布补到更早取消')
  assert.equal(storedMessage.updatedAt, 80)
  assert.equal(storedMessage.turnCancellationRequestedAt, 20)

  assert.throws(() => store.writeProject(owner.id, {
    ...document(projectId),
    agentSessions: [{
      id: sessionId, title: '会话', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 60,
      messages: [{ ...base, turnId: 'turn-canvas-conflict', updatedAt: 60 }],
    }],
    agentMemory: [], agentRuns: [],
  }, 4), (error) => error?.code === 'AGENT_MESSAGE_TURN_ID_CONFLICT')
})

test('稳定 Turn 结果投影跨 PUT 与 Canvas sync 保持 failed 终态且时间单调', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-agent-message-terminal-lww'
  const sessionId = 'session-agent-message-terminal-lww'
  const turnId = 'turn-terminal-lww'
  const messageId = `agent-turn-result-${turnId}`
  store.writeProject(owner.id, { ...document(projectId), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentSession(owner.id, projectId, {
    id: sessionId, title: '会话', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 10,
  })
  const base = { id: messageId, role: 'assistant', kind: 'notice', turnId, createdAt: 20 }

  store.putAgentMessage(owner.id, projectId, sessionId, {
    ...base, content: '未来时钟的成功', status: 'answered', updatedAt: 9_000,
  })
  let stored = store.putAgentMessage(owner.id, projectId, sessionId, {
    ...base, content: '权威取消', status: 'failed', updatedAt: 100,
  })
  assert.equal(stored.status, 'failed')
  assert.equal(stored.content, '权威取消')
  assert.equal(stored.updatedAt, 9_000)

  stored = store.putAgentMessage(owner.id, projectId, sessionId, {
    ...base, content: '迟到成功', status: 'answered', updatedAt: 10_000,
  })
  assert.equal(stored.status, 'failed')
  assert.equal(stored.content, '权威取消')
  assert.equal(stored.updatedAt, 10_000)

  assert.throws(() => store.putAgentMessage(owner.id, projectId, sessionId, {
    ...base, role: 'user', content: '借换角色绕过终态', status: 'answered', createdAt: 99_000, updatedAt: 99_000,
  }), (error) => error?.code === 'AGENT_MESSAGE_ROLE_CONFLICT')

  store.writeProject(owner.id, {
    ...document(projectId),
    agentSessions: [{
      id: sessionId, title: '会话', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 10_500,
      messages: [{ ...base, content: 'Canvas 迟到成功', status: 'answered', updatedAt: 10_500 }],
    }],
    agentMemory: [], agentRuns: [],
  }, 1)
  stored = store.listAgentSessionMessages(owner.id, projectId, sessionId).messages[0]
  assert.equal(stored.status, 'failed')
  assert.equal(stored.content, '权威取消')
  assert.equal(stored.updatedAt, 10_500)
  assert.equal(stored.createdAt, 20)
  assert.equal(store.listAgentSessions(owner.id, projectId)[0].updatedAt, 10_000)
})

test('Local CanvasDocument 写入不能首次绑定或替换 entityReferences，权威 Message 回填仍 sticky', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-canvas-untrusted-refs'
  const sessionId = 'session-canvas-untrusted-refs'
  const turnId = 'turn-canvas-untrusted-refs'
  const messageId = `agent-turn-result-${turnId}`
  const stable = {
    id: messageId, role: 'assistant', kind: 'text', content: '完成', turnId,
    status: 'answered', createdAt: 20, updatedAt: 20,
  }
  const ordinary = {
    id: 'ordinary-canvas-message', role: 'assistant', kind: 'text', content: '普通消息',
    createdAt: 21, updatedAt: 21,
  }
  const canvasDocument = (revisionUpdatedAt, messages) => ({
    ...document(projectId),
    agentSessions: [{
      id: sessionId, title: '会话', executionMode: 'manual', contextNodeIds: [],
      createdAt: 10, updatedAt: revisionUpdatedAt, messages,
    }],
    agentMemory: [],
    agentRuns: [],
  })

  store.writeProject(owner.id, { ...document(projectId), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.writeProject(owner.id, canvasDocument(30, [
    { ...stable, entityReferences: [{ type: 'artifact', id: 'artifact-forged-first' }] },
    { ...ordinary, entityReferences: [{ type: 'artifact', id: 'artifact-forged-ordinary' }] },
  ]), 1)

  let stored = store.listAgentSessionMessages(owner.id, projectId, sessionId).messages
  assert.equal('entityReferences' in stored.find((item) => item.id === messageId), false)
  assert.equal('entityReferences' in stored.find((item) => item.id === ordinary.id), false)

  const authoritative = [{ type: 'artifact', id: 'artifact-authoritative' }]
  store.putAgentMessage(owner.id, projectId, sessionId, {
    ...stable, content: '权威回填', updatedAt: 40, entityReferences: authoritative,
  })
  store.writeProject(owner.id, canvasDocument(50, [
    { ...stable, content: 'Canvas 迟到正文', updatedAt: 50, entityReferences: [{ type: 'artifact', id: 'artifact-forged-replacement' }] },
    { ...ordinary, updatedAt: 50, entityReferences: [{ type: 'artifact', id: 'artifact-forged-ordinary' }] },
  ]), 2)

  stored = store.listAgentSessionMessages(owner.id, projectId, sessionId).messages
  assert.deepEqual(stored.find((item) => item.id === messageId).entityReferences, authoritative)
  assert.equal('entityReferences' in stored.find((item) => item.id === ordinary.id), false)
})

test('turnRequestSnapshot 跨 PUT 与 Canvas sync once-bound，遗漏保留且冲突拒绝', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-agent-message-request-snapshot'
  const sessionId = 'session-agent-message-request-snapshot'
  const messageId = 'message-agent-request-snapshot'
  const snapshot = {
    locale: 'zh-CN', contextNodeIds: ['result-a'], hasTarget: true,
    selectedResultNodeId: 'result-a', selectedResultLabel: '结果 A', executionMode: 'auto',
  }
  store.writeProject(owner.id, { ...document(projectId), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentSession(owner.id, projectId, {
    id: sessionId, title: '会话', executionMode: 'auto', contextNodeIds: [], createdAt: 10, updatedAt: 10,
  })
  const base = {
    id: messageId, role: 'user', kind: 'text', content: '继续', createdAt: 20,
    mentions: [{ kind: 'skill', id: 'skill-a', name: 'Skill A' }],
  }

  store.putAgentMessage(owner.id, projectId, sessionId, { ...base, updatedAt: 300 })
  for (const mismatchedFirstBinding of [
    { ...base, content: '另一条请求正文', turnRequestSnapshot: snapshot, updatedAt: 90 },
    {
      ...base,
      mentions: [{ kind: 'skill', id: 'skill-b', name: 'Skill B' }],
      turnRequestSnapshot: snapshot,
      updatedAt: 90,
    },
  ]) {
    assert.throws(() => store.putAgentMessage(owner.id, projectId, sessionId, mismatchedFirstBinding), (error) => (
      error?.code === 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT'
    ))
  }
  let stored = store.putAgentMessage(owner.id, projectId, sessionId, {
    ...base, turnRequestSnapshot: snapshot, updatedAt: 100,
  })
  assert.equal(stored.content, '继续')
  assert.deepEqual(stored.turnRequestSnapshot, snapshot)
  assert.equal(stored.updatedAt, 300)

  stored = store.putAgentMessage(owner.id, projectId, sessionId, {
    ...base, status: 'pending', updatedAt: 400,
  })
  assert.equal(stored.content, '继续')
  assert.equal(stored.status, 'pending')
  assert.deepEqual(stored.turnRequestSnapshot, snapshot)

  for (const drift of [
    { ...base, content: '漂移正文', updatedAt: 420 },
    { ...base, mentions: [{ kind: 'skill', id: 'skill-b', name: 'Skill B' }], updatedAt: 420 },
  ]) {
    assert.throws(() => store.putAgentMessage(owner.id, projectId, sessionId, drift), (error) => (
      error?.code === 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT'
    ))
  }

  assert.throws(() => store.putAgentMessage(owner.id, projectId, sessionId, {
    ...base, role: 'assistant', kind: 'notice', content: '试图把快照粘到 assistant', updatedAt: 450,
  }), (error) => error?.code === 'AGENT_MESSAGE_ROLE_CONFLICT')

  assert.throws(() => store.writeProject(owner.id, {
    ...document(projectId),
    agentSessions: [{
      id: sessionId, title: '会话', executionMode: 'auto', contextNodeIds: [], createdAt: 10, updatedAt: 500,
      messages: [{
        ...base, updatedAt: 500,
        turnRequestSnapshot: { ...snapshot, contextNodeIds: ['result-b'], selectedResultNodeId: 'result-b' },
      }],
    }],
    agentMemory: [], agentRuns: [],
  }, 1), (error) => error?.code === 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT')

  assert.throws(() => store.writeProject(owner.id, {
    ...document(projectId),
    agentSessions: [{
      id: sessionId, title: '会话', executionMode: 'auto', contextNodeIds: [], createdAt: 10, updatedAt: 520,
      messages: [{ ...base, content: 'Canvas 正文漂移', updatedAt: 520 }],
    }],
    agentMemory: [], agentRuns: [],
  }, 1), (error) => error?.code === 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT')

  stored = store.listAgentSessionMessages(owner.id, projectId, sessionId).messages[0]
  assert.equal(stored.content, '继续', 'Canvas 冲突必须在任何兼容状态写入前回滚')
  assert.deepEqual(stored.turnRequestSnapshot, snapshot)
})

test('权威线程上下文用 CAS 写回摘要且不改变 Session 主更新时间', async () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-agent-thread-checkpoint'
  store.writeProject(owner.id, { ...document(projectId), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentSession(owner.id, projectId, {
    id: 'session-checkpoint', title: '长会话', executionMode: 'manual', contextNodeIds: [], createdAt: 1, updatedAt: 10,
  })
  for (let index = 1; index <= 9; index += 1) {
    store.putAgentMessage(owner.id, projectId, 'session-checkpoint', {
      id: `message-${index}`, role: 'user', kind: 'text', content: `目标 ${index}`,
      createdAt: 10 + index, updatedAt: 10 + index,
    })
  }

  await createAgentThreadContext({ productStore: store, now: () => 100 }).resolve({
    userId: owner.id,
    projectId,
    sessionId: 'session-checkpoint',
    inputMessage: { id: 'message-10', role: 'user', kind: 'text', content: '继续', createdAt: 20 },
  })

  const [session] = store.listAgentSessions(owner.id, projectId)
  assert.equal(session.updatedAt, 19)
  assert.equal(session.threadSummary.updatedAt, 100)
  assert.deepEqual(session.threadSummary.coveredMessageIds, Array.from({ length: 9 }, (_, index) => `message-${index + 1}`))
})

test('Agent Memory 删除墓碑阻止旧设备增量 PUT 复活同 ID 记忆', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, { ...document('project-agent-memory-version'), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentMemoryItem(owner.id, 'project-agent-memory-version', {
    id: 'memory-versioned', kind: 'avoid', content: '不要暖色', sourceNodeIds: [], createdAt: 10, updatedAt: 100,
  })
  assert.equal(store.deleteAgentMemoryItem(owner.id, 'project-agent-memory-version', 'memory-versioned'), true)

  assert.throws(() => store.putAgentMemoryItem(owner.id, 'project-agent-memory-version', {
    id: 'memory-versioned', kind: 'avoid', content: '旧设备内容', sourceNodeIds: [], createdAt: 10, updatedAt: 150,
  }), (error) => error?.code === 'AGENT_MEMORY_DELETED')
  assert.deepEqual(store.readAgentState(owner.id, 'project-agent-memory-version').memory, [])
})

test('Agent Memory 删除后即使时间戳更新也必须使用新 ID 重建', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, { ...document('project-agent-memory-recreate'), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentMemoryItem(owner.id, 'project-agent-memory-recreate', {
    id: 'memory-recreate', kind: 'rule', content: '旧内容', sourceNodeIds: [], createdAt: 10, updatedAt: 100,
  })
  assert.equal(store.deleteAgentMemoryItem(owner.id, 'project-agent-memory-recreate', 'memory-recreate'), true)
  assert.throws(() => store.putAgentMemoryItem(owner.id, 'project-agent-memory-recreate', {
    id: 'memory-recreate', kind: 'rule', content: '显式重建', sourceNodeIds: [], createdAt: 10, updatedAt: Date.now() + 10_000,
  }), (error) => error?.code === 'AGENT_MEMORY_DELETED')
  assert.deepEqual(store.readAgentState(owner.id, 'project-agent-memory-recreate').memory, [])
})

test('Agent Memory 拒绝非整数、空值和远未来客户端时间戳', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, { ...document('project-agent-memory-timestamp'), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  for (const updatedAt of [null, 1.5, Date.now() + 10 * 60_000]) {
    assert.throws(() => store.putAgentMemoryItem(owner.id, 'project-agent-memory-timestamp', {
      id: `memory-${String(updatedAt)}`, kind: 'rule', content: '无效时间戳', sourceNodeIds: [], createdAt: 10, updatedAt,
    }), (error) => error?.code === 'INVALID_AGENT_ENTITY')
  }
})

test('Agent Memory 使用墓碑删除，兼容文档中的旧副本不会复活', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, {
    ...document('project-agent-memory'), agentSessions: [], agentRuns: [],
    agentMemory: [{ id: 'memory-delete', kind: 'avoid', content: '不要暖色', sourceNodeIds: [], createdAt: 10, updatedAt: 10 }],
  }, undefined)

  assert.equal(store.deleteAgentMemoryItem(owner.id, 'project-agent-memory', 'memory-delete'), true)
  assert.deepEqual(store.readAgentState(owner.id, 'project-agent-memory').memory, [])
  assert.deepEqual(store.readProject(owner.id, 'project-agent-memory').document.agentMemory, [])
})

test('Agent 独立实体按项目授权，Viewer 只能读取且标识不能跨项目复用', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const viewer = store.createUser(owner.id, { email: 'agent-viewer@example.com', accessToken: 'agent-viewer-token' })
  store.writeProject(owner.id, { ...document('project-agent-a'), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.writeProject(owner.id, { ...document('project-agent-b'), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.addProjectMember(owner.id, 'project-agent-a', viewer.id, 'viewer')
  store.putAgentSession(owner.id, 'project-agent-a', {
    id: 'session-project-bound', title: '项目 A', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 10,
  })

  assert.equal(store.readAgentState(viewer.id, 'project-agent-a').sessions[0].id, 'session-project-bound')
  assert.throws(() => store.putAgentMessage(viewer.id, 'project-agent-a', 'session-project-bound', {
    id: 'viewer-message', role: 'user', kind: 'text', content: '越权写入', createdAt: 11,
  }), (error) => error?.code === 'PROJECT_WRITE_FORBIDDEN')
  assert.throws(() => store.putAgentSession(owner.id, 'project-agent-b', {
    id: 'session-project-bound', title: '项目 B', executionMode: 'manual', contextNodeIds: [], createdAt: 12, updatedAt: 12,
  }), (error) => error?.code === 'AGENT_SESSION_ID_CONFLICT')
})

test('历史 Agent 行动与生成输出自动回填 Artifact Index，重启和旧快照重写保持幂等', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  const project = {
    ...document('project-artifact-backfill'),
    nodes: [{
      id: 'result-history', type: 'result', position: { x: 0, y: 0 },
      data: { status: 'ready', jobId: 'job-history', candidateId: 'output-history', label: '历史主图', image: '/api/media/history' },
    }],
    agentSessions: [{
      id: 'session-history', title: '历史会话', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 20,
      messages: [{
        id: 'message-history', role: 'assistant', kind: 'text', content: '已完成', createdAt: 10,
        plan: { actions: [{
          id: 'action-history', toolName: 'skill_apply',
          result: { artifacts: [{
            id: 'artifact-history', kind: 'workflow', label: '历史 Skill', content: '锁定商品',
            provenance: { actionId: 'action-history', toolName: 'skill_apply' },
          }] },
        }] },
      }],
    }],
    agentMemory: [], agentRuns: [], activeAgentSessionId: 'session-history',
  }
  store.writeProject(owner.id, project, undefined)
  store.putGenerationJob(owner.id, {
    id: 'job-history', projectId: project.id, status: 'succeeded', kind: 'generation', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, rawInput: { projectId: project.id },
    outputs: [{ id: 'output-history', image: '/api/media/history', mediaKind: 'image' }], createdAt: 30, updatedAt: 40,
  })

  assert.deepEqual(store.listAgentArtifacts(owner.id, project.id).map((item) => item.id), [
    'generation:job-history:output-history', 'artifact-history',
  ])
  store.writeProject(owner.id, { ...document(project.id), agentSessions: [], agentMemory: [], agentRuns: [] }, 1)
  assert.equal(store.listAgentArtifacts(owner.id, project.id).some((item) => item.id === 'artifact-history'), true)

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.deepEqual(reloaded.listAgentArtifacts(owner.id, project.id).map((item) => item.id), [
    'generation:job-history:output-history', 'artifact-history',
  ])
})

test('Artifact 标识按项目隔离，项目 Viewer 可读取但不能借此跨项目访问', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-artifact-a'), undefined)
  store.writeProject(owner.id, document('project-artifact-b'), undefined)
  const viewer = store.createUser(owner.id, { email: 'artifact-viewer@example.com', name: 'Viewer', accessToken: 'artifact-viewer-token' })
  store.addProjectMember(owner.id, 'project-artifact-a', viewer.id, 'viewer')

  for (const projectId of ['project-artifact-a', 'project-artifact-b']) {
    store.putAgentActionReceipt(owner.id, {
      id: `receipt-${projectId}`, projectId, toolCallId: `call-${projectId}`, createdAt: 100,
      toolCall: { id: `call-${projectId}`, name: 'skill_apply', status: 'succeeded' },
      output: { artifacts: [{
        id: 'legacy-writeback', kind: 'text', label: projectId, content: projectId,
        provenance: { actionId: `call-${projectId}`, toolName: 'skill_apply' },
      }] },
    })
  }

  assert.equal(store.listAgentArtifacts(viewer.id, 'project-artifact-a')[0].label, 'project-artifact-a')
  assert.equal(store.listAgentArtifacts(viewer.id, 'project-artifact-b'), undefined)
  assert.equal(store.listAgentArtifacts(owner.id, 'project-artifact-b')[0].label, 'project-artifact-b')
})

test('Artifact 分页不会漏掉同一 createdAt 下的后续记录', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const project = document('project-artifact-cursor')
  store.writeProject(owner.id, project, undefined)

  for (const id of ['artifact-a', 'artifact-b', 'artifact-c']) {
    store.putAgentActionReceipt(owner.id, {
      id: `receipt-${id}`,
      projectId: project.id,
      toolCallId: `call-${id}`,
      createdAt: 100,
      output: { artifacts: [{
        id, kind: 'text', label: id, content: id,
        provenance: { actionId: `call-${id}`, toolName: 'skill_apply' },
      }] },
    })
  }
  store.putAgentActionReceipt(owner.id, {
    id: 'receipt-artifact-b-newer',
    projectId: project.id,
    toolCallId: 'call-artifact-b-newer',
    createdAt: 200,
    output: { artifacts: [{
      id: 'artifact-b', kind: 'text', label: 'artifact-b-newer', content: 'artifact-b-newer',
      provenance: { actionId: 'call-artifact-b-newer', toolName: 'skill_apply' },
    }] },
  })

  const first = store.listAgentArtifacts(owner.id, project.id, { limit: 2 })
  const second = store.listAgentArtifacts(owner.id, project.id, {
    limit: 2,
    before: { createdAt: first.at(-1).createdAt, id: first.at(-1).id },
  })
  assert.deepEqual(first.map((item) => item.id), ['artifact-a', 'artifact-b'])
  assert.equal(first[1].createdAt, 100)
  assert.deepEqual(second.map((item) => item.id), ['artifact-c'])
})

test('服务重启只返回需恢复任务，不会无条件改写仍可能在运行的任务', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  store.writeProject(owner.id, document('project-a'), undefined)

  store.putGenerationJob(owner.id, {
    id: 'queued-job',
    projectId: 'project-a',
    status: 'queued',
    kind: 'generation',
    batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    rawInput: { projectId: 'project-a' },
    outputs: [],
    createdAt: Date.now(),
  })
  store.putGenerationJob(owner.id, {
    id: 'running-job',
    projectId: 'project-a',
    status: 'running',
    kind: 'generation',
    batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    rawInput: { projectId: 'project-a' },
    outputs: [],
    createdAt: Date.now(),
  })
  store.putGenerationJob(owner.id, {
    id: 'pending-writeback-job',
    projectId: 'project-a',
    status: 'succeeded',
    kind: 'generation',
    batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    rawInput: { projectId: 'project-a' },
    outputs: [],
    projectWritebackPending: true,
    createdAt: Date.now(),
  })

  assert.deepEqual(store.recoverGenerationJobs().map((job) => job.id), ['queued-job', 'pending-writeback-job'])
  assert.equal(store.readGenerationJob(owner.id, 'running-job')?.status, 'running')
  assert.deepEqual(store.recoverStaleGenerationJobs().map((job) => job.id), [])
})

test('独立画布图谱与 Yjs 更新日志可跨服务重启恢复并压缩', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  assert.ok(owner)
  store.writeProject(owner.id, {
    ...document('project-collaboration'),
    nodes: [{ id: 'node-a', type: 'text', position: { x: 10, y: 20 }, data: { kind: 'text', label: 'A', content: 'A' } }],
  }, undefined)

  const initial = store.loadCanvasCollaboration(owner.id, 'project-collaboration')
  assert.equal(initial.graphRevision, 1)
  assert.deepEqual(initial.graph.nodes.map((node) => node.id), ['node-a'])
  assert.deepEqual(initial.updates, [])

  store.appendCanvasGraphUpdate(owner.id, 'project-collaboration', {
    update: 'AQID',
    graph: {
      nodes: [{ id: 'node-a', type: 'text', position: { x: 180, y: 20 }, data: { kind: 'text', label: 'A', content: 'A' } }],
      edges: [],
    },
  })

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  const recovered = reloaded.loadCanvasCollaboration(owner.id, 'project-collaboration')
  assert.equal(recovered.graphRevision, 2)
  assert.equal(recovered.graph.nodes[0].position.x, 180)
  assert.deepEqual(recovered.updates, ['AQID'])
  assert.equal(reloaded.readProject(owner.id, 'project-collaboration').document.nodes[0].position.x, 180)

  assert.throws(() => reloaded.writeProject(owner.id, {
    ...document('project-collaboration', '离线旧版本'),
    nodes: [{ id: 'node-a', type: 'text', position: { x: 30, y: 20 }, data: { kind: 'text', label: 'A', content: 'A' } }],
  }, 1, 1), (error) => error?.code === 'CANVAS_GRAPH_CONFLICT')

  reloaded.compactCanvasGraphUpdates(owner.id, 'project-collaboration', {
    snapshot: 'BAUG',
    graph: recovered.graph,
  })
  const compacted = reloaded.loadCanvasCollaboration(owner.id, 'project-collaboration')
  assert.equal(compacted.snapshot, 'BAUG')
  assert.deepEqual(compacted.updates, [])
  assert.equal(compacted.graph.nodes[0].position.x, 180)
})

test('画布增量按 mutationId 幂等提交，并拒绝旧 graphRevision 覆盖', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-canvas-cas'), undefined)
  const graph = {
    nodes: [{ id: 'node-a', type: 'text', position: { x: 180, y: 20 }, data: { kind: 'text', label: 'A', content: 'A' } }],
    edges: [],
  }

  const committed = store.appendCanvasGraphUpdate(owner.id, 'project-canvas-cas', {
    mutationId: 'mutation-1', expectedGraphRevision: 1, update: 'AQID', idempotencyUpdate: 'raw-update', graph,
  })
  const duplicate = store.appendCanvasGraphUpdate(owner.id, 'project-canvas-cas', {
    mutationId: 'mutation-1', expectedGraphRevision: 1, update: 'BAUG', idempotencyUpdate: 'raw-update', graph,
  })

  assert.equal(committed.graphRevision, 2)
  assert.equal(committed.duplicate, false)
  assert.equal(duplicate.graphRevision, 2)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.update, 'AQID')
  assert.deepEqual(store.loadCanvasCollaboration(owner.id, 'project-canvas-cas').updates, ['AQID'])
  assert.throws(() => store.appendCanvasGraphUpdate(owner.id, 'project-canvas-cas', {
    mutationId: 'mutation-2', expectedGraphRevision: 1, update: 'BAUG',
    graph: { nodes: [], edges: [] },
  }), (error) => error?.code === 'CANVAS_GRAPH_CONFLICT')
  assert.throws(() => store.compactCanvasGraphUpdates(owner.id, 'project-canvas-cas', {
    expectedGraphRevision: 1, snapshot: 'BAUG', graph: { nodes: [], edges: [] },
  }), (error) => error?.code === 'CANVAS_GRAPH_CONFLICT')
  assert.deepEqual(store.loadCanvasCollaboration(owner.id, 'project-canvas-cas').graph, graph)
  assert.deepEqual(store.loadCanvasCollaboration(owner.id, 'project-canvas-cas').updates, ['AQID'])
})

test('本地持久化失败会回滚内存状态，恢复后不会夹带失败图谱', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-canvas-save-failure'), undefined)
  const backupPath = `${path}.backup`
  renameSync(path, backupPath)
  mkdirSync(path)

  assert.throws(() => store.appendCanvasGraphUpdate(owner.id, 'project-canvas-save-failure', {
    mutationId: 'mutation-failed', update: 'AQID',
    graph: {
      nodes: [{ id: 'node-failed', type: 'text', position: { x: 80, y: 20 }, data: { kind: 'text', label: 'failed', content: 'failed' } }],
      edges: [],
    },
  }))
  rmSync(path, { recursive: true, force: true })
  renameSync(backupPath, path)
  assert.deepEqual(store.loadCanvasCollaboration(owner.id, 'project-canvas-save-failure').graph.nodes, [])

  store.appendCanvasGraphUpdate(owner.id, 'project-canvas-save-failure', {
    mutationId: 'mutation-recovered', update: 'BAUG',
    graph: {
      nodes: [{ id: 'node-recovered', type: 'text', position: { x: 160, y: 20 }, data: { kind: 'text', label: 'recovered', content: 'recovered' } }],
      edges: [],
    },
  })
  assert.deepEqual(
    store.loadCanvasCollaboration(owner.id, 'project-canvas-save-failure').graph.nodes.map((node) => node.id),
    ['node-recovered'],
  )
})

test('V2 epoch 在持久化提交内拒绝旧会话，匹配 epoch 才写入图谱', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-canvas-epoch'), undefined)
  const persisted = JSON.parse(readFileSync(path, 'utf8'))
  persisted.canvasGraphs.find((entry) => entry.projectId === 'project-canvas-epoch').syncProtocolEpoch = 2
  writeFileSync(path, JSON.stringify(persisted))
  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  const graph = {
    nodes: [{ id: 'node-epoch', type: 'text', position: { x: 20, y: 20 }, data: { kind: 'text', label: 'epoch', content: 'epoch' } }],
    edges: [],
  }

  assert.equal(reloaded.readCanvasSyncProtocolEpoch(owner.id, 'project-canvas-epoch'), 2)
  const current = reloaded.readProject(owner.id, 'project-canvas-epoch')
  assert.throws(() => reloaded.writeProject(owner.id, {
    ...current.document,
    nodes: graph.nodes,
  }, current.revision, current.graphRevision), (error) => (
    error?.code === 'CANVAS_SYNC_EPOCH_STALE' && error.syncProtocolEpoch === 2
  ))
  assert.throws(() => reloaded.appendCanvasGraphUpdate(owner.id, 'project-canvas-epoch', {
    mutationId: 'mutation-old-epoch', syncProtocolEpoch: 1, update: 'AQID', graph,
  }), (error) => error?.code === 'CANVAS_SYNC_EPOCH_STALE' && error.syncProtocolEpoch === 2)
  assert.equal(reloaded.loadCanvasCollaboration(owner.id, 'project-canvas-epoch').graphRevision, 1)
  assert.equal(reloaded.appendCanvasGraphUpdate(owner.id, 'project-canvas-epoch', {
    mutationId: 'mutation-current-epoch', syncProtocolEpoch: 2, update: 'AQID', graph,
  }).graphRevision, 2)
  const metadata = reloaded.readProject(owner.id, 'project-canvas-epoch')
  const metadataSaved = reloaded.writeProject(owner.id, {
    ...metadata.document,
    name: 'epoch metadata',
  }, metadata.revision, metadata.graphRevision)
  assert.equal(metadataSaved.syncProtocolEpoch, 2)
  assert.deepEqual(metadataSaved.document.nodes, graph.nodes)
})

test('Turn 事件按游标续读，只返回序号之后的事件', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-cursor'), undefined)
  store.putAgentTurn(owner.id, {
    id: 'turn_cursor', version: 2, ownerId: owner.id, projectId: 'project-cursor',
    idempotencyKey: 'cursor-1', status: 'running', createdAt: 1, updatedAt: 1,
  })
  for (const sequence of [1, 2, 3, 4]) {
    store.appendAgentTurnEvent(owner.id, 'project-cursor', {
      id: `evt-${sequence}`, turnId: 'turn_cursor', projectId: 'project-cursor',
      sequence, type: 'turn.tool', createdAt: sequence,
    })
  }
  const sequences = (options) => store
    .listAgentTurnEvents(owner.id, 'project-cursor', 'turn_cursor', options)
    .map((event) => event.sequence)

  assert.deepEqual(sequences(), [1, 2, 3, 4], '无游标返回全部')
  assert.deepEqual(sequences({ after: 2 }), [3, 4], '只返回游标之后的事件')
  assert.deepEqual(sequences({ after: 4 }), [], '读到末尾返回空而不是回到开头')
  // after: 0 是合法游标而非缺省，否则第一条事件会被重复下发。
  assert.deepEqual(sequences({ after: 0 }), [1, 2, 3, 4])
  assert.deepEqual(sequences({ limit: 2 }), [1, 2], '截断从最早的一条开始')
  assert.deepEqual(sequences({ after: 1, limit: 2 }), [2, 3], '游标与上限可同时生效')
})

test('陈旧 Turn 扫描排除 waiting_user，并以 updatedAt/id 稳定游标避免 poison row 饥饿', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-stale-a'), undefined)
  store.writeProject(owner.id, document('project-stale-b'), undefined)
  const put = (id, projectId, status, updatedAt) => store.putAgentTurn(owner.id, {
    id, version: 2, ownerId: owner.id, projectId, idempotencyKey: id,
    status, createdAt: 1, updatedAt,
  })
  put('turn_old_a', 'project-stale-a', 'running', 100)
  put('turn_old_c', 'project-stale-a', 'running', 100)
  put('turn_old_b', 'project-stale-b', 'queued', 50)
  put('turn_waiting', 'project-stale-a', 'waiting_user', 200)
  for (let index = 0; index < 10; index += 1) {
    put(`turn_waiting_${index}`, 'project-stale-a', 'waiting_user', index + 1)
  }
  put('turn_cancelling', 'project-stale-b', 'cancelling', 300)
  put('turn_done', 'project-stale-a', 'completed', 10)
  put('turn_failed', 'project-stale-b', 'failed', 10)
  put('turn_fresh', 'project-stale-a', 'running', 1_000_000)

  const stale = store.listStaleAgentTurns({ now: 1_000_000, leaseMs: 30_000 })
  assert.deepEqual(
    stale.map((turn) => turn.id),
    ['turn_old_b', 'turn_old_a', 'turn_old_c', 'turn_cancelling'],
    '跨项目按 updatedAt/id 升序返回全部可回收陈旧 Turn，waiting_user 不占批次',
  )
  // 终态不该被重新拾起，租约内的也不该被抢。
  assert.equal(stale.some((turn) => ['turn_done', 'turn_failed'].includes(turn.id)), false)
  assert.equal(stale.some((turn) => turn.id === 'turn_fresh'), false)
  assert.deepEqual(store.listStaleAgentTurns({ now: 1_000_000, leaseMs: 30_000, limit: 2 }).map((t) => t.id), ['turn_old_b', 'turn_old_a'])
  assert.deepEqual(store.listStaleAgentTurns({
    now: 1_000_000,
    leaseMs: 30_000,
    limit: 2,
    after: { updatedAt: 100, id: 'turn_old_a' },
  }).map((turn) => turn.id), ['turn_old_c', 'turn_cancelling'], '游标能越过固定失败的 poison row')
  // 显式 olderThan 落在两个陈旧 Turn 之间时，只捞更早的那个。
  assert.deepEqual(store.listStaleAgentTurns({ olderThan: 60 }).map((t) => t.id), ['turn_old_b'])
})

test('Run 按确认来源 Turn 反查，权威边只在 Run 上', () => {
  // 反向不在 Turn 上写 linkedRunIds：Turn 记录在 execute() 里被整条覆盖写，
  // 反写会被那次覆盖清掉，两侧就会不一致。
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-turn-link'), undefined)
  const run = (turnId, id, createdAt) => store.putAgentRun(owner.id, {
    id, ownerId: owner.id, projectId: 'project-turn-link', status: 'queued',
    ...(turnId ? { turnId } : {}),
    plan: { intent: 'initial_generation', summary: '测试' }, branches: [],
    createdAt, updatedAt: createdAt,
  })
  run('turn-a', 'run-second', 200)
  run('turn-a', 'run-first', 100)
  run('turn-b', 'run-other', 150)
  run(undefined, 'run-no-turn', 120)

  const linked = store.listAgentRunsForTurn(owner.id, 'project-turn-link', 'turn-a')
  // 按创建时间升序：确认顺序是这条边唯一有意义的排序。
  assert.deepEqual(linked.map((item) => item.id), ['run-first', 'run-second'])
  assert.deepEqual(store.listAgentRunsForTurn(owner.id, 'project-turn-link', 'turn-b').map((item) => item.id), ['run-other'])
  assert.deepEqual(store.listAgentRunsForTurn(owner.id, 'project-turn-link', 'turn-missing'), [])
})

test('非成员不得按 Turn 反查 Run', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-turn-guard'), undefined)
  const outsider = store.createUser(owner.id, { email: 'out@example.com', name: 'Out', accessToken: 'out-token' })
  assert.equal(store.listAgentRunsForTurn(outsider.id, 'project-turn-guard', 'turn-a'), undefined)
})

test('Run/Job 深取消与 queued Run 恢复都按 id ASC 稳定分页', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-recovery-pages'
  store.writeProject(owner.id, document(projectId), undefined)
  const putRun = (id, status, turnId = 'turn-page') => store.putAgentRun(owner.id, {
    id, ownerId: owner.id, projectId, status, turnId,
    plan: { intent: 'initial_generation', summary: '分页测试' }, branches: [],
    createdAt: 100, updatedAt: 100,
  })
  putRun('run-c', 'queued')
  putRun('run-a', 'queued')
  putRun('run-b', 'queued')
  putRun('run-done', 'completed')
  putRun('run-other-turn', 'queued', 'turn-other')
  putRun('run-Z', 'queued')

  assert.deepEqual(store.listAgentRunsForTurnPage(owner.id, projectId, 'turn-page', {
    limit: 2,
  }).map((run) => run.id), ['run-a', 'run-b'])
  assert.deepEqual(store.listAgentRunsForTurnPage(owner.id, projectId, 'turn-page', {
    afterId: 'run-b', limit: 2,
  }).map((run) => run.id), ['run-c', 'run-done'])
  assert.deepEqual(store.listAgentRunsForTurnPage(owner.id, projectId, 'turn-page', {
    afterId: 'run-done', limit: 2,
  }).map((run) => run.id), ['run-Z'], 'filter 与 localeCompare sort 必须使用同一比较器')
  assert.deepEqual(store.listQueuedAgentRunsForRecovery({ limit: 2 }).map((run) => run.id), ['run-a', 'run-b'])
  assert.deepEqual(store.listQueuedAgentRunsForRecovery({ afterId: 'run-b', limit: 10 }).map((run) => run.id), [
    'run-c', 'run-other-turn', 'run-Z',
  ])

  const putJob = (id, runId) => store.putGenerationJob(owner.id, {
    id, ownerId: owner.id, projectId, status: 'queued', prompt: '测试', settings: {}, batchCount: 1,
    agentRun: { runId, branchId: 'branch-1' }, createdAt: 100, updatedAt: 100,
  }, { updateAgentRun: false, recordAudit: false })
  putJob('job-c', 'run-a')
  putJob('job-a', 'run-a')
  putJob('job-b', 'run-a')
  putJob('job-other', 'run-b')
  putJob('job-Z', 'run-a')
  assert.deepEqual(store.listGenerationJobsForAgentRunPage(owner.id, projectId, 'run-a', {
    limit: 2,
  }).map((job) => job.id), ['job-a', 'job-b'])
  assert.deepEqual(store.listGenerationJobsForAgentRunPage(owner.id, projectId, 'run-a', {
    afterId: 'job-b', limit: 2,
  }).map((job) => job.id), ['job-c', 'job-Z'])
  assert.deepEqual(store.listGenerationJobsForAgentRunPage(owner.id, projectId, 'run-a', {
    afterId: 'job-c', limit: 2,
  }).map((job) => job.id), ['job-Z'])
})

test('Recovery Adapter 按 (updatedAt,id) ASC 稳定分页且返回权威游标字段', (t) => {
  let clock = 100
  t.mock.method(Date, 'now', () => clock)
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-recovery-keyset'
  store.writeProject(owner.id, document(projectId), undefined)

  const putRun = (id, updatedAt, status = 'failed', branchStatus = 'failed') => store.putAgentRun(owner.id, {
    id,
    ownerId: owner.id,
    projectId,
    status,
    plan: { intent: 'initial_generation', summary: '恢复分页' },
    branches: [{ id: `${id}-branch`, status: branchStatus }],
    createdAt: updatedAt,
    updatedAt,
  })
  putRun('run-b', 200)
  putRun('run-a', 200)
  putRun('run-c', 300)
  putRun('run-ok', 150, 'completed', 'succeeded')

  assert.deepEqual(store.listRunsWithFailedBranches({ limit: 2 }), [
    { id: 'run-a', runId: 'run-a', ownerId: owner.id, projectId, updatedAt: 200 },
    { id: 'run-b', runId: 'run-b', ownerId: owner.id, projectId, updatedAt: 200 },
  ])
  assert.deepEqual(store.listRunsWithFailedBranches({
    after: { updatedAt: 200, id: 'run-a' },
    limit: 2,
  }).map((item) => item.id), ['run-b', 'run-c'])

  const putTask = (id, updatedAt, status = 'queued') => {
    clock = updatedAt
    return store.putAgentReviewTask(owner.id, {
      id,
      ownerId: owner.id,
      projectId,
      runId: 'run-a',
      status,
      attempt: 0,
      qualityPolicyFingerprint: 'quality-v1',
      coverage: { artifactIds: [`generation:${id}:output`] },
      results: [],
      createdAt: updatedAt,
      updatedAt,
    })
  }
  putTask('task-b', 400)
  putTask('task-a', 400)
  putTask('task-c', 500)
  assert.deepEqual(store.listPendingAgentReviewTasks({ olderThan: 450, limit: 2 }).map((task) => task.id), [
    'task-a', 'task-b',
  ])
  assert.deepEqual(store.listPendingAgentReviewTasks({
    olderThan: 600,
    after: { updatedAt: 400, id: 'task-a' },
    limit: 2,
  }).map((task) => task.id), ['task-b', 'task-c'])

  const putJob = (id, updatedAt, status = 'queued', projectWritebackPending = false) => {
    clock = updatedAt
    return store.putGenerationJob(owner.id, {
      id,
      ownerId: owner.id,
      projectId,
      status,
      kind: 'generation',
      batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      rawInput: { projectId },
      outputs: [],
      projectWritebackPending,
      createdAt: updatedAt,
      updatedAt,
    }, { updateAgentRun: false, recordAudit: false })
  }
  putJob('job-b', 600)
  putJob('job-a', 600)
  putJob('job-c', 700, 'succeeded', true)
  putJob('job-running', 650, 'running')
  assert.deepEqual(store.listRecoverableGenerationJobs({ limit: 2 }).map((job) => job.id), ['job-a', 'job-b'])
  assert.deepEqual(store.listRecoverableGenerationJobs({
    after: { updatedAt: 600, id: 'job-a' },
    limit: 2,
  }).map((job) => job.id), ['job-b', 'job-c'])
})

test('Agent Context V2 持久化 usage anchor、CAS head 与 append-only compaction ledger', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  const projectId = 'project-context-v2'
  const sessionId = 'session-context-v2'
  store.writeProject(owner.id, { ...document(projectId), agentSessions: [], agentMemory: [], agentRuns: [] }, undefined)
  store.putAgentSession(owner.id, projectId, {
    id: sessionId, title: 'Context V2', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 10,
  })
  store.putAgentMessage(owner.id, projectId, sessionId, {
    id: 'context-message-1', role: 'user', kind: 'text', content: '原始消息不得删除', createdAt: 11, updatedAt: 11,
  })
  const editor = store.createUser(owner.id, {
    email: 'context-editor@example.com', name: 'Context Editor', accessToken: 'context-editor-token',
  })
  const viewer = store.createUser(owner.id, {
    email: 'context-viewer@example.com', name: 'Context Viewer', accessToken: 'context-viewer-token',
  })
  store.addProjectMember(owner.id, projectId, editor.id, 'editor')
  store.addProjectMember(owner.id, projectId, viewer.id, 'viewer')

  assert.deepEqual(store.readAgentContextState(viewer.id, projectId, sessionId), {
    version: 2, sessionId, projectId, revision: 0, updatedAt: 0,
  })
  assert.throws(() => store.compareAndSetAgentContextState(viewer.id, {
    projectId, sessionId, expectedRevision: 0, idempotencyKey: 'viewer-write',
    usageAnchor: {
      version: 1, provider: 'openai', model: 'gpt-5', surfaceHash: 'surface-1', staticHash: 'static-1',
      inputTokens: 100, outputTokens: 10, heuristicInputTokens: 90, observedAt: 100,
    },
  }), (error) => error?.code === 'PROJECT_WRITE_FORBIDDEN')

  const anchorCommand = {
    projectId, sessionId, expectedRevision: 0, idempotencyKey: 'anchor-1',
    usageAnchor: {
      version: 1, provider: 'openai', model: 'gpt-5', surfaceHash: 'surface-1', staticHash: 'static-1',
      inputTokens: 100, outputTokens: 10, heuristicInputTokens: 90, observedAt: 100, turnId: 'turn-1', step: 1,
    },
  }
  const anchored = store.compareAndSetAgentContextState(owner.id, anchorCommand)
  assert.equal(anchored.kind, 'updated')
  assert.equal(anchored.state.revision, 1)
  assert.deepEqual(store.listAgentContextCompactions(owner.id, projectId, sessionId).compactions, [],
    'usage-only ledger 不应被读成 compaction')

  const compaction = {
    id: 'compaction-1', version: 2, trigger: 'pre_step',
    sourceSurfaceHash: 'surface-1', resultSurfaceHash: 'surface-2',
    replacedMessageRevisions: [{ messageId: 'context-message-1', revision: 'revision-1' }],
    checkpoint: {
      role: 'user', content: '已压缩上下文', contentHash: canonicalHash('已压缩上下文'),
    },
    policy: { id: 'context-policy-1', hash: 'policy-hash-1', model: 'gpt-5' },
    meterBefore: { totalTokens: 7_000 }, meterAfter: { totalTokens: 1_000 },
  }
  const compacted = store.compareAndSetAgentContextState(editor.id, {
    projectId, sessionId, expectedRevision: 1, idempotencyKey: 'compact-1', compaction,
  })
  assert.equal(compacted.kind, 'updated')
  assert.equal(compacted.state.revision, 2)
  assert.equal(compacted.state.headCompactionId, compaction.id)
  assert.equal(compacted.state.headCompactionSequence, 2)
  assert.deepEqual(compacted.state.usageAnchor, anchorCommand.usageAnchor)
  assert.deepEqual(store.listAgentContextCompactions(viewer.id, projectId, sessionId, {
    afterSequence: 0, limit: 10,
  }).compactions, [{ ...compaction, sequence: 2, createdAt: compacted.state.updatedAt }])

  const replay = store.compareAndSetAgentContextState(owner.id, { ...anchorCommand, expectedRevision: 2 })
  assert.equal(replay.kind, 'replay')
  assert.equal(replay.state.revision, 1, '历史键返回原始响应快照')
  assert.equal(store.compareAndSetAgentContextState(owner.id, {
    ...anchorCommand,
    usageAnchor: { ...anchorCommand.usageAnchor, inputTokens: 101 },
  }).kind, 'conflict')
  assert.equal(store.compareAndSetAgentContextState(owner.id, {
    ...anchorCommand, idempotencyKey: 'stale-new-key',
  }).kind, 'conflict')
  assert.equal(store.listAgentSessionMessages(owner.id, projectId, sessionId).messages[0].content,
    '原始消息不得删除')

  const persisted = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(persisted.agentContextStates[0].ownerId, owner.id, 'Editor 推进 head 不得改绑 owner')
  assert.equal(persisted.agentContextCompactions.length, 2, '失败/replay CAS 不追加 ledger')
  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(reloaded.readAgentContextState(owner.id, projectId, sessionId).revision, 2)
  assert.equal(reloaded.listAgentContextCompactions(owner.id, projectId, sessionId).compactions.length, 1)
})
