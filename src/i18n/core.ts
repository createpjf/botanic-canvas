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
  AGENT_SKILL_BINDING_UNKNOWN: 'A mounted Skill is unavailable. Remove it and retry.',
  AGENT_SKILL_BINDING_DEPENDENCY: 'A mounted Skill has an unavailable dependency.',
  AGENT_SKILL_DEPENDENCY_CONFLICT: 'Mounted Skills require conflicting versions of a dependency.',
  AGENT_SKILL_BINDING_LIMIT: 'Up to 16 Skills can be mounted.',
  AGENT_SKILL_CONTEXT_TOO_LARGE: 'Mounted Skills exceed this turn\u2019s budget. Remove some.',
  AGENT_SKILL_SNAPSHOT_MISMATCH: 'A Skill version from the original turn is gone. Start a new turn.',
  AGENT_TURN_DEADLINE_EXCEEDED: 'The turn timed out. Start a new turn.',
  AGENT_TURN_RESUME_LIMIT_REACHED: 'Recovery attempts exhausted. Start a new turn.',
  AGENT_TOOL_OUTCOME_UNKNOWN: 'An external call\u2019s result is unconfirmed. It was not retried.',
  TOOL_NO_PROGRESS: 'The Agent repeated itself and was stopped.',
  TOOL_LOOP_LIMIT_REACHED: 'The Agent ran out of steps.',
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
