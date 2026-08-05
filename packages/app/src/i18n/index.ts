// Hand-written internationalisation for the SPA.
//
// The app only needs two locales and a flat list of strings, so a plain object
// plus a placeholder replace does the job without adding i18next (and its
// runtime) to the bundle. It mirrors what the Keycloak theme does with its
// `messages_*.properties` files: same two languages, English as the reference.
//
// `en.ts` is the source of truth. `TranslationKey` is derived from it and
// `es.ts` is typed against that union, so an incomplete translation is a
// compile error instead of a blank label in production.

import { en } from './en'
import { es } from './es'

export type Locale = 'en' | 'es'

export const LOCALES: readonly Locale[] = ['en', 'es']

export const DEFAULT_LOCALE: Locale = 'en'

/** Each language names itself in its own language: that is what users scan for. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
}

/** Where the choice is remembered between visits. */
export const LOCALE_STORAGE_KEY = 'clavis.locale'

export type TranslationKey = keyof typeof en

const CATALOGS: Record<Locale, Record<TranslationKey, string>> = { en, es }

const LOCALE_SET: ReadonlySet<string> = new Set<string>(LOCALES)

export function isLocale(value: string): value is Locale {
  return LOCALE_SET.has(value)
}

/**
 * Accepts `es`, `es-ES`, `EN_us`… and keeps only the language subtag, which is
 * what both `navigator.language` and the `?lang=` parameter may carry.
 */
function toLocale(value: string | null | undefined): Locale | null {
  if (typeof value !== 'string') return null
  const tag = value.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return isLocale(tag) ? tag : null
}

/* ------------------------------------------------------------------ */
/* Translation                                                         */
/* ------------------------------------------------------------------ */

const PLACEHOLDER = /\{(\w+)\}/g

/** Replaces `{name}` with the matching parameter; unknown names are left alone. */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template
  return template.replace(PLACEHOLDER, (match: string, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** Keys already reported, so a missing string does not flood the console. */
const warnedKeys = new Set<string>()

export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  // The type says the lookup always hits, but a value cast at the edge of the
  // app could still get here: a missing string must never break a render.
  const template: string | undefined = CATALOGS[locale][key]
  if (template === undefined) {
    const marker = `${locale}:${key}`
    if (!warnedKeys.has(marker)) {
      warnedKeys.add(marker)
      console.warn(`[i18n] missing key "${key}" for locale "${locale}"`)
    }
    return key
  }
  return interpolate(template, params)
}

/* ------------------------------------------------------------------ */
/* Initial locale resolution                                           */
/* ------------------------------------------------------------------ */

/** Name of the query parameter Keycloak is redirected back with. */
const LOCALE_QUERY_PARAM = 'lang'

function fromQuery(): Locale | null {
  return toLocale(new URLSearchParams(window.location.search).get(LOCALE_QUERY_PARAM))
}

function fromStorage(): Locale | null {
  try {
    return toLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY))
  } catch {
    // Storage can be disabled (private browsing): fall through to the next step.
    return null
  }
}

function fromBrowser(): Locale | null {
  for (const tag of navigator.languages) {
    const locale = toLocale(tag)
    if (locale !== null) return locale
  }
  return toLocale(navigator.language)
}

/**
 * Order of preference: `?lang=` beats everything (it is how you share a link in
 * a given language), then the remembered choice, then what the browser asks for.
 */
export function resolveInitialLocale(): Locale {
  return fromQuery() ?? fromStorage() ?? fromBrowser() ?? DEFAULT_LOCALE
}

/**
 * Drops the `lang` parameter from the address bar once it has been read.
 *
 * Sign-in and sign-out send the user to `origin/?lang=<locale>` so the Keycloak
 * screens and the app agree on a language. If that parameter stayed in the URL
 * it would keep winning over `resolveInitialLocale()`, and the selector would
 * look broken: pick another language, reload, and the old one comes back.
 */
export function consumeLocaleQueryParam(): void {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has(LOCALE_QUERY_PARAM)) return
    url.searchParams.delete(LOCALE_QUERY_PARAM)
    const query = url.searchParams.toString()
    window.history.replaceState(null, '', `${url.pathname}${query ? `?${query}` : ''}${url.hash}`)
  } catch {
    // Some embedded webviews expose a read-only history: not worth breaking for.
  }
}

export function persistLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Not being able to remember the choice is not worth breaking the app for.
  }
}

/* ------------------------------------------------------------------ */
/* Active locale outside React                                         */
/* ------------------------------------------------------------------ */

// The API client, `keycloak.ts` and the date formatters are plain modules: they
// cannot use the hook, so `I18nProvider` mirrors the current locale here.

let activeLocale: Locale | null = null

export function getActiveLocale(): Locale {
  activeLocale ??= resolveInitialLocale()
  return activeLocale
}

export function setActiveLocale(locale: Locale): void {
  activeLocale = locale
}

/** `translate()` against the active locale, for code that lives outside React. */
export function translateActive(
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  return translate(getActiveLocale(), key, params)
}
