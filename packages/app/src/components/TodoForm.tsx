import { useState } from 'react'
import type { FormEvent } from 'react'
import { useCreateTodo } from '../api/todos'
import type { CreateTodoInput } from '../api/todos'
import {
  PRIORITIES,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TODO_STATUSES,
  isTodoStatus,
  toPriority,
} from '../lib/types'
import { useToast } from './Toast'

const EMPTY_FORM: CreateTodoInput = {
  title: '',
  description: '',
  status: 'todo',
  priority: 3,
  dueDate: '',
}

export function TodoForm() {
  const [form, setForm] = useState<CreateTodoInput>(EMPTY_FORM)
  const createTodo = useCreateTodo()
  const toast = useToast()

  const update = (patch: Partial<CreateTodoInput>): void => {
    setForm((current) => ({ ...current, ...patch }))
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const title = form.title.trim()
    if (title === '') {
      toast.error(new Error('El titulo es obligatorio.'))
      return
    }
    createTodo.mutate(
      { ...form, title },
      {
        onSuccess: (todo) => {
          setForm(EMPTY_FORM)
          toast.success(`Tarea «${todo.title}» creada.`)
        },
        onError: (error) => {
          toast.error(error)
        },
      },
    )
  }

  return (
    <section className="panel">
      <h2 className="panel__title">Nueva tarea</h2>
      <form className="todo-form" onSubmit={submit}>
        <label className="field field--wide">
          <span className="field__label">Titulo</span>
          <input
            type="text"
            className="input"
            required
            maxLength={200}
            placeholder="Revisar el cierre mensual"
            value={form.title}
            onChange={(event) => {
              update({ title: event.target.value })
            }}
          />
        </label>

        <label className="field field--wide">
          <span className="field__label">Descripcion</span>
          <textarea
            className="input"
            rows={2}
            maxLength={2000}
            placeholder="Detalles opcionales de la tarea"
            value={form.description}
            onChange={(event) => {
              update({ description: event.target.value })
            }}
          />
        </label>

        <label className="field">
          <span className="field__label">Estado</span>
          <select
            className="input"
            value={form.status}
            onChange={(event) => {
              const value = event.target.value
              update({ status: isTodoStatus(value) ? value : 'todo' })
            }}
          >
            {TODO_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Prioridad</span>
          <select
            className="input"
            value={String(form.priority)}
            onChange={(event) => {
              update({ priority: toPriority(Number(event.target.value)) })
            }}
          >
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value} · {PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Vencimiento</span>
          <input
            type="date"
            className="input"
            value={form.dueDate}
            onChange={(event) => {
              update({ dueDate: event.target.value })
            }}
          />
        </label>

        <div className="todo-form__actions">
          <button type="submit" className="btn btn--primary" disabled={createTodo.isPending}>
            {createTodo.isPending ? 'Creando…' : 'Crear tarea'}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setForm(EMPTY_FORM)
            }}
            disabled={createTodo.isPending}
          >
            Limpiar
          </button>
        </div>
      </form>
    </section>
  )
}
