# Architecture

Technical description of the monorepo: what each package contains, how the services talk to each
other, how the database is modelled and why some decisions are the way they are.

The identity model (roles, permissions, token contents) has its own document:
[`authentication.md`](authentication.md).

---

## 1. Monorepo

Managed with **pnpm workspaces**. `pnpm-workspace.yaml` declares a single pattern: `packages/*`.

```
/
├── docker-compose.yml     # orchestration for the whole stack
├── package.json           # private, only scripts + packageManager + engines
├── pnpm-workspace.yaml
├── tsconfig.base.json     # strict options shared by both packages
├── .env.example           # the single configuration template of the project
├── docs/
├── infra/
│   ├── keycloak/
│   │   ├── realm-erp.template.json   # declarative realm with __VARIABLE__ markers
│   │   ├── render-realm.mjs          # replaces the markers with process.env
│   │   └── themes/erp/               # custom Freemarker login and email theme
│   ├── nginx/
│   │   ├── app.conf                  # SPA fallback try_files … /index.html
│   │   └── 40-erp-runtime-config.sh  # writes window.__ERP_CONFIG__ at startup
│   └── postgres/
│       └── 00-init-databases.sh      # creates Keycloak's role and database
└── packages/
    ├── api/   → @erp/api
    └── app/   → @erp/app
```

There is no `shared` package: the two packages talk **only over HTTP** and through the contract
published in Swagger. That is deliberate — it keeps the frontend from depending on backend types
and keeps the demo understandable by reading one package at a time.

### `@erp/api`

HTTP backend. **Strict ESM** (`"type": "module"`, `module`/`moduleResolution` = `NodeNext`),
which forces **every relative import to carry the `.js` extension** even though the source is
`.ts` (`import { env } from '../config/env.js'`).

| Area | Responsibility |
|---|---|
| `src/config/env.ts` | Reads and validates the environment with **zod**. It is the **only** place zod is used. If a required variable is missing the process dies at startup with a clear message. |
| `src/plugins/` | Fastify plugins that decorate the instance: `db`, `cache`, `storage`, `mailer`, `auth`. All wrapped in `fastify-plugin` so the decorators reach the root scope. |
| `src/lib/permissions.ts` | The literal `PERMISSIONS` list, the `Permission` type, `AuthContext`, `hasPermission()`, `canSeeAllTodos()`. |
| `src/lib/errors.ts` | `AppError` with `statusCode` and `code`, plus the `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict` helpers. The global *error handler* always answers `{ error: { code, message, statusCode } }`. |
| `src/modules/` | One directory per domain (`health`, `me`, `todos`, `attachments`, `admin`), each exporting a `FastifyPluginAsync`. |
| `src/lib/migrator.ts` | Home-grown migrator: reads `migrations/*.sql`, computes a checksum and applies what is pending. |
| `migrations/` | Versioned SQL, `NNNN_name.sql`, lexicographic order. |

Request validation uses **Fastify's native JSON Schema** (the `schema` property of each route,
validated by ajv), not zod. That same definition feeds Swagger, so the documentation at `/docs`
cannot drift away from the validation that actually runs.

Decorators available across the whole application:

```ts
fastify.authenticate                       // preHandler: verifies the Bearer and fills request.auth
fastify.requirePermissions(...perms)       // preHandler: logical AND over the permissions
request.auth                               // AuthContext, available after authenticate
fastify.db                                 // pg pool + query() + tx() + ping()
fastify.cache                              // ioredis + get/set/version/bumpVersion/ping
fastify.storage                            // Azure Blob: upload/download/remove/ping
fastify.mailer                             // Resend or dry-run: send()
```

### `@erp/app`

React 19 SPA served by Vite 7 in development and by nginx under the `full` profile.
**No CSS framework and no extra dependencies**: `src/index.css` with CSS variables and light/dark
support through `prefers-color-scheme`.

