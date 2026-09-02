import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MEMORY_SELECTION_TIERS,
  MEMORY_SUBJECTS,
  isActiveMemory,
  memoryBindingSnapshot,
  memoryConfidenceScore,
  memorySubjectApplicability,
  selectBotanicAgentMemory,
} from './botanicAgentMemory.mjs'

const memory = [
  { id: 'human-rule', kind: 'rule', content: '瓶身比例不可改变', sourceNodeIds: ['product'], source: 'human', confidence: 'confirmed', scope: 'project', version: 2, contentHash: 'hash-1', updatedAt: 300 },
  { id: 'old-avoid', kind: 'avoid', content: '不要使用过度饱和的背景', sourceNodeIds: [], source: 'conversation', confidence: 'provisional', updatedAt: 200 },
  { id: 'scene-rule', kind: 'approved', content: '夏日海边自然光', sourceNodeIds: ['scene'], source: 'human', confidence: 'confirmed', scope: 'project', updatedAt: 100 },
]

test('Memory V2 选择器优先命中查询、上下文关联和已确认来源', () => {
  const result = selectBotanicAgentMemory(memory, { query: '比例', contextNodeIds: ['product'] })
  assert.equal(result.zeroHit, false)
  assert.equal(result.matchedQuery, true)
  assert.equal(result.items[0].id, 'human-rule')
  assert.equal(result.selections[0].tier, 'matched')
})

test('用户确认过的规则不因为本轮措辞没命中而落选', () => {
  // 用户存下的规则不会和每次查询用同样的措辞；用阈值淘汰等于把「没命中」当成
  // 「不相关」，那条规则就永远等不到生效的那一轮（ADR 0006）。
  const result = selectBotanicAgentMemory(memory, { query: '完全无关的词' })
  assert.equal(result.zeroHit, false)
  assert.deepEqual(result.items.map((item) => item.id), ['human-rule', 'scene-rule'])
  assert.ok(result.selections.every((selection) => selection.tier === 'standing'))
  // 但要照实说明本轮查询并没有命中，否则读者会以为这些规则是针对他这次问题的。
  assert.equal(result.matchedQuery, false)
})

test('非人工来源且未命中的记忆在有查询时才被淘汰', () => {
  const withMachineMemory = [
    ...memory,
    { id: 'machine-rule', kind: 'rule', content: '模型推断的构图偏好', sourceNodeIds: [], source: 'review', confidence: 'confirmed', updatedAt: 400 },
  ]
  assert.deepEqual(
    selectBotanicAgentMemory(withMachineMemory, { query: '完全无关的词' }).items.map((item) => item.id),
    ['human-rule', 'scene-rule'],
  )
  // 没有查询时不做相关性淘汰：这是「当前生效的全部规则」。
  assert.deepEqual(
    selectBotanicAgentMemory(withMachineMemory).items.map((item) => item.id).sort(),
    ['human-rule', 'machine-rule', 'scene-rule'],
  )
})

test('Memory V2 不把未激活的候选暴露给 Planner', () => {
  const result = selectBotanicAgentMemory(memory)
  assert.deepEqual(result.items.map((item) => item.id).sort(), ['human-rule', 'scene-rule'])
  assert.equal(result.items.some((item) => item.confidence === 'provisional'), false)
})

test('激活态由 status 决定，没有 status 的历史记忆按 confidence 兼容判定', () => {
  // status 是激活开关，confidence 是可信程度，两者不能互相顶替：
  // 「未确认但很可信」和「已确认但已停用」都要能表达。
  assert.equal(isActiveMemory({ status: 'active', confidence: 'provisional' }), true)
  assert.equal(isActiveMemory({ status: 'proposed', confidence: 'confirmed' }), false)
  assert.equal(isActiveMemory({ status: 'superseded', confidence: 'confirmed' }), false)
  assert.equal(isActiveMemory({ status: 'deleted', confidence: 'confirmed' }), false)
  // 历史记忆没有 status。
  assert.equal(isActiveMemory({ confidence: 'confirmed' }), true)
  assert.equal(isActiveMemory({ confidence: 'provisional' }), false)
  assert.equal(isActiveMemory({}), true)
  assert.equal(isActiveMemory(undefined), false)
})

