import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
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

test('项目 Skill 创建后可跨重启恢复且不会泄露到其他项目', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-skill-a'), undefined)
  store.writeProject(owner.id, document('project-skill-b'), undefined)

  const created = store.putAgentSkill(owner.id, {
    id: 'skill-scene-campaign',
    projectId: 'project-skill-a',
    name: '夏日场景系列',
    instructions: '锁定人物和服装，只替换场景与环境光线。',
    status: 'active',
    createdAt: 100,
    updatedAt: 100,
  })

  assert.equal(created.name, '夏日场景系列')
  assert.deepEqual(store.listAgentSkills(owner.id, 'project-skill-a').map((skill) => skill.id), ['skill-scene-campaign'])
  assert.deepEqual(store.listAgentSkills(owner.id, 'project-skill-b'), [])

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.equal(reloaded.listAgentSkills(owner.id, 'project-skill-a')[0]?.instructions, '锁定人物和服装，只替换场景与环境光线。')
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
    agentRun: { runId: 'run-agent', branchId: 'branch-1' }, outputs: [{ id: 'output-1' }], createdAt: 20, updatedAt: 30,
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

  const project = store.readProject(owner.id, 'project-agent-concurrent')
  assert.deepEqual(project.document.agentSessions[0].messages.map((item) => item.id), ['message-device-a', 'message-device-b'])
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

test('服务重启保留排队任务，并把执行中的任务标记为可重试失败', () => {
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
  assert.equal(store.readGenerationJob(owner.id, 'running-job')?.status, 'failed')
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

test('陈旧 Turn 扫描跨项目、只捞非终态、按最旧优先', () => {
  const { store } = createStore()
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, document('project-stale-a'), undefined)
  store.writeProject(owner.id, document('project-stale-b'), undefined)
  const put = (id, projectId, status, updatedAt) => store.putAgentTurn(owner.id, {
    id, version: 2, ownerId: owner.id, projectId, idempotencyKey: id,
    status, createdAt: 1, updatedAt,
  })
  put('turn_old_a', 'project-stale-a', 'running', 100)
  put('turn_old_b', 'project-stale-b', 'queued', 50)
  put('turn_waiting', 'project-stale-a', 'waiting_user', 200)
  put('turn_cancelling', 'project-stale-b', 'cancelling', 300)
  put('turn_done', 'project-stale-a', 'completed', 10)
  put('turn_failed', 'project-stale-b', 'failed', 10)
  put('turn_fresh', 'project-stale-a', 'running', 1_000_000)

  const stale = store.listStaleAgentTurns({ now: 1_000_000, leaseMs: 30_000 })
  assert.deepEqual(
    stale.map((turn) => turn.id),
    ['turn_old_b', 'turn_old_a', 'turn_waiting', 'turn_cancelling'],
    '跨项目按 updatedAt 升序返回全部非终态陈旧 Turn',
  )
  // 终态不该被重新拾起，租约内的也不该被抢。
  assert.equal(stale.some((turn) => ['turn_done', 'turn_failed'].includes(turn.id)), false)
  assert.equal(stale.some((turn) => turn.id === 'turn_fresh'), false)
  assert.deepEqual(store.listStaleAgentTurns({ now: 1_000_000, leaseMs: 30_000, limit: 2 }).map((t) => t.id), ['turn_old_b', 'turn_old_a'])
  // 显式 olderThan 落在两个陈旧 Turn 之间时，只捞更早的那个。
  assert.deepEqual(store.listStaleAgentTurns({ olderThan: 60 }).map((t) => t.id), ['turn_old_b'])
})
