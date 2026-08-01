import type { ReactNode } from 'react'
import { useAuth } from './AuthProvider'
import type { Permission } from '../lib/types'

interface CanProps {
  /** Required permission; an array demands all of them (logical AND). */
  perm: Permission | Permission[]
  children: ReactNode
  /** What to render when the permission is missing. Nothing by default. */
  fallback?: ReactNode
}

/**
 * Renders its content only if the user holds the given permission.
 *
 * This is a convenience for the UI: the real authorisation happens in the API,
 * which checks the very same permission against the token.
 */
export function Can({ perm, children, fallback = null }: CanProps) {
  const { has } = useAuth()
  return <>{has(perm) ? children : fallback}</>
}
