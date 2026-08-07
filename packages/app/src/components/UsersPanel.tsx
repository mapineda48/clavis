import { useState } from 'react'
import type { FormEvent } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Can } from '../auth/Can'
import { useCatalog } from '../api/access'
import { describeApiError } from '../api/client'
import {
  useCreateUser,
  useDeleteUser,
  useResendInvite,
  useUpdateUser,
  useUsers,
} from '../api/users'
import type { CredentialMode, SystemUser } from '../api/users'
import { useI18n } from '../i18n/I18nProvider'
import { formatDateTime } from '../lib/types'
import { useToast } from './Toast'

/* ------------------------------------------------------------------ */
/* Create form                                                         */
/* ------------------------------------------------------------------ */

interface CreateFormState {
  email: string
  displayName: string
  username: string
  credentialMode: CredentialMode
  temporaryPassword: string
  roles: string[]
}

const EMPTY_FORM: CreateFormState = {
  email: '',
  displayName: '',
  username: '',
  credentialMode: 'temporary_password',
  temporaryPassword: '',
  roles: [],
}

function CreateUserForm({ availableRoles }: { availableRoles: string[] }) {
  const { t } = useI18n()
  const toast = useToast()
  const createUser = useCreateUser()
  const [form, setForm] = useState<CreateFormState>(EMPTY_FORM)

  const patch = (changes: Partial<CreateFormState>) => {
    setForm((current) => ({ ...current, ...changes }))
  }

  const toggleRole = (slug: string) => {
    setForm((current) => ({
      ...current,
      roles: current.roles.includes(slug)
        ? current.roles.filter((role) => role !== slug)
        : [...current.roles, slug],
    }))
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createUser.mutate(
      {
        email: form.email.trim(),
        displayName: form.displayName.trim(),
        ...(form.username.trim() === '' ? {} : { username: form.username.trim() }),
        roles: form.roles,
        credentialMode: form.credentialMode,
        ...(form.credentialMode === 'temporary_password'
          ? { temporaryPassword: form.temporaryPassword }
          : {}),
      },
      {
        onSuccess: ({ user, invite }) => {
          setForm(EMPTY_FORM)
          if (form.credentialMode === 'invite' && !invite.sent) {
            toast.info(t('users.createdInviteFailed', { username: user.username }))
          } else {
            toast.success(t('users.created', { username: user.username }))
          }
        },
        onError: (error) => {
          toast.error(error)
        },
      },
    )
  }

  return (
    <form className="panel form-grid" onSubmit={submit}>
      <h3 className="panel__title">{t('users.createTitle')}</h3>

      <div className="form-grid__row">
        <label className="field">
          <span className="field__label">{t('users.fieldEmail')}</span>
          <input
            className="input"
            type="email"
            required
            value={form.email}
            onChange={(event) => {
              patch({ email: event.target.value })
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">{t('users.fieldDisplayName')}</span>
          <input
            className="input"
            type="text"
            required
            value={form.displayName}
            onChange={(event) => {
              patch({ displayName: event.target.value })
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">{t('users.fieldUsername')}</span>
          <input
            className="input"
            type="text"
            placeholder={t('users.usernamePlaceholder')}
            value={form.username}
            onChange={(event) => {
              patch({ username: event.target.value })
            }}
          />
        </label>
      </div>

      <fieldset className="field">
        <legend className="field__label">{t('users.fieldCredentialMode')}</legend>
        <div className="radio-row">
          <label className="radio">
            <input
              type="radio"
              name="credentialMode"
              checked={form.credentialMode === 'temporary_password'}
              onChange={() => {
                patch({ credentialMode: 'temporary_password' })
              }}
            />
            <span>{t('users.modeTemporaryPassword')}</span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="credentialMode"
              checked={form.credentialMode === 'invite'}
              onChange={() => {
                patch({ credentialMode: 'invite' })
              }}
            />
            <span>{t('users.modeInvite')}</span>
          </label>
        </div>
        <p className="muted">
          {form.credentialMode === 'temporary_password'
            ? t('users.modeTemporaryPasswordHint')
            : t('users.modeInviteHint')}
        </p>
      </fieldset>

      {form.credentialMode === 'temporary_password' && (
        <label className="field">
          <span className="field__label">{t('users.fieldTemporaryPassword')}</span>
          <input
            className="input"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={form.temporaryPassword}
            onChange={(event) => {
              patch({ temporaryPassword: event.target.value })
            }}
          />
        </label>
      )}

      {availableRoles.length > 0 && (
        <fieldset className="field">
          <legend className="field__label">{t('users.fieldRoles')}</legend>
          <div className="check-row">
            {availableRoles.map((slug) => (
              <label key={slug} className="radio">
                <input
                  type="checkbox"
                  checked={form.roles.includes(slug)}
                  onChange={() => {
                    toggleRole(slug)
                  }}
                />
                <span>{slug}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div>
        <button type="submit" className="btn" disabled={createUser.isPending}>
          {createUser.isPending ? t('users.creating') : t('users.createButton')}
        </button>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------------ */
/* Row editor                                                          */
/* ------------------------------------------------------------------ */

function UserRowActions({ user, availableRoles }: { user: SystemUser; availableRoles: string[] }) {
  const { t } = useI18n()
  const { has, me } = useAuth()
  const toast = useToast()
  const updateUser = useUpdateUser()
  const deleteUser = useDeleteUser()
  const resendInvite = useResendInvite()

  const onError = (error: unknown) => {
    toast.error(error)
  }

  const toggleStatus = () => {
    updateUser.mutate(
      { id: user.id, status: user.status === 'active' ? 'disabled' : 'active' },
      { onError },
    )
  }

  const toggleRole = (slug: string) => {
    const roles = user.roles.includes(slug)
      ? user.roles.filter((role) => role !== slug)
      : [...user.roles, slug]
    updateUser.mutate({ id: user.id, roles }, { onError })
  }

  const remove = () => {
    if (!window.confirm(t('users.deleteConfirm', { username: user.username }))) return
    deleteUser.mutate(user.id, {
      onSuccess: () => {
        toast.success(t('users.deleted', { username: user.username }))
      },
      onError,
    })
  }

  const invite = () => {
    resendInvite.mutate(user.id, {
      onSuccess: ({ sent }) => {
        if (sent) toast.success(t('users.inviteSent', { username: user.username }))
        else toast.error(t('users.inviteFailed', { username: user.username }))
      },
      onError,
    })
  }

  const busy = updateUser.isPending || deleteUser.isPending || resendInvite.isPending

  // The API refuses these: roles are an `access:manage` operation, the status
  // flip and the invitation resend are `users:update` ones, and nobody changes
  // their own roles or status or deletes their own account. `users:delete`
  // alone opens this editor, so without the `canUpdate` check it would offer
  // two buttons the server answers 403 to.
  const isSelf = me?.user.id === user.id
  const canUpdate = has('users:update')
  const canAssignRoles = has('access:manage') && !isSelf
  const canDelete = has('users:delete') && !isSelf

  return (
    <div className="row-actions">
      {isSelf && <p className="muted">{t('users.selfImmutableHint')}</p>}
      {canAssignRoles && availableRoles.length > 0 && (
        <div className="check-row" aria-label={t('users.fieldRoles')}>
          {availableRoles.map((slug) => (
            <label key={slug} className="radio">
              <input
                type="checkbox"
                checked={user.roles.includes(slug)}
                disabled={busy}
                onChange={() => {
                  toggleRole(slug)
                }}
              />
              <span>{slug}</span>
            </label>
          ))}
        </div>
      )}
      <div className="row-actions__buttons">
        {canUpdate && !isSelf && (
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={toggleStatus}>
            {user.status === 'active' ? t('users.disableButton') : t('users.enableButton')}
          </button>
        )}
        {canUpdate && (
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={invite}>
            {t('users.resendInviteButton')}
          </button>
        )}
        {canDelete && (
          <button type="button" className="btn btn--ghost btn--danger" disabled={busy} onClick={remove}>
            {t('users.deleteButton')}
          </button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function UsersPanel() {
  const { has } = useAuth()
  const { locale, t } = useI18n()
  const usersQuery = useUsers()
  // The role picker needs the catalog, which sits behind access:read; without
  // that permission the panel simply offers no role editing.
  const catalogQuery = useCatalog(has('access:read'))
  const [expanded, setExpanded] = useState<string | null>(null)

  // Assigning a role needs access:manage on both create and update, so without
  // it the pickers are not offered at all rather than offered and refused.
  const availableRoles = has('access:manage')
    ? (catalogQuery.data?.roles ?? []).map((role) => role.slug)
    : []
  // The row editor covers the update actions and the deletion: either
  // permission on its own is enough to have something to show there.
  const canManageRows = has('users:update') || has('users:delete')
  const emptyValue = t('common.emptyValue')

  return (
    <div className="admin">
      <Can perm="users:create">
        <CreateUserForm availableRoles={availableRoles} />
      </Can>

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">{t('users.listTitle')}</h2>
          <span className="muted">{t('users.listSubtitle')}</span>
        </div>
        {usersQuery.isPending && <p className="muted">{t('users.loading')}</p>}
        {usersQuery.isError && (
          <p className="notice notice--error">{describeApiError(usersQuery.error)}</p>
        )}
        {usersQuery.data !== undefined && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('users.columnUsername')}</th>
                  <th scope="col">{t('users.columnName')}</th>
                  <th scope="col">{t('users.columnEmail')}</th>
                  <th scope="col">{t('users.columnRoles')}</th>
                  <th scope="col">{t('users.columnStatus')}</th>
                  <th scope="col">{t('users.columnLastSeen')}</th>
                  {canManageRows && <th scope="col">{t('users.columnActions')}</th>}
                </tr>
              </thead>
              <tbody>
                {usersQuery.data.map((user) => (
                  <tr key={user.id}>
                    <th scope="row">
                      <code>{user.username}</code>
                      {user.isRoot && <span className="chip chip--role">root</span>}
                    </th>
                    <td>{user.displayName ?? emptyValue}</td>
                    <td>{user.email}</td>
                    <td>
                      {user.roles.length === 0 ? (
                        <span className="muted">{emptyValue}</span>
                      ) : (
                        user.roles.map((role) => (
                          <span key={role} className="chip">
                            {role}
                          </span>
                        ))
                      )}
                    </td>
                    <td>
                      <span
                        className={`chip ${user.status === 'active' ? 'chip--ok' : 'chip--warn'}`}
                      >
                        {user.status === 'active' ? t('users.statusActive') : t('users.statusDisabled')}
                      </span>
                    </td>
                    <td>{formatDateTime(user.lastSeenAt, locale)}</td>
                    {canManageRows && (
                      <td>
                        {user.isRoot ? (
                          <span className="muted" title={t('users.rootImmutableHint')}>
                            {emptyValue}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--ghost"
                            aria-expanded={expanded === user.id}
                            onClick={() => {
                              setExpanded((current) => (current === user.id ? null : user.id))
                            }}
                          >
                            {expanded === user.id ? t('users.closeActions') : t('users.openActions')}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canManageRows &&
          usersQuery.data !== undefined &&
          expanded !== null &&
          (() => {
            const user = usersQuery.data.find((candidate) => candidate.id === expanded)
            if (user === undefined || user.isRoot) return null
            return (
              <div className="panel panel--nested">
                <h3 className="panel__title">
                  {t('users.actionsFor', { username: user.username })}
                </h3>
                <UserRowActions user={user} availableRoles={availableRoles} />
              </div>
            )
          })()}
      </section>
    </div>
  )
}
