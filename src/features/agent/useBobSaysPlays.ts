import { useEffect, useState } from 'react'
import {
  emptyBobSaysPlayCounts,
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

  const markPlayed = (says: BobPresentationSays) => {
    setPlays((current) => {
      const next = markBobSaysPlayed(current, says)
      playsByKey.set(key, next)
      return next
    })
  }

  return { plays, markPlayed }
}
