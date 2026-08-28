import assert from 'node:assert/strict'
import test from 'node:test'
import { acquireGenerationProviderAdmission } from './generationProviderAdmission.mjs'

test('Flock 进程级许可串行覆盖高内存任务，释放操作幂等', async () => {
  const releaseFirst = await acquireGenerationProviderAdmission({ providers: ['flock'] })
  let secondEntered = false
  const second = acquireGenerationProviderAdmission({ providers: ['flock'] }).then((release) => {
    secondEntered = true
    return release
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(secondEntered, false)
  releaseFirst()
  releaseFirst()
  const releaseSecond = await second
  assert.equal(secondEntered, true)
  releaseSecond()
})

test('普通 Provider 不占用 Flock 高内存许可', async () => {
  const releaseFlock = await acquireGenerationProviderAdmission({ providers: ['flock'] })
  const releaseOpenAI = await acquireGenerationProviderAdmission({ providers: ['openai'] })
  releaseOpenAI()
  releaseFlock()
})

test('等待 Flock 许可时可取消，且不会阻塞后续任务', async () => {
  const releaseFirst = await acquireGenerationProviderAdmission({ providers: ['flock'] })
  const controller = new AbortController()
  const cancelled = acquireGenerationProviderAdmission({ providers: ['flock'], signal: controller.signal })
  controller.abort(new Error('cancelled'))
  await assert.rejects(cancelled, /cancelled/u)
  releaseFirst()
  const releaseNext = await acquireGenerationProviderAdmission({ providers: ['flock'] })
  releaseNext()
})