| Area | Responsibility |
|---|---|
| `src/config.ts` | Resolves configuration at runtime: `window.__ERP_CONFIG__` → `import.meta.env.VITE_*` → development defaults. |
| `src/auth/keycloak.ts` | **Singleton** `keycloak-js` instance and an `init()` promise **memoised at module level**. |
| `src/auth/AuthProvider.tsx` | Context + `useAuth()`: `{ ready, authenticated, profile, realmRoles, permissions, has(perm), login(), logout(), token() }`. |
| `src/auth/Can.tsx` | `<Can perm="todos:delete">…</Can>`, with an optional `fallback`. |
| `src/api/client.ts` | `apiFetch<T>()`: injects `Authorization: Bearer`, unwraps the error envelope and throws `ApiError` with `status` and `code`. |
| `src/api/todos.ts` | Types + React Query hooks (`useTodos`, `useCreateTodo`, …). |
| `src/i18n/` | Hand-written English/Spanish catalogues and the `I18nProvider` that exposes `useI18n()`. |

Two details that are a classic source of bugs and are solved here on purpose:

- **React 19 StrictMode mounts effects twice.** Calling `keycloak.init()` twice throws, which is
  why the init promise is memoised outside the component tree.
- **`token()` is asynchronous** and runs `updateToken(30)` before returning the JWT, so a request
  never leaves with a token that is about to expire.

### Configuration: a single `.env`

There is **one** `.env`, at the root. It is consumed by `docker compose` and also by Vite, because
`vite.config.ts` points `envDir` two levels up. That way there are no duplicated `.env` files to
drift apart. Compose also **derives** values that are never written by hand:

| Derived | Composed from |
|---|---|
| `DATABASE_URL` | `postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB` |
| `VALKEY_URL` | `redis://valkey:6379` |
| `KEYCLOAK_ISSUER` | `$KEYCLOAK_PUBLIC_URL/realms/$KEYCLOAK_REALM` |
| `KEYCLOAK_INTERNAL_ISSUER` | `http://keycloak:8080/realms/$KEYCLOAK_REALM` |
| `KEYCLOAK_AUDIENCE` | `$KEYCLOAK_API_CLIENT_ID` |
| `CORS_ORIGINS` | `$APP_DEV_URL,$APP_PROD_URL` |

---

## 2. Component diagram

