// @ts-check

import * as Sentry from '@sentry/node'

function withoutQueryOrHash(value) {
  if (!value) return value
  const suffix = value.search(/[?#]/u)
  return suffix === -1 ? value : value.slice(0, suffix)
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
export const flushSentry = Sentry.flush
