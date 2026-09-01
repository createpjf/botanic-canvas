// @ts-check

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
      ...(value.stacktrace ? {
        stacktrace: {
          ...value.stacktrace,
          frames: value.stacktrace.frames?.map((frame) => ({
            ...frame,
            ...(typeof frame.filename === 'string'
              ? { filename: withoutQueryOrHash(redactSentryText(frame.filename)) }
              : {}),
            ...(typeof frame.abs_path === 'string'
              ? { abs_path: withoutQueryOrHash(redactSentryText(frame.abs_path)) }
              : {}),
          })),
        },
      } : {}),
    })),
  }
}

export function scrubSentryBreadcrumb(breadcrumb) {
  if (breadcrumb.category === 'console') return null
  if (!breadcrumb.data?.url) return breadcrumb
  return { ...breadcrumb, data: { ...breadcrumb.data, url: withoutQueryOrHash(String(breadcrumb.data.url)) } }
}

export function scrubSentryEvent(event) {
  return {
    ...event,
    user: undefined,
    extra: undefined,
    ...(typeof event.message === 'string' ? { message: redactSentryText(event.message) } : {}),
    exception: scrubSentryException(event.exception),
    request: event.request
      ? { method: event.request.method, url: withoutQueryOrHash(event.request.url) }
      : undefined,
    breadcrumbs: event.breadcrumbs?.map(scrubSentryBreadcrumb).filter(Boolean),
  }
}

const dsn = process.env.SENTRY_DSN?.trim()
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT
      || process.env.RAILWAY_ENVIRONMENT_NAME
      || process.env.VERCEL_ENV
      || process.env.NODE_ENV
      || 'development',
    release: process.env.SENTRY_RELEASE
      || process.env.RAILWAY_GIT_COMMIT_SHA
      || process.env.VERCEL_GIT_COMMIT_SHA,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    skipOpenTelemetrySetup: true,
    registerEsmLoaderHooks: false,
    integrations: [Sentry.httpIntegration({
      spans: false,
      tracePropagation: false,
      maxIncomingRequestBodySize: 'none',
    })],
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  })
}

export const captureException = Sentry.captureException
export const captureMessage = Sentry.captureMessage
export const captureCheckIn = Sentry.captureCheckIn
export const flushSentry = Sentry.flush
