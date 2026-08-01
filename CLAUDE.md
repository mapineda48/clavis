# Instrucciones del proyecto

Laboratorio de control de acceso con Keycloak. Monorepo pnpm con dos paquetes
(`@erp/api` y `@erp/app`) y toda la infraestructura en `docker compose`.

---

## OBLIGATORIO

Estas reglas no son preferencias: incumplirlas rompe el proyecto o expone datos.

### 1. Mensajes de commit

- **NUNCA** incluyas un trailer `Claude-Session:` ni ninguna URL de sesión, de
  conversación o de herramienta en el mensaje de commit. El historial es público.
- Se permite `Co-Authored-By:` al final.
- Mensajes en español, en imperativo, con prefijo de tipo (`feat:`, `fix:`,
  `docs:`, `refactor:`, `chore:`). El cuerpo explica **por qué**, no solo qué.

### 2. Secretos

- El **único** secreto real del proyecto es `RESEND_API_KEY`. Vive solo en `.env`,
  que está en `.gitignore` y **nunca** debe versionarse.
- `.env.example` se versiona con valores de desarrollo, jamás con valores reales.
- No escribas contraseñas en el tema de Keycloak, ni en el código, ni en la
  documentación. Remite siempre a `.env.example`.
- Antes de publicar o subir algo, audita el **historial completo**, no solo el
  árbol de trabajo: un secreto en un commit antiguo sigue ahí aunque el archivo
  actual esté limpio.
- No pongas datos personales (correos reales) en el contenido de archivos
  versionados. Los commits usan el correo *noreply* de GitHub.

### 3. Determinismo

- Versiones **exactas** en `package.json` (sin `^` ni `~`) e imágenes Docker con
  tag fijo. Nunca `latest`.
- `pnpm-lock.yaml` se versiona. Los scripts de instalación aprobados se declaran
  en `pnpm-workspace.yaml` (`allowBuilds`), no con `pnpm approve-builds` a mano.

---

## Comandos

```bash
pnpm install                 # instala el workspace
pnpm run up                  # docker compose up -d --build
pnpm run down                # para el stack (conserva datos)
pnpm run reset               # down -v: borra volúmenes y REIMPORTA el realm
pnpm dev                     # API y SPA fuera de Docker, en paralelo
pnpm build / pnpm typecheck  # ambos paquetes
pnpm run verify              # las tres suites de verificación
```

Verificación individual: `./scripts/verify-api.sh`,
`./scripts/verify-login-theme.sh`, `./scripts/verify-password-reset.sh`.
**Ejecuta la suite que corresponda tras tocar la API, el tema o el realm.**

---

## Trampas conocidas

Cada una de estas costó un fallo real. No las redescubras.

### API (`@erp/api`)

- Es **ESM con `moduleResolution: NodeNext`**: todo import relativo lleva
  extensión `.js`, aunque el fuente sea `.ts`.
- `ioredis` es CommonJS: bajo ESM hay que usar el export **nombrado**
  (`import { Redis } from 'ioredis'`); el default no es construible.
- La validación de rutas usa **JSON Schema de Fastify**, no zod. `zod` solo se
  usa en `src/config/env.ts`.
- Si declaras `response` en el `schema` de una ruta, Fastify **serializa y
  descarta** los campos no declarados. Decláralos todos o no declares `response`.
- El issuer público (`KEYCLOAK_ISSUER`) y el interno (`KEYCLOAK_INTERNAL_ISSUER`)
  son distintos a propósito: el navegador ve `localhost:8080` y el contenedor ve
  `keycloak:8080`. El JWKS se descarga por el interno; el `iss` se valida contra
  el público.

### Keycloak y el tema

- Los archivos `.properties` del tema se leen como **ISO-8859-1**: escribe tildes
  y eñes con escapes unicode (`á`), nunca caracteres acentuados directos.
  Esto incluye los comentarios.
- `start-dev` **no cachea las plantillas** `.ftl` ni el CSS: editar y recargar
  basta. Pero `theme.properties` **sí** se cachea: exige reiniciar el contenedor.
- `passwordVisibility.js` del tema base **reemplaza el `className` entero** del
  icono, así que `kcFormPasswordVisibilityIconShow/Hide` deben bastarse solos.
- El realm solo lee `loginTheme`, `emailTheme`, `smtpServer`,
  `resetPasswordAllowed` y demás **al importarse**. Para un realm que ya existe,
  aplícalos con `kcadm.sh` (ver `docs/operacion.md`) o haz `pnpm run reset`.
- `actionTokenGeneratedByUserLifespan` es un campo de **primer nivel** del realm,
  no un `attributes.*`. Con `-s attributes.…` no se aplica y no avisa.
- Los roles compuestos del realm deben declarar explícitamente `offline_access` y
  `uma_authorization` en `roles.realm`, o el import falla con
  «Unable to find composite realm role».

### Correo

Son **dos caminos distintos**: la API envía por la **API HTTP** de Resend, y
Keycloak solo sabe enviar por **SMTP**. Por eso el realm apunta al relay SMTP de
Resend reutilizando `RESEND_API_KEY` como contraseña.

### Shell

`.env` **no se puede `source`** sin más: `MAIL_FROM` contiene `<...>`. Los valores
con espacios van entrecomillados (Docker Compose retira las comillas al
interpolar). Para leer una variable suelta, usa `envval` de `scripts/_common.sh`.

---

## Estructura

```
packages/api/     Fastify 5 + TypeScript (ESM). Valida el token, no lo emite.
packages/app/     React 19 + Vite + keycloak-js (PKCE S256).
infra/keycloak/   Plantilla del realm (marcadores __VAR__) y tema propio.
infra/postgres/   Init de la base de datos de Keycloak.
scripts/          Suites de verificación end-to-end.
docs/             Arquitectura, autenticación y operación.
```

El realm se renderiza en el arranque: `render-realm.mjs` sustituye los marcadores
`__VARIABLE__` por variables de entorno y **falla si alguno queda sin resolver**.

---

## Al terminar una tarea

1. `pnpm typecheck && pnpm build`.
2. La suite de verificación que corresponda.
3. Comprueba que no has añadido secretos ni datos personales.
4. Commit siguiendo las reglas de arriba.
