import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 画布协作 CRDT 清洗器有两份实现：浏览器侧 `src/domain/collaborativeGraph.ts`
 * 与服务端 room `server/canvasCollaborationRoom.mjs`（架构门禁禁止 `src/` 导入
 * `server/`）。两份分别维护的坏法与 mediaFormats 相同：一侧加了新的媒体字段名、
 * 另一侧没加，媒体引用就会从没改的那一侧漏进 mutation log 或 Yjs 广播。
 *
 * 与 scripts/mediaFormatContract.test.mjs 同一手法：把源码当文本读，抠出字面量。
 */
const domainSource = readFileSync(new URL('../src/domain/collaborativeGraph.ts', import.meta.url), 'utf8')
const serverSource = readFileSync(new URL('../server/canvasCollaborationRoom.mjs', import.meta.url), 'utf8')

function setLiteral(source, name, file) {
  const start = source.indexOf(`${name} = new Set([`)
  assert.notEqual(start, -1, `${file} 找不到 ${name}`)
  const end = source.indexOf('])', start)
  assert.notEqual(end, -1, `${file} 的 ${name} 未闭合`)
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1])
}

test('两侧媒体引用字段词表逐项一致', () => {
  assert.deepEqual(
    setLiteral(domainSource, 'mediaReferenceKeys', 'domain'),
    setLiteral(serverSource, 'mediaReferenceKeys', 'server'),
  )
})

test('两侧媒体负载字段词表逐项一致', () => {
  assert.deepEqual(
    setLiteral(domainSource, 'mediaPayloadKeys', 'domain'),
    setLiteral(serverSource, 'mediaPayloadKeys', 'server'),
  )
})

test('两侧的节点与连线清洗都剥离本机选中态', () => {
  // 选中是本机私有视图状态。任何一侧漏剥离，协作者就会看到「被别人选中」，
  // 且纯选中也会产生 CRDT 增量或 mutation log 记录。
  for (const [source, file] of [[domainSource, 'domain'], [serverSource, 'server']]) {
    const nodeBody = functionBody(source, 'collaborativeNode', file)
    const edgeBody = functionBody(source, 'collaborativeEdge', file)
    // 节点侧允许经 persistableNode 间接剥离（服务端形态）。
    const nodeStrips = /delete\s+normalized\.selected/.test(nodeBody)
      || /persistableNode\(/.test(nodeBody) && /delete\s+normalized\.selected/.test(functionBody(source, 'persistableNode', file, { optional: true }) ?? '')
    assert.ok(nodeStrips, `${file} 的 collaborativeNode 未剥离 selected`)
    assert.match(edgeBody, /delete\s+normalized\.selected/, `${file} 的 collaborativeEdge 未剥离 selected`)
  }
})

function functionBody(source, name, file, { optional = false } = {}) {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) {
    if (optional) return undefined
    assert.fail(`${file} 找不到 function ${name}`)
  }
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  assert.fail(`${file} 的 ${name} 函数体未闭合`)
}
