import { useAuth } from '../auth/AuthProvider'
import { isLocale, LOCALE_LABELS, LOCALES } from '../i18n'
import { useI18n } from '../i18n/I18nProvider'

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
      </section>
    </div>
  )
}
