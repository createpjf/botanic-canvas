import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FALLBACK_PROJECT_CAPABILITIES,
  PROJECT_CAPABILITIES,
  PROJECT_ENTRY_CAPABILITY,
  canUseProjectEntry,
  hasProjectCapability,
  isReadOnlyProject,
  readOnlyProjectNotice,
} from './projectCapabilities.ts'

// 与服务端 authorization.mjs 的三个角色一致。
const owner = ['read', 'edit', 'create-generation', 'delete-content', 'modify-workflow',
  'execute-external-tool', 'manage-members', 'delete-project', 'read-audit', 'read-operational']
const editor = ['read', 'edit', 'create-generation', 'delete-content', 'modify-workflow']
const viewer = ['read']

test('Viewer 看不到生成、Skill 发布、评审决定与工作流修改入口', () => {
  // 这四条正是 Epic 10 的验收原文。
  for (const entry of ['submitGeneration', 'publishSkill', 'decideReview', 'modifyWorkflow'] as const) {
    assert.equal(canUseProjectEntry(viewer, entry), false, `viewer 不该看到 ${entry}`)
    assert.equal(canUseProjectEntry(editor, entry), true, `editor 应该看到 ${entry}`)
    assert.equal(canUseProjectEntry(owner, entry), true, `owner 应该看到 ${entry}`)
  }
})

test('成员管理只有 owner 能看到', () => {
  assert.equal(canUseProjectEntry(owner, 'manageMembers'), true)
  assert.equal(canUseProjectEntry(editor, 'manageMembers'), false)
  assert.equal(canUseProjectEntry(viewer, 'manageMembers'), false)
})

test('外部工具只有 owner 能看到', () => {
  // 与服务端 agentActionGovernance 的 mcp_call → execute-external-tool 对应。
  assert.equal(canUseProjectEntry(owner, 'runExternalTool'), true)
  assert.equal(canUseProjectEntry(editor, 'runExternalTool'), false)
})

test('能力未取到时保守缺省为只读', () => {
  // 缺省成「什么都能做」会让一次读取失败变成越权入口全部显示。
  assert.deepEqual(FALLBACK_PROJECT_CAPABILITIES, ['read'])
  assert.equal(canUseProjectEntry(undefined, 'submitGeneration'), false)
  assert.equal(hasProjectCapability(undefined, 'read'), true)
  assert.equal(hasProjectCapability(undefined, 'edit'), false)
  // 空数组是「明确什么都不能」，比缺省更严。
  assert.equal(hasProjectCapability([], 'read'), false)
})

test('只读判定：能看但改不了', () => {
  assert.equal(isReadOnlyProject(viewer), true)
  assert.equal(isReadOnlyProject(editor), false)
  assert.equal(isReadOnlyProject(owner), false)
  assert.equal(isReadOnlyProject(undefined), true, '未取到能力时按只读展示')
  // 连 read 都没有的不是「只读」，那是无权访问，不该走只读提示这条路。
  assert.equal(isReadOnlyProject([]), false)
})

test('只读提示要说清为什么，不是只说「无权限」', () => {
  // 逐个按钮消失而不解释原因，用户只会以为功能坏了。
  assert.match(readOnlyProjectNotice(), /只有查看权限/u)
  assert.match(readOnlyProjectNotice(), /因为你无法执行它们/u)
  assert.match(readOnlyProjectNotice('en'), /view-only access/u)
})

test('每个入口都声明了它需要的能力，且能力都在词表里', () => {
  // 散落在组件里各写各的判断，迟早出现「这个按钮忘了判」。
  for (const [entry, capability] of Object.entries(PROJECT_ENTRY_CAPABILITY)) {
    assert.ok(
      (PROJECT_CAPABILITIES as readonly string[]).includes(capability),
      `入口 ${entry} 声明了词表外的能力 ${capability}`,
    )
  }
})
