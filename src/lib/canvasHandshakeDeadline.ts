export function createCanvasHandshakeDeadline(onExpired: () => void, timeoutMs = 10_000) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    timeoutId = undefined
  }
  return {
    arm() {
      clear()
      timeoutId = setTimeout(() => {
        timeoutId = undefined
        onExpired()
      }, timeoutMs)
    },
    clear,
  }
}
