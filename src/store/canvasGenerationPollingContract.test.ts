import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('多任务轮询按 jobId 独立计时，stopPolling 仍清空全部', async () => {
  const source = await readFile(new URL('./canvasGenerationActions.ts', import.meta.url), 'utf8')
  assert.match(source, /const pollTimers = new Map<string, number>\(\)/u)
  assert.match(source, /const clearPollTimer = \(jobId: string\)/u)
  assert.match(source, /pollJob = \(jobId: string\) => \{[\s\S]*clearPollTimer\(jobId\)/u)
  assert.doesNotMatch(source, /let pollTimerId/u)
  assert.match(source, /if \(request\?\.jobId !== jobId\) return/u)
})
