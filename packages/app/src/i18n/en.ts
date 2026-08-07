// English catalogue — the source of truth of the whole i18n module.
//
// `TranslationKey` is derived from this object, so adding a key here is what
// makes it available everywhere; `es.ts` is typed against that union and the
// type check fails if a translation is missing or left over.
//
// Keys are flat, dot-namespaced and sorted alphabetically. Placeholders use the
// `{name}` form and are filled in by `translate()`.

export const en = {
  'admin.auditColumnAction': 'Action',
  'admin.auditColumnActor': 'Actor',
  'admin.auditColumnDate': 'Date',
  'admin.auditColumnDetail': 'Details',
  'admin.auditColumnEntity': 'Entity',
  'admin.auditEmpty': 'No events recorded.',
  'admin.auditLoading': 'Loading the audit log…',
  'admin.auditSubtitle': 'last {limit} events · requires admin:manage',
  'admin.auditTitle': 'Audit log',
  'admin.missingAdminManage': 'Your token does not include admin:manage.',
  'admin.missingUsersRead': 'Your token does not include users:read.',
  'admin.requiresUsersRead': 'requires users:read',
  'admin.unknownUser': '(no username)',
  'admin.userColumnCreated': 'Created',
  'admin.userColumnEmail': 'Email',
  'admin.userColumnLastSeen': 'Last seen',
  'admin.userColumnName': 'Name',
  'admin.userColumnUsername': 'User',
  'admin.usersEmpty': 'No users provisioned yet.',
  'admin.usersLoading': 'Loading users…',
  'admin.usersTitle': 'Users',

  'auth.checkingSession': 'Checking the Keycloak session…',
  'auth.defaultDisplayName': 'User',
  'auth.loginButton': 'Sign in with Keycloak',
  'auth.loginLead':
    'Keycloak owns authentication and decides what each account may do. Sign in to see the access it grants you.',
  'auth.permAdminManage': 'Administer',
  'auth.permUsersRead': 'See users',
  'auth.roleAdmin': 'Administrator',
  'auth.roleManager': 'Manager',
  'auth.roleUser': 'User',
  'auth.signOut': 'Sign out',

  'common.appName': 'Clavis',
  'common.brandMark': 'CLV',
  'common.brandTagline': 'Access control governed by Keycloak',
  'common.emptyValue': '—',
  'common.language': 'Language',
  'common.unknown': 'unknown',

  'error.forbidden': 'Insufficient permission: {message}',
  'error.httpStatus': 'The API answered with error {status}.',
  'error.network': 'The API is unreachable. Check that the service is up.',
  'error.noAccessToken': 'Keycloak did not return an access token.',
  'error.noSession': 'There is no active Keycloak session.',
  'error.sessionExpired': 'The session has expired. Sign in again.',
  'error.unauthorized': 'Your session is not valid or has expired. Sign in again.',
  'error.unexpected': 'Something went wrong.',

  'home.lead':
    'Keycloak has authenticated you and the API has validated your token. Your roles and what they let you reach are shown above.',
  'home.title': 'Signed in',

  'nav.admin': 'Administration',
  'nav.home': 'Home',
  'nav.realmRolesLabel': 'Realm roles',
  'nav.sectionsLabel': 'Sections',

  'toast.dismiss': 'Dismiss notification',
  'toast.titleError': 'Error',
  'toast.titleInfo': 'Information',
  'toast.titleSuccess': 'Done',
} as const
