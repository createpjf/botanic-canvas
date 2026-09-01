import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentStreamEvent } from '../../domain/agentChatStream.ts'
import {
  agentTurnTimelineHydrationFailureDisposition,
  agentTurnTimelineFromHydrationEvents,
  appendAgentTurnTimelineHydrationRead,
  beginAgentTurnTimelineHydrationBatch,
  mergeHydratedAgentTurnTimeline,
  releaseAbortedAgentTurnTimelineHydrations,
} from './agentTurnTimelineHydration.ts'

test('只读 Turn Events 可恢复来源时间线，并与先到的 Run 步骤合并', () => {
  const events: BotanicAgentStreamEvent[] = [{
    type: 'tool',
    step: 0,
    sequence: 2,
    toolCall: {
      id: 'fetch-1', name: 'web_fetch', label: '网页获取', risk: 'external',
      status: 'succeeded', requiresConfirmation: false,
    },
    presentation: {
      kind: 'fetch',
      title: '网页获取 www.andlight.cn',
      sources: [{ hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/' }],
    },
  }]
  const hydrated = agentTurnTimelineFromHydrationEvents(events, 100)
  assert.ok(hydrated)
  assert.deepEqual(hydrated?.blocks.find((block) => block.type === 'step'), {
    id: 'step:fetch-1', type: 'step', status: 'succeeded', kind: 'fetch',
    title: '网页获取 www.andlight.cn',
    startedAt: 100, endedAt: 100,
    sources: [{ hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/' }],
    sourceToolIds: ['fetch-1'],
  })

  const merged = mergeHydratedAgentTurnTimeline({
    blocks: [{
      id: 'exec:submit', type: 'step', status: 'succeeded', kind: 'write',
      title: '提交生成任务', sourceToolIds: ['run:1'],
    }],
  }, hydrated!)
  assert.equal(merged.blocks.some((block) => block.id === 'step:fetch-1'), true)
  assert.equal(merged.blocks.some((block) => block.id === 'exec:submit'), true)
})

test('没有工具事件时不制造历史时间线', () => {
  assert.equal(agentTurnTimelineFromHydrationEvents([{ type: 'done' }], 100), undefined)
})

test('截断时间线按 nextAfter 继续 reduce,旧工具/raw items 保留且终页清掉 truncation', () => {
  const firstEvent: BotanicAgentStreamEvent = {
    type: 'tool', step: 0,
    toolCall: { id: 'read-1', name: 'ontology_read', label: '读取本体', risk: 'read', status: 'succeeded', requiresConfirmation: false },
  }
  const timeline = agentTurnTimelineFromHydrationEvents([firstEvent], 100, { loadedCount: 1000, nextAfter: 1000 })!
  assert.deepEqual(timeline.truncation, { loadedCount: 1000, nextAfter: 1000 })
  const appended = appendAgentTurnTimelineHydrationRead(timeline, {
    events: [{ type: 'tool', step: 1, toolCall: { id: 'read-2', name: 'skill_search', label: '检索 Skill', risk: 'read', status: 'succeeded', requiresConfirmation: false } }],
    truncated: false,
  }, 200)
  const raw = appended.blocks.find((block) => block.type === 'raw_group')
  assert.deepEqual(raw?.items.map((item) => item.id), ['read-1', 'read-2'])
  assert.equal(appended.truncation, undefined)
})

test('404 终止热循环，网络错误留待 online/focus 重试，切会话 abort 可立即释放', () => {
  assert.equal(agentTurnTimelineHydrationFailureDisposition({ status: 404 }), 'terminal')
  assert.equal(agentTurnTimelineHydrationFailureDisposition({ status: 0 }), 'retry_later')
  assert.equal(agentTurnTimelineHydrationFailureDisposition(new DOMException('aborted', 'AbortError')), 'cancelled')
})

test('Run projection 竞态不冒充 hydration；被其重绘 abort 后同一 Turn 可重新入批', () => {
  const message = {
    id: 'agent-turn-result-turn-race', role: 'assistant' as const, kind: 'text' as const,
    content: '完成', createdAt: 1, status: 'submitted' as const, turnId: 'turn-race',
    runId: 'run-1',
  }
  const attempts = new Map()
  const first = beginAgentTurnTimelineHydrationBatch([message], attempts, 2)
  assert.deepEqual(first, [{ messageId: message.id, turnId: 'turn-race' }])
  // Run effect 写入 executionTimelines 时会 cleanup；独立 loading 标记必须释放。
  releaseAbortedAgentTurnTimelineHydrations(first, attempts)
  const retried = beginAgentTurnTimelineHydrationBatch([message], attempts, 2)
  assert.deepEqual(retried, first)
  attempts.set('turn-race', 'terminal')
  assert.deepEqual(beginAgentTurnTimelineHydrationBatch([message], attempts, 2), [])
})
