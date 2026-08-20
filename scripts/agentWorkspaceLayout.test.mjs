import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const workspace = readFileSync(new URL('../src/features/agent/AgentWorkspace.tsx', import.meta.url), 'utf8')

function firstRuleBody(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*{([^}]*)}`))
  assert.ok(match, `缺少选择器 ${selector}`)
  return match[1]
}

function declaration(body, property) {
  const match = body.match(new RegExp(`${property}\\s*:\\s*([^;]+);`))
  return match?.[1].trim()
}

function zIndex(body) {
  const value = declaration(body, 'z-index')
  assert.ok(value, '缺少 z-index')
  const parsed = Number(value)
  assert.equal(Number.isFinite(parsed), true, `z-index 不是数字：${value}`)
  return parsed
}

test('Agent 浮层让开项目顶栏，并给画布上沿留出空隙', () => {
  const pane = firstRuleBody(styles, '.canvas-pane')
  const tabBar = firstRuleBody(styles, '.tab-bar')
  const agent = firstRuleBody(styles, '.agent-workspace')
  const openPane = firstRuleBody(styles, '.canvas-pane.has-agent-open')
  const openTabBar = firstRuleBody(styles, '.canvas-pane.has-agent-open .tab-bar')

  assert.match(pane, /--tab-bar-height:\s*57px/)
  assert.match(pane, /--agent-workspace-gap:\s*12px/)
  assert.match(pane, /--agent-workspace-column:/)
  assert.equal(declaration(tabBar, 'height'), 'var(--tab-bar-height)')
  assert.equal(declaration(agent, 'position'), 'absolute')
  assert.equal(declaration(agent, 'top'), 'calc(var(--tab-bar-height) + var(--agent-workspace-gap))')
  assert.match(openPane, /padding-right:\s*var\(--agent-workspace-column\)/)
  assert.match(openTabBar, /margin-right:\s*calc\(-1 \* var\(--agent-workspace-column\)\)/)
  assert.ok(zIndex(tabBar) > zIndex(agent), '项目顶栏必须叠在 Agent 浮层之上，标签全程可点')
  assert.doesNotMatch(
    styles,
    /@media\s*\(max-width:\s*900px\)\s*{[^}]*\.agent-workspace\s*{[^}]*top:\s*\d+px/,
    '窄屏不得用固定 top 盖住顶栏',
  )
})

test('阅读位置条在消息滚动区外占位，不盖住正文', () => {
  const restore = firstRuleBody(styles, '.agent-reading-restore')
  assert.notEqual(declaration(restore, 'position'), 'sticky')
  assert.match(styles, /\.agent-workspace__body\s*{[^}]*minmax\(0,\s*1fr\)/)
  const restoreAt = workspace.indexOf('className="agent-reading-restore"')
  const bodyAt = workspace.indexOf('agent-workspace__body')
  const messagesAt = workspace.indexOf('className="agent-workspace__messages"')
  assert.ok(bodyAt !== -1 && restoreAt !== -1 && messagesAt !== -1)
  assert.ok(bodyAt < restoreAt, '阅读位置条应落在消息主体内')
  assert.ok(restoreAt < messagesAt, '阅读位置条必须在滚动消息区之前，避免 sticky 盖住 Prompt')
})
