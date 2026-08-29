import { runStatusCollect } from '../src/lib/statusPageRuntime'
import { readStatusSamples, writeStatusSamples } from './statusBlob'

function json(status: number, body: unknown) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

async function collect(request: Request) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' })
  }
  try {
    const result = await runStatusCollect({
      authorization: request.headers.get('authorization'),
      cronSecret: process.env.CRON_SECRET,
      env: process.env,
      readSamples: readStatusSamples,
      writeSamples: writeStatusSamples,
    })
    return json(result.status, result.body)
  } catch (error) {
    console.error(error)
    return json(500, { error: 'unavailable' })
  }
}

export function GET(request: Request) {
  return collect(request)
}

export function POST(request: Request) {
  return collect(request)
}
