// Spanish catalogue.
//
// The `Record<TranslationKey, string>` annotation is the whole point of the
// file: TypeScript rejects it if a key from `en.ts` is missing or if one that no
// longer exists is left behind.

import type { TranslationKey } from './index'

export const es: Record<TranslationKey, string> = {
  'admin.auditColumnAction': 'Acción',
  'admin.auditColumnActor': 'Actor',
  'admin.auditColumnDate': 'Fecha',
  'admin.auditColumnDetail': 'Detalles',
  'admin.auditColumnEntity': 'Entidad',
  'admin.auditEmpty': 'Sin eventos registrados.',
  'admin.auditLoading': 'Cargando el registro de auditoría…',
  'admin.auditSubtitle': 'últimos {limit} eventos · requiere admin:manage',
  'admin.auditTitle': 'Registro de auditoría',
  'admin.missingAdminManage': 'Tu token no incluye admin:manage.',
  'admin.missingUsersRead': 'Tu token no incluye users:read.',
  'admin.requiresUsersRead': 'requiere users:read',
  'admin.unknownUser': '(sin nombre de usuario)',
  'admin.userColumnCreated': 'Alta',
  'admin.userColumnEmail': 'Correo',
  'admin.userColumnLastSeen': 'Último acceso',
  'admin.userColumnName': 'Nombre',
  'admin.userColumnUsername': 'Usuario',
  'admin.usersEmpty': 'Todavía no hay usuarios aprovisionados.',
  'admin.usersLoading': 'Cargando usuarios…',
  'admin.usersTitle': 'Usuarios',

  'auth.checkingSession': 'Comprobando la sesión en Keycloak…',
  'auth.defaultDisplayName': 'Usuario',
  'auth.loginButton': 'Iniciar sesión con Keycloak',
  'auth.loginLead':
    'Keycloak resuelve la autenticación y decide qué puede hacer cada cuenta. Inicia sesión para ver el acceso que te concede.',
  'auth.permAdminManage': 'Administrar',
  'auth.permUsersRead': 'Ver usuarios',
  'auth.roleAdmin': 'Administrador',
  'auth.roleManager': 'Responsable',
  'auth.roleUser': 'Usuario',
  'auth.signOut': 'Cerrar sesión',

  'common.appName': 'Clavis',
  'common.brandMark': 'CLV',
  'common.brandTagline': 'Control de acceso gobernado por Keycloak',
  'common.emptyValue': '—',
  'common.language': 'Idioma',
  'common.unknown': 'desconocido',

  'error.forbidden': 'Permiso insuficiente: {message}',
  'error.httpStatus': 'La API ha respondido con un error {status}.',
  'error.network': 'No se ha podido contactar con la API. Comprueba que el servicio está levantado.',
  'error.noAccessToken': 'Keycloak no ha devuelto un token de acceso.',
  'error.noSession': 'No hay ninguna sesión activa en Keycloak.',
  'error.sessionExpired': 'La sesión ha caducado. Vuelve a iniciar sesión.',
  'error.unauthorized': 'Tu sesión no es válida o ha caducado. Vuelve a iniciar sesión.',
  'error.unexpected': 'Se ha producido un error inesperado.',

  'home.lead':
    'Keycloak te ha autenticado y la API ha validado tu token. Arriba se muestran tus roles y hasta dónde te permiten llegar.',
  'home.title': 'Sesión iniciada',

  'nav.admin': 'Administración',
  'nav.home': 'Inicio',
  'nav.realmRolesLabel': 'Roles de realm',
  'nav.sectionsLabel': 'Secciones',

  'toast.dismiss': 'Cerrar aviso',
  'toast.titleError': 'Error',
  'toast.titleInfo': 'Información',
  'toast.titleSuccess': 'Hecho',
}
