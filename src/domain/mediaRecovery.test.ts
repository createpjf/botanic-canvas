import assert from 'node:assert/strict'
import test from 'node:test'
import { mediaRetryUrl } from './mediaRecovery.ts'

test('媒体重试只在恢复时追加缓存破坏参数，并保留原查询与锚点', () => {
  assert.equal(mediaRetryUrl('/api/media/media-a', 0), '/api/media/media-a')
  assert.equal(mediaRetryUrl('/api/media/media-a', 2), '/api/media/media-a?botanic_retry=2')
  assert.equal(mediaRetryUrl('/api/media/media-a?size=full#preview', 3), '/api/media/media-a?size=full&botanic_retry=3#preview')
})
