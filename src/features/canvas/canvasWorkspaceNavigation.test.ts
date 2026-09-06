import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWorkspaceNavigation,
  sameWorkspaceLocation,
  workspaceHash,
  workspaceLocationFromHash,
} from './canvasWorkspaceNavigation.ts'

test('工作区 hash 往返保留包含空格和中文的项目标识', () => {
  const location = { view: 'canvas' as const, projectId: '夏日 项目/01' }
  const hash = workspaceHash(location)

  assert.equal(hash, '#/canvas/%E5%A4%8F%E6%97%A5%20%E9%A1%B9%E7%9B%AE%2F01')
  assert.deepEqual(workspaceLocationFromHash(hash), location)
})

test('工作区路由拒绝空项目和畸形编码', () => {
  assert.equal(workspaceLocationFromHash('#/canvas/'), null)
  assert.equal(workspaceLocationFromHash('#/canvas/%E0%A4%A'), null)
  assert.equal(workspaceLocationFromHash('#/unknown'), null)
  assert.equal(workspaceLocationFromHash('#access_token=invite&type=invite'), null)
})

test('旧经营驾驶舱地址兼容进入项目库', () => {
  assert.deepEqual(workspaceLocationFromHash('#/dashboard'), { view: 'projects' })
  assert.deepEqual(workspaceLocationFromHash('#/dashboard/'), { view: 'projects' })
  assert.deepEqual(workspaceLocationFromHash('#/projects/'), { view: 'projects' })
  assert.equal(workspaceHash({ view: 'projects' }), '#/projects')
})

test('工作区位置比较同时检查视图和项目', () => {
  assert.equal(sameWorkspaceLocation({ view: 'canvas', projectId: 'a' }, { view: 'canvas', projectId: 'a' }), true)
  assert.equal(sameWorkspaceLocation({ view: 'canvas', projectId: 'a' }, { view: 'canvas', projectId: 'b' }), false)
  assert.equal(sameWorkspaceLocation({ view: 'projects' }, { view: 'projects' }), true)
})

test('项目双导航事件只读一次，切项目不等旧读取，晚到结果不能串页', async () => {
  const reads: string[] = [], views: string[] = []
  const pending = new Map<string, { signal: AbortSignal; resolve: (ok: boolean) => void }>()
  const navigation = createWorkspaceNavigation({
    openDocument: (id, signal) => { reads.push(id); return new Promise((resolve) => pending.set(id, { signal, resolve })) },
    onStart: () => {}, onFinish: (location) => views.push(location.projectId ?? 'projects'), onError: () => assert.fail('不应失败'),
  })
  const a = navigation.open({ view: 'canvas', projectId: 'a' })
  assert.equal(navigation.open({ view: 'canvas', projectId: 'a' }), a)
  await Promise.resolve()
  const b = navigation.open({ view: 'canvas', projectId: 'b' })
  await Promise.resolve()
  assert.equal(pending.get('a')!.signal.aborted, true)
  pending.get('b')!.resolve(true)
  assert.equal(await b, true)
  pending.get('a')!.resolve(true)
  assert.equal(await a, false)
  assert.deepEqual(reads, ['a', 'b'])
  assert.deepEqual(views, ['b'])
  assert.equal(await navigation.open({ view: 'canvas', projectId: 'b' }), true)
  assert.deepEqual(reads, ['a', 'b'])
  navigation.cancel()
})

test('挂起读取超时可重试；返回列表后旧结果不能重新打开项目', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const errors: string[] = [], views: string[] = []
  const reads: { signal: AbortSignal; resolve: (ok: boolean) => void }[] = []
  const navigation = createWorkspaceNavigation({
    openDocument: (_id, signal) => new Promise((resolve) => reads.push({ signal, resolve })),
    onStart: () => {}, onFinish: (location) => views.push(location.projectId ?? 'projects'), onError: (location) => errors.push(location.projectId!),
  })
  const first = navigation.open({ view: 'canvas', projectId: 'a' })
  await Promise.resolve()
  t.mock.timers.tick(45_000)
  assert.equal(await first, false)
  assert.equal(reads[0].signal.aborted, true)
  assert.deepEqual(errors, ['a'])
  const retry = navigation.open({ view: 'canvas', projectId: 'a' }, true)
  await Promise.resolve()
  assert.equal(reads.length, 2)
  await navigation.open({ view: 'projects' })
  reads[0].resolve(true)
  reads[1].resolve(true)
  assert.equal(await retry, false)
  assert.equal(reads[1].signal.aborted, true)
  assert.deepEqual(views, ['projects'])
  navigation.cancel()
})
