// HTTP layer of the audit module. No service in between: there is no rule to
// apply, so the route reads the repository directly — a pass-through layer
// would be ceremony, not separation.
import { errorResponses } from '../../http/openapi.js'
import type { ModuleDef } from '../../http/route.js'
import type { Db } from '../../infra/db.js'
import { listAuditEntries } from './repository.js'
import { AuditResponse, ListAuditQuery, type ListQueryInput, serializeAuditEntry } from './schemas.js'

export interface AuditModuleDeps {
  db: Db
}

export function auditModule(deps: AuditModuleDeps): ModuleDef {
  return {
    tag: { name: 'audit', description: 'Audit trail' },
    routes: [
      {
        method: 'get',
        path: '/audit',
        summary: 'Audit trail',
        description: 'Returns the latest entries recorded in clavis.audit_log, newest first.',
        permissions: ['audit:read'],
        schema: { query: ListAuditQuery },
        responses: {
          200: AuditResponse,
          ...errorResponses(401, 403),
        },
        handler: async (req, res) => {
          const query = req.query as ListQueryInput
          const rows = await listAuditEntries(deps.db, query.limit ?? 50)
          res.json({ items: rows.map(serializeAuditEntry) })
        },
      },
    ],
  }
}
