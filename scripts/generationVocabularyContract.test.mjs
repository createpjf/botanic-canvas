import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  GENERATION_ASPECT_RATIOS,
  GENERATION_RESOLUTIONS,
  NANO_BANANA_MODEL_ID,
} from '../server/generation/generationVocabulary.mjs'

const domain = readFileSync(new URL('../src/domain/canvas.ts', import.meta.url), 'utf8')

function domainConstArray(name) {
  const start = domain.indexOf(`export const ${name} = [`)
  assert.notEqual(start, -1, `找不到 ${name}`)
  const end = domain.indexOf('] as const', start)
  assert.notEqual(end, -1, `${name} 缺少 as const`)
  return [...domain.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1])
}

test('两侧比例与分辨率词表逐项一致', () => {
  assert.deepEqual(domainConstArray('GENERATION_ASPECT_RATIOS'), [...GENERATION_ASPECT_RATIOS])
  assert.deepEqual(domainConstArray('GENERATION_RESOLUTIONS'), [...GENERATION_RESOLUTIONS])
})

test('Nano Banana 型号 id 两侧一致', () => {
  const match = domain.match(/export const NANO_BANANA_MODEL_ID = '([^']+)'/)
  assert.ok(match, '找不到 NANO_BANANA_MODEL_ID')
  assert.equal(match[1], NANO_BANANA_MODEL_ID)
})
