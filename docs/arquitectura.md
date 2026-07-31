# Arquitectura

Descripción técnica del monorepo: qué contiene cada paquete, cómo se comunican los servicios,
cómo está modelada la base de datos y por qué algunas decisiones son como son.

Para el modelo de identidad (roles, permisos, contenido del token) hay un documento aparte:
[`autenticacion.md`](autenticacion.md).

---

## 1. Monorepo

Gestionado con **pnpm workspaces**. `pnpm-workspace.yaml` declara un único patrón: `packages/*`.

```
/
├── docker-compose.yml     # orquestación completa del stack
├── package.json           # privado, solo scripts + packageManager + engines
├── pnpm-workspace.yaml
├── tsconfig.base.json     # opciones estrictas compartidas por ambos paquetes
├── .env.example           # única plantilla de configuración del proyecto
├── docs/
├── infra/
│   ├── keycloak/
│   │   ├── realm-erp.template.json   # realm declarativo con marcadores __VARIABLE__
│   │   └── render-realm.mjs          # sustituye marcadores por process.env
│   ├── nginx/
│   │   ├── app.conf                  # SPA fallback try_files … /index.html
│   │   └── 40-erp-runtime-config.sh  # genera window.__ERP_CONFIG__ en el arranque
│   └── postgres/
│       └── 00-init-databases.sh      # crea rol y base de datos de Keycloak
└── packages/
    ├── api/   → @erp/api
    └── app/   → @erp/app
```

No hay paquete `shared`: los dos paquetes se comunican **solo por HTTP** y por el contrato
publicado en Swagger. Es deliberado — evita que el frontend dependa de tipos del backend y
mantiene la demo entendible leyendo un solo paquete cada vez.

### `@erp/api`

Backend HTTP. **ESM estricto** (`"type": "module"`, `module`/`moduleResolution` = `NodeNext`),
lo que obliga a que **todo import relativo lleve la extensión `.js`** aunque el fuente sea `.ts`
(`import { env } from '../config/env.js'`).

| Zona | Responsabilidad |
|---|---|
| `src/config/env.ts` | Lee y valida el entorno con **zod**. Es el **único** sitio donde se usa zod. Si falta una variable obligatoria, el proceso muere en el arranque con un mensaje claro. |
| `src/plugins/` | Plugins Fastify que decoran la instancia: `db`, `cache`, `storage`, `mailer`, `auth`. Todos con `fastify-plugin` para que los decoradores suban al ámbito raíz. |
| `src/lib/permissions.ts` | Lista literal `PERMISSIONS`, tipo `Permission`, `AuthContext`, `hasPermission()`, `canSeeAllTodos()`. |
| `src/lib/errors.ts` | `AppError` con `statusCode` y `code`, más helpers `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`. El *error handler* global responde siempre `{ error: { code, message, statusCode } }`. |
| `src/modules/` | Un directorio por dominio (`health`, `me`, `todos`, `attachments`, `admin`), cada uno con un `FastifyPluginAsync` exportado. |
| `src/db/migrate.ts` | Migrador propio: lee `migrations/*.sql`, calcula checksum y aplica lo pendiente. |
| `migrations/` | SQL versionado, `NNNN_nombre.sql`, orden lexicográfico. |

La validación de peticiones usa **JSON Schema nativo de Fastify** (propiedad `schema` de cada
ruta, validada por ajv), no zod. Esa misma definición alimenta Swagger, así que la documentación
de `/docs` no puede quedarse desfasada respecto a la validación real.

Decoradores disponibles en toda la aplicación:

```ts
fastify.authenticate                       // preHandler: verifica el Bearer y llena request.auth
fastify.requirePermissions(...perms)       // preHandler: AND lógico sobre los permisos
request.auth                               // AuthContext, disponible tras authenticate
fastify.db                                 // pool de pg + query() + tx() + ping()
fastify.cache                              // ioredis + get/set/version/bumpVersion/ping
fastify.storage                            // Azure Blob: upload/download/remove/ping
fastify.mailer                             // Resend o dry-run: send()
```

