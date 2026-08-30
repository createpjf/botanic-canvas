import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { BotanicAgentMessage } from '../../domain/agent.ts'
import { nextAgentSuggestionIndex, resolveAgentRetrySourceMessage } from './agentComposerState.ts'

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
