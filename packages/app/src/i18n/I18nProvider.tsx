import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import {
  consumeLocaleQueryParam,
  persistLocale,
  resolveInitialLocale,
  setActiveLocale,
  translate,
} from './index'
import type { Locale, TranslationKey } from './index'

export interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  /** Looks the key up in the active catalogue and fills in the `{name}` placeholders. */
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }): ReactElement {
  // The initialiser runs once: reading the query string, storage and the
  // browser languages on every render would be wasted work.
  const [locale, setLocale] = useState<Locale>(resolveInitialLocale)

  useEffect(() => {
    // `?lang=` has already been read by the initialiser above. Leaving it in the
    // address bar would make it win over every later choice from the selector,
    // so it is consumed once and removed.
    consumeLocaleQueryParam()
  }, [])

  useEffect(() => {
    // Modules that cannot use the hook (the API client, keycloak.ts, the date
    // formatters) read the locale from the i18n module, so keep it in sync.
    setActiveLocale(locale)
    persistLocale(locale)
    // Screen readers and the browser spell checker rely on this attribute.
    document.documentElement.lang = locale
  }, [locale])

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>): string =>
      translate(locale, key, params),
    [locale],
  )

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext)
  if (value === null) {
    throw new Error('useI18n() must be used inside <I18nProvider>.')
  }
  return value
}
