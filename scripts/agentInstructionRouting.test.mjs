import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// 路由与生成前置的行为断言在 src/domain/agentInstructionRouting.test.ts；
// 这里只守编排层的不变量：忙碌态复位、决策权归属与追问结论的回传。
const workspace = readFileSync(new URL('../src/features/agent/AgentWorkspace.tsx', import.meta.url), 'utf8')

function between(source, from, to) {
  const start = source.indexOf(from)
  assert.notEqual(start, -1, `找不到锚点：${from}`)
  const end = source.indexOf(to, start)
  assert.notEqual(end, -1, `找不到锚点：${to}`)
  return source.slice(start, end)
}

test('服务端回合判定生成后立刻复位忙碌态，追问分支不会锁死面板', () => {
  const turnBranch = between(workspace, 'if (entry.useServerTurn) {', 'const decision = serverDecision')
  assert.match(turnBranch, /finally\s*{[\s\S]*?setPlanning\(false\)/)
  assert.doesNotMatch(
    turnBranch,
    /if\s*\([^)]*\)\s*setPlanning\(false\)/,
    '忙碌态必须无条件复位：runInstruction 与 answerClarification 都以 planning 为守卫，漏掉复位会让确认卡和输入框一起点不动',
  )

  // 复位之后到生成流程重新置忙之间不能有 await：一旦让出，用户就会看到忙碌态闪烁，
  // 而这段区间里的追问、失败与设置不全都是直接 return 的早退路径。
  const beforeReplanning = between(workspace, 'const draft = prepareBotanicAgentGenerationDraft', 'setPlanning(true)')
  assert.doesNotMatch(
    beforeReplanning,
    /\bawait\b/,
    '生成前置流程出现 await 时，必须自己接管忙碌态复位，不能继续依赖同步执行',
  )
})

test('路由决策由领域模块拥有，编排层不再自带落点判断', () => {
  const run = between(workspace, 'const runInstruction = async', 'const retryLastInstruction')
  assert.match(run, /resolveBotanicAgentInstructionEntry\(/)
  assert.match(run, /prepareBotanicAgentGenerationDraft\(/)
  assert.match(run, /buildBotanicAgentInitialDraftPlan\(/)
  // 落点顺序与执行语语义只能有一份实现：编排层不得再翻找 pending 计划之外的消息。
  assert.doesNotMatch(run, /item\.prompt\?\.trim\(\)/, '历史 Prompt 的查找属于入口路由领域函数')
  assert.doesNotMatch(run, /botanicAgentPendingVariationClarification/, '变体追问判定属于生成草案领域函数')
})

test('服务端回合的降级判定与图片规划器同语义：离线、缺失与所有 5xx 都回退本地正则', () => {
  const turnBranch = between(workspace, 'if (entry.useServerTurn) {', 'const decision = serverDecision')
  // 曾用枚举集合 [0,404,502,503]：本地代理或网关故障返回 500 时不降级，
  // 服务端一挂用户就被整体挡住，而设计初衷是回退本地正则继续可用。
  assert.match(turnBranch, /caught\.status === 0 \|\| caught\.status === 404 \|\| caught\.status >= 500/)
})

test('服务端判定的生成意图跟着追问卡回到下一轮', () => {
  // 追问卡本体由领域草案产出（已含 resolvedGeneration）；编排层负责在作答时原样回传。
  assert.match(workspace, /question: draft\.clarification/)
  assert.match(workspace, /resolvedGeneration: message\.question\.resolvedGeneration/)
})
