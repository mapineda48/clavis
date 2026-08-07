import { useEffect } from 'react'
import { RouterProvider } from '@tanstack/react-router'
import { useAuth } from './auth/AuthProvider'
import { LoginScreen } from './components/LoginScreen'
import { useI18n } from './i18n/I18nProvider'
import { describeApiError } from './api/client'
import { router } from './router'

function Splash({ text }: { text: string }) {
  return (
    <div className="splash">
      <span className="spinner" aria-hidden="true" />
      <p className="splash__text">{text}</p>
    </div>
  )
}

/**
 * Shown when Keycloak authenticated the identity but the API refused it:
 * a disabled account, or an identity with no application user behind it.
 */
function BlockedScreen({ retry }: { retry: boolean }) {
  const { meError, logout } = useAuth()
  const { t } = useI18n()

  return (
    <div className="splash">
      <p className="splash__text">
        {meError === null ? t('error.unexpected') : describeApiError(meError)}
      </p>
      {retry ? <p className="muted">{t('auth.blockedRetryHint')}</p> : null}
      <button type="button" className="btn" onClick={logout}>
        {t('auth.signOut')}
      </button>
    </div>
  )
}

export default function App() {
  const auth = useAuth()
  const { t } = useI18n()

  // Guards read permissions from the router context: when they change, the
  // current match must be re-evaluated (a revoked permission ejects the user).
  useEffect(() => {
    void router.invalidate()
  }, [auth.permissions, auth.isRoot])

  // While keycloak-js runs the silent session check we still do not know
  // whether to show the login screen or the application itself.
  if (!auth.ready) return <Splash text={t('auth.checkingSession')} />
  if (!auth.authenticated) return <LoginScreen />
  if (auth.meStatus === 'loading' || auth.meStatus === 'idle') {
    return <Splash text={t('auth.loadingProfile')} />
  }
  if (auth.meStatus === 'blocked') return <BlockedScreen retry={false} />
  if (auth.meStatus === 'error') return <BlockedScreen retry />

  return <RouterProvider router={router} context={{ auth }} />
}
