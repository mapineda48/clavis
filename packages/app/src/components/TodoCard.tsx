import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Can } from '../auth/Can'
import { useDeleteTodo, useNotifyTodo, useUpdateTodo } from '../api/todos'
import type { Todo } from '../api/todos'
import { useI18n } from '../i18n/I18nProvider'
import {
  PRIORITY_LABEL_KEYS,
  STATUS_LABEL_KEYS,
  TODO_STATUSES,
  formatDate,
  formatDateTime,
  isTodoStatus,
} from '../lib/types'
import { AttachmentPanel } from './AttachmentPanel'
import { useToast } from './Toast'

export function TodoCard({ todo }: { todo: Todo }) {
  const { has } = useAuth()
  const toast = useToast()
  // The locale is passed to the formatters explicitly: a language change has to
  // re-render the dates in the same pass as the labels.
  const { locale, t } = useI18n()
  const [showAttachments, setShowAttachments] = useState(false)

  const updateTodo = useUpdateTodo()
  const deleteTodo = useDeleteTodo()
  const notifyTodo = useNotifyTodo()

  const canWrite = has('todos:write')
  const busy = updateTodo.isPending || deleteTodo.isPending

  const changeStatus = (value: string): void => {
    if (!isTodoStatus(value) || value === todo.status) return
    updateTodo.mutate(
      { id: todo.id, changes: { status: value } },
      {
        onSuccess: () => {
          toast.success(
            t('toast.todoStatusChanged', {
              title: todo.title,
              status: t(STATUS_LABEL_KEYS[value]).toLowerCase(),
            }),
          )
        },
        onError: (error) => {
          toast.error(error)
        },
      },
    )
  }

  const remove = (): void => {
    if (!window.confirm(t('todo.confirmDelete', { title: todo.title }))) {
      return
    }
    deleteTodo.mutate(todo.id, {
      onSuccess: () => {
        toast.success(t('toast.todoDeleted'))
      },
      onError: (error) => {
        toast.error(error)
      },
    })
  }

  const notify = (): void => {
    notifyTodo.mutate(
      { id: todo.id, to: null },
      {
        onSuccess: (result) => {
          if (!result.delivered) {
            toast.success(
              t('toast.mailNotDelivered', { reason: result.reason ?? result.provider }),
            )
            return
          }
          toast.success(
            result.to === null
              ? t('toast.mailSent', { provider: result.provider })
              : t('toast.mailSentTo', { to: result.to, provider: result.provider }),
          )
        },
        onError: (error) => {
          toast.error(error)
        },
      },
    )
  }

  return (
    <article className={`todo-card todo-card--${todo.status}`}>
      <header className="todo-card__head">
        <h3 className="todo-card__title">{todo.title}</h3>
        <div className="todo-card__badges">
          <span className={`badge badge--${todo.status}`}>{t(STATUS_LABEL_KEYS[todo.status])}</span>
          <span className={`badge badge--p${todo.priority}`}>
            {t('todo.priorityBadge', {
              priority: todo.priority,
              label: t(PRIORITY_LABEL_KEYS[todo.priority]),
            })}
          </span>
        </div>
      </header>

      {todo.description !== null && <p className="todo-card__desc">{todo.description}</p>}

      <dl className="todo-card__meta">
        <div>
          <dt>{t('todo.due')}</dt>
          <dd>{formatDate(todo.dueDate, locale)}</dd>
        </div>
        <div>
          <dt>{t('todo.created')}</dt>
          <dd>{formatDateTime(todo.createdAt, locale)}</dd>
        </div>
        <div>
          <dt>{t('todo.updated')}</dt>
          <dd>{formatDateTime(todo.updatedAt, locale)}</dd>
        </div>
        <div>
          <dt>{t('todo.owner')}</dt>
          <dd>
            {todo.ownerUsername ??
              (todo.ownerId === ''
                ? t('common.emptyValue')
                : `${todo.ownerId.slice(0, 8)}…`)}
          </dd>
        </div>
        {todo.completedAt !== null && (
          <div>
            <dt>{t('todo.completed')}</dt>
            <dd>{formatDateTime(todo.completedAt, locale)}</dd>
          </div>
        )}
      </dl>

      <footer className="todo-card__actions">
        <label className="field field--inline">
          <span className="field__label">{t('todo.fieldStatus')}</span>
          <select
            className="input input--sm"
            value={todo.status}
            disabled={!canWrite || busy}
            title={canWrite ? t('todo.changeStatusHint') : t('todo.changeStatusDenied')}
            onChange={(event) => {
              changeStatus(event.target.value)
            }}
          >
            {TODO_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(STATUS_LABEL_KEYS[value])}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-expanded={showAttachments}
          onClick={() => {
            setShowAttachments((current) => !current)
          }}
        >
          {showAttachments ? t('attachment.hide') : t('attachment.show')}
        </button>

        <Can perm="todos:write">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={notify}
            disabled={notifyTodo.isPending}
          >
            {notifyTodo.isPending ? t('todo.notifying') : t('todo.notify')}
          </button>
        </Can>

        <Can perm="todos:delete">
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={remove}
            disabled={deleteTodo.isPending}
          >
            {deleteTodo.isPending ? t('common.deleting') : t('common.delete')}
          </button>
        </Can>
      </footer>

      {showAttachments && <AttachmentPanel todoId={todo.id} canWrite={canWrite} />}
    </article>
  )
}
