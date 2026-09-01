import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentSkillFormReducer,
  BOTANIC_AGENT_MOUNTED_SKILL_LIMIT,
  canSubmitAgentSkillForm,
  emptyAgentSkillForm,
  nextExpandedSkillId,
  nextMountedSkillIds,
  type AgentSkillFormAction,
  type AgentSkillFormState,
} from './agentSkillForm.ts'

const reduce = (state: AgentSkillFormState, ...actions: AgentSkillFormAction[]) =>
  actions.reduce(agentSkillFormReducer, state)

const filled = reduce(emptyAgentSkillForm,
  { type: 'openForm' },
  { type: 'editName', value: '夏日换景' },
  { type: 'editInstructions', value: '保持商品，替换场景' },
)

test('编辑任一字段都退出确认态并清掉上次错误', () => {
  const confirmed = reduce(filled, { type: 'requestConfirm' })
  assert.equal(confirmed.confirming, true)

  // 内容变了，上一次的确认就不再成立。
  assert.equal(reduce(confirmed, { type: 'editName', value: '夏日换景 v2' }).confirming, false)
  assert.equal(reduce(confirmed, { type: 'editInstructions', value: '改成海边' }).confirming, false)

  const failed = reduce(filled, { type: 'submitFailed', error: 'Skill 创建失败。' })
  assert.equal(failed.error, 'Skill 创建失败。')
  assert.equal(reduce(failed, { type: 'editName', value: 'x' }).error, '')
  assert.equal(reduce(failed, { type: 'editInstructions', value: 'y' }).error, '')
})

test('内容不完整或正在保存时不能进入确认态', () => {
  assert.equal(canSubmitAgentSkillForm(emptyAgentSkillForm), false)
  // 只有空白字符不算填写。
  assert.equal(canSubmitAgentSkillForm({ ...filled, name: '   ' }), false)
  assert.equal(canSubmitAgentSkillForm({ ...filled, instructions: '\n\t' }), false)
  assert.equal(canSubmitAgentSkillForm(filled), true)
  assert.equal(canSubmitAgentSkillForm({ ...filled, saving: true }), false)

  // requestConfirm 自己也要守这条，否则空表单能走到确认区。
  assert.equal(reduce(emptyAgentSkillForm, { type: 'requestConfirm' }).confirming, false)
  assert.equal(reduce({ ...filled, saving: true }, { type: 'requestConfirm' }).confirming, false)
})

test('面板关闭收起表单但保留内容，重新打开还能接着写', () => {
  const closed = reduce(filled, { type: 'requestConfirm' }, { type: 'panelClosed' })
  assert.equal(closed.open, false)
  assert.equal(closed.confirming, false)
  assert.equal(closed.name, '夏日换景', '面板关闭不应丢掉已填内容')

  const reopened = reduce(closed, { type: 'openForm' })
  assert.equal(reopened.open, true)
  assert.equal(reopened.name, '夏日换景')
})

test('关闭表单清掉错误，下次打开不会挂着上次的报错', () => {
  const failed = reduce(filled, { type: 'submitFailed', error: '创建失败' })
  assert.equal(reduce(failed, { type: 'closeForm' }).error, '')
  assert.equal(reduce(failed, { type: 'openForm' }).error, '')
})

test('提交成功后表单整体回到初始态，避免同一内容被误提交第二次', () => {
  const submitted = reduce(filled, { type: 'requestConfirm' }, { type: 'submitStarted' })
  assert.equal(submitted.saving, true)
  assert.equal(submitted.error, '')

  const done = reduce(submitted, { type: 'submitSucceeded' })
  assert.deepEqual(done, emptyAgentSkillForm)
  assert.equal(canSubmitAgentSkillForm(done), false)
})

test('提交失败保留内容让用户可以重试', () => {
  const failed = reduce(filled, { type: 'submitStarted' }, { type: 'submitFailed', error: '创建失败' })
  assert.equal(failed.saving, false)
  assert.equal(failed.name, '夏日换景')
  assert.equal(failed.instructions, '保持商品，替换场景')
  assert.equal(canSubmitAgentSkillForm(failed), true)
})

test('初始态是冻结常量，reducer 不得原地改它', () => {
  const before = { ...emptyAgentSkillForm }
  reduce(emptyAgentSkillForm, { type: 'editName', value: 'x' }, { type: 'openForm' })
  assert.deepEqual({ ...emptyAgentSkillForm }, before)
})

test('展开是单选切换', () => {
  assert.equal(nextExpandedSkillId('', 'skill-a'), 'skill-a')
  assert.equal(nextExpandedSkillId('skill-a', 'skill-a'), '')
  assert.equal(nextExpandedSkillId('skill-a', 'skill-b'), 'skill-b')
})

test('挂载去重且保留原有挂载，卸载只移除目标', () => {
  assert.deepEqual(nextMountedSkillIds(['a'], 'b', true), ['a', 'b'])
  assert.deepEqual(nextMountedSkillIds(['a', 'b'], 'a', true), ['a', 'b'], '重复挂载不应产生重复 ID')
  assert.deepEqual(nextMountedSkillIds(['a', 'b'], 'a', false), ['b'])
  assert.deepEqual(nextMountedSkillIds([], 'a', false), [])
  // 不修改入参。
  const current = ['a', 'b']
  nextMountedSkillIds(current, 'c', true)
  assert.deepEqual(current, ['a', 'b'])
  // Composer、Skill 面板、新建后自动挂载共用此 owner:第 17 个绑定不能进入前端状态。
  const full = Array.from({ length: BOTANIC_AGENT_MOUNTED_SKILL_LIMIT }, (_, index) => `skill-${index}`)
  assert.deepEqual(nextMountedSkillIds(full, 'skill-17', true), full)
  assert.deepEqual(nextMountedSkillIds(full, 'skill-0', true), full, '满额时已挂载项仍保持幂等')
})
