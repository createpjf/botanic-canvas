import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workspace = readFileSync(new URL('../src/features/canvas/CanvasWorkspace.tsx', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('../src/features/canvas/useCanvasAgentExecutionBridge.ts', import.meta.url), 'utf8')

function between(source, from, to) {
  const start = source.indexOf(from)
  assert.notEqual(start, -1, `找不到锚点：${from}`)
  const end = source.indexOf(to, start)
  assert.notEqual(end, -1, `找不到锚点：${to}`)
  return source.slice(start, end)
}

test('Agent 面板开着时点选画布节点会挂载到对话上下文', () => {
  const nodeClick = between(workspace, 'onNodeClick={(event, node) => {', 'onNodeDoubleClick')
  const agentBranch = between(nodeClick, 'if (agentOpen) {', '\n            }')
  assert.match(
    agentBranch,
    /attachNodeContext\(node\.id\)/,
    '点一张图就该把它交给 Agent，用户不必再 @ 一次',
  )
})

test('自动挂载复用领域里的图片参考规则，面板关着时不写入会话', () => {
  const attach = between(bridge, 'const attachNodeContext = useCallback', '}, [')
  // 文字、生成节点和视频不能因为被点到就进 composer；这条规则只能有一份实现。
  assert.match(attach, /resolveBotanicAgentWorkflowReferenceNodeIds\(document\.nodes, \[nodeId\]\)/)
  // 合并而不是替换：逐张点选才能攒出一组参考。
  assert.doesNotMatch(attach, /replace:\s*true/)

  // 面板关着时 AgentWorkspace 不挂载，自动挂载也不该发生：入口只在 agentOpen 分支里。
  const callSites = [...workspace.matchAll(/attachNodeContext\(/g)]
  assert.equal(callSites.length, 1, '自动挂载只应有一个入口')
})
