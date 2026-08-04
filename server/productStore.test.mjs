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

test('Agent Session、Message 与 Memory 从旧文档双写到独立实体并跨重启恢复', () => {
  const { path, store } = createStore()
  const owner = store.authenticate('owner-token')
  const legacy = {
    ...document('project-agent-state'),
    agentSessions: [{
      id: 'session-a', title: '首个会话', executionMode: 'manual', contextNodeIds: ['node-a'],
      messages: [{ id: 'message-a', role: 'user', kind: 'text', content: '第一条', createdAt: 10 }],
      createdAt: 10, updatedAt: 10,
    }],
    agentMemory: [{ id: 'memory-a', kind: 'rule', content: '保持品牌色', sourceNodeIds: ['node-a'], createdAt: 10, updatedAt: 10 }],
    agentRuns: [],
    activeAgentSessionId: 'session-a',
  }
  store.writeProject(owner.id, legacy, undefined)

  const reloaded = createProductStore({ dataPath: path, bootstrapAccessToken: 'owner-token' })
  assert.deepEqual(reloaded.readAgentState(owner.id, legacy.id).sessions[0].messages.map((item) => item.id), ['message-a'])
  assert.equal(reloaded.readAgentState(owner.id, legacy.id).memory[0].content, '保持品牌色')
  assert.equal(reloaded.readProject(owner.id, legacy.id).document.activeAgentSessionId, 'session-a')
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
