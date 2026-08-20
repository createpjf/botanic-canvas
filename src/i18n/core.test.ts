import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatProductNumber,
  formatProductRelativeTime,
  localizeProductError,
} from './core.ts'

test('产品数字与相对时间跟随当前语言', () => {
  assert.equal(formatProductNumber(12345, 'en'), '12,345')
  assert.equal(formatProductNumber(12345, 'zh-CN'), '12,345')
  assert.equal(formatProductRelativeTime(-1, 'hour', 'en'), '1 hour ago')
  assert.equal(formatProductRelativeTime(-1, 'hour', 'zh-CN'), '1小时前')
})
test('英文错误优先使用稳定错误码且不泄漏中文服务端消息', () => {
  assert.equal(localizeProductError(
    { code: 'AUTH_REQUIRED', status: 401, message: '登录状态已失效。' },
    'en',
    { 'zh-CN': '请求失败。', en: 'Request failed.' },
  ), 'Your session expired. Sign in again.')
  assert.equal(localizeProductError(
    { code: 'UNKNOWN', status: 500, message: '供应商返回异常。' },
    'en',
    { 'zh-CN': '请求失败。', en: 'Request failed.' },
  ), 'Request failed.')
})

test('中文错误保留服务端兼容文案', () => {
  assert.equal(localizeProductError(
    { code: 'UNKNOWN', status: 500, message: '供应商返回异常。' },
    'zh-CN',
    { 'zh-CN': '请求失败。', en: 'Request failed.' },
  ), '供应商返回异常。')
})
