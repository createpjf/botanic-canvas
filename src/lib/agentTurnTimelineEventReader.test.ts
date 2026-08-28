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
  const events = await readAgentTurnTimelineEvents({
    turnId: 'turn-1',
    projectId: 'project-1',
    readPage: async (path) => {
      paths.push(path)
      return pages.shift()!
    },
  })
  assert.deepEqual(events.map((event) => event.type === 'tool' ? event.toolCall.id : event.type), ['search-1', 'fetch-1'])
  assert.deepEqual(paths, [
    '/api/agent-turns/turn-1?after=0&limit=200',
    '/api/agent-turns/turn-1?after=2&limit=200',
  ])
  assert.equal(paths.every((path) => !path.includes('stream') && !path.includes('execute')), true)
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
