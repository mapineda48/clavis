import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import type { PermissionKey } from '@clavis/shared'
import type { AuthContextValue } from './auth/AuthProvider'
import { AppShell } from './components/AppShell'
import { AccessPanel } from './components/AccessPanel'
import { AuditPanel } from './components/AuditPanel'
import { ForbiddenView } from './components/ForbiddenView'
import { HomeView } from './components/HomeView'
import { UsersPanel } from './components/UsersPanel'
import type { TranslationKey } from './i18n'

/** What every route can read in `beforeLoad`. */
export interface RouterContext {
  auth: AuthContextValue
}

/**
 * The navigation manifest: one entry per section, with the permission that
 * makes it visible. The AppShell renders ONLY the entries the user passes, so
 * a user without a permission does not even see the option — and the matching
 * `beforeLoad` guard covers the direct-URL path.
 */
export const NAV_ITEMS: ReadonlyArray<{
  to: '/' | '/admin/users' | '/admin/access' | '/admin/audit'
  labelKey: TranslationKey
  required: PermissionKey | null
}> = [
  { to: '/', labelKey: 'nav.home', required: null },
  { to: '/admin/users', labelKey: 'nav.users', required: 'users:read' },
  { to: '/admin/access', labelKey: 'nav.access', required: 'access:read' },
  { to: '/admin/audit', labelKey: 'nav.audit', required: 'audit:read' },
]

/** Route guard: no permission, no entry — straight to the 403 view. */
function requirePermission(permission: PermissionKey) {
  return ({ context }: { context: RouterContext }) => {
    if (!context.auth.has(permission)) {
      throw redirect({ to: '/forbidden' })
    }
  }
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
})

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeView,
})

const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/users',
  beforeLoad: requirePermission('users:read'),
  component: UsersPanel,
})

const accessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/access',
  beforeLoad: requirePermission('access:read'),
  component: AccessPanel,
})

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/audit',
  beforeLoad: requirePermission('audit:read'),
  component: AuditPanel,
})

const forbiddenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forbidden',
  component: ForbiddenView,
})

const routeTree = rootRoute.addChildren([
  homeRoute,
  usersRoute,
  accessRoute,
  auditRoute,
  forbiddenRoute,
])

export const router = createRouter({
  routeTree,
  // The real context arrives through <RouterProvider context={...}>; this
  // placeholder only exists so the router can be created at module level.
  context: { auth: null as unknown as AuthContextValue },
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
