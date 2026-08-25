import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ROLLOUT_FLAGS,
  agentFeatureEnabled,
  createRolloutFlags,
  parseRolloutFlagRule,
  resolveAgentFeatureFlags,
} from './featureFlags.mjs'

// ── 已发布能力的 kill switch：默认 true ──────────────────────────────────

test('Agent V2 flags 默认启用，便于完整升级后直接生效', () => {
  assert.deepEqual(resolveAgentFeatureFlags({}), {
    runtimeV2: true,
    qualityV2: true,
    memoryV2: true,
    skillGovernanceV2: true,
    forkCompareV2: true,
  })
})

test('Agent V2 flags accept common truthy values and expose stable lookups', () => {
  const flags = resolveAgentFeatureFlags({
    AGENT_RUNTIME_V2: 'true',
    AGENT_QUALITY_V2: '1',
    AGENT_MEMORY_V2: 'on',
    AGENT_SKILL_GOVERNANCE_V2: 'yes',
    AGENT_FORK_COMPARE_V2: 'false',
  })
  assert.equal(agentFeatureEnabled(flags, 'runtimeV2'), true)
  assert.equal(agentFeatureEnabled(flags, 'qualityV2'), true)
  assert.equal(agentFeatureEnabled(flags, 'memoryV2'), true)
  assert.equal(agentFeatureEnabled(flags, 'skillGovernanceV2'), true)
  assert.equal(agentFeatureEnabled(flags, 'forkCompareV2'), false)
})

// ── 升级期灰度闸门：默认 false ───────────────────────────────────────────

test('两类旗标的默认值相反，避免把未建成路径当成已发布能力', () => {
  // 已发布能力默认开，未建成路径默认关。混用会让未完成的代码在生产直接生效。
  assert.equal(resolveAgentFeatureFlags({}).runtimeV2, true)
  assert.deepEqual(createRolloutFlags({}).enabledFor(), [])
})

test('灰度闸门默认全部关闭，因此关掉全部新 Flag 后现有路径行为不变是默认状态', () => {
  const flags = createRolloutFlags({})
  assert.deepEqual(flags.enabledFor(), [])
  assert.deepEqual(flags.enabledFor({ projectId: 'project-a', userId: 'user-a' }), [])
  for (const name of ROLLOUT_FLAGS) assert.equal(flags.isEnabled(name), false, `${name} 默认应关闭`)
})

test('未声明的灰度闸门名称抛错，不静默返回 false', () => {
  const flags = createRolloutFlags({ AGENT_TURN_RESUME_V3: 'true' })
  // 拼错的 Flag 名如果静默为假，功能会永远打不开且没有任何信号。
  assert.throws(() => flags.isEnabled('AGNET_TURN_RESUME_V3'), /未声明的 Feature Flag/u)
  assert.throws(() => flags.isEnabled('PRODUCTION_WORKFLOW_V3'), /未声明的 Feature Flag/u)
  // kill switch 的名字也不属于灰度词表，不能混查。
  assert.throws(() => flags.isEnabled('runtimeV2'), /未声明的 Feature Flag/u)
})

test('truthy 与 falsy 字面量按全局开关解析', () => {
  for (const raw of ['true', 'TRUE', '1', 'on', 'yes']) {
    assert.equal(parseRolloutFlagRule(raw).mode, 'all', `${raw} 应为全开`)
  }
  for (const raw of ['false', '0', 'off', 'no', '', '   ', undefined]) {
    assert.equal(parseRolloutFlagRule(raw).mode, 'off', `${String(raw)} 应为全关`)
  }
})

test('按项目与按用户灰度只对命中的上下文开启', () => {
  const flags = createRolloutFlags({
    AGENT_TURN_RESUME_V3: 'project:project-a, project:project-b',
    AGENT_ACTIVE_CANCEL_V3: 'user:user-a',
    AGENT_COMPILED_PLAN_V2: 'true',
  })
  assert.equal(flags.isEnabled('AGENT_TURN_RESUME_V3', { projectId: 'project-a' }), true)
  assert.equal(flags.isEnabled('AGENT_TURN_RESUME_V3', { projectId: 'project-b' }), true)
  assert.equal(flags.isEnabled('AGENT_TURN_RESUME_V3', { projectId: 'project-z' }), false)
  // 没有上下文时按项目灰度的 Flag 不得开启，否则后台任务会误用新路径。
  assert.equal(flags.isEnabled('AGENT_TURN_RESUME_V3'), false)

  assert.equal(flags.isEnabled('AGENT_ACTIVE_CANCEL_V3', { userId: 'user-a' }), true)
  // 项目选择器与用户选择器不得互相命中。
  assert.equal(flags.isEnabled('AGENT_ACTIVE_CANCEL_V3', { projectId: 'user-a' }), false)

  // 全开的 Flag 不需要上下文。
  assert.equal(flags.isEnabled('AGENT_COMPILED_PLAN_V2'), true)

  assert.deepEqual(
    flags.enabledFor({ projectId: 'project-a', userId: 'user-a' }).sort(),
    ['AGENT_ACTIVE_CANCEL_V3', 'AGENT_COMPILED_PLAN_V2', 'AGENT_TURN_RESUME_V3'],
  )
})

test('选择器笔误被忽略并汇总，不让配置错误拖垮启动', () => {
  const flags = createRolloutFlags({ PRODUCTION_WORKFLOW_V2: 'projekt:project-a,project:project-b' })
  assert.equal(flags.isEnabled('PRODUCTION_WORKFLOW_V2', { projectId: 'project-b' }), true)
  assert.equal(flags.isEnabled('PRODUCTION_WORKFLOW_V2', { projectId: 'project-a' }), false)
  assert.deepEqual(flags.invalidSelectors(), [{ name: 'PRODUCTION_WORKFLOW_V2', entry: 'projekt:project-a' }])
})

test('全部选择器都无效时收敛为关闭，不误开成全局生效', () => {
  const rule = parseRolloutFlagRule('nonsense,alsowrong')
  assert.equal(rule.mode, 'off')
  assert.deepEqual(rule.invalid, ['nonsense', 'alsowrong'])
  const flags = createRolloutFlags({ AGENT_REVIEW_WORKER_V3: 'nonsense' })
  assert.equal(flags.isEnabled('AGENT_REVIEW_WORKER_V3', { projectId: 'any' }), false)
})

test('已开启名单只暴露 Flag 名，不泄漏白名单里的项目或用户标识', () => {
  const flags = createRolloutFlags({ AGENT_TURN_RESUME_V3: 'project:secret-project-id' })
  const names = flags.enabledFor({ projectId: 'secret-project-id' })
  assert.deepEqual(names, ['AGENT_TURN_RESUME_V3'])
  assert.doesNotMatch(JSON.stringify(names), /secret-project-id/u)
})
