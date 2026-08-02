export const productSessionInvalidationMessage = '登录状态已失效，请重新登录。'

type ProductSessionInvalidationListener = (message: string) => void

const listeners = new Set<ProductSessionInvalidationListener>()

export function subscribeProductSessionInvalidated(listener: ProductSessionInvalidationListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyProductSessionInvalidated(message = productSessionInvalidationMessage) {
  for (const listener of listeners) listener(message)
}

export function invalidateProductSessionIfRequired(input: { status: number; code?: string }) {
  if (input.status !== 401 || input.code !== 'AUTH_REQUIRED') return false
  notifyProductSessionInvalidated()
  return true
}