test('停用与替代的记忆不再进入任何读取路径', () => {
  const governed = [
    { id: 'active-rule', kind: 'rule', content: '主色只用品牌绿', sourceNodeIds: [], source: 'human', status: 'active', confidence: 'confirmed', updatedAt: 500 },
    { id: 'superseded-rule', kind: 'rule', content: '主色用旧版蓝', sourceNodeIds: [], source: 'human', status: 'superseded', confidence: 'confirmed', updatedAt: 400 },
    { id: 'proposed-rule', kind: 'rule', content: '模型建议的规则', sourceNodeIds: [], source: 'review', status: 'proposed', confidence: 'confirmed', updatedAt: 600 },
  ]
  assert.deepEqual(selectBotanicAgentMemory(governed).items.map((item) => item.id), ['active-rule'])
})

test('绑定快照记录版本、内容摘要与「为什么用了这条」', () => {
  assert.deepEqual(memoryBindingSnapshot(memory, { query: '比例' }), [
    { id: 'human-rule', version: 2, contentHash: 'hash-1', selectionReason: '匹配本轮检索「比例」' },
    { id: 'scene-rule', selectionReason: '用户确认的常驻项目规则' },
  ])
  assert.deepEqual(
    memoryBindingSnapshot(memory, { contextNodeIds: ['scene'] }).find((binding) => binding.id === 'scene-rule'),
    { id: 'scene-rule', selectionReason: '关联本轮画布上下文' },
  )
})

test('分档是声明式的，排序按分档优先于分数', () => {
  assert.deepEqual([...MEMORY_SELECTION_TIERS], ['matched', 'standing', 'weak'])
  // 命中的记忆即使总分较低，也排在未命中的常驻规则之前。
  const items = [
    { id: 'standing-high', kind: 'rule', content: '常驻规则', sourceNodeIds: [], source: 'human', confidence: 'confirmed', scope: 'run', updatedAt: 900 },
    { id: 'matched-low', kind: 'rule', content: '海边', sourceNodeIds: [], source: 'review', updatedAt: 100 },
  ]
  const result = selectBotanicAgentMemory(items, { query: '海边' })
  assert.deepEqual(result.items.map((item) => item.id), ['matched-low', 'standing-high'])
})

test('同分时新的规则在前', () => {
  const items = [
    { id: 'older', kind: 'rule', content: '旧规则', sourceNodeIds: [], source: 'human', confidence: 'confirmed', scope: 'project', updatedAt: 100 },
    { id: 'newer', kind: 'rule', content: '新规则', sourceNodeIds: [], source: 'human', confidence: 'confirmed', scope: 'project', updatedAt: 900 },
  ]
  assert.deepEqual(selectBotanicAgentMemory(items).items.map((item) => item.id), ['newer', 'older'])
})

test('相互矛盾的记忆不同时进入同一个 Plan，落选的被记录而不是静默丢弃', () => {
  // 静默丢弃会让「为什么这条规则没生效」无从解释。
  const conflicting = [
    { id: 'rule-green', kind: 'rule', content: '主色只用品牌绿', sourceNodeIds: [], source: 'human', status: 'active', updatedAt: 900 },
    { id: 'rule-blue', kind: 'rule', content: '主色只用品牌蓝', sourceNodeIds: [], source: 'human', status: 'active', conflictsWith: ['rule-green'], updatedAt: 100 },
    { id: 'rule-spacing', kind: 'rule', content: '保持留白', sourceNodeIds: [], source: 'human', status: 'active', updatedAt: 500 },
  ]
  const result = selectBotanicAgentMemory(conflicting)
  assert.deepEqual(result.items.map((item) => item.id), ['rule-green', 'rule-spacing'])
  assert.deepEqual(result.conflicts, [{ keptId: 'rule-green', droppedId: 'rule-blue' }])
})

