import { runStatusCollect } from './statusCore.mjs'
import { readStatusSamples, writeStatusSamples } from './statusBlob.mjs'
import { captureCheckIn, captureException, flushSentry } from './sentry.mjs'

const monitorSlug = 'botanic-status-collect'
const monitorConfig = {
  schedule: { type: 'crontab', value: '0 4 * * *' },
  checkinMargin: 15,
  maxRuntime: 5,
  timezone: 'UTC',
  failureIssueThreshold: 1,
  recoveryThreshold: 1,
  isolateTrace: true,
}

function json(status, body) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

async function collect(request) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' })
  }
  const checkInId = captureCheckIn({ monitorSlug, status: 'in_progress' }, monitorConfig)
  try {
    const result = await runStatusCollect({
      authorization: request.headers.get('authorization'),
      cronSecret: process.env.CRON_SECRET,
      env: process.env,
      readSamples: readStatusSamples,
      writeSamples: writeStatusSamples,
    })
    captureCheckIn({ monitorSlug, status: result.status >= 400 ? 'error' : 'ok', checkInId })
    return json(result.status, result.body)
  } catch (error) {
    captureException(error, { tags: { component: 'status-collect' } })
    captureCheckIn({ monitorSlug, status: 'error', checkInId })
    console.error(JSON.stringify({ event: 'status_collect_failed', error: error instanceof Error ? error.name : 'unknown' }))
    return json(500, { error: 'unavailable' })
  } finally {
    await flushSentry(2_000).catch(() => undefined)
  }
}

export function GET(request) {
  return collect(request)
}

export function POST(request) {
  return collect(request)
}
