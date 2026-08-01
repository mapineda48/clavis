import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { describeApiError } from '../api/client'
import { useI18n } from '../i18n/I18nProvider'
import type { TranslationKey } from '../i18n'

export type ToastKind = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastContextValue {
  push: (kind: ToastKind, message: string) => void
  success: (message: string) => void
  info: (message: string) => void
  /** Turns any error (the 403 included) into a message the user can read. */
  error: (cause: unknown, fallback?: string) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

/** How many notices stay on screen at the same time. */
const MAX_TOASTS = 4

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current
    nextId.current += 1
    setToasts((current) => [...current, { id, kind, message }].slice(-MAX_TOASTS))
  }, [])

  const success = useCallback(
    (message: string) => {
      push('success', message)
    },
    [push],
  )

  const info = useCallback(
    (message: string) => {
      push('info', message)
    },
    [push],
  )

  const error = useCallback(
    (cause: unknown, fallback?: string) => {
      push('error', describeApiError(cause, fallback))
    },
    [push],
  )

  const value = useMemo<ToastContextValue>(
    () => ({ push, success, info, error, dismiss }),
    [push, success, info, error, dismiss],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <ToastRow key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

const TITLE_KEYS: Record<ToastKind, TranslationKey> = {
  success: 'toast.titleSuccess',
  error: 'toast.titleError',
  info: 'toast.titleInfo',
}

function ToastRow({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const { t } = useI18n()

  useEffect(() => {
    // Errors stay longer: they are the teaching moment of the demo.
    const delay = toast.kind === 'error' ? 9000 : 5000
    const timer = window.setTimeout(() => {
      onDismiss(toast.id)
    }, delay)
    return () => {
      window.clearTimeout(timer)
    }
  }, [toast.id, toast.kind, onDismiss])

  return (
    <div className={`toast toast--${toast.kind}`}>
      <div className="toast__body">
        <p className="toast__title">{t(TITLE_KEYS[toast.kind])}</p>
        <p className="toast__message">{toast.message}</p>
      </div>
      <button
        type="button"
        className="toast__close"
        aria-label={t('toast.dismiss')}
        onClick={() => {
          onDismiss(toast.id)
        }}
      >
        ×
      </button>
    </div>
  )
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext)
  if (value === null) {
    throw new Error('useToast() must be used inside <ToastProvider>.')
  }
  return value
}