test('冲突声明是对称的：只有一侧写了也成立', () => {
  // 单方面声明若被忽略，两条矛盾规则仍会一起进 Plan。
  const oneSided = [
    { id: 'rule-a', kind: 'rule', content: '规则 A', sourceNodeIds: [], source: 'human', status: 'active', conflictsWith: ['rule-b'], updatedAt: 900 },
    { id: 'rule-b', kind: 'rule', content: '规则 B', sourceNodeIds: [], source: 'human', status: 'active', updatedAt: 100 },
  ]
  assert.deepEqual(selectBotanicAgentMemory(oneSided).items.map((item) => item.id), ['rule-a'])
  const reversed = [
    { id: 'rule-b', kind: 'rule', content: '规则 B', sourceNodeIds: [], source: 'human', status: 'active', updatedAt: 900 },
    { id: 'rule-a', kind: 'rule', content: '规则 A', sourceNodeIds: [], source: 'human', status: 'active', conflictsWith: ['rule-b'], updatedAt: 100 },
  ]
  assert.deepEqual(selectBotanicAgentMemory(reversed).items.map((item) => item.id), ['rule-b'])
})

test('命中本轮查询的一方在冲突中胜出，与写入时间无关', () => {
  const conflicting = [
    { id: 'rule-old-hit', kind: 'rule', content: '海边场景用暖光', sourceNodeIds: [], source: 'human', status: 'active', updatedAt: 100 },
    { id: 'rule-new-miss', kind: 'rule', content: '统一用冷光', sourceNodeIds: [], source: 'human', status: 'active', conflictsWith: ['rule-old-hit'], updatedAt: 900 },
  ]
  const result = selectBotanicAgentMemory(conflicting, { query: '海边' })
  assert.deepEqual(result.items.map((item) => item.id), ['rule-old-hit'])
  assert.deepEqual(result.conflicts, [{ keptId: 'rule-old-hit', droppedId: 'rule-new-miss' }])
})

test('可信程度是读时派生的数值，不改存储也不迁移历史', () => {
  // 原先推迟这一项的理由是「改数值要迁移全部历史数据与每处读取」——那说的是把枚举
  // 换成数值。这里是叠加：没给分数就按枚举派生，两条路径同一个量纲。
  assert.equal(memoryConfidenceScore({ confidence: 'confirmed' }), 0.85)
  assert.equal(memoryConfidenceScore({ confidence: 'provisional' }), 0.4)
  assert.equal(memoryConfidenceScore({}), 0.85, '没有 confidence 的历史记忆按已确认处理')
  assert.equal(memoryConfidenceScore({ confidence: 'confirmed', confidenceScore: 0.6 }), 0.6, '显式分数优先')
  // 越界值按「没给」处理而不是夹到边界：夹了之后一个写错的 42 会变成最高可信度。
  assert.equal(memoryConfidenceScore({ confidence: 'provisional', confidenceScore: 42 }), 0.4)
  assert.equal(memoryConfidenceScore({ confidence: 'provisional', confidenceScore: -1 }), 0.4)
})

test('同一档内可信度更高的排在前面', () => {
  // 此前 confirmed 一律 +4，两条都确认过的记忆完全平手，谁在前只取决于数组顺序。
  const base = { kind: 'rule', sourceNodeIds: [], createdAt: 1, updatedAt: 1, source: 'human', status: 'active', confidence: 'confirmed' }
  const selected = selectBotanicAgentMemory([
    { ...base, id: 'lower', content: '较低可信', confidenceScore: 0.5 },
    { ...base, id: 'higher', content: '较高可信', confidenceScore: 0.95 },
  ], {})
  assert.deepEqual(selected.selections.map((entry) => entry.item.id), ['higher', 'lower'])
})

const subjectRule = (extra) => ({
  id: 'r', kind: 'rule', content: '规则', sourceNodeIds: [],
  createdAt: 1, updatedAt: 1, source: 'human', status: 'active', ...extra,
})

test('适用主体词表按具体程度排序', () => {
  assert.deepEqual([...MEMORY_SUBJECTS], ['project', 'brand', 'product', 'channel', 'user'])
})

test('缺省主体永远适用，等于改动前的行为', () => {
  assert.equal(memorySubjectApplicability({}, {}).applies, true)
  assert.equal(memorySubjectApplicability({ subject: 'project' }, {}).applies, true)
})

