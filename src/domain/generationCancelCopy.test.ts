import assert from 'node:assert/strict'
import test from 'node:test'
import { generationCancelAssistantMessage, generationCancelMessage, type GenerationCancelOutcome } from './generationCancelCopy.ts'

const outcome = (extra: Partial<GenerationCancelOutcome>): GenerationCancelOutcome => ({
  billing: 'possible', capability: 'local-abort-only', workerReleased: true, code: 'CANCELLED_RESULT_DISCARDED',
  ...extra,
})

test('已派发的取消必须说明费用可能已产生，不能只说已取消', () => {
  // 当前 Provider 都不支持提交后停止计费；只说「已取消」会让用户以为省下了费用。
  for (const locale of ['zh-CN', 'en'] as const) {
    const message = generationCancelMessage(outcome({}), locale)
    assert.match(message, locale === 'en' ? /quota may have been consumed/u : /费用可能已产生/u)
    assert.doesNotMatch(message, locale === 'en' ? /No generation quota/u : /未消耗/u)
  }
})

test('派发前取消可以直说没有消耗额度', () => {
  const message = generationCancelMessage(outcome({ billing: 'none', code: 'CANCELLED_BEFORE_DISPATCH' }), 'zh-CN')
  assert.match(message, /未消耗生成额度/u)
  assert.match(
    generationCancelMessage(outcome({ billing: 'none', code: 'CANCELLED_BEFORE_DISPATCH' }), 'en'),
    /No generation quota was used/u,
  )
})

test('已结算的任务说明它本就无需取消', () => {
  assert.match(generationCancelMessage(outcome({ code: 'ALREADY_SETTLED', billing: 'none' }), 'zh-CN'), /已经结束/u)
  assert.match(generationCancelMessage(outcome({ code: 'ALREADY_SETTLED', billing: 'none' }), 'en'), /already finished/u)
})

test('远端取消可用时才允许说没有费用', () => {
  const message = generationCancelMessage(
    outcome({ billing: 'none', capability: 'remote-cancel', code: 'CANCELLED_AT_PROVIDER' }),
    'zh-CN',
  )
  assert.doesNotMatch(message, /费用可能已产生/u)
})

test('缺少判定时退到中性表述，不臆测计费情况', () => {
  // 旧客户端或旧服务端可能没有 cancelOutcome；此时不能猜测任何一边。
  for (const locale of ['zh-CN', 'en'] as const) {
    const message = generationCancelMessage(undefined, locale)
    assert.doesNotMatch(message, locale === 'en' ? /quota/u : /额度|费用/u)
  }
})

test('画布助手文案同时说清计费判定与画布留下了什么', () => {
  // 取消只把任务节点改成 cancelled，提示词与参考组都还在；不说这一点用户会以为要从头再来。
  const message = generationCancelAssistantMessage(outcome({}), 'zh-CN')
  assert.match(message, /费用可能已产生/u)
  assert.match(message, /画布保留/u)
  const english = generationCancelAssistantMessage(outcome({}), 'en')
  assert.match(english, /quota may have been consumed/u)
  assert.match(english, /canvas keeps/u)
})

test('缺少判定时画布助手文案仍不臆测计费，但仍说明画布保留内容', () => {
  const message = generationCancelAssistantMessage(undefined, 'zh-CN')
  assert.doesNotMatch(message, /额度|费用/u)
  assert.match(message, /画布保留/u)
})

test('持久回执可以直接当判定用：刷新后仍照实说明费用', () => {
  // 服务端把回执写在任务上，字段是判定的超集；界面不必再问一次接口。
  const record = { requestedAt: 1_700, reason: 'user', ...outcome({}) }
  assert.match(generationCancelAssistantMessage(record, 'zh-CN'), /费用可能已产生/u)
  assert.match(
    generationCancelAssistantMessage({ requestedAt: 1, reason: 'workflow-pause', ...outcome({ billing: 'none', code: 'CANCELLED_BEFORE_DISPATCH' }) }, 'zh-CN'),
    /未消耗生成额度/u,
  )
})