### `@erp/app`

SPA de React 19 servida por Vite 7 en desarrollo y por nginx en el perfil `full`.
**Sin frameworks de CSS ni dependencias extra**: `src/index.css` con variables CSS y soporte de
modo claro/oscuro vía `prefers-color-scheme`.

| Zona | Responsabilidad |
|---|---|
| `src/config.ts` | Resuelve la configuración en runtime: `window.__ERP_CONFIG__` → `import.meta.env.VITE_*` → valores por defecto de desarrollo. |
| `src/auth/keycloak.ts` | Instancia **singleton** de `keycloak-js` y promesa de `init()` **memorizada a nivel de módulo**. |
| `src/auth/AuthProvider.tsx` | Contexto + `useAuth()`: `{ ready, authenticated, profile, realmRoles, permissions, has(perm), login(), logout(), token() }`. |
| `src/auth/Can.tsx` | `<Can perm="todos:delete">…</Can>`, con `fallback` opcional. |
| `src/api/client.ts` | `apiFetch<T>()`: inyecta `Authorization: Bearer`, desempaqueta el sobre de error y lanza `ApiError` con `status` y `code`. |
| `src/api/todos.ts` | Tipos + hooks de React Query (`useTodos`, `useCreateTodo`, …). |

Dos detalles que son fuente habitual de bugs y están resueltos a propósito:

- **StrictMode de React 19 monta los efectos dos veces.** Llamar a `keycloak.init()` dos veces
  lanza excepción, por eso la promesa de init se memoriza fuera del árbol de componentes.
- **`token()` es asíncrono** y ejecuta `updateToken(30)` antes de devolver el JWT, de modo que
  una petición nunca sale con un token a punto de expirar.

### Configuración: un único `.env`

Hay **un solo** `.env` en la raíz. Lo consume `docker compose` y también Vite, porque
`vite.config.ts` fija `envDir` dos niveles arriba. Así no existen `.env` duplicados que se
desincronicen. Compose además **deriva** valores que nunca se escriben a mano:

| Derivada | Composición |
|---|---|
| `DATABASE_URL` | `postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB` |
| `VALKEY_URL` | `redis://valkey:6379` |
| `KEYCLOAK_ISSUER` | `$KEYCLOAK_PUBLIC_URL/realms/$KEYCLOAK_REALM` |
| `KEYCLOAK_INTERNAL_ISSUER` | `http://keycloak:8080/realms/$KEYCLOAK_REALM` |
| `KEYCLOAK_AUDIENCE` | `$KEYCLOAK_API_CLIENT_ID` |
| `CORS_ORIGINS` | `$APP_DEV_URL,$APP_PROD_URL` |

---

## 2. Diagrama de componentes

```mermaid
flowchart TB
    subgraph client["Cliente"]
        SPA["@erp/app<br/>React 19 · keycloak-js · React Query"]
    end

    subgraph api["@erp/api — Fastify 5"]
        AUTH["plugin auth<br/>jose + JWKS remoto<br/>authenticate / requirePermissions"]
        MOD["modules<br/>health · me · todos · attachments · admin"]
        DB["plugin db<br/>pg.Pool · query · tx"]
        CACHE["plugin cache<br/>ioredis · versión por namespace"]
        STO["plugin storage<br/>@azure/storage-blob"]
        MAIL["plugin mailer<br/>resend | dry-run"]
        MIG["migrator<br/>migrations/*.sql + checksum"]
    end

    subgraph infra["Infraestructura"]
        KC["Keycloak 26.4<br/>realm erp"]
        PG[("PostgreSQL 17.6<br/>esquema erp")]
        VK[("Valkey 8.1")]
        AZ[("Azurite 3.35<br/>erp-attachments")]
    end

    RS["Resend<br/>(externo, opcional)"]

    SPA -->|"OIDC PKCE S256"| KC
    SPA -->|"Bearer JWT"| AUTH
    AUTH --> MOD
    AUTH -->|"JWKS interno"| KC
    AUTH -->|"provisión JIT en erp.users"| DB
    MOD --> DB
    MOD --> CACHE
    MOD --> STO
    MOD --> MAIL
    MIG --> PG
    DB --> PG
    CACHE --> VK
    STO --> AZ
    MAIL -.-> RS
    KC --> PG
```

