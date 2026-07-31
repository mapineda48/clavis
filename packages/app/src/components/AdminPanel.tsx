import { useAuth } from '../auth/AuthProvider'
import { useAdminAudit, useAdminStats, useAdminUsers } from '../api/admin'
import type { AdminStats, CountEntry } from '../api/admin'
import { describeApiError } from '../api/client'
import { formatDateTime } from '../lib/types'

const AUDIT_LIMIT = 25

function CountTable({ title, entries }: { title: string; entries: CountEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="stat-block">
        <h3 className="stat-block__title">{title}</h3>
        <p className="muted">Sin datos.</p>
      </div>
    )
  }
  const max = entries.reduce((acc, entry) => Math.max(acc, entry.count), 0)
  return (
    <div className="stat-block">
      <h3 className="stat-block__title">{title}</h3>
      <ul className="bars">
        {entries.map((entry) => (
          <li key={entry.key} className="bars__row">
            <span className="bars__label">{entry.label}</span>
            <span className="bars__track">
              <span
                className="bars__fill"
                style={{ width: `${max === 0 ? 0 : Math.round((entry.count / max) * 100)}%` }}
              />
            </span>
            <span className="bars__value">{entry.count}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StatsSection({ stats }: { stats: AdminStats }) {
  return (
    <>
      <div className="stat-grid">
        {stats.totals.map((entry) => (
          <article key={entry.key} className="stat">
            <p className="stat__value">{entry.count}</p>
            <p className="stat__label">{entry.label}</p>
          </article>
        ))}
      </div>
      <div className="stat-columns">
        <CountTable title="Por estado" entries={stats.byStatus} />
        <CountTable title="Por prioridad" entries={stats.byPriority} />
      </div>
    </>
  )
}

export function AdminPanel() {
  const { has } = useAuth()
  const canManage = has('admin:manage')
  const canReadUsers = has('users:read')

  const statsQuery = useAdminStats(canManage)
  const usersQuery = useAdminUsers(canReadUsers)
  const auditQuery = useAdminAudit(AUDIT_LIMIT, canManage)

  return (
    <div className="admin">
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Estadisticas</h2>
          <span className="muted">requiere admin:manage</span>
        </div>
        {!canManage && (
          <p className="notice notice--warn">
            Tu token no incluye <code>admin:manage</code>.
          </p>
        )}
        {statsQuery.isPending && canManage && <p className="muted">Cargando estadisticas…</p>}
        {statsQuery.isError && <p className="notice notice--error">{describeApiError(statsQuery.error)}</p>}
        {statsQuery.data !== undefined && <StatsSection stats={statsQuery.data} />}
      </section>

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Usuarios</h2>
          <span className="muted">requiere users:read</span>
        </div>
        {!canReadUsers && (
          <p className="notice notice--warn">
            Tu token no incluye <code>users:read</code>.
          </p>
        )}
        {usersQuery.isPending && canReadUsers && <p className="muted">Cargando usuarios…</p>}
        {usersQuery.isError && <p className="notice notice--error">{describeApiError(usersQuery.error)}</p>}
        {usersQuery.data !== undefined && usersQuery.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Usuario</th>
                  <th scope="col">Nombre</th>
                  <th scope="col">Correo</th>
                  <th scope="col">Alta</th>
                  <th scope="col">Ultimo acceso</th>
                </tr>
              </thead>
              <tbody>
                {usersQuery.data.map((user) => (
                  <tr key={user.id}>
                    <th scope="row">
                      <code>{user.username}</code>
                    </th>
                    <td>{user.displayName ?? '—'}</td>
                    <td>{user.email ?? '—'}</td>
                    <td>{formatDateTime(user.createdAt)}</td>
                    <td>{formatDateTime(user.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {usersQuery.data !== undefined && usersQuery.data.length === 0 && (
          <p className="muted">Todavia no hay usuarios aprovisionados.</p>
        )}
      </section>

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Auditoria</h2>
          <span className="muted">ultimos {AUDIT_LIMIT} eventos · requiere admin:manage</span>
        </div>
        {auditQuery.isPending && canManage && <p className="muted">Cargando auditoria…</p>}
        {auditQuery.isError && <p className="notice notice--error">{describeApiError(auditQuery.error)}</p>}
        {auditQuery.data !== undefined && auditQuery.data.length > 0 && (
          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Accion</th>
                  <th scope="col">Entidad</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {auditQuery.data.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDateTime(entry.createdAt)}</td>
                    <td>
                      <span className="chip">{entry.action}</span>
                    </td>
                    <td>
                      {entry.entity}
                      {entry.entityId !== null && (
                        <span className="muted"> {entry.entityId.slice(0, 8)}…</span>
                      )}
                    </td>
                    <td>{entry.actorUsername ?? entry.actorId ?? '—'}</td>
                    <td>
                      <code className="payload">{summarizePayload(entry.payload)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {auditQuery.data !== undefined && auditQuery.data.length === 0 && (
          <p className="muted">Sin eventos registrados.</p>
        )}
      </section>
    </div>
  )
}

/** Resume el `payload` jsonb para que quepa en una celda. */
function summarizePayload(payload: unknown): string {
  if (payload === null || payload === undefined) return '—'
  let text: string
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  } catch {
    return '—'
  }
  if (text.length <= 90) return text
  return `${text.slice(0, 90)}…`
}
