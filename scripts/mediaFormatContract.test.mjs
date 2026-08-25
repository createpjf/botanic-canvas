import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { MEDIA_LIMITS, UPLOAD_IMAGE_FORMATS } from '../server/mediaFormats.mjs'

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

test('客户端字节上限与服务端一致', () => {
  const match = domain.match(/maxUploadBytes:\s*([\d*\s]+),/)
  assert.ok(match, '找不到 maxUploadBytes')
  // 只求值一个由数字与 * 组成的字面量，不用 eval：按 * 拆开再连乘。
  const value = match[1].split('*').map((part) => Number(part.trim())).reduce((total, part) => total * part, 1)
  assert.equal(value, MEDIA_LIMITS.maxUploadBytes)
})
