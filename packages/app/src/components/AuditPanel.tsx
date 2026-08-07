import { useAudit } from '../api/audit'
import { describeApiError } from '../api/client'
import { useI18n } from '../i18n/I18nProvider'
import { formatDateTime } from '../lib/types'

const AUDIT_LIMIT = 50

export function AuditPanel() {
  const { locale, t } = useI18n()
  const auditQuery = useAudit(AUDIT_LIMIT, true)
  const emptyValue = t('common.emptyValue')

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">{t('audit.title')}</h2>
        <span className="muted">{t('audit.subtitle', { limit: AUDIT_LIMIT })}</span>
      </div>
      {auditQuery.isPending && <p className="muted">{t('audit.loading')}</p>}
      {auditQuery.isError && (
        <p className="notice notice--error">{describeApiError(auditQuery.error)}</p>
      )}
      {auditQuery.data !== undefined && auditQuery.data.length > 0 && (
        <div className="table-wrap">
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col">{t('audit.columnDate')}</th>
                <th scope="col">{t('audit.columnAction')}</th>
                <th scope="col">{t('audit.columnEntity')}</th>
                <th scope="col">{t('audit.columnActor')}</th>
                <th scope="col">{t('audit.columnDetail')}</th>
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
        <p className="muted">{t('audit.empty')}</p>
      )}
    </section>
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
