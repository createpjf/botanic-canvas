import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import type { CanvasDocument } from '../domain/canvas.ts'
import { createCanvasDocumentPatch } from '../domain/canvasDocumentPatch.ts'
import { canvasPatchTracePaths } from './canvasWriteTrace.ts'

test('写入诊断定位真实字段，但不输出正文、媒体、节点 ID 和自由字典键', () => {
  const previous = { id: 'private-project', nodes: [{ id: 'private-node', type: 'text', position: { x: 0, y: 0 }, data: { content: 'secret-before' } }], edges: [], updatedAt: 1 } as unknown as CanvasDocument
  const next = { ...previous, updatedAt: 2, nodes: [{ ...previous.nodes[0], position: { x: 3, y: 0 }, data: { content: 'secret-after', 'private-dictionary-key': 'https://secret.test/token' } }] } as unknown as CanvasDocument
  assert.deepEqual(canvasPatchTracePaths(previous, createCanvasDocumentPatch(previous, next)), [
    'fields.updatedAt', 'nodes[].data.[other]', 'nodes[].data.content', 'nodes[].position.x',
  ])
  assert.deepEqual(canvasPatchTracePaths(previous, createCanvasDocumentPatch(previous, { ...previous, nodes: [] })), ['fields.updatedAt', 'nodes[].remove'])
  assert.deepEqual(canvasPatchTracePaths(previous, createCanvasDocumentPatch(previous, previous)), [])
})

test('诊断默认关闭；启用时同次写入关联请求 ID，重试使用独立请求 ID', async () => {
  const { traceCanvasWrite } = await import('./canvasWriteTrace.ts')
  const document = { nodes: [], edges: [] } as unknown as CanvasDocument
  assert.equal(traceCanvasWrite(document, document, {}, 3, 2), undefined)
  const compiled = await build({ entryPoints: ['src/lib/canvasWriteTrace.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
    define: { 'import.meta.env.VITE_CANVAS_WRITE_TRACE': '"true"' } })
  const tracing = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
  const logged: string[] = []
  const originalInfo = console.info
  console.info = (_label, record) => logged.push(record)
  try {
    tracing.markCanvasWrite(document)
    const first = tracing.traceCanvasWrite(document, document, {}, 3, 2)
    const second = tracing.traceCanvasWrite(document, document, {}, 4, 2)
    const records = logged.map(record => JSON.parse(record))
    assert.equal(records[0].requestId, first)
    assert.notEqual(first, second)
    assert.equal(records[0].write.id, records[1].write.id)
    assert.equal(records[0].pageId, records[1].pageId)
    assert.deepEqual(records.map(record => record.revision), [3, 4])
  } finally { console.info = originalInfo }
})
