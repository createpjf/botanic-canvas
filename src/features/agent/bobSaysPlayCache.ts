import type { BobSaysPlayCounts } from '../../domain/bobPresentation'

export const BOB_SAYS_PLAY_CACHE_LIMIT = 512

const playsByKey = new Map<string, BobSaysPlayCounts>()

export function readCachedBobSaysPlays(key: string) {
  const plays = playsByKey.get(key)
  if (!plays) return undefined
  playsByKey.delete(key)
  playsByKey.set(key, plays)
  return plays
}

export function cacheBobSaysPlays(key: string, plays: BobSaysPlayCounts) {
  playsByKey.delete(key)
  playsByKey.set(key, plays)
  if (playsByKey.size > BOB_SAYS_PLAY_CACHE_LIMIT) {
    const oldest = playsByKey.keys().next().value
    if (oldest !== undefined) playsByKey.delete(oldest)
  }
}
