import incidents from '../src/data/statusIncidents.json'
import { runStatusSnapshot } from '../src/lib/statusPageRuntime'
import { readStatusSamples } from './statusBlob'

function json(status: number, body: unknown) {
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
    console.error(error)
    return json(503, { error: 'unavailable' })
  }
}
