/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_ENVIRONMENT?: string
  readonly VITE_SENTRY_RELEASE?: string
  readonly VITE_STATUS_PAGE_JSON_URL?: string
}

declare const __BOTANIC_RELEASE__: { version: string; revision: string }
declare const __BOTANIC_SENTRY_RELEASE__: string | null
