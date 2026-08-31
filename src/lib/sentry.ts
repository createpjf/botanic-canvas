import * as Sentry from '@sentry/react'
import type { Breadcrumb, ErrorEvent } from '@sentry/react'

function withoutQueryOrHash(value: string | undefined) {
  if (!value) return value
  const suffix = value.search(/[?#]/u)
  return suffix === -1 ? value : value.slice(0, suffix)
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb) {
  if (breadcrumb.category === 'console') return null
  if (!breadcrumb.data?.url) return breadcrumb
  return { ...breadcrumb, data: { ...breadcrumb.data, url: withoutQueryOrHash(String(breadcrumb.data.url)) } }
}

export function scrubSentryEvent(event: ErrorEvent) {
  return {
    ...event,
    user: undefined,
    extra: undefined,
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

/**
 * 静默兜底路径的最低可观测性：失败不打断用户，但要留痕，
 * 否则「刷新没生效 / 补丁没落盘」这类断链只能靠猜。未初始化时是 no-op。
 */
export function recordSentryBreadcrumb(category: string, message: string) {
  Sentry.addBreadcrumb({ category, message, level: 'warning' })
}
