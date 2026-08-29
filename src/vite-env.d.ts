/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STATUS_PAGE_JSON_URL?: string
}

declare const __BOTANIC_RELEASE__: { version: string; revision: string }
