import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyBobSaysPlayCounts } from '../../domain/bobPresentation.ts'
import {
  BOB_SAYS_PLAY_CACHE_LIMIT,
  cacheBobSaysPlays,
  readCachedBobSaysPlays,
} from './bobSaysPlayCache.ts'

test('Bob 播放缓存超过上限后回收最旧 key', () => {
  for (let index = 0; index <= BOB_SAYS_PLAY_CACHE_LIMIT; index += 1) {
    cacheBobSaysPlays(`lru-${index}`, emptyBobSaysPlayCounts())
  }
  assert.equal(readCachedBobSaysPlays('lru-0'), undefined)
  assert.deepEqual(readCachedBobSaysPlays(`lru-${BOB_SAYS_PLAY_CACHE_LIMIT}`), { hmm: 0, wow: 0 })
})
