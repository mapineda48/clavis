import { useAuth } from '../auth/AuthProvider'
import { useAdminAudit, useAdminStats, useAdminUsers } from '../api/admin'
import type { AdminStats, CountEntry } from '../api/admin'
import { describeApiError } from '../api/client'
import { useI18n } from '../i18n/I18nProvider'
import { formatDateTime } from '../lib/types'

const AUDIT_LIMIT = 25

function CountTable({ title, entries }: { title: string; entries: CountEntry[] }) {
  const { t } = useI18n()

  if (entries.length === 0) {
    return (
      <div className="stat-block">
        <h3 className="stat-block__title">{title}</h3>
        <p className="muted">{t('admin.noData')}</p>
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
  const { t } = useI18n()

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
        <CountTable title={t('admin.byStatus')} entries={stats.byStatus} />
        <CountTable title={t('admin.byPriority')} entries={stats.byPriority} />
      </div>
    </>
  )
}

export function AdminPanel() {
  const { has } = useAuth()
  const { locale, t } = useI18n()
  const canManage = has('admin:manage')
  const canReadUsers = has('users:read')

  const statsQuery = useAdminStats(canManage)
  const usersQuery = useAdminUsers(canReadUsers)
  const auditQuery = useAdminAudit(AUDIT_LIMIT, canManage)

  const emptyValue = t('common.emptyValue')

  return (
    <div className="admin">
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">{t('admin.statsTitle')}</h2>
          <span className="muted">{t('admin.requiresAdminManage')}</span>
        </div>
        {!canManage && <p className="notice notice--warn">{t('admin.missingAdminManage')}</p>}
        {statsQuery.isPending && canManage && <p className="muted">{t('admin.statsLoading')}</p>}
        {statsQuery.isError && <p className="notice notice--error">{describeApiError(statsQuery.error)}</p>}
        {statsQuery.data !== undefined && <StatsSection stats={statsQuery.data} />}
      </section>

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">{t('admin.usersTitle')}</h2>
          <span className="muted">{t('admin.requiresUsersRead')}</span>
        </div>
        {!canReadUsers && <p className="notice notice--warn">{t('admin.missingUsersRead')}</p>}
        {usersQuery.isPending && canReadUsers && <p className="muted">{t('admin.usersLoading')}</p>}
        {usersQuery.isError && <p className="notice notice--error">{describeApiError(usersQuery.error)}</p>}
        {usersQuery.data !== undefined && usersQuery.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.userColumnUsername')}</th>
                  <th scope="col">{t('admin.userColumnName')}</th>
                  <th scope="col">{t('admin.userColumnEmail')}</th>
                  <th scope="col">{t('admin.userColumnCreated')}</th>
                  <th scope="col">{t('admin.userColumnLastSeen')}</th>
                </tr>
              </thead>
              <tbody>
                {usersQuery.data.map((user) => (
                  <tr key={user.id}>
                    <th scope="row">
                      <code>{user.username}</code>
                    </th>
                    <td>{user.displayName ?? emptyValue}</td>
                    <td>{user.email ?? emptyValue}</td>
                    <td>{formatDateTime(user.createdAt, locale)}</td>
                    <td>{formatDateTime(user.lastSeenAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {usersQuery.data !== undefined && usersQuery.data.length === 0 && (
          <p className="muted">{t('admin.usersEmpty')}</p>
        )}
      </section>

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">{t('admin.auditTitle')}</h2>
          <span className="muted">{t('admin.auditSubtitle', { limit: AUDIT_LIMIT })}</span>
        </div>
        {auditQuery.isPending && canManage && <p className="muted">{t('admin.auditLoading')}</p>}
        {auditQuery.isError && <p className="notice notice--error">{describeApiError(auditQuery.error)}</p>}
        {auditQuery.data !== undefined && auditQuery.data.length > 0 && (
          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th scope="col">{t('admin.auditColumnDate')}</th>
                  <th scope="col">{t('admin.auditColumnAction')}</th>
                  <th scope="col">{t('admin.auditColumnEntity')}</th>
                  <th scope="col">{t('admin.auditColumnActor')}</th>
                  <th scope="col">{t('admin.auditColumnDetail')}</th>
                </tr>
              </thead>
              <tbody>
                {auditQuery.data.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDateTime(entry.createdAt, locale)}</td>
                    <td>
                      <span className="chip">{entry.action}</span>
                    </td>
                    <td>
                      {entry.entity}
                      {entry.entityId !== null && (
                        <span className="muted"> {entry.entityId.slice(0, 8)}…</span>
                      )}
                    </td>
                    <td>{entry.actorUsername ?? entry.actorId ?? emptyValue}</td>
                    <td>
                      <code className="payload">{summarizePayload(entry.payload, emptyValue)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {auditQuery.data !== undefined && auditQuery.data.length === 0 && (
          <p className="muted">{t('admin.auditEmpty')}</p>
        )}
      </section>
    </div>
  )
}

/** Summarises the jsonb `payload` so it fits in a table cell. */
function summarizePayload(payload: unknown, empty: string): string {
  if (payload === null || payload === undefined) return empty
  let text: string
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  } catch {
    return empty
  }
  if (text.length <= 90) return text
  return `${text.slice(0, 90)}…`
}
