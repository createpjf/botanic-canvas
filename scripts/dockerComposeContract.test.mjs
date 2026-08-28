import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')

function serviceBlock(name) {
  const marker = `  ${name}:\n`
  const start = compose.indexOf(marker)
  assert.notEqual(start, -1, `docker-compose.yml 缺少 ${name} service`)
  const body = compose.slice(start + marker.length)
  const nextService = body.search(/^  [a-zA-Z0-9_-]+:\n/m)
  return nextService === -1 ? body : body.slice(0, nextService)
}

test('API 与 Worker 都透传 Flock 图片 Provider 配置', () => {
  for (const service of ['api', 'worker']) {
    const block = serviceBlock(service)
    for (const key of ['FLOCK_API_KEY', 'FLOCK_API_BASE_URL', 'FLOCK_IMAGE_MODELS']) {
      assert.match(block, new RegExp(`^      ${key}:`, 'm'), `${service} 未透传 ${key}`)
    }
  }
})
