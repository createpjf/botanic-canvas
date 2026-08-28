import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_VISION_CAPABLE_MODELS,
  captionAgentVisionModel,
  isAgentVisionCapableModel,
  nativeAgentVisionModel,
} from './botanicAgentVisionCapability.mjs'

test('看图能力集合只认 Gemini 3.7 与 DeepSeek Vision Exp', () => {
  assert.deepEqual([...AGENT_VISION_CAPABLE_MODELS], [
    'gemini-3.7-flash',
    'deepseek-v4-flash-vision-exp',
  ])
  assert.equal(isAgentVisionCapableModel('gemini-3.7-flash'), true)
  assert.equal(isAgentVisionCapableModel('deepseek-v4-flash-vision-exp'), true)
  assert.equal(isAgentVisionCapableModel('deepseek-v4-pro'), false)
  assert.equal(isAgentVisionCapableModel('deepseek-v4-flash'), false)
  assert.equal(isAgentVisionCapableModel('kimi-k3'), false)
  assert.equal(isAgentVisionCapableModel('gemini-3.6-flash'), false)
  assert.equal(isAgentVisionCapableModel('glm-5'), false)
})

test('原生看图只跟所选规划模型走，不回落环境变量', () => {
  assert.equal(nativeAgentVisionModel('gemini-3.7-flash'), 'gemini-3.7-flash')
  assert.equal(nativeAgentVisionModel('deepseek-v4-flash-vision-exp'), 'deepseek-v4-flash-vision-exp')
  assert.equal(nativeAgentVisionModel('kimi-k3'), '')
  assert.equal(nativeAgentVisionModel('deepseek-v4-pro'), '')
  assert.equal(captionAgentVisionModel({ agentVisionModel: 'gemini-3.7-flash' }), 'gemini-3.7-flash')
  assert.equal(captionAgentVisionModel({}), '')
})
