import assert from 'node:assert/strict'
import test from 'node:test'
import { nextExclusiveSurface } from './exclusiveSurface.ts'

test('打开新的主面板会替换当前主面板', () => {
  assert.equal(nextExclusiveSurface('assets', 'agent', true), 'agent')
})

test('关闭非当前面板不会误关正在使用的面板', () => {
  assert.equal(nextExclusiveSurface('agent', 'assets', false), 'agent')
})

test('同一入口支持切换关闭，并保持其他入口互斥', () => {
  assert.equal(nextExclusiveSurface('history', 'history', (open) => !open), null)
  assert.equal(nextExclusiveSurface('history', 'utility', (open) => !open), 'utility')
})
