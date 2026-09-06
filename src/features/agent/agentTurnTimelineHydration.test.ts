import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentStreamEvent } from '../../domain/agentChatStream.ts'
import { createBotanicAgentChatStreamReader, agentTimelineEventFromStream } from '../../domain/agentChatStream.ts'
import { applyAgentConversationStreamEvent, createAgentTimeline, projectBotanicAgentRunOntoTimeline, reduceAgentTimeline } from '../../domain/agentTimeline.ts'
import { agentTurnEventAsStreamEvent } from '../../domain/agentTurnObservation.ts'
import { agentReferenceUsageLabel } from '../../domain/agentReferenceUsage.ts'
import { presentAgentToolAccordion } from '../../domain/agentToolAccordion.ts'
import {
  agentTurnTimelineHydrationFailureDisposition,
  agentTurnTimelineFromHydrationEvents,
  agentTurnTimelineFromHydrationRead,
  appendAgentTurnTimelineHydrationRead,
  beginAgentTurnTimelineHydrationBatch,
  mergeHydratedAgentTurnTimeline,
  releaseAbortedAgentTurnTimelineHydrations,
} from './agentTurnTimelineHydration.ts'

test('引用反馈清洗后贯通实时与历史，废弃 attempt 不覆盖新请求', () => {
  const reader = createBotanicAgentChatStreamReader()
  const [vision] = reader.push(`data: ${JSON.stringify({ type: 'references', attemptId: 'vision', privateUrl: 'private', items: [
    { nodeId: 'image-1', stage: 'submitted', mode: 'image', image: 'private' },
    { nodeId: 'bad', stage: 'submitted', mode: 'none' },
  ] })}\n\n`)
  assert.doesNotMatch(JSON.stringify(vision), /private|bad/)
  const text = agentTurnEventAsStreamEvent({
    id: 'event-2', turnId: 'turn-1', projectId: 'project-1', type: 'turn.references', sequence: 2, createdAt: 200,
    payload: { attemptId: 'text', items: [{ nodeId: 'image-1', stage: 'submitted', mode: 'description', description: 'private' }] },
  })!
  let state = applyAgentConversationStreamEvent({ content: '', timeline: createAgentTimeline(0) }, agentTimelineEventFromStream(vision, 1))
  const reset = agentTurnEventAsStreamEvent({
    id: 'reset-text', turnId: 'turn-1', projectId: 'project-1', type: 'turn.output_preview.updated', sequence: 2, createdAt: 190,
    payload: { attemptId: 'text', revision: 2, charCount: 0, step: 0 },
  })!
  state = applyAgentConversationStreamEvent(state, agentTimelineEventFromStream(reset, 2))
  assert.equal(state.timeline.references, undefined)
  state = applyAgentConversationStreamEvent(state, agentTimelineEventFromStream(text, 3))
  const stale = applyAgentConversationStreamEvent(state, agentTimelineEventFromStream(vision, 4))
  assert.deepEqual(stale, state)
  const finished = reduceAgentTimeline(state.timeline, { type: 'done', receivedAt: 5 })
  assert.equal(finished.references?.items[0].mode, 'description')
  const restored = agentTurnTimelineFromHydrationEvents([vision, reset, text])!
  assert.deepEqual(restored.references, finished.references)
  assert.equal(agentReferenceUsageLabel(restored.references!.items[0], 'zh-CN'), '请求含图片描述')
  assert.doesNotMatch(JSON.stringify(restored), /private/)
})

test('只读 Turn Events 可恢复来源时间线，并与先到的 Run 步骤合并', () => {
  const events: BotanicAgentStreamEvent[] = [{
    type: 'tool',
    step: 0,
    sequence: 2,
    occurredAt: 180,
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
    startedAt: undefined, endedAt: 180,
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
  assert.equal(presentAgentToolAccordion(hydrated)?.elapsedMs, 0)
})

test('历史用时跨页沿实际事件计算，缺少时间不以读取时刻补齐', () => {
  const event: Extract<BotanicAgentStreamEvent, { type: 'tool' }> = {
    type: 'tool', step: 0, occurredAt: 1000,
    toolCall: { id: 'read-1', name: 'ontology_read', label: '读取项目', risk: 'read', status: 'running', requiresConfirmation: false },
  }
  const first = agentTurnTimelineFromHydrationEvents([event], 100_000, { loadedCount: 1, nextAfter: 1 })!
  const pending = first.blocks.find((block) => block.type === 'step')!
  assert.equal(pending.status, 'running')
  assert.equal(pending.endedAt, undefined)
  assert.equal(presentAgentToolAccordion(first, 'zh-CN', 900_000)?.elapsedMs, 0)
  assert.equal(presentAgentToolAccordion(first, 'zh-CN', 900_000)?.groups[0].rows[0].durationMs, undefined)
  const done = appendAgentTurnTimelineHydrationRead(first, { events: [{ ...event, occurredAt: 4500, toolCall: { ...event.toolCall, status: 'succeeded' } }], truncated: false }, 900_000)
  assert.equal(presentAgentToolAccordion(done)?.elapsedMs, 3500)
  const unknown = agentTurnTimelineFromHydrationEvents([{ ...event, occurredAt: undefined, toolCall: { ...event.toolCall, status: 'succeeded' } }], 900_000)!
  const step = unknown.blocks.find((block) => block.type === 'step')!
  assert.equal(step.startedAt, undefined)
  assert.equal(step.endedAt, undefined)
  assert.equal(presentAgentToolAccordion(unknown)?.elapsedMs, 0)
  const historical = agentTurnTimelineFromHydrationRead({
    events: [event, { ...event, occurredAt: 4500, toolCall: { ...event.toolCall, status: 'succeeded' } }],
    turn: { status: 'completed', createdAt: 500, updatedAt: 6000 }, truncated: false,
  }, 900_000)!
  assert.equal(presentAgentToolAccordion(historical)?.elapsedMs, 5500)
  const run = projectBotanicAgentRunOntoTimeline({ id: 'run-1', status: 'completed', branches: [], createdAt: 8000, updatedAt: 12_000 }, undefined, 900_000)
  assert.equal(presentAgentToolAccordion(mergeHydratedAgentTurnTimeline(run, historical))?.elapsedMs, 11_500)
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
