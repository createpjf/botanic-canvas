import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('欢迎动画与 DOM 使用同一显示条件，消息加载/失败不启动动画', () => {
  const source = readFileSync(new URL('../src/features/agent/AgentWorkspace.tsx', import.meta.url), 'utf8')
  const condition = source.match(/const showWelcome = (.+)/)?.[1]
  assert.ok(condition)
  const visible = new Function('utilityPanelOpen', 'hasMessages', 'messageHistory', `return ${condition}`)
  assert.equal(visible(false, false, undefined), true)
  assert.equal(visible(false, false, { loading: false }), true)
  assert.equal(visible(false, false, { loading: true }), false)
  assert.equal(visible(false, false, { error: '读取失败' }), false)
  assert.equal(visible(false, true, undefined), false)
  assert.equal(visible(true, false, undefined), false)
  assert.match(source, /if \(!showWelcome \|\| prefersReducedMotion\(\) \|\| welcomePlayedRef.current\) return/)
  assert.match(source, /\{showWelcome \? <section className="agent-workspace__welcome"/)
  assert.match(source, /dependencies: \[fromEmptyGuide, showWelcome, locale\], revertOnUpdate: true/)
})
