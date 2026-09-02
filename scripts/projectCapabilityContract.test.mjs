import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { projectCapabilities } from '../server/auth/authorization.mjs'

const domain = readFileSync(new URL('../src/domain/projectCapabilities.ts', import.meta.url), 'utf8')

/**
 * 客户端能力词表必须与服务端权限表一致。
 *
 * 两边分别维护是这类模型最常见的坏法：服务端加了一个新权限、界面不知道，于是那个
 * 入口对谁都不显示；或者反过来，界面留着一个服务端早就收回的能力，用户点了才 403。
 */
function domainCapabilities() {
  const start = domain.indexOf('export const PROJECT_CAPABILITIES = [')
  assert.notEqual(start, -1, '找不到 PROJECT_CAPABILITIES')
  const end = domain.indexOf('] as const', start)
  return [...domain.slice(start, end).matchAll(/'([a-z-]+)'/g)].map((match) => match[1])
}

test('客户端能力词表覆盖服务端 owner 的全部权限', () => {
  const server = projectCapabilities('owner')
  const client = domainCapabilities()
  const missing = server.filter((capability) => !client.includes(capability))
  assert.deepEqual(missing, [], `服务端有但客户端词表缺：${missing.join('、')}`)
})

test('客户端不声明服务端不存在的能力', () => {
  // 界面留着一个服务端早就收回的能力，用户点了才 403。
  const server = projectCapabilities('owner')
  const extra = domainCapabilities().filter((capability) => !server.includes(capability))
  assert.deepEqual(extra, [], `客户端多出服务端没有的能力：${extra.join('、')}`)
})

test('三个角色的能力是逐级包含的', () => {
  // viewer ⊂ editor ⊂ owner。破坏包含关系会让「降级一个成员」反而给他新能力。
  const owner = projectCapabilities('owner')
  const editor = projectCapabilities('editor')
  const viewer = projectCapabilities('viewer')
  assert.ok(viewer.every((capability) => editor.includes(capability)), 'viewer 应是 editor 的子集')
  assert.ok(editor.every((capability) => owner.includes(capability)), 'editor 应是 owner 的子集')
  assert.deepEqual(viewer, ['read'])
  // 未知角色不给任何能力 —— 缺省放行是这类表最危险的写法。
  assert.deepEqual(projectCapabilities(undefined), [])
  assert.deepEqual(projectCapabilities('superuser'), [])
})
