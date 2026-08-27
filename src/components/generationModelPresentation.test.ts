import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./generationModelPresentation.ts', import.meta.url), 'utf8')

test('defaultAgentPlannerModels 包含 Gemini 与 GLM', () => {
  const match = source.match(/export const defaultAgentPlannerModels = \[([\s\S]*?)\]/)
  assert.ok(match, '找不到 defaultAgentPlannerModels')
  const models = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
  assert.deepEqual(models, [
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'kimi-k3',
    'gemini-3.6-flash',
    'glm-5',
  ])
})

test('agentPlannerModelLabel 与 provider 映射覆盖 Gemini / GLM', () => {
  assert.match(source, /gemini-3\.6-flash.*Gemini 3\.6 Flash/)
  assert.match(source, /glm-5.*GLM 5/)
  assert.match(source, /gemini-3\.6-flash.*return 'Gemini'/)
  assert.match(source, /glm-5.*return 'GLM-5'/)
  assert.match(source, /\/gemini\/i\.test\(model\).*return 'gemini'/)
  assert.match(source, /\/glm|zhipu|chatglm\/i\.test\(model\).*return 'glm'/)
})

test('AgentPlannerProviderIcon 使用 Gemini / GLM 原厂 logo 路径', () => {
  const iconSource = readFileSync(new URL('./AgentPlannerProviderIcon.tsx', import.meta.url), 'utf8')
  assert.match(iconSource, /provider-logos\/gemini\.png/)
  assert.match(iconSource, /provider-logos\/glm\.png/)
})
