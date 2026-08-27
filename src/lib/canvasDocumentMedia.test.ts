import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('打开项目只水合画布可见媒体，不走 Agent / 任务整树', () => {
  const source = readFileSync(new URL('./db.ts', import.meta.url), 'utf8')
  const match = source.match(/export const canvasDocumentMediaRoots = \[([^\]]+)\]/)
  assert.ok(match, '找不到 canvasDocumentMediaRoots')
  const roots = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
  assert.deepEqual(roots, ['nodes', 'assets', 'history', 'templates', 'deliveries'])
  for (const key of ['agentSessions', 'agentMemory', 'agentRuns', 'generationJobs', 'batchVariationRuns']) {
    assert.equal(roots.includes(key), false)
  }
})

test('本地序列化与水合走同一组媒体根，不做整树递归', () => {
  const source = readFileSync(new URL('./db.ts', import.meta.url), 'utf8')
  const serializeBody = source.match(/async function serializeDocumentMedia\(document: CanvasDocument\) \{([\s\S]*?)\n\}/)
  assert.ok(serializeBody, '找不到 serializeDocumentMedia')
  assert.match(serializeBody[1], /canvasDocumentMediaRoots\.map/)
  assert.doesNotMatch(serializeBody[1], /serializeMediaValue\(document,/)
})
