import { useAuth } from '../auth/AuthProvider'
import { config } from '../config'
import { PERMISSIONS, PERMISSION_LABELS, REALM_ROLE_LABELS } from '../lib/types'
import type { Permission } from '../lib/types'

interface DemoUser {
  username: string
  role: string
  permissions: Permission[]
}

/**
 * Usuarios que crea el realm importado. Las contrasenas NO se escriben aqui:
 * viven en las variables DEMO_*_PASSWORD del `.env` de la raiz.
 */
const DEMO_USERS: DemoUser[] = [
  { username: 'admin', role: 'erp-admin', permissions: [...PERMISSIONS] },
  {
    username: 'manager',
    role: 'erp-manager',
    permissions: ['todos:read', 'todos:read:all', 'todos:write', 'todos:delete', 'users:read'],
  },
  { username: 'worker', role: 'erp-user', permissions: ['todos:read', 'todos:write'] },
]

export function LoginScreen() {
  const { login } = useAuth()

  return (
    <div className="login">
      <section className="login__card">
        <header className="login__header">
          <span className="brand__mark" aria-hidden="true">
            ERP
          </span>
          <h1 className="login__title">ERP Demo</h1>
          <p className="login__lead">
            Aplicacion de ejemplo para ver, paso a paso, como Keycloak resuelve la autenticacion y
            como los <strong>client roles</strong> se convierten en permisos dentro del token.
          </p>
        </header>

        <button type="button" className="btn btn--primary btn--block" onClick={login}>
          Iniciar sesion con Keycloak
        </button>

        <div className="login__hint">
          <p>
            Realm <code>{config.keycloakRealm}</code> en <code>{config.keycloakUrl}</code>
          </p>
          <p>
            Las contrasenas de los usuarios de demostracion estan en las variables{' '}
            <code>DEMO_*_PASSWORD</code> del archivo <code>.env</code> de la raiz del repositorio.
          </p>
        </div>

        <div className="table-wrap">
          <table className="table">
            <caption className="table__caption">Usuarios de demostracion</caption>
            <thead>
              <tr>
                <th scope="col">Usuario</th>
                <th scope="col">Rol de realm</th>
                <th scope="col">Permisos en la API</th>
              </tr>
            </thead>
            <tbody>
              {DEMO_USERS.map((user) => (
                <tr key={user.username}>
                  <th scope="row">
                    <code>{user.username}</code>
                  </th>
                  <td>
                    <span className="chip chip--role">{user.role}</span>
                    <span className="muted"> {REALM_ROLE_LABELS[user.role] ?? ''}</span>
                  </td>
                  <td>
                    <ul className="chips">
                      {user.permissions.map((perm) => (
                        <li key={perm}>
                          <span className="chip" title={PERMISSION_LABELS[perm]}>
                            {perm}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="login__foot">
          Prueba a entrar con <code>worker</code> y observa como desaparecen las acciones que
          requieren permisos: la interfaz las oculta y, si aun asi se invocan, la API responde{' '}
          <code>403</code>.
        </p>
      </section>
    </div>
  )
}
