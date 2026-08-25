import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  TRANSIENT_DATABASE_ERROR_CODES,
  createDatabaseResilience,
  installDatabaseResilience,
  isTransientDatabaseError,
} from './databaseResilience.mjs'

const connectTimeout = () => Object.assign(new Error('write CONNECT_TIMEOUT undefined:undefined'), {
  code: 'CONNECT_TIMEOUT', errno: 'CONNECT_TIMEOUT',
})

test('只认错误码，不做消息文本匹配', () => {
  // 文本会随驱动版本变化；按文本匹配的容忍清单迟早在某次升级后悄悄放行本不该放行的错误。
  assert.equal(isTransientDatabaseError(connectTimeout()), true)
  assert.equal(isTransientDatabaseError({ errno: 'ECONNRESET' }), true)
  // 消息里带 CONNECT_TIMEOUT 但没有错误码 —— 不认。
  assert.equal(isTransientDatabaseError(new Error('write CONNECT_TIMEOUT undefined:undefined')), false)
  assert.equal(isTransientDatabaseError(undefined), false)
  assert.equal(isTransientDatabaseError('CONNECT_TIMEOUT'), false)
})

test('容忍清单里没有任何查询级错误', () => {
  // 语法错误、约束冲突、权限不足是代码或数据的问题，藏起来只会更难查。
  for (const code of ['23505', '42601', '42501', 'PROJECT_CONFLICT', 'INVALID_REQUEST']) {
    assert.equal(isTransientDatabaseError({ code }), false, `${code} 不该被容忍`)
  }
  assert.ok(TRANSIENT_DATABASE_ERROR_CODES.includes('CONNECT_TIMEOUT'))
  assert.ok(TRANSIENT_DATABASE_ERROR_CODES.every((code) => !/^\d+$/.test(code)), '不含 SQLSTATE 数字码')
})

test('非连接类错误照原样抛出，保持 fail-fast', () => {
  const resilience = createDatabaseResilience()
  const decision = resilience.classify(new TypeError('x is not a function'))
  assert.equal(decision.action, 'rethrow')
  assert.match(decision.reason, /不是数据库连接层的瞬时故障/u)
})

test('偶发抖动被容忍，连续故障则判定为持续故障', () => {
  let clock = 0
  const resilience = createDatabaseResilience({ windowMs: 60_000, threshold: 5, now: () => clock })
  for (let index = 0; index < 4; index += 1) {
    clock += 1_000
    assert.equal(resilience.classify(connectTimeout()).action, 'tolerate', `第 ${index + 1} 次应容忍`)
  }
  clock += 1_000
  const fatal = resilience.classify(connectTimeout())
  // 持续容忍一个彻底断掉的数据库，会让服务「活着但每个请求都 500」，
  // 而健康检查一直显示正常 —— 比直接退出让编排器重启更难被发现。
  assert.equal(fatal.action, 'exit')
  assert.match(fatal.reason, /60 秒内发生 5 次/u)
})

test('窗口滑走之后重新开始计数', () => {
  let clock = 0
  const resilience = createDatabaseResilience({ windowMs: 60_000, threshold: 3, now: () => clock })
  for (let index = 0; index < 2; index += 1) { clock += 1_000; resilience.classify(connectTimeout()) }
  assert.equal(resilience.recentCount(), 2)
  // 两分钟后再抖一次，不该被算成「连续第 3 次」。
  clock += 120_000
  assert.equal(resilience.classify(connectTimeout()).action, 'tolerate')
  assert.equal(resilience.recentCount(), 1)
})

test('装到进程上：瞬时故障只记录，不退出', () => {
  const target = new EventEmitter()
  target.exit = () => { throw new Error('不该退出') }
  const events = []
  installDatabaseResilience({ process: target, observe: (event) => events.push(event) })
  target.emit('uncaughtException', connectTimeout())
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'database.connection.tolerated')
  assert.equal(events[0].code, 'CONNECT_TIMEOUT')
  assert.equal(events[0].kind, 'uncaughtException')
})

test('装到进程上：非连接类异常仍然抛出', () => {
  const target = new EventEmitter()
  const events = []
  installDatabaseResilience({ process: target, observe: (event) => events.push(event) })
  assert.throws(() => target.emit('uncaughtException', new RangeError('真 bug')), RangeError)
  assert.equal(events.length, 0, '不该记录，也不该容忍')
})

test('unhandledRejection 同样被接住', () => {
  // 连接层的错误既可能以 socket error 冒出来，也可能是一个没人 await 的重连 Promise。
  const target = new EventEmitter()
  const events = []
  installDatabaseResilience({ process: target, observe: (event) => events.push(event) })
  target.emit('unhandledRejection', connectTimeout())
  assert.equal(events[0].kind, 'unhandledRejection')
})

test('持续故障时调用 onFatal 而不是直接 exit（供编排器接管）', () => {
  const target = new EventEmitter()
  const fatal = []
  const events = []
  installDatabaseResilience({
    process: target, threshold: 2, observe: (event) => events.push(event), onFatal: (error) => fatal.push(error),
  })
  target.emit('uncaughtException', connectTimeout())
  target.emit('uncaughtException', connectTimeout())
  assert.equal(fatal.length, 1)
  assert.equal(events.at(-1).event, 'database.connection.fatal')
})
