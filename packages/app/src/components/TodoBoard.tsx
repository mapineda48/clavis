import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Can } from '../auth/Can'
import { useSeedDemo, useTodos } from '../api/todos'
import type { CacheStatus } from '../api/client'
import type { ScopeFilter, StatusFilter, TodoListParams } from '../api/todos'
import { describeApiError } from '../api/client'
import { useI18n } from '../i18n/I18nProvider'
import { STATUS_LABEL_KEYS, TODO_STATUSES, isTodoStatus } from '../lib/types'
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

/** Badge that makes it visible whether the response came from the Valkey cache. */
function CacheBadge({ status }: { status: CacheStatus }) {
  const { t } = useI18n()

  if (status === null) {
    return (
      <span className="cache-badge cache-badge--unknown" title={t('todo.cacheUnknownTitle')}>
        {t('todo.cacheLabel', { status: t('common.notAvailable') })}
      </span>
    )
  }
  const isHit = status === 'HIT'
  return (
    <span
      className={`cache-badge ${isHit ? 'cache-badge--hit' : 'cache-badge--miss'}`}
      title={isHit ? t('todo.cacheHitTitle') : t('todo.cacheMissTitle')}
    >
      {t('todo.cacheLabel', { status })}
    </span>
  )
}

export function TodoBoard() {
  const { has } = useAuth()
  const toast = useToast()
  const { t } = useI18n()

  const canRead = has('todos:read')
  const canReadAll = has('todos:read:all')

  const [status, setStatus] = useState<StatusFilter>('all')
  const [scope, setScope] = useState<ScopeFilter>('mine')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  // Debounce for the search box: avoids one request per keystroke.
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
          created > 0 ? t('toast.seedCreated', { count: created }) : t('toast.seedSkipped'),
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
        <h2 className="panel__title">{t('nav.board')}</h2>
        <p className="notice notice--warn">{t('todo.readForbidden')}</p>
      </section>
    )
  }

  return (
    <div className="board">
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">{t('todo.boardTitle')}</h2>
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
              {todosQuery.isFetching ? t('common.refreshing') : t('common.refresh')}
            </button>
          </div>
        </div>

        <div className="filters">
          <label className="field">
            <span className="field__label">{t('todo.filterSearch')}</span>
            <input
              type="search"
              className="input"
              placeholder={t('todo.filterSearchPlaceholder')}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
              }}
            />
          </label>

          <label className="field">
            <span className="field__label">{t('todo.fieldStatus')}</span>
            <select
              className="input"
              value={status}
              onChange={(event) => {
                setStatus(parseStatusFilter(event.target.value))
                setPage(1)
              }}
            >
              <option value="all">{t('todo.filterStatusAll')}</option>
              {TODO_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(STATUS_LABEL_KEYS[value])}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">{t('todo.filterScope')}</span>
            <select
              className="input"
              value={canReadAll ? scope : 'mine'}
              disabled={!canReadAll}
              title={canReadAll ? t('todo.scopeAllHint') : t('todo.scopeDeniedHint')}
              onChange={(event) => {
                setScope(parseScope(event.target.value))
                setPage(1)
              }}
            >
              <option value="mine">{t('todo.scopeMine')}</option>
              <option value="all">{t('todo.scopeAll')}</option>
            </select>
          </label>

          <label className="field field--narrow">
            <span className="field__label">{t('todo.filterPageSize')}</span>
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

        {!canReadAll && <p className="hint">{t('todo.scopeNotice')}</p>}
      </section>

      <Can
        perm="todos:write"
        fallback={<p className="notice notice--info">{t('todo.writeForbidden')}</p>}
      >
        <TodoForm />
      </Can>

      {todosQuery.isError && (
        <p className="notice notice--error">{describeApiError(todosQuery.error)}</p>
      )}

      {todosQuery.isPending && <p className="notice">{t('todo.loading')}</p>}

      {!todosQuery.isPending && items.length === 0 && !todosQuery.isError && (
        <section className="empty">
          <h3 className="empty__title">{t('todo.emptyTitle')}</h3>
          <p className="empty__text">{t('todo.emptyText')}</p>
          <Can perm="todos:write">
            <button
              type="button"
              className="btn btn--primary"
              onClick={runSeed}
              disabled={seedDemo.isPending}
            >
              {seedDemo.isPending ? t('common.creating') : t('todo.seedButton')}
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

          <nav className="pagination" aria-label={t('nav.paginationLabel')}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={page <= 1}
              onClick={() => {
                setPage((current) => Math.max(1, current - 1))
              }}
            >
              {t('common.previous')}
            </button>
            <span className="pagination__info">
              {t(total === 1 ? 'todo.paginationInfoOne' : 'todo.paginationInfo', {
                page,
                pages: totalPages,
                total,
              })}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={page >= totalPages}
              onClick={() => {
                setPage((current) => current + 1)
              }}
            >
              {t('common.next')}
            </button>
          </nav>
        </>
      )}
    </div>
  )
}
