import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEMORY_SUBJECT_OPTIONS,
  memoryComparisonRows,
  memoryConflictPairs,
  memoryIneffectiveReason,
  memorySubjectDescription,
  memorySubjectLabel,
} from './agentMemoryComparison.ts'
import type { BotanicAgentMemoryItem } from './agent.ts'

const item = (extra: Partial<BotanicAgentMemoryItem>): BotanicAgentMemoryItem => ({
  id: 'memory-x', kind: 'rule', content: '规则', sourceNodeIds: [],
  createdAt: 1, updatedAt: 1, source: 'human', status: 'active', ...extra,
})

const conflicting = [
  item({ id: 'green', content: '主色只用品牌绿', updatedAt: 900 }),
  item({ id: 'blue', content: '主色用旧版蓝', updatedAt: 100, conflictsWith: ['green'] }),
  item({ id: 'spacing', content: '保持留白', updatedAt: 500 }),
]

test('冲突是对称的：只有一侧写了也算', () => {
  assert.deepEqual(memoryConflictPairs(conflicting), [['blue', 'green']])
  // 指向不存在的记忆不算冲突。
  assert.deepEqual(memoryConflictPairs([item({ id: 'a', conflictsWith: ['missing'] })]), [])
})

test('冲突中只有一条生效，另一条被标出来', () => {
  // 用户看不到「这两条互相矛盾」，就永远不知道该停用哪一条，冲突会一直累积。
  const rows = memoryComparisonRows(conflicting)
  const byId = new Map(rows.map((row) => [row.id, row]))
  assert.equal(byId.get('green')?.effective, true)
  assert.equal(byId.get('blue')?.effective, false)
  assert.equal(byId.get('spacing')?.effective, true)
  // 双向都能看到冲突对象。
  assert.deepEqual(byId.get('green')?.conflictsWith, ['blue'])
  assert.deepEqual(byId.get('blue')?.conflictsWith, ['green'])
})

test('未生效的原因必须区分「被压住」与「你自己停用的」', () => {
  const rows = memoryComparisonRows([
    ...conflicting,
    item({ id: 'proposed', content: '模型建议', source: 'review', status: 'proposed' }),
    item({ id: 'retired', content: '旧规则', status: 'superseded', supersededBy: 'green' }),
  ])
  const byId = new Map(rows.map((row) => [row.id, row]))
  assert.match(memoryIneffectiveReason(byId.get('blue')!, rows), /与「green」冲突/u)
  assert.match(memoryIneffectiveReason(byId.get('blue')!, rows), /停用其中一条/u)
  assert.match(memoryIneffectiveReason(byId.get('proposed')!, rows), /确认后才会生效/u)
  assert.match(memoryIneffectiveReason(byId.get('retired')!, rows), /已被「green」替代/u)
  assert.equal(memoryIneffectiveReason(byId.get('green')!, rows), '')
  assert.match(memoryIneffectiveReason(byId.get('blue')!, rows, 'en'), /Conflicts with green/u)
})

test('人工来源优先于更新时间：新写的机器规则压不住用户确认过的', () => {
  const rows = memoryComparisonRows([
    item({ id: 'human-old', content: '用户规则', source: 'human', updatedAt: 100 }),
    item({ id: 'machine-new', content: '机器规则', source: 'review', updatedAt: 900, conflictsWith: ['human-old'] }),
  ])
  assert.equal(rows.find((row) => row.id === 'human-old')?.effective, true)
  assert.equal(rows.find((row) => row.id === 'machine-new')?.effective, false)
})

test('历史记忆没有 status 时按 confidence 兼容判定', () => {
  const rows = memoryComparisonRows([
    item({ id: 'legacy-active', status: undefined, confidence: 'confirmed' }),
    item({ id: 'legacy-proposed', status: undefined, confidence: 'provisional' }),
  ])
  assert.equal(rows.find((row) => row.id === 'legacy-active')?.status, 'active')
  assert.equal(rows.find((row) => row.id === 'legacy-proposed')?.status, 'proposed')
  assert.equal(rows.find((row) => row.id === 'legacy-proposed')?.effective, false)
})

test('空集合不炸', () => {
  assert.deepEqual(memoryComparisonRows([]), [])
  assert.deepEqual(memoryConflictPairs([]), [])
})

test('适用范围说明把「全项目」与「限定范围」分开说', () => {
  // 限定范围的规则不会进入每一次生成；用户若以为它总是生效，就会在别的渠道下
  // 疑惑「我明明写了这条规则」。
  assert.equal(memorySubjectDescription({}), '本项目每一次生成都适用。')
  assert.equal(memorySubjectDescription({ subject: 'project' }), '本项目每一次生成都适用。')
  assert.equal(
    memorySubjectDescription({ subject: 'channel', subjectValue: 'tmall' }),
    '只在渠道为「tmall」时适用，其余生成不会带上它。',
  )
  assert.match(
    memorySubjectDescription({ subject: 'user', subjectValue: 'u-1' }, 'en'),
    /Only applies when just me is “u-1”\. It does not take part in other generations\./u,
  )
  assert.deepEqual([...MEMORY_SUBJECT_OPTIONS], ['project', 'brand', 'product', 'channel', 'user'])
  assert.equal(memorySubjectLabel('channel'), '渠道')
  assert.equal(memorySubjectLabel(undefined), '全项目')
})