```mermaid
flowchart TB
    subgraph client["Client"]
        SPA["@erp/app<br/>React 19 · keycloak-js · React Query"]
    end

    subgraph api["@erp/api — Fastify 5"]
        AUTH["auth plugin<br/>jose + remote JWKS<br/>authenticate / requirePermissions"]
        MOD["modules<br/>health · me · todos · attachments · admin"]
        DB["db plugin<br/>pg.Pool · query · tx"]
        CACHE["cache plugin<br/>ioredis · version per namespace"]
        STO["storage plugin<br/>@azure/storage-blob"]
        MAIL["mailer plugin<br/>resend | dry-run"]
        MIG["migrator<br/>migrations/*.sql + checksum"]
    end

    subgraph infra["Infrastructure"]
        KC["Keycloak 26.4<br/>realm erp"]
        PG[("PostgreSQL 17.6<br/>schema erp")]
        VK[("Valkey 8.1")]
        AZ[("Azurite 3.35<br/>erp-attachments")]
    end

    RS["Resend<br/>(external, optional)"]

    SPA -->|"OIDC PKCE S256"| KC
    SPA -->|"Bearer JWT"| AUTH
    AUTH --> MOD
    AUTH -->|"internal JWKS"| KC
    AUTH -->|"JIT provisioning into erp.users"| DB
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

### Lifecycle of an authenticated request

1. `authenticate` pulls the `Bearer` out of the `Authorization` header.
2. `jose` verifies the signature (JWKS), `iss`, `aud` and `exp`.
3. The `AuthContext` is built from `sub`, `preferred_username`, `email`, `name`,
   `realm_access.roles` and `resource_access['erp-api'].roles`.
4. **JIT provisioning**: `INSERT … ON CONFLICT (id) DO UPDATE` into `erp.users`, refreshing
   `username`, `email`, `display_name` and `last_seen_at`. The application never has an "unknown"
   user behind its foreign keys and needs no periodic sync with Keycloak.
5. `requirePermissions(...)` checks the AND of the permissions the route demands; on failure it
   returns 403 with the standard error envelope.
6. The handler runs the business logic, applying the data-level **visibility rule** on top.

---

## 3. Database

Schema `erp` in the `erp` database. Keycloak uses a **separate** database (`keycloak`) on the same
PostgreSQL instance, created idempotently by `infra/postgres/00-init-databases.sh`. They share a
server but **not** a schema: identity and business data do not mix.

```mermaid
erDiagram
    users ||--o{ todos : "owner_id"
    users ||--o{ todos : "assignee_id"
    users ||--o{ todo_attachments : "uploaded_by"
    todos ||--o{ todo_attachments : "todo_id"

    users {
        uuid id PK "Keycloak sub"
        text username UK
        text email
        text display_name
        timestamptz created_at
        timestamptz updated_at
        timestamptz last_seen_at
    }
    todos {
        uuid id PK
        text title "CHECK not empty"
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

### Modelling decisions

- **`erp.users.id` is the Keycloak `sub`.** There is no parallel internal ID and no mapping table:
  the identity identifier *is* the user identifier in the business domain. That makes an ownership
  check as simple as `owner_id = auth.sub`, with no translation in between.
- **`owner_id` with `ON DELETE CASCADE`, `assignee_id` with `ON DELETE SET NULL`.** If a user
  disappears their own tasks go with them, but somebody else's task that happened to be assigned
  to them is simply left unassigned.
- **`audit_log` has no foreign key to `users`.** An audit record has to survive the deletion of the
  actor, which is why `actor_id` is a loose, nullable `uuid`.
- **`gen_random_uuid()` is native in PostgreSQL 17**: neither `pgcrypto` nor `uuid-ossp` is
  installed. One extension fewer is one difference fewer between environments.
- **Indexes**: `todos(owner_id)`, `todos(assignee_id)`, `todos(status)`,
  `todo_attachments(todo_id)` and `audit_log(created_at DESC)`. They cover exactly the access
  patterns of the filtered listing, the attachments panel and the audit log paginated by date
  descending.
- **`updated_at` is maintained by the database**, not by the application: the
  `erp.set_updated_at()` function plus `BEFORE UPDATE` triggers on `erp.users` and `erp.todos`.

### Migrations

- Files under `packages/api/migrations/NNNN_name.sql`, applied in **lexicographic order**.
  - `0001_init.sql` — schema, tables, indexes, function and triggers.
  - `0002_views.sql` — the `erp.v_todo_stats` view with counts by status and priority, which feeds
    `GET /api/admin/stats`.
- The `erp.schema_migrations (version, checksum, applied_at)` registry **is created by the migrator
  itself**, not by a migration; that way the migrator can start against an empty database.
- Each migration is applied exactly once and its **checksum** is stored. Editing a file that has
  already been applied fails at startup instead of silently diverging between environments. To
  change something you add a new migration (see
  [`operations.md`](operations.md#add-a-migration)).

---

## 4. Versioned cache in Valkey

The `GET /api/todos` listing is the most frequent read and the most expensive one (filters +
pagination + total count). It is cached in Valkey with a **namespace version** strategy rather
than key deletion.

**List key:**

```
erp:v<version>:todos:<sub>:<effectiveScope>:<status|_>:<q|_>:<page>:<pageSize>
```

- `<version>` — integer counter for the `todos` namespace, obtained with `cache.version('todos')`
  (created as `1` if it does not exist).
- `<sub>` — the user, because **the same query returns different rows depending on who is asking**
  (visibility rule). Caching without the `sub` would be a data leak.
- `<effectiveScope>` — `mine` or `all` **already resolved** after checking permissions, not the raw
  query value.
- `<status|_>` and `<q|_>` — filters; `_` when they are not applied, so the key is never ambiguous.
- TTL = `CACHE_TTL_SECONDS` (60 s by default).

**Invalidation:** every domain write (`POST`, `PATCH`, `DELETE`, `seed-demo`) calls
`cache.bumpVersion('todos')`, which runs `INCR` on the counter. From that moment on every new key
is built with `v<version+1>` and **the old ones are orphaned**: nobody reads them and they expire
on their own by TTL.

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant V as Valkey

    C->>A: GET /api/todos?status=todo
    A->>V: version('todos') → 7
    A->>V: GET erp:v7:todos:[sub]:mine:todo:_:1:20
    V-->>A: null
    A->>A: query PostgreSQL
    A->>V: SET key (TTL 60 s)
    A-->>C: 200 · X-Cache MISS

    C->>A: POST /api/todos
    A->>V: bumpVersion('todos') → 8

    C->>A: GET /api/todos?status=todo
    A->>V: version('todos') → 8
    A->>V: GET erp:v8:… → null
    A-->>C: 200 · X-Cache MISS (fresh data)
```

Why a version instead of `DEL` by pattern:

- Invalidating with `SCAN` + `DEL` over a pattern is O(n) across the whole keyspace and hard to
  make atomic. `INCR` is O(1) and atomic.
- One write invalidates **every** filter/page/user combination at once, without having to
  enumerate them.
- The price is the temporary memory held by dead keys, bounded by the TTL.

The response always carries `X-Cache: HIT|MISS` and the body includes a `cached` field, so the
behaviour is observable from the UI without opening the dev tools.

---

## 5. Attachments in Azurite

Azurite is the official Azure Storage emulator. It is used through `@azure/storage-blob` with the
standard development connection string (`AZURE_STORAGE_CONNECTION_STRING`), whose account key is
**public and documented by Microsoft**: it is not a secret, which is why it lives in
`.env.example`. Swapping Azurite for a real Azure Storage account means changing that string and
nothing else.

Container: `AZURE_STORAGE_CONTAINER` = `erp-attachments`, created by the `storage` plugin at
startup if it does not exist (idempotent).

### Blob naming convention

```
todos/<todo_id>/<uuid>-<sanitised-file-name>
```

Example: `todos/6b0f…/9c1a…-q3_report.pdf`

The reason for each part:

- **The `todos/<todo_id>/` prefix** — Azure has no directories, but the prefix lets you list every
  attachment of a task in a single call and makes cascade deletion straightforward.
- **The leading `<uuid>-`** — two users can upload `invoice.pdf` to the same task without
  overwriting each other. The visible name is kept separately in `file_name`.
- **Sanitised name** — normalised to `[A-Za-z0-9._-]` so nothing depends on the character set of
  the storage backend.

The exact value is stored in `erp.todo_attachments.blob_name` with a **UNIQUE** constraint: the
database is the source of truth for the blob inventory, and the name is never recomputed on
download. The download path (`GET /api/attachments/:id`) resolves the row first, checks visibility
on the parent task and **then** asks for the blob: the blob identifier is never exposed to the
client nor accepted from it, so there is no way to request an arbitrary blob.

Size limit: `MAX_UPLOAD_BYTES` (10 MiB) enforced by `@fastify/multipart`, which cuts the stream
instead of reading the whole file into memory before rejecting it.

---

<a id="public-issuer-vs-internal-issuer"></a>

## 6. Public issuer vs internal issuer

This is the least obvious decision in the project and the one that prevents the most trouble.

The browser and the API **see Keycloak at different addresses**:

| Who | How it reaches Keycloak |
|---|---|
| Browser (outside Docker) | `http://localhost:8080` |
| API (inside `erp-net`) | `http://keycloak:8080` — `localhost` would be the API container itself |

The catch is that the token carries **a single** `iss`, the one Keycloak considers its public
hostname: `http://localhost:8080/realms/erp`. If the API validated `iss` against the URL it uses to
talk to Keycloak (`http://keycloak:8080/...`), **every token would be rejected** even though they
are perfectly valid. And the other way round: if it tried to download the JWKS from
`http://localhost:8080`, inside the container that resolves to nothing.

The solution is two variables with two separate uses:

| Variable | Value | Used for |
|---|---|---|
| `KEYCLOAK_ISSUER` | `http://localhost:8080/realms/erp` | Comparing against the token's `iss` claim (it must match **exactly**, no extra trailing slash) |
| `KEYCLOAK_INTERNAL_ISSUER` | `http://keycloak:8080/realms/erp` | Deriving the JWKS URL: `<internal>/protocol/openid-connect/certs` |

```mermaid
flowchart LR
    B["Browser"] -->|"gets a token from<br/>http://localhost:8080"| KC["Keycloak"]
    B -->|"Bearer with<br/>iss = http://localhost:8080/realms/erp"| API["API"]
    API -->|"downloads JWKS from<br/>http://keycloak:8080"| KC
    API -->|"compares iss against<br/>KEYCLOAK_ISSUER"| API
```

Alternatives that were discarded, and why:

- **Publishing Keycloak as `keycloak:8080` on the host too** (an `/etc/hosts` entry): it forces
  everyone who clones the repo to modify their machine. That breaks "clone and run".
- **`network_mode: host`**: not portable to Docker Desktop on macOS/Windows.
- **Trusting `iss` without validating it**: throws away one of the JWT security checks.

This is the same situation you hit when deploying for real behind a proxy or an ingress, so the
demo teaches the correct pattern from the start instead of a shortcut you have to undo later.

---

## 7. Declarative realm and ordered startup

The realm is not configured by hand: it is **rendered and imported** on every clean start.

```mermaid
flowchart LR
    ENV[".env"] --> R["keycloak-realm (one-shot)<br/>node:22.23.1-alpine<br/>render-realm.mjs"]
    T["realm-erp.template.json<br/>__VARIABLE__ markers"] --> R
    R -->|"writes /import/realm-erp.json"| VOL[("keycloak-import<br/>volume")]
    VOL --> KC["keycloak<br/>start-dev --import-realm"]
    PG[("healthy postgres")] --> KC
```

- The markers are `__VARIABLE_NAME__` (double underscore, **no `$`**) so the file stays valid JSON
  and can be edited with any tool.
- `render-realm.mjs` **exits with a non-zero code** if any marker is left unsubstituted. An
  incomplete `.env` is caught at startup, not when a user cannot sign in.
- The `keycloak` service depends on the one-shot with
  `condition: service_completed_successfully`, and on `postgres` with `condition: service_healthy`.
- Keycloak starts with `start-dev --import-realm`, `KC_DB=postgres`, `KC_HOSTNAME` pointing at the
  public URL, `KC_HTTP_ENABLED=true` and `KC_HEALTH_ENABLED=true`.

**Healthchecks** are mandatory on `postgres`, `keycloak`, `valkey`, `azurite` and `api`, because
the dependencies use `condition: service_healthy`:

| Service | Probe | Why |
|---|---|---|
| `postgres` | `pg_isready` | Ships with the image |
| `valkey` | `valkey-cli ping` | Ships with the image |
| `keycloak` | bash with `/dev/tcp` against the management port `9000`, path `/health/ready` | The image ships **neither `curl` nor `wget`** |
| `azurite`, `api` | `node -e "…"` with `http.get` | Both images ship Node |

---

## 8. The API image inside a pnpm monorepo

The `Dockerfile` in `packages/api` is multi-stage and has one quirk worth knowing before touching
it:

1. It copies `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `package.json`, `tsconfig.base.json` and
   **the `package.json` of both packages**. If one is missing, `--frozen-lockfile` fails: the
   lockfile describes the whole workspace, not a single package.
2. It installs with `--filter @erp/api...` (only the API and its workspace dependencies).
3. It builds with `tsc`.
4. It reinstalls with `--prod` to drop the development dependencies.
5. The final stage copies **all of `/repo`**: the symlinks pnpm creates in `node_modules` are
   **relative**, so they stay valid when the whole tree is copied — but they break if you copy only
   `packages/api/node_modules`.

pnpm is installed into the image with `npm i -g pnpm@11.9.0` (exact version). Final command:
`node dist/main.js`.