### Ciclo de arranque de una petición autenticada

1. `authenticate` extrae el `Bearer` de la cabecera `Authorization`.
2. `jose` verifica firma (JWKS), `iss`, `aud` y `exp`.
3. Se construye el `AuthContext` a partir de `sub`, `preferred_username`, `email`, `name`,
   `realm_access.roles` y `resource_access['erp-api'].roles`.
4. **Provisión JIT**: `INSERT … ON CONFLICT (id) DO UPDATE` en `erp.users`, actualizando
   `username`, `email`, `display_name` y `last_seen_at`. La aplicación nunca tiene un usuario
   "desconocido" en sus claves foráneas y no necesita sincronización periódica con Keycloak.
5. `requirePermissions(...)` comprueba el AND de los permisos exigidos por la ruta; si falla,
   403 con el sobre de error estándar.
6. El handler ejecuta la lógica aplicando además la **regla de visibilidad** por datos.

---

## 3. Base de datos

Esquema `erp` en la base de datos `erp`. Keycloak usa una base de datos **separada**
(`keycloak`) en la misma instancia de PostgreSQL, creada de forma idempotente por
`infra/postgres/00-init-databases.sh`. Comparten servidor pero **no** esquema: la identidad y el
negocio no se mezclan.

```mermaid
erDiagram
    users ||--o{ todos : "owner_id"
    users ||--o{ todos : "assignee_id"
    users ||--o{ todo_attachments : "uploaded_by"
    todos ||--o{ todo_attachments : "todo_id"

    users {
        uuid id PK "sub de Keycloak"
        text username UK
        text email
        text display_name
        timestamptz created_at
        timestamptz updated_at
        timestamptz last_seen_at
    }
    todos {
        uuid id PK
        text title "CHECK no vacío"
        text description
        text status "todo / in_progress / done"
        smallint priority "1..4"
        date due_date
        uuid owner_id FK "ON DELETE CASCADE"
        uuid assignee_id FK "ON DELETE SET NULL"
        timestamptz created_at
        timestamptz updated_at
        timestamptz completed_at
    }
    todo_attachments {
        uuid id PK
        uuid todo_id FK "ON DELETE CASCADE"
        text blob_name UK
        text file_name
        text content_type
        bigint size_bytes
        uuid uploaded_by FK
        timestamptz created_at
    }
    audit_log {
        bigint id PK "GENERATED ALWAYS AS IDENTITY"
        uuid actor_id
        text action
        text entity
        text entity_id
        jsonb payload
        timestamptz created_at
    }
```

### Decisiones del modelo

- **`erp.users.id` es el `sub` de Keycloak.** No hay un ID interno paralelo ni tabla de mapeo:
  el identificador de la identidad *es* el identificador del usuario en el negocio. Eso hace que
  la comprobación de propiedad sea `owner_id = auth.sub`, sin ninguna traducción intermedia.
- **`owner_id` con `ON DELETE CASCADE`, `assignee_id` con `ON DELETE SET NULL`.** Si un usuario
  desaparece, sus tareas propias se van con él, pero una tarea ajena que tenía asignada
  simplemente queda sin asignar.
- **`audit_log` no tiene clave foránea a `users`.** Un registro de auditoría debe sobrevivir al
  borrado del actor; por eso `actor_id` es un `uuid` suelto y anulable.
- **`gen_random_uuid()` es nativo en PostgreSQL 17**: no se instala `pgcrypto` ni `uuid-ossp`.
  Una extensión menos es una diferencia menos entre entornos.
