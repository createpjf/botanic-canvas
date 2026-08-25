import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_DISMISS_PRIORITY,
  agentEscapeDismissTarget,
  type AgentDismissLayer,
} from './agentWorkspaceNavigation.ts'

const allOpen = Object.fromEntries(AGENT_DISMISS_PRIORITY.map((layer) => [layer, true]))

test('什么都没开时 Escape 关闭整个工作台', () => {
  assert.equal(agentEscapeDismissTarget({}), 'workspace')
  const allClosed = Object.fromEntries(AGENT_DISMISS_PRIORITY.map((layer) => [layer, false]))
  assert.equal(agentEscapeDismissTarget(allClosed), 'workspace')
})

test('只开一层时消解那一层', () => {
  for (const layer of AGENT_DISMISS_PRIORITY) {
    assert.equal(agentEscapeDismissTarget({ [layer]: true }), layer, `单独开启 ${layer} 时应消解自身`)
  }
})

test('优先级顺序被锁定：由内到外逐层消解', () => {
  // 这条断言就是交互契约。改动 AGENT_DISMISS_PRIORITY 的顺序会让它失败，
  // 迫使改动者确认这是有意的语义变更而不是插错了位置。
  assert.deepEqual([...AGENT_DISMISS_PRIORITY], [
    'mention',
    'contextMenu',
    'modeMenu',
    'history',
    'utilityMenu',
    'skillConfirm',
    'recoveryMenu',
    'runtimeDetails',
    'utilityPanel',
  ])

  // 全开时按优先级逐层剥离，最后才关工作台。
  const dismissed: string[] = []
  const open = { ...allOpen } as Record<AgentDismissLayer, boolean>
  for (let guard = 0; guard <= AGENT_DISMISS_PRIORITY.length; guard += 1) {
    const target = agentEscapeDismissTarget(open)
    dismissed.push(target)
    if (target === 'workspace') break
    open[target] = false
  }
  assert.deepEqual(dismissed, [...AGENT_DISMISS_PRIORITY, 'workspace'])
})

test('二次确认比它所在的面板更内层', () => {
  // Escape 应该退出确认，而不是连工具面板一起关掉。
  assert.equal(agentEscapeDismissTarget({ skillConfirm: true, utilityPanel: true }), 'skillConfirm')
  assert.equal(agentEscapeDismissTarget({ utilityPanel: true }), 'utilityPanel')
})

test('提及菜单优先于任何面板与菜单', () => {
  assert.equal(agentEscapeDismissTarget(allOpen), 'mention')
  assert.equal(agentEscapeDismissTarget({ mention: true, utilityPanel: true, history: true }), 'mention')
})

test('未列出的键不影响判定，缺失的键按未开启处理', () => {
  assert.equal(
    agentEscapeDismissTarget({ runtimeDetails: true, unknownLayer: true } as never),
    'runtimeDetails',
  )
  assert.equal(agentEscapeDismissTarget({ mention: undefined, history: true }), 'history')
})
