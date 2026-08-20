export type ProductLocale = 'zh-CN' | 'en'

export const productLocaleStorageKey = 'botanic:product-locale:v1'

export type LocalizedText = Record<ProductLocale, string>

export function readProductLocale(): ProductLocale {
  if (typeof window === 'undefined') return 'zh-CN'
  try {
    return window.localStorage.getItem(productLocaleStorageKey) === 'en' ? 'en' : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}
export function productIntlLocale(locale: ProductLocale) {
  return locale === 'en' ? 'en-US' : 'zh-CN'
}

export function formatProductDateTime(
  value: number | Date,
  locale: ProductLocale,
  options: Intl.DateTimeFormatOptions,
) {
  return new Intl.DateTimeFormat(productIntlLocale(locale), options).format(value)
}

export function formatProductNumber(value: number, locale: ProductLocale) {
  return new Intl.NumberFormat(productIntlLocale(locale)).format(value)
}

export function formatProductRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, locale: ProductLocale) {
  return new Intl.RelativeTimeFormat(productIntlLocale(locale), { numeric: 'auto' }).format(value, unit)
}

type LocalizableError = {
  code?: string
  status?: number
  message?: string
}

const englishErrorMessages: Record<string, string> = {
  AUTH_REQUIRED: 'Your session expired. Sign in again.',
  REQUEST_TIMEOUT: 'The request timed out. Try again.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  PROJECT_NOT_FOUND: 'This project is unavailable or has been deleted.',
  WORKSPACE_ACCESS_REQUIRED: 'This account does not have access to the Botanic workspace.',
  SUPABASE_SIGN_IN_FAILED: 'Unable to sign in. Check your email and password.',
  PASSWORD_TOO_SHORT: 'Choose a password with at least 8 characters.',
  PASSWORD_SETUP_FAILED: 'Unable to save your password. Try again.',
  OFFLINE_DRAFT_SAVED: 'You are offline. Your changes are saved locally and will sync when you reconnect.',
  STREAM_DISCONNECTED: 'The Agent connection ended before the response was complete. Try again.',
  SUBMISSION_STATUS_UNKNOWN: 'The task was submitted, but its status is not confirmed yet. Check again shortly.',
  SUBMISSION_NOT_CONFIRMED: 'The task could not be confirmed. Try again.',
}

export function localizeProductError(
  error: unknown,
  locale: ProductLocale,
  fallback: LocalizedText,
) {
  const candidate = error && typeof error === 'object' ? error as LocalizableError : undefined
  if (locale === 'zh-CN') return candidate?.message?.trim() || fallback['zh-CN']
  if (candidate?.code && englishErrorMessages[candidate.code]) return englishErrorMessages[candidate.code]
  if (candidate?.status === 401) return englishErrorMessages.AUTH_REQUIRED
  if (candidate?.status === 403) return 'You do not have permission to perform this action.'
  if (candidate?.status === 404) return 'The requested content could not be found.'
  if (candidate?.status === 429) return englishErrorMessages.RATE_LIMITED
  return fallback.en
}
