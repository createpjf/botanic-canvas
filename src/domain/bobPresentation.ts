export const BOB_LARGE_REPLY_MIN_CHARS = 200
export const BOB_LARGE_AVATAR_GROW_CHARS = 80
export const BOB_SAYS_MAX_PLAYS = 1
export const BOB_MESSAGE_AVATAR_PX = 28
export const BOB_LARGE_REPLY_AVATAR_PX = 72

export type BobPresentationMood = 'idle' | 'listening' | 'thinking' | 'confused' | 'excited'
export type BobPresentationSays = 'none' | 'question' | 'hmm' | 'wow'

export const BOB_SAYS_MOTION = {
  none: 'idle',
  question: 'confused',
  hmm: 'thinking',
  wow: 'excited',
} as const satisfies Record<BobPresentationSays, BobPresentationMood>

export type BobSaysPlayCounts = {
  hmm: number
  wow: number
}

export function emptyBobSaysPlayCounts(): BobSaysPlayCounts {
  return { hmm: 0, wow: 0 }
}

export function bobAssistantMessageMood(input: {
  streaming: boolean
  isLatestAssistant: boolean
  agentBusy: boolean
}): BobPresentationMood {
  if (input.streaming || (input.isLatestAssistant && input.agentBusy)) return 'thinking'
  if (input.isLatestAssistant) return 'listening'
  return 'idle'
}

export function bobMessageReplyText(message: {
  content?: string
  kind?: string
}) {
  if (message.kind === 'notice' || message.kind === 'run') return ''
  return message.content?.trim() ?? ''
}

export function bobMessageIsLargeReply(
  message: { content?: string; kind?: string; role?: string },
  minChars = BOB_LARGE_REPLY_MIN_CHARS,
) {
  if (message.role && message.role !== 'assistant') return false
  return bobMessageReplyText(message).length >= minChars
}

export function bobMessageAllowsSays(input: {
  isLatestAssistant: boolean
  isLargeReply: boolean
}) {
  return input.isLatestAssistant && input.isLargeReply
}

export function bobMessageUsesLargeAvatar(input: {
  isLatestAssistant: boolean
  streaming: boolean
  message: { content?: string; kind?: string; role?: string }
  minChars?: number
  growChars?: number
}) {
  if (!input.isLatestAssistant) return false
  if (input.message.role && input.message.role !== 'assistant') return false
  const chars = bobMessageReplyText(input.message).length
  if (chars >= (input.minChars ?? BOB_LARGE_REPLY_MIN_CHARS)) return true
  if (!input.streaming) return false
  return chars >= (input.growChars ?? BOB_LARGE_AVATAR_GROW_CHARS)
}

export function bobWelcomePresentation(plays: BobSaysPlayCounts, maxPlays = BOB_SAYS_MAX_PLAYS): {
  mood: BobPresentationMood
  says: BobPresentationSays
  cycles: number
} {
  if (plays.hmm < maxPlays) return { mood: BOB_SAYS_MOTION.hmm, says: 'hmm', cycles: 1 }
  return { mood: BOB_SAYS_MOTION.question, says: 'question', cycles: Number.POSITIVE_INFINITY }
}

export function bobReplyPresentation(input: {
  allowsSays: boolean
  streaming: boolean
  isLatestAssistant: boolean
  agentBusy: boolean
  plays: BobSaysPlayCounts
  maxPlays?: number
}): {
  mood: BobPresentationMood
  says: BobPresentationSays
  cycles: number
} {
  const maxPlays = input.maxPlays ?? BOB_SAYS_MAX_PLAYS
  const mood = bobAssistantMessageMood(input)
  if (!input.allowsSays) return { mood, says: 'none', cycles: 0 }
  if (input.streaming) {
    if (input.plays.hmm < maxPlays) return { mood: BOB_SAYS_MOTION.hmm, says: 'hmm', cycles: 1 }
    return { mood, says: 'none', cycles: 0 }
  }
  if (input.plays.wow < maxPlays) return { mood: BOB_SAYS_MOTION.wow, says: 'wow', cycles: 1 }
  return { mood, says: 'none', cycles: 0 }
}

export function markBobSaysPlayed(plays: BobSaysPlayCounts, says: BobPresentationSays): BobSaysPlayCounts {
  if (says === 'hmm') return { ...plays, hmm: plays.hmm + 1 }
  if (says === 'wow') return { ...plays, wow: plays.wow + 1 }
  return plays
}
