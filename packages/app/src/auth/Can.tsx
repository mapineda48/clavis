import type { ReactNode } from 'react'
import type { PermissionKey } from '@clavis/shared'
import { useAuth } from './AuthProvider'

interface CanProps {
  /** Required permission; an array demands all of them (logical AND). */
  perm: PermissionKey | PermissionKey[]
  children: ReactNode
  /** What to render when the permission is missing. Nothing by default. */
  fallback?: ReactNode
}

/**
 * Renders its content only if the user holds the given permission.
 *
 * This is a convenience for the UI: the real authorisation happens in the API,
 * which resolves the very same permission from the database.
 */
export function Can({ perm, children, fallback = null }: CanProps) {
  const { has } = useAuth()
  return <>{has(perm) ? children : fallback}</>
}
