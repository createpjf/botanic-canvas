import incidents from '../src/data/statusIncidents.json'
import { runStatusSnapshot } from '../src/lib/statusPageRuntime.ts'
import { readStatusSamples } from './statusBlob.ts'

export default async function handler(
  req: { method?: string },
  res: {
    setHeader(name: string, value: string): void
    status(code: number): { json(body: unknown): void }
  },
) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }
  const snapshot = await runStatusSnapshot({
    env: process.env,
    incidents,
    readSamples: readStatusSamples,
  })
  res.status(snapshot.loadState === 'unavailable' ? 503 : 200).json(snapshot)
}
