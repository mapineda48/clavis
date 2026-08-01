import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Can } from '../auth/Can'
import { AdminPanel } from './AdminPanel'
import { TodoBoard } from './TodoBoard'
import { isLocale, LOCALE_LABELS, LOCALES } from '../i18n'
import { useI18n } from '../i18n/I18nProvider'
import {
  initialsOf,
  PERMISSION_LABEL_KEYS,
  REALM_ROLE_LABEL_KEYS,
  visibleRealmRoles,
} from '../lib/types'

type TabId = 'board' | 'admin'

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
  const { profile, realmRoles, permissions, logout, has } = useAuth()
  const { t } = useI18n()
  const [tab, setTab] = useState<TabId>('board')

  const canAdmin = has('admin:manage')
  // If the user loses the permission (token refresh) we fall back to the board.
  const activeTab: TabId = tab === 'admin' && !canAdmin ? 'board' : tab

  const displayName = profile?.displayName ?? t('auth.defaultDisplayName')
  const roles = visibleRealmRoles(realmRoles)

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
              <span className="user-meta__mail">{profile?.email ?? profile?.username ?? ''}</span>
            </span>
            <ul className="chips" aria-label={t('nav.realmRolesLabel')}>
              {roles.map((role) => {
                const labelKey = REALM_ROLE_LABEL_KEYS[role]
                return (
                  <li key={role}>
                    <span
                      className="chip chip--role"
                      title={labelKey === undefined ? role : t(labelKey)}
                    >
                      {role}
                    </span>
                  </li>
                )
              })}
            </ul>
            <LanguagePicker />
            <button type="button" className="btn btn--ghost" onClick={logout}>
              {t('auth.signOut')}
            </button>
          </div>
        </div>

        <nav className="tabs" aria-label={t('nav.sectionsLabel')}>
          <button
            type="button"
            className={`tab${activeTab === 'board' ? ' tab--active' : ''}`}
            aria-current={activeTab === 'board' ? 'page' : undefined}
            onClick={() => {
              setTab('board')
            }}
          >
            {t('nav.board')}
          </button>
          <Can perm="admin:manage">
            <button
              type="button"
              className={`tab${activeTab === 'admin' ? ' tab--active' : ''}`}
              aria-current={activeTab === 'admin' ? 'page' : undefined}
              onClick={() => {
                setTab('admin')
              }}
            >
              {t('nav.admin')}
            </button>
          </Can>
        </nav>
      </header>

      <main className="shell__main">{activeTab === 'admin' ? <AdminPanel /> : <TodoBoard />}</main>

      <footer className="shell__footer">
        <span className="muted">{t('auth.tokenPermissions')}</span>
        <ul className="chips">
          {permissions.length === 0 ? (
            <li>
              <span className="chip chip--warn">{t('auth.tokenPermissionsEmpty')}</span>
            </li>
          ) : (
            permissions.map((perm) => (
              <li key={perm}>
                <span className="chip" title={t(PERMISSION_LABEL_KEYS[perm])}>
                  {perm}
                </span>
              </li>
            ))
          )}
        </ul>
      </footer>
    </div>
  )
}
