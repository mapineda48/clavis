import { Link, Outlet } from '@tanstack/react-router'
import { useAuth } from '../auth/AuthProvider'
import { isLocale, LOCALE_LABELS, LOCALES } from '../i18n'
import { useI18n } from '../i18n/I18nProvider'
import { initialsOf } from '../lib/types'
import { NAV_ITEMS } from '../router'

/**
 * Language picker. A native `<select>` is deliberate: it is reachable with the
 * keyboard, announces itself to screen readers and already gets the focus ring
 * of `.input` for free, with no extra markup or state to maintain.
 */
function LanguagePicker() {
  const { locale, setLocale, t } = useI18n()

  return (
    <label className="field field--inline">
      <span className="field__label">{t('common.language')}</span>
      <select
        className="input input--sm"
        value={locale}
        onChange={(event) => {
          const value = event.target.value
          if (isLocale(value)) setLocale(value)
        }}
      >
        {LOCALES.map((code) => (
          <option key={code} value={code}>
            {LOCALE_LABELS[code]}
          </option>
        ))}
      </select>
    </label>
  )
}

export function AppShell() {
  const { me, roles, isRoot, logout, has } = useAuth()
  const { t } = useI18n()

  const displayName = me?.user.displayName ?? me?.user.username ?? t('auth.defaultDisplayName')

  return (
    <div className="shell">
      <header className="shell__header">
        <div className="shell__bar">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              {t('common.brandMark')}
            </span>
            <span className="brand__text">
              <span className="brand__name">{t('common.appName')}</span>
              <span className="brand__sub">{t('common.brandTagline')}</span>
            </span>
          </div>

          <div className="shell__user">
            <span className="avatar" aria-hidden="true">
              {initialsOf(displayName)}
            </span>
            <span className="user-meta">
              <span className="user-meta__name">{displayName}</span>
              <span className="user-meta__mail">{me?.user.email ?? me?.user.username ?? ''}</span>
            </span>
            <ul className="chips" aria-label={t('nav.rolesLabel')}>
              {isRoot ? (
                <li>
                  <span className="chip chip--role" title={t('auth.rootChipTitle')}>
                    root
                  </span>
                </li>
              ) : null}
              {roles.map((role) => (
                <li key={role}>
                  <span className="chip chip--role">{role}</span>
                </li>
              ))}
            </ul>
            <LanguagePicker />
            <button type="button" className="btn btn--ghost" onClick={logout}>
              {t('auth.signOut')}
            </button>
          </div>
        </div>

        <nav className="tabs" aria-label={t('nav.sectionsLabel')}>
          {NAV_ITEMS.filter((item) => item.required === null || has(item.required)).map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="tab"
              activeProps={{ className: 'tab tab--active', 'aria-current': 'page' }}
              activeOptions={{ exact: item.to === '/' }}
            >
              {t(item.labelKey)}
            </Link>
          ))}
        </nav>
      </header>

      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  )
}
