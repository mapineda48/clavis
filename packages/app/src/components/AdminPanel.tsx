import { useAuth } from '../auth/AuthProvider'
import { useAdminAudit, useAdminUsers } from '../api/admin'
import { describeApiError } from '../api/client'
import { useI18n } from '../i18n/I18nProvider'
import { formatDateTime } from '../lib/types'

const AUDIT_LIMIT = 25

export function AdminPanel() {
  const { has } = useAuth()
  const { locale, t } = useI18n()
  const canManage = has('admin:manage')
  const canReadUsers = has('users:read')

  const usersQuery = useAdminUsers(canReadUsers)
  const auditQuery = useAdminAudit(AUDIT_LIMIT, canManage)

  const emptyValue = t('common.emptyValue')

  return (
    <div className="admin">
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
        {!canManage && <p className="notice notice--warn">{t('admin.missingAdminManage')}</p>}
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
