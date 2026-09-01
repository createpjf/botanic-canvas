import { runStatusSnapshot } from './statusCore.mjs'
import { readStatusSamples } from './statusBlob.mjs'
import { captureException, flushSentry } from './sentry.mjs'

const incidents = [
  {
    id: '2026-08-29-railway-deploys',
    title: 'API 部署排队',
    level: 'degraded',
    startedAt: '2026-08-28T23:59:00.000Z',
    resolvedAt: '2026-08-29T03:38:00.000Z',
    affected: ['api'],
    updates: [
      { at: '2026-08-29T00:20:00.000Z', body: '单机网络故障导致部署排队，已发布的 API 仍可访问。' },
      { at: '2026-08-29T03:38:00.000Z', body: '队列已清空，部署恢复。' },
    ],
  },
]

function json(status, body) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function GET() {
  try {
    const snapshot = await runStatusSnapshot({
      env: process.env,
      incidents,
      readSamples: readStatusSamples,
    })
    return json(snapshot.loadState === 'unavailable' ? 503 : 200, snapshot)
  } catch (error) {
    captureException(error, { tags: { component: 'status-snapshot' } })
    await flushSentry(2_000).catch(() => undefined)
    console.error(JSON.stringify({ event: 'status_snapshot_failed', error: error instanceof Error ? error.name : 'unknown' }))
    return json(503, { error: 'unavailable' })
  }
}
