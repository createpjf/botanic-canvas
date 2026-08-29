import { runStatusCollect } from '../src/lib/statusPageRuntime.ts'
import { readStatusSamples, writeStatusSamples } from './statusBlob.ts'

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export default async function handler(
  req: { method?: string; headers: Record<string, string | string[] | undefined> },
  res: {
    setHeader(name: string, value: string): void
    status(code: number): { json(body: unknown): void }
  },
) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }
  const result = await runStatusCollect({
    authorization: headerValue(req.headers.authorization),
    cronSecret: process.env.CRON_SECRET,
    env: process.env,
    readSamples: readStatusSamples,
    writeSamples: writeStatusSamples,
  })
  res.status(result.status).json(result.body)
}
