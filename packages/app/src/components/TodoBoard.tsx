import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Can } from '../auth/Can'
import { useSeedDemo, useTodos } from '../api/todos'
import type { CacheStatus } from '../api/client'
import type { ScopeFilter, StatusFilter, TodoListParams } from '../api/todos'
import { describeApiError } from '../api/client'
import { STATUS_LABELS, TODO_STATUSES, isTodoStatus } from '../lib/types'
import { TodoCard } from './TodoCard'
import { TodoForm } from './TodoForm'
import { useToast } from './Toast'

const PAGE_SIZES = [5, 10, 20, 50] as const

function parseStatusFilter(value: string): StatusFilter {
  return isTodoStatus(value) ? value : 'all'
}

function parseScope(value: string): ScopeFilter {
  return value === 'all' ? 'all' : 'mine'
}

function parsePageSize(value: string): number {
  const parsed = Number(value)
  return PAGE_SIZES.some((size) => size === parsed) ? parsed : 10
}

/** Insignia que hace visible si la respuesta vino de la cache de Valkey. */
function CacheBadge({ status }: { status: CacheStatus }) {
  if (status === null) {
    return (
      <span
        className="cache-badge cache-badge--unknown"
        title="La API no ha expuesto la cabecera X-Cache (revisa `exposedHeaders` en CORS)."
      >
        X-Cache: n/d
      </span>
    )
  }
  const isHit = status === 'HIT'
  return (
    <span
      className={`cache-badge ${isHit ? 'cache-badge--hit' : 'cache-badge--miss'}`}
      title={
        isHit
          ? 'La respuesta se ha servido desde Valkey sin tocar PostgreSQL.'
          : 'La respuesta se ha calculado en PostgreSQL y se ha guardado en Valkey.'
      }
    >
      X-Cache: {status}
    </span>
  )
}

export function TodoBoard() {
  const { has } = useAuth()
  const toast = useToast()

  const canRead = has('todos:read')
  const canReadAll = has('todos:read:all')

  const [status, setStatus] = useState<StatusFilter>('all')
  const [scope, setScope] = useState<ScopeFilter>('mine')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  // Antirrebote del buscador: evita una peticion por pulsacion.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQ(search.trim())
      setPage(1)
    }, 350)
    return () => {
      window.clearTimeout(timer)
    }
  }, [search])

  const params: TodoListParams = {
    status,
    q,
    scope: canReadAll ? scope : 'mine',
    page,
    pageSize,
  }

  const todosQuery = useTodos(params, canRead)
  const seedDemo = useSeedDemo()

  const result = todosQuery.data
  const items = result?.items ?? []
  const total = result?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const runSeed = () => {
    seedDemo.mutate(undefined, {
      onSuccess: (created) => {
        toast.success(
          created > 0
            ? `Se han creado ${String(created)} tareas de ejemplo.`
            : 'Ya tenias tareas: no se ha creado ninguna nueva.',
        )
      },
      onError: (error) => {
        toast.error(error)
      },
    })
  }

  if (!canRead) {
    return (
      <section className="panel">
        <h2 className="panel__title">Tablero</h2>
        <p className="notice notice--warn">
          Tu token no incluye el permiso <code>todos:read</code>, asi que la API rechazaria
          cualquier consulta con un <code>403</code>.
        </p>
      </section>
    )
  }

  return (
    <div className="board">
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Tablero de tareas</h2>
          <div className="panel__tools">
            <CacheBadge status={result?.cache ?? null} />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                void todosQuery.refetch()
              }}
              disabled={todosQuery.isFetching}
            >
              {todosQuery.isFetching ? 'Actualizando…' : 'Actualizar'}
            </button>
          </div>
        </div>

        <div className="filters">
          <label className="field">
            <span className="field__label">Buscar</span>
            <input
              type="search"
              className="input"
              placeholder="Titulo o descripcion"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
              }}
            />
          </label>

          <label className="field">
            <span className="field__label">Estado</span>
            <select
              className="input"
              value={status}
              onChange={(event) => {
                setStatus(parseStatusFilter(event.target.value))
                setPage(1)
              }}
            >
              <option value="all">Todos</option>
              {TODO_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Alcance</span>
            <select
              className="input"
              value={canReadAll ? scope : 'mine'}
              disabled={!canReadAll}
              title={
                canReadAll
                  ? 'Con todos:read:all puedes ver las tareas de todo el equipo.'
                  : 'Necesitas el permiso todos:read:all para ver las tareas del equipo.'
              }
              onChange={(event) => {
                setScope(parseScope(event.target.value))
                setPage(1)
              }}
            >
              <option value="mine">Mis tareas</option>
              <option value="all">Todo el equipo</option>
            </select>
          </label>

          <label className="field field--narrow">
            <span className="field__label">Por pagina</span>
            <select
              className="input"
              value={String(pageSize)}
              onChange={(event) => {
                setPageSize(parsePageSize(event.target.value))
                setPage(1)
              }}
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!canReadAll && (
          <p className="hint">
            Solo ves las tareas donde eres propietario o asignado. El alcance «Todo el equipo»
            requiere <code>todos:read:all</code>.
          </p>
        )}
      </section>

      <Can
        perm="todos:write"
        fallback={
          <p className="notice notice--info">
            Sin el permiso <code>todos:write</code> el formulario de creacion no se muestra.
          </p>
        }
      >
        <TodoForm />
      </Can>

      {todosQuery.isError && (
        <p className="notice notice--error">{describeApiError(todosQuery.error)}</p>
      )}

      {todosQuery.isPending && <p className="notice">Cargando tareas…</p>}

      {!todosQuery.isPending && items.length === 0 && !todosQuery.isError && (
        <section className="empty">
          <h3 className="empty__title">Aqui no hay nada todavia</h3>
          <p className="empty__text">
            Crea tu primera tarea o genera un juego de datos de ejemplo para probar filtros,
            adjuntos y notificaciones.
          </p>
          <Can perm="todos:write">
            <button
              type="button"
              className="btn btn--primary"
              onClick={runSeed}
              disabled={seedDemo.isPending}
            >
              {seedDemo.isPending ? 'Creando…' : 'Crear datos de ejemplo'}
            </button>
          </Can>
        </section>
      )}

      {items.length > 0 && (
        <>
          <ul className="todo-list">
            {items.map((todo) => (
              <li key={todo.id}>
                <TodoCard todo={todo} />
              </li>
            ))}
          </ul>

          <nav className="pagination" aria-label="Paginacion">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={page <= 1}
              onClick={() => {
                setPage((current) => Math.max(1, current - 1))
              }}
            >
              Anterior
            </button>
            <span className="pagination__info">
              Pagina {page} de {totalPages} · {total} tarea{total === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={page >= totalPages}
              onClick={() => {
                setPage((current) => current + 1)
              }}
            >
              Siguiente
            </button>
          </nav>
        </>
      )}
    </div>
  )
}
