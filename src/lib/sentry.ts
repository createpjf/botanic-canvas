import * as Sentry from '@sentry/react'
import type { Breadcrumb, ErrorEvent } from '@sentry/react'

function withoutQueryOrHash(value: string | undefined) {
  if (!value) return value
  const suffix = value.search(/[?#]/u)
  return suffix === -1 ? value : value.slice(0, suffix)
}

const sentryRedactions = [
  { pattern: /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/giu, replacement: '[redacted-inline-media]' },
  { pattern: /https?:\/\/[^\s"'<>）)]+/giu, replacement: '[redacted-url]' },
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/giu, replacement: '[redacted-key]' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/giu, replacement: '[redacted-token]' },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/gu, replacement: '[redacted-jwt]' },
]

function redactSentryText(value: string | undefined) {
  if (!value) return value
  return sentryRedactions.reduce(
    (text, { pattern, replacement }) => text.replace(pattern, replacement),
    value,
  ).slice(0, 500)
}

function scrubSentryException(exception: ErrorEvent['exception']) {
  if (!exception?.values) return exception
  return {
    ...exception,
    values: exception.values.map((value) => ({
      ...value,
      ...(typeof value.type === 'string' ? { type: redactSentryText(value.type) } : {}),
      ...(typeof value.value === 'string' ? { value: redactSentryText(value.value) } : {}),
    })),
  }
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb) {
  if (breadcrumb.category === 'console') return null
  if (!breadcrumb.data?.url) return breadcrumb
  return { ...breadcrumb, data: { ...breadcrumb.data, url: withoutQueryOrHash(String(breadcrumb.data.url)) } }
}

function isBrowserNoiseError(event: ErrorEvent) {
  const value = event.exception?.values?.[0]
  const type = value?.type ?? ''
  const message = value?.value ?? ''
  if (type === 'AbortError' || /signal is aborted/i.test(message) || message === 'aborted') return true
  if (type === 'TypeError' && /Failed to fetch|NetworkError|Load failed|network error/i.test(message)) return true
  return false
}

export function scrubSentryEvent(event: ErrorEvent) {
  if (isBrowserNoiseError(event)) return null
  return {
    ...event,
    user: undefined,
    extra: undefined,
    ...(typeof event.message === 'string' ? { message: redactSentryText(event.message) } : {}),
    exception: scrubSentryException(event.exception),
    request: event.request
      ? { method: event.request.method, url: withoutQueryOrHash(event.request.url) }
      : undefined,
    breadcrumbs: event.breadcrumbs
      ?.map(scrubSentryBreadcrumb)
      .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null),
  }
}

export function initializeBrowserSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim()
  if (!dsn) return false
  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE || __BOTANIC_SENTRY_RELEASE__ || undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  })
  return true
}

export const sentryReactErrorHandler = Sentry.reactErrorHandler

type SentryMessageLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug'

function safeTag(value: unknown) {
  return String(value ?? 'unknown').replace(/[\r\n]/gu, ' ').slice(0, 120)
}

function safeApiPath(path: string | undefined) {
  return (path ?? 'unknown').split(/[?#]/u, 1)[0].slice(0, 160)
}

export function captureSentryApiFailure(
  error: unknown,
  input: { path?: string; method?: string; aborted?: boolean } = {},
) {
  if (input.aborted) return
  const source = error && typeof error === 'object' ? error as { status?: unknown; code?: unknown; requestId?: unknown } : {}
  const status = Number(source.status)
  const code = typeof source.code === 'string' && source.code ? source.code : undefined
  const requestId = typeof source.requestId === 'string' && source.requestId ? source.requestId : undefined
  const reportable = status === 0 || status >= 500 || status === 401 || status === 403 || status === 429
  if (!reportable) return
  Sentry.captureException(error, {
    level: status >= 500 || status === 0 ? 'error' : 'warning',
    tags: {
      component: 'browser-api',
      method: safeTag(input.method ?? 'GET'),
      http_status: safeTag(Number.isFinite(status) ? status : 'unknown'),
      ...(code ? { error_code: safeTag(code) } : {}),
      ...(requestId ? { request_id: safeTag(requestId) } : {}),
    },
    contexts: { request: { method: input.method ?? 'GET', path: safeApiPath(input.path), ...(requestId ? { id: safeTag(requestId) } : {}) } },
  })
}

export function captureSentryMessage(
  message: string,
  input: { component?: string; level?: SentryMessageLevel; tags?: Record<string, unknown> } = {},
) {
  Sentry.captureMessage(redactSentryText(message) ?? 'botanic_event', {
    level: input.level ?? 'warning',
    tags: {
      ...(input.component ? { component: safeTag(input.component) } : {}),
      ...Object.fromEntries(Object.entries(input.tags ?? {}).map(([key, value]) => [key, safeTag(value)])),
    },
  })
}

/**
 * 静默兜底路径的最低可观测性：失败不打断用户，但要留痕，
 * 否则「刷新没生效 / 补丁没落盘」这类断链只能靠猜。未初始化时是 no-op。
 */
export function recordSentryBreadcrumb(category: string, message: string) {
  Sentry.addBreadcrumb({ category, message, level: 'warning' })
}
