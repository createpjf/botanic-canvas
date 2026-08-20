import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { productLocaleStorageKey, readProductLocale, type ProductLocale } from './core'

type ProductI18nContextValue = {
  locale: ProductLocale
  setLocale: (locale: ProductLocale) => void
  toggleLocale: () => void
}
const ProductI18nContext = createContext<ProductI18nContextValue | null>(null)

export function ProductI18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<ProductLocale>(readProductLocale)

  useEffect(() => {
    document.documentElement.lang = locale
    try {
      window.localStorage.setItem(productLocaleStorageKey, locale)
    } catch {
      // Language switching remains available when browser storage is unavailable.
    }
  }, [locale])

  const value = useMemo<ProductI18nContextValue>(() => ({
    locale,
    setLocale,
    toggleLocale: () => setLocale((current) => current === 'zh-CN' ? 'en' : 'zh-CN'),
  }), [locale])

  return <ProductI18nContext.Provider value={value}>{children}</ProductI18nContext.Provider>
}

export function useProductI18n() {
  const value = useContext(ProductI18nContext)
  if (!value) throw new Error('useProductI18n must be used inside ProductI18nProvider')
  return value
}

export function useProductMessages<T extends Record<ProductLocale, unknown>>(messages: T): T[ProductLocale] {
  const { locale } = useProductI18n()
  return messages[locale]
}

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { locale, toggleLocale } = useProductI18n()
  const label = locale === 'zh-CN' ? 'EN' : '中文'
  const ariaLabel = locale === 'zh-CN' ? '切换为英文' : 'Switch to Chinese'
  return <button type="button" className={className} onClick={toggleLocale} aria-label={ariaLabel}>{label}</button>
}
