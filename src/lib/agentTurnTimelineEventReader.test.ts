import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentTurnObservationPage } from '../domain/agentTurnObservation.ts'
import { readAgentTurnTimelineEvents } from './agentTurnTimelineEventReader.ts'

test('时间线 hydration 只分页读取 Turn Events，不进入 POST/observer 等待路径', async () => {
  const pages: BotanicAgentTurnObservationPage[] = [
    {
      turn: { id: 'turn-1', projectId: 'project-1', status: 'completed' },
      events: [{
        sequence: 2, type: 'turn.tool', payload: {
          step: 0, toolCallId: 'search-1', toolName: 'web_search', status: 'succeeded',
          presentation: {
            kind: 'search', title: '已搜索 1 个网站', count: 1,
            sources: [{ hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/' }],
          },
        },
      }],
      cursor: { after: 2, hasMore: true },
    },
    {
      turn: { id: 'turn-1', projectId: 'project-1', status: 'completed' },
      events: [{
        sequence: 3, type: 'turn.tool', payload: {
          step: 1, toolCallId: 'fetch-1', toolName: 'web_fetch', status: 'succeeded',
          presentation: { kind: 'fetch', title: '网页获取 www.andlight.cn' },
        },
      }],
      cursor: { after: 3, hasMore: false },
    },
  ]
  const paths: string[] = []
  const result = await readAgentTurnTimelineEvents({
    turnId: 'turn-1',
    projectId: 'project-1',
    readPage: async (path) => {
      paths.push(path)
      return pages.shift()!
    },
  })
  assert.deepEqual(result.events.map((event) => event.type === 'tool' ? event.toolCall.id : event.type), ['search-1', 'fetch-1'])
  assert.equal(result.truncated, false)
  assert.deepEqual(paths, [
    '/api/agent-turns/turn-1?after=0&limit=200',
    '/api/agent-turns/turn-1?after=2&limit=200',
  ])
  assert.equal(paths.every((path) => !path.includes('stream') && !path.includes('execute')), true)
})

test('超过 1000 条事件返回截断标记与续读游标', async () => {
  let page = 0
  const result = await readAgentTurnTimelineEvents({
    turnId: 'turn-long',
    projectId: 'project-1',
    readPage: async () => {
      const start = page * 200 + 1
      page += 1
      return {
        turn: { id: 'turn-long', projectId: 'project-1', status: 'running' },
        events: Array.from({ length: 200 }, (_, index) => ({
          sequence: start + index,
          type: 'turn.tool',
          payload: { step: 0, toolCallId: `tool-${start + index}`, toolName: 'read', status: 'succeeded' },
        })),
        cursor: { after: start + 199, hasMore: true },
      }
    },
  })

  assert.equal(result.events.length, 1000)
  assert.equal(result.truncated, true)
  assert.equal(result.nextAfter, 1000)

  let continuationPath = ''
  const continuation = await readAgentTurnTimelineEvents({
    turnId: 'turn-long', projectId: 'project-1', after: result.nextAfter, maximumPages: 1,
    readPage: async (path) => {
      continuationPath = path
      return {
        turn: { id: 'turn-long', projectId: 'project-1', status: 'completed' },
        events: [{ sequence: 1001, type: 'turn.tool', payload: { step: 1, toolCallId: 'tool-1001', toolName: 'read', status: 'succeeded' } }],
        cursor: { after: 1001, hasMore: false },
      }
    },
  })
  assert.equal(continuationPath, '/api/agent-turns/turn-long?after=1000&limit=200')
  assert.equal(continuation.events.length, 1)
  assert.equal(continuation.truncated, false)
})

test('时间线 hydration 遇到停滞游标立即失败，不无限循环', async () => {
  let reads = 0
  await assert.rejects(readAgentTurnTimelineEvents({
    turnId: 'turn-stalled',
    projectId: 'project-1',
    readPage: async () => {
      reads += 1
      return {
        turn: { id: 'turn-stalled', projectId: 'project-1', status: 'completed' },
        events: [],
        cursor: { after: 0, hasMore: true },
      }
    },
  }), (error: unknown) => (error as { code?: string }).code === 'AGENT_TURN_EVENT_CURSOR_STALLED')
  assert.equal(reads, 1)
})
