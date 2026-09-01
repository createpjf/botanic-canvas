import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { BotanicAgentMessage } from '../../domain/agent.ts'
import {
  agentComposerDraftStorageKey,
  agentSuggestionFuzzyScore,
  createAgentComposerState,
  dismissAgentComposerMention,
  initialAgentComposerHistoryState,
  navigateAgentComposerHistory,
  nextAgentSuggestionIndex,
  rankAgentSuggestions,
  readAgentComposerDraft,
  reduceAgentComposerStates,
  resolveAgentComposerMention,
  resolveAgentRetrySourceMessage,
  writeAgentComposerDraft,
} from './agentComposerState.ts'

const composerSource = readFileSync(new URL('./AgentComposer.tsx', import.meta.url), 'utf8')

test('同文本失败重试只按 sourceMessageId 复用原 Message', () => {
  const messages: BotanicAgentMessage[] = [
    { id: 'message-a', role: 'user', kind: 'text', content: '把背景换成白色', createdAt: 1 },
    { id: 'message-b', role: 'user', kind: 'text', content: '把背景换成白色', createdAt: 2 },
  ]

  assert.equal(resolveAgentRetrySourceMessage(messages, 'message-b')?.id, 'message-b')
  assert.equal(resolveAgentRetrySourceMessage(messages, 'missing'), undefined)
  assert.equal(resolveAgentRetrySourceMessage(messages, undefined), undefined)
})

test('建议菜单可用方向键选到第二项，并公开 combobox/listbox 语义', () => {
  assert.equal(nextAgentSuggestionIndex(0, 3, 'ArrowDown'), 1)
  assert.equal(nextAgentSuggestionIndex(0, 3, 'ArrowUp'), 2)
  assert.equal(nextAgentSuggestionIndex(2, 3, 'ArrowDown'), 0)
  assert.match(composerSource, /role="combobox"/u)
  assert.match(composerSource, /role="listbox"/u)
  assert.match(composerSource, /aria-activedescendant/u)
  assert.match(composerSource, /aria-selected/u)
  assert.match(composerSource, /mentionOptions\[selectedSuggestionIndex\]/u)
})


test('Composer transient state 按 project/session 隔离,切换不会串草稿或错误', () => {
  const base = createAgentComposerState()
  let states = reduceAgentComposerStates({}, { key: 'p:a', base, patch: { instruction: '会话 A', caret: 4, error: 'A error' } })
  states = reduceAgentComposerStates(states, { key: 'p:b', base, patch: { instruction: '会话 B', caret: 4 } })
  assert.equal(states['p:a'].instruction, '会话 A')
  assert.equal(states['p:a'].error, 'A error')
  assert.equal(states['p:b'].instruction, '会话 B')
  assert.equal(states['p:b'].error, '')
})

test('sessionStorage 草稿只保存 instruction+caret,坏 JSON/越界内容 fail closed', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  const key = agentComposerDraftStorageKey('project-1', 'session-1')
  assert.equal(writeAgentComposerDraft(storage, key, { instruction: '长指令草稿', caret: 3 }), true)
  assert.deepEqual(readAgentComposerDraft(storage, key), { instruction: '长指令草稿', caret: 3 })
  assert.deepEqual(Object.keys(JSON.parse(values.get(key)!)).sort(), ['caret', 'instruction'])
  values.set(key, '{bad')
  assert.equal(readAgentComposerDraft(storage, key), undefined)
  values.set(key, JSON.stringify({ instruction: 'x', caret: 99 }))
  assert.equal(readAgentComposerDraft(storage, key), undefined)
  writeAgentComposerDraft(storage, key, { instruction: '', caret: 0 })
  assert.equal(values.has(key), false)
})

test('Esc dismissed mention 在 token 未修改时保持关闭,编辑 token 后恢复', () => {
  const initial = resolveAgentComposerMention('/plat', 5)
  assert.equal(initial.mentionQuery?.query, 'plat')
  const dismissed = dismissAgentComposerMention('/plat', initial.mentionQuery)
  assert.equal(resolveAgentComposerMention('/plat', 5, dismissed).mentionQuery, undefined)
  assert.equal(resolveAgentComposerMention('/platform', 9, dismissed).mentionQuery?.query, 'platform')
})


test('输入历史只在空输入或未修改召回文本的边界接管 Up/Down', () => {
  const entries = ['第一条', '第二条']
  let state = initialAgentComposerHistoryState
  const latest = navigateAgentComposerHistory({ state, entries, direction: 'older', text: '', caret: 0 })
  assert.equal(latest.handled, true)
  assert.equal(latest.text, '第二条')
  state = latest.state
  const older = navigateAgentComposerHistory({ state, entries, direction: 'older', text: '第二条', caret: 3 })
  assert.equal(older.text, '第一条')
  const newer = navigateAgentComposerHistory({ state: older.state, entries, direction: 'newer', text: '第一条', caret: 3 })
  assert.equal(newer.text, '第二条')
  const cleared = navigateAgentComposerHistory({ state: newer.state, entries, direction: 'newer', text: '第二条', caret: 3 })
  assert.equal(cleared.text, '')
  assert.equal(navigateAgentComposerHistory({ state, entries, direction: 'older', text: '第二条\n继续写', caret: 2 }).handled, false)
  assert.equal(navigateAgentComposerHistory({ state, entries, direction: 'older', text: '第二条已改', caret: 5 }).handled, false)
})

test('fuzzy 建议排序 exact>prefix>substring>有序子序列,中文按字符匹配', () => {
  assert.ok(agentSuggestionFuzzyScore('平台交付包', '平台') > agentSuggestionFuzzyScore('电商平台交付', '平台'))
  assert.ok(agentSuggestionFuzzyScore('platform_pack', 'pfpk') >= 0)
  assert.equal(agentSuggestionFuzzyScore('受控局部编辑', '视频'), -1)
  const ranked = rankAgentSuggestions(
    [{ name: '电商平台交付' }, { name: '平台交付包' }, { name: '视频分镜' }],
    '平台',
    (item) => [item.name],
  )
  assert.deepEqual(ranked.map((item) => item.name), ['平台交付包', '电商平台交付'])
})
