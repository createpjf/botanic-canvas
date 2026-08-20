import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workspace = readFileSync(new URL('../src/features/agent/AgentWorkspace.tsx', import.meta.url), 'utf8')

function between(source, from, to) {
  const start = source.indexOf(from)
  assert.notEqual(start, -1, `找不到锚点：${from}`)
  const end = source.indexOf(to, start)
  assert.notEqual(end, -1, `找不到锚点：${to}`)
  return source.slice(start, end)
}

test('服务端回合判定生成后立刻复位忙碌态，追问分支不会锁死面板', () => {
  const turnBranch = between(workspace, 'const useServerTurn =', 'const decision = serverDecision')
  assert.match(turnBranch, /finally\s*{[\s\S]*?setPlanning\(false\)/)
  assert.doesNotMatch(
    turnBranch,
    /if\s*\([^)]*\)\s*setPlanning\(false\)/,
    '忙碌态必须无条件复位：runInstruction 与 answerClarification 都以 planning 为守卫，漏掉复位会让确认卡和输入框一起点不动',
  )

  // 复位之后到生成流程重新置忙之间不能有 await：一旦让出，用户就会看到忙碌态闪烁，
  // 而这段区间里的追问、失败与设置不全都是直接 return 的早退路径。
  const beforeReplanning = between(workspace, 'let generationPrompt: string', 'setPlanning(true)')
  assert.doesNotMatch(
    beforeReplanning,
    /\bawait\b/,
    '生成前置流程出现 await 时，必须自己接管忙碌态复位，不能继续依赖同步执行',
  )
})

test('服务端判定的生成意图跟着追问卡回到下一轮', () => {
  const beforeRouting = between(workspace, 'const restoredGeneration', 'if (decision.kind === ')
  assert.match(beforeRouting, /useServerTurn\s*=[^\n]*!restoredGeneration/)
  assert.match(beforeRouting, /serverDecision[^=]*=\s*restoredGeneration/)
  assert.match(beforeRouting, /synthesizedPrompt[^=]*=\s*restoredGeneration\?\.prompt/)

  // 追问卡里的 originalInstruction 是模型综合出的画面描述。下一轮若对它重新做意图分类，
  // 通常会判成聊天，用户答完确认卡就再也拿不到生成计划。
  const generationFlow = between(workspace, 'const clarificationCarryOver = {', 'const retryLastInstruction')
  assert.match(between(generationFlow, 'const clarificationCarryOver = {', '\n    }'), /resolvedGeneration/)
  const cards = [...generationFlow.matchAll(/kind: 'question'/g)]
  assert.ok(cards.length >= 4, `生成路径上的追问卡少于预期：${cards.length}`)
  for (const card of cards) {
    assert.match(
      generationFlow.slice(card.index, card.index + 400),
      /clarificationCarryOver/,
      '生成路径上的每张追问卡都要带回本轮生成结论',
    )
  }
  assert.match(workspace, /resolvedGeneration: message\.question\.resolvedGeneration/)
})
