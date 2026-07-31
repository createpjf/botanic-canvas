import assert from 'node:assert/strict'
import test from 'node:test'
import { assignVideoInputRoles } from './videoGeneration.ts'

const image = (nodeId: string) => ({
  nodeId,
  assetId: nodeId,
  name: nodeId,
  image: `/api/media/${nodeId}`,
  role: '场景' as const,
  mediaKind: 'image' as const,
})

test('首尾帧模式按连接顺序产生明确的 first_frame 与 last_frame 角色', () => {
  const result = assignVideoInputRoles([image('start'), image('end')], 'first_last')

  assert.equal(result.error, undefined)
  assert.deepEqual(result.references.map((reference) => reference.inputRole), ['first_frame', 'last_frame'])
})

test('参考模式区分参考图片与上游视频', () => {
  const result = assignVideoInputRoles([
    image('style'),
    { ...image('clip'), mediaKind: 'video' as const },
  ], 'reference')

  assert.equal(result.error, undefined)
  assert.deepEqual(result.references.map((reference) => reference.inputRole), ['reference_image', 'reference_video'])
})

test('首尾帧模式拒绝视频或超过两张图片，避免提交互斥的 H3 输入', () => {
  assert.match(assignVideoInputRoles([{ ...image('clip'), mediaKind: 'video' }], 'first_frame').error ?? '', /图片/)
  assert.match(assignVideoInputRoles([image('a'), image('b'), image('c')], 'first_last').error ?? '', /两张/)
})
