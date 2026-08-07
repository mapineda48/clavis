import { useAuth } from '../auth/AuthProvider'
import { useI18n } from '../i18n/I18nProvider'

/** Landing view: who you are and what the database lets you do. */
export function HomeView() {
  const { me, roles, permissions, isRoot } = useAuth()
  const { t } = useI18n()

  return (
    <section className="panel">
      <h2 className="panel__title">{t('home.title')}</h2>
      <p className="muted">{t('home.lead')}</p>

      <dl className="facts">
        <div className="facts__item">
          <dt>{t('home.factUser')}</dt>
          <dd>
            <code>{me?.user.username}</code>
          </dd>
        </div>
        <div className="facts__item">
          <dt>{t('home.factRoles')}</dt>
          <dd>
            {isRoot ? <span className="chip chip--role">root</span> : null}
            {roles.length === 0 && !isRoot ? (
              <span className="muted">{t('common.emptyValue')}</span>
            ) : (
              roles.map((role) => (
                <span key={role} className="chip chip--role">
                  {role}
                </span>
              ))
            )}
          </dd>
        </div>
        <div className="facts__item">
          <dt>{t('home.factPermissions')}</dt>
          <dd>
            {isRoot ? (
              <span className="muted">{t('home.rootAllPermissions')}</span>
            ) : permissions.length === 0 ? (
              <span className="muted">{t('home.noPermissions')}</span>
            ) : (
              permissions.map((permission) => (
                <span key={permission} className="chip">
                  {permission}
                </span>
              ))
            )}
          </dd>
        </div>
      </dl>
    </section>
  )
}
