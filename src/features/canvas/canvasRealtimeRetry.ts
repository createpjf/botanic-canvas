import { canvasSyncFailureMessage } from '../../domain/realtimeSync.ts'

type Collaboration = { retryBlocked: () => Promise<void> }
export type CanvasRealtimeRetryAttempt = { projectId: string; collaboration: Collaboration | null; promise: Promise<void> }

/** 两个可见重试入口共用一次尝试；这里仅拥有交互状态，握手/ACK 仍决定同步状态。 */
export function retryCanvasRealtimeSync(input: {
  projectId: string
  collaboration: Collaboration | null
  inFlight: { current: CanvasRealtimeRetryAttempt | null }
  isCurrent: () => boolean
  onState: (state: { realtimeRetrying?: boolean; realtimeRetryError?: string }) => void
  locale: 'zh-CN' | 'en'
}) {
  const { projectId, collaboration, inFlight, isCurrent, onState, locale } = input
  if (inFlight.current?.projectId === projectId && inFlight.current.collaboration === collaboration) return inFlight.current.promise
  if (!isCurrent()) return Promise.resolve()
  onState({ realtimeRetrying: true })
  const promise = Promise.resolve().then(() => {
    if (!isCurrent()) return
    if (!collaboration) throw Object.assign(new Error('Canvas collaboration is unavailable.'), { code: 'CANVAS_COLLABORATION_UNAVAILABLE' })
    return collaboration.retryBlocked()
  }).catch((caught) => {
    if (isCurrent()) onState({ realtimeRetryError: canvasSyncFailureMessage((caught as { code?: string })?.code ?? 'UNKNOWN', locale) })
    throw caught
  }).finally(() => {
    if (isCurrent()) onState({ realtimeRetrying: false })
    if (inFlight.current?.promise === promise) inFlight.current = null
  })
  inFlight.current = { projectId, collaboration, promise }
  return promise
}
