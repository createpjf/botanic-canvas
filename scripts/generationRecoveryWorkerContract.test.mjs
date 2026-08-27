import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const worker = readFileSync(new URL('../server/worker.mjs', import.meta.url), 'utf8')

test('Worker 启动与周期恢复复用同一个有界 Generation keyset sweep', () => {
  assert.match(
    worker,
    /import \{ createGenerationRecoverySweep \} from '\.\/generationRecoverySweep\.mjs'/u,
  )
  assert.match(worker, /createGenerationRecoverySweep\(\{[\s\S]*productStore:\s*runtime\.productStore[\s\S]*enqueue:\s*\(jobId\)\s*=>\s*queue\.enqueue\(jobId\)/u)
  assert.match(worker, /async function recoverQueuedJobs\(\)[\s\S]*await sweepRecoverableGenerationJobs\(\)/u)
  assert.match(worker, /void recoverQueuedJobs\(\)[\s\S]*setInterval\(\(\)\s*=>\s*void recoverQueuedJobs\(\),\s*30_000\)/u)
  assert.doesNotMatch(worker, /recoverGenerationJobs\(/u)
})
