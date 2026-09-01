import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_COMPOSER_LARGE_PASTE_THRESHOLD,
  expandAgentComposerPasteCaret,
  expandAgentComposerPastes,
  insertAgentComposerLargePaste,
  pruneAgentComposerPendingPastes,
} from './agentComposerPaste.ts'

test('大粘贴替换选区为唯一placeholder,提交展开原文且caret对应展开后位置', () => {
  const pasted = '长'.repeat(AGENT_COMPOSER_LARGE_PASTE_THRESHOLD)
  const first = insertAgentComposerLargePaste({
    instruction: '前后', start: 1, end: 1, pasted, pendingPastes: {}, locale: 'zh-CN',
  })!
  assert.match(first.instruction, /前\[已粘贴 1000 字\]后/u)
  assert.equal(expandAgentComposerPastes(first.instruction, first.pendingPastes), `前${pasted}后`)
  assert.equal(expandAgentComposerPasteCaret(first.instruction, first.caret, first.pendingPastes), 1 + pasted.length)
  const second = insertAgentComposerLargePaste({
    instruction: first.instruction, start: first.caret, end: first.caret,
    pasted, pendingPastes: first.pendingPastes, locale: 'zh-CN',
  })!
  assert.equal(Object.keys(second.pendingPastes).some((key) => key.endsWith('#2')), true)
  assert.equal(expandAgentComposerPastes(second.instruction, second.pendingPastes), `前${pasted}${pasted}后`)
})

test('小粘贴走浏览器原生输入;删除placeholder会清映射', () => {
  assert.equal(insertAgentComposerLargePaste({ instruction: '', start: 0, end: 0, pasted: '短文本', pendingPastes: {}, locale: 'zh-CN' }), undefined)
  assert.deepEqual(pruneAgentComposerPendingPastes('已删除占位', { '[已粘贴 1000 字]': 'x'.repeat(1000) }), {})
})
