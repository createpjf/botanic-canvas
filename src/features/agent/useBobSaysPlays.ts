import { useEffect, useState } from 'react'
import {
  emptyBobSaysPlayCounts,
  markBobSaysPlayed,
  type BobPresentationSays,
  type BobSaysPlayCounts,
} from '../../domain/bobPresentation'
import { cacheBobSaysPlays, readCachedBobSaysPlays } from './bobSaysPlayCache'

export function useBobSaysPlays(key: string) {
  const [plays, setPlays] = useState<BobSaysPlayCounts>(() => readCachedBobSaysPlays(key) ?? emptyBobSaysPlayCounts())

  useEffect(() => {
    setPlays(readCachedBobSaysPlays(key) ?? emptyBobSaysPlayCounts())
  }, [key])

  const markPlayed = (says: BobPresentationSays) => {
    setPlays((current) => {
      const next = markBobSaysPlayed(current, says)
      cacheBobSaysPlays(key, next)
      return next
    })
  }

  return { plays, markPlayed }
}
