import * as Sentry from '@sentry/node'

function withoutQueryOrHash(value) {
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

function redactSentryText(value) {
  if (typeof value !== 'string' || !value) return value
  return sentryRedactions.reduce(
    (text, { pattern, replacement }) => text.replace(pattern, replacement),
    value,
  ).slice(0, 500)
}

function scrubSentryException(exception) {
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

export function scrubBreadcrumb(breadcrumb) {
  if (breadcrumb.category === 'console') return null
  if (!breadcrumb.data?.url) return breadcrumb
  return { ...breadcrumb, data: { ...breadcrumb.data, url: withoutQueryOrHash(String(breadcrumb.data.url)) } }
}

export function scrubEvent(event) {
  return {
    ...event,
    user: undefined,
    extra: undefined,
    ...(typeof event.message === 'string' ? { message: redactSentryText(event.message) } : {}),
    exception: scrubSentryException(event.exception),
    breadcrumbs: event.breadcrumbs?.map(scrubBreadcrumb).filter(Boolean),
    request: event.request
      ? { method: event.request.method, url: withoutQueryOrHash(event.request.url) }
      : undefined,
  }
}

const dsn = process.env.SENTRY_DSN?.trim()
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV || 'development',
    release: process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    skipOpenTelemetrySetup: true,
    registerEsmLoaderHooks: false,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  })
}

export const captureException = Sentry.captureException
export const captureCheckIn = Sentry.captureCheckIn
export const flushSentry = Sentry.flush
