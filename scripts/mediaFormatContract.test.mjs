import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CANONICAL_IMAGE_FORMATS, FORMAT_LABELS, MEDIA_LIMITS, UPLOAD_IMAGE_FORMATS } from '../server/mediaFormats.mjs'

/**
 * 客户端格式词表必须与服务端一致。
 *
 * 架构门禁禁止 `src/` 导入 `server/`，所以词表只能有两份。两份分别维护是这类
 * 模型最常见的坏法：服务端加了 AVIF、`accept=` 忘了改，用户在文件选择器里
 * 根本选不到；或者反过来，选得到、传上去被拒。
 *
 * 与 scripts/projectCapabilityContract.test.mjs 同一手法：把 TS 源码当文本读。
 */
const domain = readFileSync(new URL('../src/domain/mediaFormats.ts', import.meta.url), 'utf8')

function domainList(name) {
  const start = domain.indexOf(`export const ${name} = [`)
  assert.notEqual(start, -1, `找不到 ${name}`)
  const end = domain.indexOf('] as const', start)
  assert.notEqual(end, -1, `${name} 缺少 as const`)
  return [...domain.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1])
}

test('两份上传格式词表逐项一致（含顺序）', () => {
  // 顺序也要一致：accept= 的顺序决定文件选择器里的分组顺序。
  assert.deepEqual(domainList('UPLOAD_IMAGE_FORMATS'), [...UPLOAD_IMAGE_FORMATS])
})

test('两份 canonical 格式词表逐项一致（含顺序）', () => {
  // canonical 是供应商约束，不是 UPLOAD 的别名——即便当前两份词表恰好同值，
  // 也要各自校验，否则 PR-B 放宽 UPLOAD 时不会有任何测试发现两者已经分叉。
  assert.deepEqual(domainList('CANONICAL_IMAGE_FORMATS'), [...CANONICAL_IMAGE_FORMATS])
})

/**
 * 从 domain 源文本里抠出 `FORMAT_LABELS` 这个九项映射。
 *
 * 与 `domainList` 同一手法：把 TS 源码当文本读，正则抠出字面量。这里的对象是
 * 平铺的（值不含嵌套 `{`/`}`），所以从声明处找到第一个 `{` 到随后第一个 `}`
 * 之间的区间就是整个映射体，不需要真正的括号配对。
 */
function domainFormatLabels() {
  const start = domain.indexOf('const FORMAT_LABELS')
  assert.notEqual(start, -1, '找不到 FORMAT_LABELS')
  const braceStart = domain.indexOf('{', start)
  assert.notEqual(braceStart, -1, 'FORMAT_LABELS 缺少 {')
  const braceEnd = domain.indexOf('}', braceStart)
  assert.notEqual(braceEnd, -1, 'FORMAT_LABELS 缺少 }')
  const entries = [...domain.slice(braceStart, braceEnd).matchAll(/'([^']+)':\s*'([^']+)'/g)]
  assert.ok(entries.length > 0, 'FORMAT_LABELS 解析出 0 项')
  return Object.fromEntries(entries.map((match) => [match[1], match[2]]))
}

test('两份格式标签词表逐项一致（key 与 value 都要对上）', () => {
  // 词表加了新格式却漏改其中一份标签映射，那一侧就会把原始 MIME 字符串
  // 回显进用户可见文案——这条测试就是防这个漂移的唯一栅栏。
  assert.deepEqual(domainFormatLabels(), { ...FORMAT_LABELS })
})

test('客户端字节上限与服务端一致', () => {
  const match = domain.match(/maxUploadBytes:\s*([\d*\s]+),/)
  assert.ok(match, '找不到 maxUploadBytes')
  // 只求值一个由数字与 * 组成的字面量，不用 eval：按 * 拆开再连乘。
  const value = match[1].split('*').map((part) => Number(part.trim())).reduce((total, part) => total * part, 1)
  assert.equal(value, MEDIA_LIMITS.maxUploadBytes)
})
