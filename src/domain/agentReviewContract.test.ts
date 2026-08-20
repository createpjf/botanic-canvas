import assert from 'node:assert/strict'
import test from 'node:test'
import { botanicAgentRunReviewMessageId, formatBotanicAgentRunReviewMessage } from './agentReviewContract.ts'

test('评审消息按 Run 固定标识，重评与刷新不会重复追加', () => {
  assert.equal(botanicAgentRunReviewMessageId('run-1'), 'agent-review-run-1')
})

test('评审正文标注最佳分支，并按结论给出可执行的下一步', () => {
  const message = formatBotanicAgentRunReviewMessage({
    summary: '整体达标，深棕肤色偏灰。',
    bestNodeId: 'result-a',
    items: [
      { nodeId: 'result-a', branchLabel: '白皙', verdict: 'pass', note: '光线柔和。' },
      { nodeId: 'result-b', branchLabel: '深棕', verdict: 'adjust', note: '肤色偏灰。' },
    ],
  })
  assert.match(message, /已看完这轮生成的 2 张结果：整体达标/)
  assert.match(message, /1\. ★ 「白皙」达标 —— 光线柔和。/)
  assert.match(message, /2\. 「深棕」建议调整 —— 肤色偏灰。/)
  assert.match(message, /推荐「白皙」/)
  assert.match(message, /在任务卡上重试，或直接告诉我要改哪里/)

  const allPass = formatBotanicAgentRunReviewMessage({
    summary: '全部达标。',
    items: [{ nodeId: 'result-a', branchLabel: '首图', verdict: 'pass', note: '' }],
  })
  assert.match(allPass, /可以直接基于结果继续下一轮/)
  assert.doesNotMatch(allPass, /——/)
})
