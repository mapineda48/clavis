import { Fragment, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { PermissionKey } from '@clavis/shared'
import { useAuth } from '../auth/AuthProvider'
import {
  useCatalog,
  useCreateRole,
  useDeleteRole,
  useReplaceOverrides,
  useReplaceRolePermissions,
  useUserAccess,
} from '../api/access'
import type { Catalog, OverrideEffect } from '../api/access'
import { describeApiError } from '../api/client'
import { useUsers } from '../api/users'
import { useI18n } from '../i18n/I18nProvider'
import { useToast } from './Toast'

/* ------------------------------------------------------------------ */
/* Catalog matrix                                                      */
/* ------------------------------------------------------------------ */

function CatalogMatrix({ catalog, canManage }: { catalog: Catalog; canManage: boolean }) {
  const { t } = useI18n()
  const toast = useToast()
  const replacePermissions = useReplaceRolePermissions()
  const deleteRole = useDeleteRole()

  const onError = (error: unknown) => {
    toast.error(error)
  }

  const toggle = (roleSlug: string, permission: PermissionKey) => {
    const role = catalog.roles.find((candidate) => candidate.slug === roleSlug)
    if (role === undefined) return
    const permissions = role.permissions.includes(permission)
      ? role.permissions.filter((key) => key !== permission)
      : [...role.permissions, permission]
    replacePermissions.mutate({ slug: roleSlug, permissions }, { onError })
  }

  const remove = (roleSlug: string) => {
    if (!window.confirm(t('access.deleteRoleConfirm', { role: roleSlug }))) return
    deleteRole.mutate(roleSlug, {
      onSuccess: () => {
        toast.success(t('access.roleDeleted', { role: roleSlug }))
      },
      onError,
    })
  }

  // Group the catalog rows by module so future modules read as sections.
  const byModule = useMemo(() => {
    const groups = new Map<string, Catalog['permissions']>()
    for (const permission of catalog.permissions) {
      const group = groups.get(permission.module) ?? []
      group.push(permission)
      groups.set(permission.module, group)
    }
    return [...groups.entries()]
  }, [catalog.permissions])

  return (
    <div className="table-wrap">
      <table className="table table--compact matrix">
        <thead>
          <tr>
            <th scope="col">{t('access.columnPermission')}</th>
            {catalog.roles.map((role) => (
              <th key={role.slug} scope="col" className="matrix__role">
                <span title={role.description ?? role.name}>{role.slug}</span>
                {role.isSystem ? (
                  <span className="muted" title={t('access.systemRoleHint')}>
                    {' '}
                    ⚙
                  </span>
                ) : (
                  canManage && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--danger matrix__delete"
                      title={t('access.deleteRoleButton')}
                      onClick={() => {
                        remove(role.slug)
                      }}
                    >
                      ×
                    </button>
                  )
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {byModule.map(([module, permissions]) => (
            <Fragment key={module}>
              <tr className="matrix__module">
                <th scope="rowgroup" colSpan={catalog.roles.length + 1}>
                  {module}
                </th>
              </tr>
              {permissions.map((permission) => (
                <tr key={permission.key}>
                  <th scope="row">
                    <code>{permission.key}</code>
                    <span className="muted matrix__description">{permission.description}</span>
                  </th>
                  {catalog.roles.map((role) => {
                    const checked = role.permissions.includes(permission.key)
                    return (
                      <td key={role.slug} className="matrix__cell">
                        {canManage && !role.isSystem ? (
                          <input
                            type="checkbox"
                            checked={checked}
                            aria-label={`${role.slug}: ${permission.key}`}
                            disabled={replacePermissions.isPending}
                            onChange={() => {
                              toggle(role.slug, permission.key)
                            }}
                          />
                        ) : checked ? (
                          <span aria-hidden="true">✓</span>
                        ) : (
                          <span className="muted" aria-hidden="true">
                            ·
                          </span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CreateRoleForm() {
  const { t } = useI18n()
  const toast = useToast()
  const createRole = useCreateRole()
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createRole.mutate(
      { slug: slug.trim(), name: name.trim(), permissions: [] },
      {
        onSuccess: () => {
          toast.success(t('access.roleCreated', { role: slug.trim() }))
          setSlug('')
          setName('')
        },
        onError: (error) => {
          toast.error(error)
        },
      },
    )
  }

  return (
    <form className="form-grid__row form-grid__row--end" onSubmit={submit}>
      <label className="field">
        <span className="field__label">{t('access.fieldRoleSlug')}</span>
        <input
          className="input input--sm"
          type="text"
          required
          pattern="[a-z][a-z0-9-]{1,63}"
          placeholder="auditors"
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value)
          }}
        />
      </label>
      <label className="field">
        <span className="field__label">{t('access.fieldRoleName')}</span>
        <input
          className="input input--sm"
          type="text"
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value)
          }}
        />
      </label>
      <button type="submit" className="btn" disabled={createRole.isPending}>
        {t('access.createRoleButton')}
      </button>
    </form>
  )
}

/* ------------------------------------------------------------------ */
/* Per-user exceptions                                                 */
/* ------------------------------------------------------------------ */

type OverrideChoice = 'none' | OverrideEffect

function UserAccessEditor({ catalog }: { catalog: Catalog }) {
  const { has } = useAuth()
  const { t } = useI18n()
  const toast = useToast()
  const canManage = has('access:manage')
  const canListUsers = has('users:read')

  const usersQuery = useUsers(canListUsers)
  const [selected, setSelected] = useState<string | null>(null)
  const accessQuery = useUserAccess(selected)
  const replaceOverrides = useReplaceOverrides()

  if (!canListUsers) {
    return <p className="notice notice--warn">{t('access.needsUsersRead')}</p>
  }

  const access = accessQuery.data

  const choiceOf = (key: PermissionKey): OverrideChoice => {
    const override = access?.overrides.find((candidate) => candidate.permissionKey === key)
    return override?.effect ?? 'none'
  }

  const setChoice = (key: PermissionKey, choice: OverrideChoice) => {
    if (access === undefined) return
    const others = access.overrides.filter((candidate) => candidate.permissionKey !== key)
    const overrides =
      choice === 'none' ? others : [...others, { permissionKey: key, effect: choice }]
    replaceOverrides.mutate(
      { userId: access.userId, overrides },
      {
        onError: (error) => {
          toast.error(error)
        },
      },
    )
  }

  return (
    <div className="access-editor">
      <label className="field">
        <span className="field__label">{t('access.selectUser')}</span>
        <select
          className="input input--sm"
          value={selected ?? ''}
          onChange={(event) => {
            setSelected(event.target.value === '' ? null : event.target.value)
          }}
        >
          <option value="">{t('access.selectUserPlaceholder')}</option>
          {(usersQuery.data ?? [])
            .filter((user) => !user.isRoot)
            .map((user) => (
              <option key={user.id} value={user.id}>
                {user.username}
              </option>
            ))}
        </select>
      </label>

      {accessQuery.isError && (
        <p className="notice notice--error">{describeApiError(accessQuery.error)}</p>
      )}

      {access !== undefined && (
        <>
          <div className="facts__item">
            <dt>{t('access.userRoles')}</dt>
            <dd>
              {access.roles.length === 0 ? (
                <span className="muted">{t('common.emptyValue')}</span>
              ) : (
                access.roles.map((role) => (
                  <span key={role} className="chip chip--role">
                    {role}
                  </span>
                ))
              )}
            </dd>
          </div>

          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th scope="col">{t('access.columnPermission')}</th>
                  <th scope="col">{t('access.columnException')}</th>
                  <th scope="col">{t('access.columnEffective')}</th>
                </tr>
              </thead>
              <tbody>
                {catalog.permissions.map((permission) => {
                  const effective = access.effectivePermissions.includes(permission.key)
                  return (
                    <tr key={permission.key}>
                      <th scope="row">
                        <code>{permission.key}</code>
                      </th>
                      <td>
                        {canManage ? (
                          <select
                            className="input input--sm"
                            value={choiceOf(permission.key)}
                            disabled={replaceOverrides.isPending}
                            aria-label={`${t('access.columnException')}: ${permission.key}`}
                            onChange={(event) => {
                              setChoice(permission.key, event.target.value as OverrideChoice)
                            }}
                          >
                            <option value="none">{t('access.exceptionNone')}</option>
                            <option value="grant">{t('access.exceptionGrant')}</option>
                            <option value="revoke">{t('access.exceptionRevoke')}</option>
                          </select>
                        ) : (
                          <span className="muted">{choiceOf(permission.key)}</span>
                        )}
                      </td>
                      <td>
                        <span className={`chip ${effective ? 'chip--ok' : ''}`}>
                          {effective ? t('access.effectiveYes') : t('access.effectiveNo')}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

type AccessTab = 'catalog' | 'user'

export function AccessPanel() {
  const { has } = useAuth()
  const { t } = useI18n()
  const catalogQuery = useCatalog()
  const [tab, setTab] = useState<AccessTab>('catalog')
  const canManage = has('access:manage')

  return (
    <div className="admin">
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">{t('access.title')}</h2>
          <span className="muted">{t('access.subtitle')}</span>
        </div>

        <nav className="tabs tabs--inner" aria-label={t('access.tabsLabel')}>
          <button
            type="button"
            className={`tab${tab === 'catalog' ? ' tab--active' : ''}`}
            aria-current={tab === 'catalog' ? 'page' : undefined}
            onClick={() => {
              setTab('catalog')
            }}
          >
            {t('access.tabCatalog')}
          </button>
          <button
            type="button"
            className={`tab${tab === 'user' ? ' tab--active' : ''}`}
            aria-current={tab === 'user' ? 'page' : undefined}
            onClick={() => {
              setTab('user')
            }}
          >
            {t('access.tabUser')}
          </button>
        </nav>

        {catalogQuery.isPending && <p className="muted">{t('access.loading')}</p>}
        {catalogQuery.isError && (
          <p className="notice notice--error">{describeApiError(catalogQuery.error)}</p>
        )}

        {catalogQuery.data !== undefined && tab === 'catalog' && (
          <>
            <CatalogMatrix catalog={catalogQuery.data} canManage={canManage} />
            {canManage && <CreateRoleForm />}
          </>
        )}
        {catalogQuery.data !== undefined && tab === 'user' && (
          <UserAccessEditor catalog={catalogQuery.data} />
        )}
      </section>
    </div>
  )
}
