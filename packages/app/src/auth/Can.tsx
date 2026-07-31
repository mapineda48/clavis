import type { ReactNode } from 'react'
import { useAuth } from './AuthProvider'
import type { Permission } from '../lib/types'

interface CanProps {
  /** Permiso requerido; con un array se exigen todos (AND logico). */
  perm: Permission | Permission[]
  children: ReactNode
  /** Que mostrar cuando falta el permiso. Por defecto no se muestra nada. */
  fallback?: ReactNode
}

/**
 * Muestra su contenido solo si el usuario tiene el permiso indicado.
 *
 * Es una comodidad visual: la autorizacion real la aplica la API, que vuelve a
 * comprobar el mismo permiso sobre el token.
 */
export function Can({ perm, children, fallback = null }: CanProps) {
  const { has } = useAuth()
  return <>{has(perm) ? children : fallback}</>
}