- **Índices**: `todos(owner_id)`, `todos(assignee_id)`, `todos(status)`,
  `todo_attachments(todo_id)` y `audit_log(created_at DESC)`. Cubren exactamente los accesos del
  listado con filtros, el panel de adjuntos y la auditoría paginada por fecha descendente.
- **`updated_at` lo mantiene la base de datos**, no la aplicación: función `erp.set_updated_at()`
  y triggers `BEFORE UPDATE` en `erp.users` y `erp.todos`.

### Migraciones

- Ficheros en `packages/api/migrations/NNNN_nombre.sql`, aplicados en **orden lexicográfico**.
  - `0001_init.sql` — esquema, tablas, índices, función y triggers.
  - `0002_views.sql` — vista `erp.v_todo_stats` con conteos por estado y prioridad, que alimenta
    `GET /api/admin/stats`.
- El registro `erp.schema_migrations (version, checksum, applied_at)` **lo crea el propio
  migrador**, no una migración; así el migrador puede arrancar sobre una base de datos vacía.
- Cada migración se aplica una sola vez y se guarda su **checksum**. Editar un fichero ya
  aplicado provoca un fallo en el arranque en vez de una divergencia silenciosa entre entornos.
  Para cambiar algo se añade una migración nueva (ver
  [`operacion.md`](operacion.md#anadir-una-migracion)).

---

## 4. Caché versionada en Valkey

El listado `GET /api/todos` es la lectura más frecuente y la más cara (filtros + paginación +
conteo total). Se cachea en Valkey con una estrategia de **versión de namespace**, no de borrado
de claves.

**Clave de lista:**

```
erp:v<version>:todos:<sub>:<scopeEfectivo>:<status|_>:<q|_>:<page>:<pageSize>
```

- `<version>` — contador entero del namespace `todos`, obtenido con `cache.version('todos')`
  (se crea en `1` si no existe).
- `<sub>` — el usuario, porque **el mismo query devuelve resultados distintos según quién
  pregunte** (regla de visibilidad). Cachear sin el `sub` sería una fuga de datos.
- `<scopeEfectivo>` — `mine` o `all` **ya resuelto** tras comprobar permisos, no el valor crudo
  de la query.
- `<status|_>` y `<q|_>` — filtros; `_` cuando no se aplican, para que la clave nunca sea ambigua.
- TTL = `CACHE_TTL_SECONDS` (60 s por defecto).

**Invalidación:** toda escritura de dominio (`POST`, `PATCH`, `DELETE`, `seed-demo`) llama a
`cache.bumpVersion('todos')`, que hace `INCR` sobre el contador. A partir de ese instante todas
las claves nuevas se construyen con `v<version+1>` y **las viejas quedan huérfanas**: nadie las
lee y caducan solas por TTL.

```mermaid
sequenceDiagram
    participant C as Cliente
    participant A as API
    participant V as Valkey

    C->>A: GET /api/todos?status=todo
    A->>V: version('todos') → 7
    A->>V: GET erp:v7:todos:[sub]:mine:todo:_:1:20
    V-->>A: null
    A->>A: consulta a PostgreSQL
    A->>V: SET clave (TTL 60 s)
    A-->>C: 200 · X-Cache MISS

    C->>A: POST /api/todos
    A->>V: bumpVersion('todos') → 8

    C->>A: GET /api/todos?status=todo
    A->>V: version('todos') → 8
    A->>V: GET erp:v8:… → null
    A-->>C: 200 · X-Cache MISS (datos frescos)
```

Por qué versión en lugar de `DEL` por patrón:

- Invalidar con `SCAN` + `DEL` sobre un patrón es O(n) sobre todo el keyspace y difícil de hacer
  atómico. `INCR` es O(1) y atómico.
- Una escritura invalida **todas** las combinaciones de filtro/página/usuario de golpe, sin
  tener que enumerarlas.
- El coste es memoria temporal ocupada por claves muertas, acotada por el TTL.

La respuesta incluye siempre `X-Cache: HIT|MISS` y el cuerpo lleva el campo `cached`, de modo
que el comportamiento es observable desde la interfaz sin abrir las herramientas de desarrollo.

---

## 5. Adjuntos en Azurite

Azurite es el emulador oficial de Azure Storage. Se usa con `@azure/storage-blob` y la cadena de
conexión estándar de desarrollo (`AZURE_STORAGE_CONNECTION_STRING`), cuya clave de cuenta es
**pública y documentada por Microsoft**: no es un secreto y por eso está en `.env.example`.
Cambiar Azurite por un Azure Storage real es cambiar esa cadena, nada más.

Contenedor: `AZURE_STORAGE_CONTAINER` = `erp-attachments`, creado por el plugin `storage` en el
arranque si no existe (idempotente).

### Convención de nombres de blob

```
todos/<todo_id>/<uuid>-<nombre-de-archivo-saneado>
```

Ejemplo: `todos/6b0f…/9c1a…-informe_q3.pdf`

Razones de cada parte:

- **Prefijo `todos/<todo_id>/`** — Azure no tiene directorios, pero el prefijo permite listar
  todos los adjuntos de una tarea con una sola llamada y facilita el borrado en cascada.
- **`<uuid>-` delante del nombre** — dos usuarios pueden subir `factura.pdf` a la misma tarea sin
  pisarse. El nombre visible se conserva aparte en `file_name`.
- **Nombre saneado** — se normaliza a `[A-Za-z0-9._-]` para no depender del juego de caracteres
  del backend de almacenamiento.

El valor exacto se guarda en `erp.todo_attachments.blob_name` con restricción **UNIQUE**: la base
de datos es la fuente de verdad del inventario de blobs, y el nombre nunca se recalcula al
descargar. La descarga (`GET /api/attachments/:id`) resuelve primero la fila, comprueba
visibilidad sobre la tarea y **luego** pide el blob: el identificador del blob nunca se expone al
cliente ni se acepta desde él, de modo que no hay forma de pedir un blob arbitrario.

Límite de tamaño: `MAX_UPLOAD_BYTES` (10 MiB) aplicado en `@fastify/multipart`, que corta el
stream en vez de leer el fichero entero en memoria antes de rechazarlo.

---

<a id="issuer-publico-vs-issuer-interno"></a>

## 6. Issuer público vs issuer interno

Es la decisión menos obvia del proyecto y la que más problemas evita.

El navegador y la API **ven a Keycloak en direcciones distintas**:

| Quién | Cómo alcanza a Keycloak |
|---|---|
| Navegador (fuera de Docker) | `http://localhost:8080` |
| API (dentro de `erp-net`) | `http://keycloak:8080` — `localhost` sería el propio contenedor de la API |

El problema es que el token trae **un solo** `iss`, el que Keycloak considera su hostname
público: `http://localhost:8080/realms/erp`. Si la API validase el `iss` contra la URL que ella
usa para hablar con Keycloak (`http://keycloak:8080/...`), **todos los tokens serían
rechazados** aunque fuesen perfectamente válidos. Y al revés: si intentase descargar el JWKS
desde `http://localhost:8080`, dentro del contenedor eso no resuelve a nada.

La solución son dos variables con dos usos separados:

| Variable | Valor | Se usa para |
|---|---|---|
| `KEYCLOAK_ISSUER` | `http://localhost:8080/realms/erp` | Comparar con el claim `iss` del token (debe coincidir **exactamente**, sin barra final de más) |
| `KEYCLOAK_INTERNAL_ISSUER` | `http://keycloak:8080/realms/erp` | Derivar la URL del JWKS: `<internal>/protocol/openid-connect/certs` |

```mermaid
flowchart LR
    B["Navegador"] -->|"obtiene token de<br/>http://localhost:8080"| KC["Keycloak"]
    B -->|"Bearer con<br/>iss = http://localhost:8080/realms/erp"| API["API"]
    API -->|"descarga JWKS de<br/>http://keycloak:8080"| KC
    API -->|"compara iss contra<br/>KEYCLOAK_ISSUER"| API
```

Alternativas descartadas y por qué:

- **Publicar Keycloak en `keycloak:8080` también en el host** (entrada en `/etc/hosts`): obliga a
  tocar la máquina de quien clona el repo. Se rompe el "clonar y levantar".
- **`network_mode: host`**: no es portable a Docker Desktop en macOS/Windows.
- **Confiar en `iss` sin validarlo**: quita una de las comprobaciones de seguridad del JWT.

Es la misma situación que aparece al desplegar de verdad detrás de un proxy o un ingress, así
que la demo enseña el patrón correcto desde el principio en vez de un atajo que luego hay que
deshacer.

---

## 7. Realm declarativo y arranque ordenado

El realm no se configura a mano: se **renderiza e importa** en cada arranque limpio.

```mermaid
flowchart LR
    ENV[".env"] --> R["keycloak-realm (one-shot)<br/>node:22.23.1-alpine<br/>render-realm.mjs"]
    T["realm-erp.template.json<br/>marcadores __VARIABLE__"] --> R
    R -->|"escribe /import/realm-erp.json"| VOL[("volumen<br/>keycloak-import")]
    VOL --> KC["keycloak<br/>start-dev --import-realm"]
    PG[("postgres sano")] --> KC
```

- Los marcadores son `__NOMBRE_VARIABLE__` (doble guion bajo, **sin `$`**) para que el fichero
  siga siendo JSON válido y editable con cualquier herramienta.
- `render-realm.mjs` **falla con código ≠ 0** si queda algún marcador sin sustituir. Un `.env`
  incompleto se detecta en el arranque, no cuando un usuario no puede entrar.
- El servicio `keycloak` depende del one-shot con
  `condition: service_completed_successfully`, y de `postgres` con `condition: service_healthy`.
- Keycloak arranca con `start-dev --import-realm`, `KC_DB=postgres`, `KC_HOSTNAME` apuntando a
  la URL pública, `KC_HTTP_ENABLED=true` y `KC_HEALTH_ENABLED=true`.

**Healthchecks**, obligatorios en `postgres`, `keycloak`, `valkey`, `azurite` y `api`, porque las
dependencias usan `condition: service_healthy`:

| Servicio | Sonda | Motivo |
|---|---|---|
| `postgres` | `pg_isready` | Viene en la imagen |
| `valkey` | `valkey-cli ping` | Viene en la imagen |
| `keycloak` | bash con `/dev/tcp` contra el puerto de management `9000`, ruta `/health/ready` | La imagen **no trae `curl` ni `wget`** |
| `azurite`, `api` | `node -e "…"` con `http.get` | Ambas imágenes traen Node |

---

## 8. Imagen de la API en un monorepo pnpm

El `Dockerfile` de `packages/api` es multi-stage y tiene una particularidad que conviene conocer
antes de tocarlo:

1. Copia `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `package.json`, `tsconfig.base.json` y **los
   `package.json` de los dos paquetes**. Si falta uno, `--frozen-lockfile` falla: el lockfile
   describe el workspace completo, no un paquete suelto.
2. Instala con `--filter @erp/api...` (solo la API y sus dependencias del workspace).
3. Compila con `tsc`.
4. Reinstala con `--prod` para descartar las dependencias de desarrollo.
5. La etapa final copia **`/repo` entero**: los symlinks que crea pnpm en `node_modules` son
   **relativos**, así que siguen siendo válidos si se copia el árbol completo — pero se rompen si
   se copia solo `packages/api/node_modules`.

pnpm se instala en la imagen con `npm i -g pnpm@11.9.0` (versión exacta). Comando final:
`node dist/main.js`.
