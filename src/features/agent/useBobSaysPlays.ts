import { useCallback, useEffect, useState } from 'react'
import {
  emptyBobSaysPlayCounts,
  markBobHappyPlayed,
  markBobSaysPlayed,
  type BobPresentationSays,
  type BobSaysPlayCounts,
} from '../../domain/bobPresentation'

const playsByKey = new Map<string, BobSaysPlayCounts>()

export function useBobSaysPlays(key: string) {
  const [plays, setPlays] = useState<BobSaysPlayCounts>(() => playsByKey.get(key) ?? emptyBobSaysPlayCounts())

  useEffect(() => {
    setPlays(playsByKey.get(key) ?? emptyBobSaysPlayCounts())
  }, [key])

  const markPlayed = useCallback((says: BobPresentationSays) => {
    setPlays((current) => {
      const next = markBobSaysPlayed(current, says)
      playsByKey.set(key, next)
      return next
    })
  }, [key])

  const markHappy = useCallback(() => {
    setPlays((current) => {
      const next = markBobHappyPlayed(current)
      playsByKey.set(key, next)
      return next
    })
  }, [key])

  return { plays, markPlayed, markHappy }
}
