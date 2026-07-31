import { useAuth } from './auth/AuthProvider'
import { AppShell } from './components/AppShell'
import { LoginScreen } from './components/LoginScreen'

export default function App() {
  const { ready, authenticated } = useAuth()

  // Mientras keycloak-js hace la comprobacion silenciosa de sesion no sabemos
  // aun si hay que mostrar el login o la aplicacion.
  if (!ready) {
    return (
      <div className="splash">
        <span className="spinner" aria-hidden="true" />
        <p className="splash__text">Comprobando la sesion en Keycloak…</p>
      </div>
    )
  }

  return authenticated ? <AppShell /> : <LoginScreen />
}
