import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Can } from '../auth/Can'
import { AdminPanel } from './AdminPanel'
import { TodoBoard } from './TodoBoard'
import { initialsOf, PERMISSION_LABELS, REALM_ROLE_LABELS, visibleRealmRoles } from '../lib/types'

type TabId = 'board' | 'admin'

export function AppShell() {
  const { profile, realmRoles, permissions, logout, has } = useAuth()
  const [tab, setTab] = useState<TabId>('board')

  const canAdmin = has('admin:manage')
  // Si el usuario pierde el permiso (refresco de token) volvemos al tablero.
  const activeTab: TabId = tab === 'admin' && !canAdmin ? 'board' : tab

  const displayName = profile?.displayName ?? 'Usuario'
  const roles = visibleRealmRoles(realmRoles)

  return (
    <div className="shell">
      <header className="shell__header">
        <div className="shell__bar">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              ERP
            </span>
            <span className="brand__text">
              <span className="brand__name">ERP Demo</span>
              <span className="brand__sub">Keycloak · permisos en el token</span>
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
            <ul className="chips" aria-label="Roles de realm">
              {roles.map((role) => (
                <li key={role}>
                  <span className="chip chip--role" title={REALM_ROLE_LABELS[role] ?? role}>
                    {role}
                  </span>
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn--ghost" onClick={logout}>
              Cerrar sesion
            </button>
          </div>
        </div>

        <nav className="tabs" aria-label="Secciones">
          <button
            type="button"
            className={`tab${activeTab === 'board' ? ' tab--active' : ''}`}
            aria-current={activeTab === 'board' ? 'page' : undefined}
            onClick={() => {
              setTab('board')
            }}
          >
            Tablero
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
              Administracion
            </button>
          </Can>
        </nav>
      </header>

      <main className="shell__main">{activeTab === 'admin' ? <AdminPanel /> : <TodoBoard />}</main>

      <footer className="shell__footer">
        <span className="muted">Permisos del access token:</span>
        <ul className="chips">
          {permissions.length === 0 ? (
            <li>
              <span className="chip chip--warn">sin permisos</span>
            </li>
          ) : (
            permissions.map((perm) => (
              <li key={perm}>
                <span className="chip" title={PERMISSION_LABELS[perm]}>
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
