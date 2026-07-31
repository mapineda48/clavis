import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Can } from '../auth/Can'
import { useDeleteTodo, useNotifyTodo, useUpdateTodo } from '../api/todos'
import type { Todo } from '../api/todos'
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
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
          toast.success(`«${todo.title}» pasa a ${STATUS_LABELS[value].toLowerCase()}.`)
        },
        onError: (error) => {
          toast.error(error)
        },
      },
    )
  }

  const remove = (): void => {
    if (!window.confirm(`¿Borrar la tarea «${todo.title}»? Esta accion no se puede deshacer.`)) {
      return
    }
    deleteTodo.mutate(todo.id, {
      onSuccess: () => {
        toast.success('Tarea borrada.')
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
          const destino = result.to === null ? '' : ` a ${result.to}`
          toast.success(
            result.delivered
              ? `Correo enviado${destino} mediante ${result.provider}.`
              : `Correo no entregado (${result.reason ?? result.provider}).`,
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
          <span className={`badge badge--${todo.status}`}>{STATUS_LABELS[todo.status]}</span>
          <span className={`badge badge--p${todo.priority}`}>
            P{todo.priority} · {PRIORITY_LABELS[todo.priority]}
          </span>
        </div>
      </header>

      {todo.description !== null && <p className="todo-card__desc">{todo.description}</p>}

      <dl className="todo-card__meta">
        <div>
          <dt>Vence</dt>
          <dd>{formatDate(todo.dueDate)}</dd>
        </div>
        <div>
          <dt>Creada</dt>
          <dd>{formatDateTime(todo.createdAt)}</dd>
        </div>
        <div>
          <dt>Actualizada</dt>
          <dd>{formatDateTime(todo.updatedAt)}</dd>
        </div>
        <div>
          <dt>Propietario</dt>
          <dd>{todo.ownerUsername ?? (todo.ownerId === '' ? '—' : `${todo.ownerId.slice(0, 8)}…`)}</dd>
        </div>
        {todo.completedAt !== null && (
          <div>
            <dt>Completada</dt>
            <dd>{formatDateTime(todo.completedAt)}</dd>
          </div>
        )}
      </dl>

      <footer className="todo-card__actions">
        <label className="field field--inline">
          <span className="field__label">Estado</span>
          <select
            className="input input--sm"
            value={todo.status}
            disabled={!canWrite || busy}
            title={canWrite ? 'Cambia el estado de la tarea' : 'Necesitas el permiso todos:write'}
            onChange={(event) => {
              changeStatus(event.target.value)
            }}
          >
            {TODO_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
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
          {showAttachments ? 'Ocultar adjuntos' : 'Adjuntos'}
        </button>

        <Can perm="todos:write">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={notify}
            disabled={notifyTodo.isPending}
          >
            {notifyTodo.isPending ? 'Enviando…' : 'Notificar por correo'}
          </button>
        </Can>

        <Can perm="todos:delete">
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={remove}
            disabled={deleteTodo.isPending}
          >
            {deleteTodo.isPending ? 'Borrando…' : 'Borrar'}
          </button>
        </Can>
      </footer>

      {showAttachments && <AttachmentPanel todoId={todo.id} canWrite={canWrite} />}
    </article>
  )
}
