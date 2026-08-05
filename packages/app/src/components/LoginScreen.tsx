import { useAuth } from '../auth/AuthProvider'
import { config } from '../config'
import { isLocale, LOCALE_LABELS, LOCALES } from '../i18n'
import { useI18n } from '../i18n/I18nProvider'
import { PERMISSIONS, PERMISSION_LABEL_KEYS, REALM_ROLE_LABEL_KEYS } from '../lib/types'
import type { Permission } from '../lib/types'

interface DemoUser {
  username: string
  role: string
  permissions: Permission[]
}

/**
 * Users created by the imported realm. The passwords are NOT written here: they
 * live in the DEMO_*_PASSWORD variables of the `.env` at the root.
 */
const DEMO_USERS: DemoUser[] = [
  { username: 'admin', role: 'clavis-admin', permissions: [...PERMISSIONS] },
  {
    username: 'manager',
    role: 'clavis-manager',
    permissions: ['todos:read', 'todos:read:all', 'todos:write', 'todos:delete', 'users:read'],
  },
  { username: 'worker', role: 'clavis-user', permissions: ['todos:read', 'todos:write'] },
]

/**
 * Same control as the one in the shell, repeated here on purpose: the Keycloak
 * login theme offers the language before asking who you are, and this screen is
 * what the app shows in its place, so it has to offer it too. A native
 * `<select>` keeps it reachable with the keyboard and labelled for screen
 * readers with no extra markup.
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

export function LoginScreen() {
  const { login } = useAuth()
  const { t } = useI18n()

  return (
    <div className="login">
      <section className="login__card">
        {/* Title on the left, language on the right: the picker sits beside the
            heading instead of between the lead and the sign-in button. */}
        <div className="panel__head">
          <header className="login__header">
            <span className="brand__mark" aria-hidden="true">
              {t('common.brandMark')}
            </span>
            <h1 className="login__title">{t('common.appName')}</h1>
            <p className="login__lead">{t('auth.loginLead')}</p>
          </header>

          <div className="panel__tools">
            <LanguagePicker />
          </div>
        </div>

        <button type="button" className="btn btn--primary btn--block" onClick={login}>
          {t('auth.loginButton')}
        </button>

        <div className="login__hint">
          <p>{t('auth.realmHint', { realm: config.keycloakRealm, url: config.keycloakUrl })}</p>
          <p>{t('auth.demoPasswordHint')}</p>
        </div>

        <div className="table-wrap">
          <table className="table">
            <caption className="table__caption">{t('auth.demoUsersCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('auth.demoUserColumn')}</th>
                <th scope="col">{t('auth.demoRoleColumn')}</th>
                <th scope="col">{t('auth.demoPermissionsColumn')}</th>
              </tr>
            </thead>
            <tbody>
              {DEMO_USERS.map((user) => {
                const roleLabelKey = REALM_ROLE_LABEL_KEYS[user.role]
                return (
                  <tr key={user.username}>
                    <th scope="row">
                      <code>{user.username}</code>
                    </th>
                    <td>
                      <span className="chip chip--role">{user.role}</span>
                      <span className="muted">
                        {' '}
                        {roleLabelKey === undefined ? '' : t(roleLabelKey)}
                      </span>
                    </td>
                    <td>
                      <ul className="chips">
                        {user.permissions.map((perm) => (
                          <li key={perm}>
                            <span className="chip" title={t(PERMISSION_LABEL_KEYS[perm])}>
                              {perm}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <p className="login__foot">{t('auth.demoFooter')}</p>
      </section>
    </div>
  )
}