test('「本次没有那个维度」与「取值不同」是两个不同的落选原因', () => {
  // 两者修法完全不同：一个是这次生成没有渠道信息，一个是这条规则不适用于京东。
  const rule = { subject: 'channel', subjectValue: 'tmall' }
  const missing = memorySubjectApplicability(rule, {})
  assert.equal(missing.applies, false)
  assert.equal(missing.code, 'context_missing')
  assert.match(missing.detail, /本次生成没有渠道信息/u)

  const mismatch = memorySubjectApplicability(rule, { channel: 'jd' })
  assert.equal(mismatch.applies, false)
  assert.equal(mismatch.code, 'context_mismatch')
  assert.match(mismatch.detail, /限定渠道「tmall」，本次是「jd」/u)

  assert.equal(memorySubjectApplicability(rule, { channel: 'tmall' }).applies, true)
})

test('残缺与未知主体一律判不适用', () => {
  // 限定了主体却没取值，规则永远不会匹配任何执行；未知主体可能来自更新的写侧，
  // 放行等于凭空扩大适用面。
  assert.equal(memorySubjectApplicability({ subject: 'channel' }, { channel: 'tmall' }).code, 'subject_value_missing')
  assert.equal(memorySubjectApplicability({ subject: 'season', subjectValue: '夏' }, {}).code, 'subject_unknown')
})

test('不适用的规则被排除而不是降权，且落选原因可见', () => {
  // 降权只是让它排在后面，限额一满照样进 Prompt。
  const selected = selectBotanicAgentMemory([
    subjectRule({ id: 'all', content: '全项目规则' }),
    subjectRule({ id: 'tmall', content: '天猫顶部留 20% 安全区', subject: 'channel', subjectValue: 'tmall' }),
    subjectRule({ id: 'jd', content: '京东主图不加角标', subject: 'channel', subjectValue: 'jd' }),
  ], { context: { channel: 'tmall' } })
  assert.deepEqual(selected.items.map((item) => item.id), ['tmall', 'all'], '限定渠道的更具体，排在前')
  // 静默丢弃会让「为什么这条规则没生效」无从解释。
  assert.deepEqual(selected.filtered, [{ id: 'jd', code: 'context_mismatch', detail: '这条规则限定渠道「jd」，本次是「tmall」。' }])
})

test('没有上下文时限定主体的规则全部落选并说明', () => {
  // 用户写「仅天猫」就是这个意思；用在没有渠道的场景等于应用了一条他说过不要应用的规则。
  const selected = selectBotanicAgentMemory([
    subjectRule({ id: 'all', content: '全项目规则' }),
    subjectRule({ id: 'tmall', content: '天猫规则', subject: 'channel', subjectValue: 'tmall' }),
  ], {})
  assert.deepEqual(selected.items.map((item) => item.id), ['all'])
  assert.equal(selected.filtered[0].code, 'context_missing')
})

test('品牌与产品主体按各自的上下文维度判定', () => {
  const memory = [
    subjectRule({ id: 'brand', content: '品牌规则', subject: 'brand', subjectValue: 'botanic' }),
    subjectRule({ id: 'sku', content: '产品规则', subject: 'product', subjectValue: 'SKU-A' }),
    subjectRule({ id: 'me', content: '个人偏好', subject: 'user', subjectValue: 'u-1' }),
  ]
  assert.deepEqual(
    selectBotanicAgentMemory(memory, { context: { brandId: 'botanic', sku: 'SKU-A', userId: 'u-1' } }).items.map((item) => item.id).sort(),
    ['brand', 'me', 'sku'],
  )
  // 项目改绑了别的品牌之后，品牌规则应当停止生效。
  assert.deepEqual(
    selectBotanicAgentMemory(memory, { context: { brandId: 'other', sku: 'SKU-A', userId: 'u-1' } }).items.map((item) => item.id).sort(),
    ['me', 'sku'],
  )
})

test('绑定快照同样只含适用的规则', () => {
  const bindings = memoryBindingSnapshot([
    subjectRule({ id: 'all', content: '全项目规则' }),
    subjectRule({ id: 'jd', content: '京东规则', subject: 'channel', subjectValue: 'jd' }),
  ], { context: { channel: 'tmall' } })
  assert.deepEqual(bindings.map((binding) => binding.id), ['all'])
})
