import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./AgentConversationMessage.tsx', import.meta.url), 'utf8')
const pills = readFileSync(new URL('../../components/AgentWebSourcePills.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')

test('web_search 与 web_fetch 共用来源面板，折叠时从可访问树和焦点序列移除', () => {
  assert.match(source, /if \(timelineStepShowsWebSources\(block, toolItems\)\)/u)
  assert.doesNotMatch(source, /block\.kind === ['"]search['"] && timelineStepShowsWebSources/u)
  assert.equal(source.includes('aria-hidden={!open}'), true)
  assert.equal(source.includes('inert={!open ? true : undefined}'), true)
})

test('来源 hostname 完整可访问且不向第三方图标服务泄露', () => {
  assert.equal(source.includes('hostname: source.hostname'), true)
  assert.equal(pills.includes('aria-label={accessibleLabel}'), true)
  assert.equal(pills.includes('`${source.hostname} — ${source.title}`'), true)
  assert.doesNotMatch(pills, /https?:\/\//u)
  assert.doesNotMatch(pills, /<img\b|\bsrc=/u)
  assert.match(styles, /\.agent-timeline-search-source span \{[^}]*overflow-wrap: anywhere/u)
  assert.doesNotMatch(styles, /\.agent-timeline-search-source span \{[^}]*text-overflow: ellipsis/u)
})
