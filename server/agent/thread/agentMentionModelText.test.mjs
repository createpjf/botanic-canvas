import assert from 'node:assert/strict'
import test from 'node:test'
import { agentMentionOnlyInstruction, agentMentionReferenceLine } from './agentMentionModelText.mjs'

test('Mention 模型文本统一处理中英文、混合类型与重复引用', () => {
  const mentions = [
    { kind: 'skill', id: 'skill-1', name: '品牌规则' },
    { kind: 'reference', id: 'asset-1', label: '商品图' },
    { kind: 'reference', id: 'asset-1-copy', label: '商品图' },
  ]

  assert.equal(agentMentionOnlyInstruction(mentions, 'zh-CN'), '按已挂载 Skill 与已引用素材处理。')
  assert.equal(agentMentionOnlyInstruction(mentions, 'en'), 'Follow the mounted Skills and referenced assets.')
  assert.equal(agentMentionReferenceLine(mentions, 'zh-CN'), '已引用：商品图。')
  assert.equal(agentMentionReferenceLine(mentions, 'en'), 'Referenced: 商品图.')
})
