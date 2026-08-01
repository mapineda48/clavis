import { useAuth } from './auth/AuthProvider'
import { useI18n } from './i18n/I18nProvider'
import { AppShell } from './components/AppShell'
import { LoginScreen } from './components/LoginScreen'

export default function App() {
  const { ready, authenticated } = useAuth()
  const { t } = useI18n()

  // While keycloak-js runs the silent session check we still do not know
  // whether to show the login screen or the application itself.
  if (!ready) {
    return (
      <div className="splash">
        <span className="spinner" aria-hidden="true" />
        <p className="splash__text">{t('auth.checkingSession')}</p>
      </div>
    )
  }

  return authenticated ? <AppShell /> : <LoginScreen />
}
