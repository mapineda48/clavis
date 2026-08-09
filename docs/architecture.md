# Architecture

Technical description of the monorepo: what each package contains, how the services talk to each
other, how the database is modelled and why some decisions are the way they are.

Two things have their own documents and are only referenced here: what Keycloak does
([`authentication.md`](authentication.md)) and how the application decides what a user may do
([`access-control.md`](access-control.md)).

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
│   │   ├── realm-clavis.template.json   # declarative realm with __VARIABLE__ markers
│   │   ├── render-realm.mjs          # replaces the markers with process.env
│   │   └── themes/clavis/               # custom Freemarker login and email theme
│   ├── nginx/
│   │   ├── app.conf                  # SPA fallback try_files … /index.html
│   │   └── 40-clavis-runtime-config.sh  # writes window.__CLAVIS_CONFIG__ at startup
│   └── postgres/
│       └── 00-init-databases.sh      # creates Keycloak's role and database
├── scripts/                          # verification suites and deployment helpers
└── packages/
    ├── shared/ → @clavis/shared
    ├── api/    → @clavis/api
    └── app/    → @clavis/app
```

### `@clavis/shared`

The **only** thing the two runtime packages share, and it exists for one reason: the permission
catalog has to be identical on both sides of the HTTP boundary.

`src/permissions.ts` exports `PERMISSION_DEFS` — six entries of `{ key, module, description }`,
declared `as const satisfies readonly PermissionDef[]` — plus `PermissionKey`, derived from it as
a union of string literals. The API types `requirePermissions()` with that union; the SPA types
`NAV_ITEMS[].required` and `<Can perm=…>` with it. A permission that does not exist cannot be
required, and a route and a menu entry cannot disagree about how one is spelled.

Everything else still travels **only over HTTP**, through the contract published in Swagger: the
package carries no DTOs, no client and no business logic. It compiles to `dist/` with plain
`tsc`, which is why `pnpm dev` builds it before starting the other two in parallel.

### `@clavis/api`

HTTP backend. **Strict ESM** (`"type": "module"`, `module`/`moduleResolution` = `NodeNext`),
which forces **every relative import to carry the `.js` extension** even though the source is
`.ts` (`import { loadConfig } from '../config/env.js'`).

| Area | Responsibility |
|---|---|
| `src/config/env.ts` | `loadConfig(env)`: validates an environment with **zod** and returns an `AppConfig`, or throws `ConfigError` naming every offending variable. It is the **only** place zod is used. It reads no ambient state and never exits — `src/main.ts` is the only file that touches `process.env` or calls `process.exit`, and every factory declares the slice it reads as `Pick<AppConfig, …>`. |
| `src/infra/` | Framework-free service factories: `logger` (pino), `db` (pg pool + `tx()`, runs the migrations), `cache` (Valkey, namespace versions), `storage` (Azure Blob), `mailer` (Resend or dry-run), `keycloak-admin` (Admin REST over plain `fetch`), and `services.ts`, which builds them all in dependency order and owns `close()`. |
| `src/http/` | Everything Express-specific: `auth` (the `authenticate` / `requirePermissions` middlewares), `validate` (ajv request validation), `error-handler` (the envelope), `route` (the `RouteDef` registry) and `openapi` (the document and the swagger-ui router, derived from the same registry). |
| `src/lib/access.ts` | `AccessUser`, `AccessContext`, the single query that resolves a user's effective permissions, the `access` cache namespace and its key format. |
| `src/bootstrap/seed.ts` | Runs once at startup, before the listener: syncs the permission catalog, re-seeds the `admin` system role, links root. |
| `src/lib/errors.ts` | `AppError` with `statusCode` and `code`, plus the `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict` helpers. The global *error handler* always answers `{ error: { code, message, statusCode } }`, with an optional `details` field when the application error carries structured context (for example the `missing` permission list on a 403). |
| `src/modules/` | One directory per domain (`health`, `me`, `users`, `access`, `audit`), split into layers: `routes.ts` (HTTP), `service.ts` (rules and orchestration), `repository.ts` (SQL), `schemas.ts` (contract + serializer). Modules without rules skip the service; every module keeps SQL out of its routes. |
| `src/lib/migrator.ts` | Home-grown migrator: reads `migrations/*.sql`, computes a checksum and applies what is pending, on a connection of its own. |
| `migrations/` | Versioned SQL, `YYYYMMDDHHMMSS_name.sql`, lexicographic order. |

Each module is one `ModuleDef`: its OpenAPI tag plus a list of `RouteDef`s. A `RouteDef` is the
single source for the middleware stack (its `permissions` field wires `authenticate` and
`requirePermissions`), the ajv validation (its `schema` field) and the OpenAPI operation
(everything, including `security`, is derived from the same fields). The docs at `/api/docs`
therefore cannot claim a guard or accept a shape the route does not actually have.

The layering inside a module is a one-way street:

```
routes.ts      Express request/response: validation, RequestContext, serialization. No SQL, no Keycloak.
service.ts     The rules: guards, Keycloak orchestration, mutate() with its audit row. No Express.
repository.ts  The SQL, every function over an Executor. No transactions of its own, no rules.
schemas.ts     JSON Schemas (documentation + validation) and the serializer they are tested against.
```

Services receive their dependencies (`db`, `cache`, `keycloakAdmin`) from the composition root
(`main.ts` → `createServices` → `buildApp`) and take a `RequestContext` — actor id, resolved
access, request-scoped logger — instead of ever seeing a request object. That is what makes the
guards unit-testable with plain fakes and keeps queries out of the endpoint layer.

The split between `authState.auth` and `authState.access` is the whole architecture in two
lines: the first comes from the token and answers *who*, the second comes from PostgreSQL and
answers *what*. `req.authState` is absent until `authenticate` fills it in, and handlers read it
through `authOf(req)` / `requestContext(req)`, which turn a read on a route that never wired
authentication into a loud error instead of an `undefined` downstream.

Every connection of the pool behind `db` starts with a `statement_timeout` and an
`idle_in_transaction_session_timeout` (`DB_STATEMENT_TIMEOUT_MS`,
`DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`; `0` disables either). The second one is the one that matters
at the database level: a transaction left open with nothing running pins `backend_xmin`, and
vacuum then cannot clean any row version newer than it anywhere in the database.

The third timeout is client-side: `DB_CONNECTION_TIMEOUT_MS` bounds how long a request waits for
a connection **from the pool**. Without it there is no timer on that wait at all — once all ten
clients are checked out, callers queue indefinitely, and the symptom is requests that never
answer with nothing logged and no failing statement to point at. Five seconds is far longer than
a healthy checkout, and past it the pool sheds load instead of growing a queue.

### `@clavis/app`

React 19 SPA served by Vite 7 in development and by nginx under the `full` profile.
**No CSS framework and no extra dependencies**: `src/index.css` with CSS variables and light/dark
support through `prefers-color-scheme`.

| Area | Responsibility |
|---|---|
| `src/config.ts` | Resolves configuration at runtime: `window.__CLAVIS_CONFIG__` → `import.meta.env.VITE_*` → development defaults. |
| `src/auth/keycloak.ts` | **Singleton** `keycloak-js` instance and an `init()` promise **memoised at module level**. |
| `src/auth/AuthProvider.tsx` | Context + `useAuth()`: `{ ready, authenticated, me, meStatus, meError, roles, permissions, isRoot, has(perm), login(), logout(), token() }`. |
| `src/auth/Can.tsx` | `<Can perm="users:create">…</Can>`, with an optional `fallback`. |
| `src/router.tsx` | The `NAV_ITEMS` manifest, the code-based TanStack Router route tree and the `beforeLoad` permission guards. |
| `src/api/client.ts` | `apiFetch<T>()`: injects `Authorization: Bearer`, unwraps the error envelope and throws `ApiError` with `status` and `code`. |
| `src/api/{me,users,access,audit}.ts` | Types + React Query hooks, one file per API module. |
| `src/i18n/` | Hand-written English/Spanish catalogues and the `I18nProvider` that exposes `useI18n()`. |

Routing is **code-based**, not file-based: `@tanstack/react-router` route definitions live in one
file next to the manifest they are generated from, so a section and its guard cannot drift apart.
The router context carries the auth value, and `App.tsx` calls `router.invalidate()` whenever
`permissions` or `isRoot` changes, so a revoked permission re-runs the guards and ejects the user
from the screen they are on.

Three details that are a classic source of bugs and are solved here on purpose:

- **React 19 StrictMode mounts effects twice.** Calling `keycloak.init()` twice throws, which is
  why the init promise is memoised outside the component tree.
- **`token()` is asynchronous** and runs `updateToken(30)` before returning the JWT, so a request
  never leaves with a token that is about to expire.
- **A `403` on `/api/me` is a decision, not a failure.** The provider surfaces it as
  `meStatus: 'blocked'` and `App.tsx` renders a screen explaining it (disabled account, or an
  identity with no application user) with a sign-out button, instead of an empty application.

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
        SPA["@clavis/app<br/>React 19 · TanStack Router · keycloak-js · React Query"]
    end

    SH["@clavis/shared<br/>PERMISSION_DEFS · PermissionKey"]

    subgraph api["@clavis/api — Express 5"]
        AUTH["http/auth<br/>jose + remote JWKS<br/>authenticate / requirePermissions"]
        ACC["lib/access<br/>effective permissions"]
        BOOT["bootstrap/seed<br/>catalog · admin role · root"]
        KA["infra/keycloak-admin<br/>service account · Admin REST"]
        MOD["modules (routes → service → repository)<br/>health · me · users · access · audit"]
        DB["infra/db<br/>pg.Pool · query · tx"]
        CACHE["infra/cache<br/>ioredis · version per namespace"]
        STO["infra/storage<br/>@azure/storage-blob"]
        MAIL["infra/mailer<br/>resend | dry-run"]
        MIG["migrator<br/>migrations/*.sql + checksum"]
    end

    subgraph infra["Infrastructure"]
        KC["Keycloak 26.4<br/>realm clavis"]
        PG[("PostgreSQL 17.6<br/>schema clavis")]
        VK[("Valkey 8.1")]
        AZ[("Azurite 3.35<br/>clavis-attachments")]
    end

    RS["Resend<br/>(external, optional)"]

    SH -.->|"PermissionKey"| SPA
    SH -.->|"PermissionKey"| MOD
    SH -.->|"catalog"| BOOT
    SPA -->|"OIDC PKCE S256"| KC
    SPA -->|"Bearer JWT"| AUTH
    AUTH --> ACC
    ACC --> CACHE
    ACC --> DB
    AUTH --> MOD
    AUTH -->|"internal JWKS"| KC
    BOOT --> DB
    BOOT --> KA
    MOD --> KA
    KA -->|"Admin REST, client_credentials"| KC
    MOD --> DB
    MOD --> CACHE
    MOD --> MAIL
    MOD --> STO
    MIG --> PG
    DB --> PG
    CACHE --> VK
    STO --> AZ
    MAIL -.-> RS
    KC --> PG
```

### Lifecycle of an authenticated request

1. `authenticate` pulls the `Bearer` out of the `Authorization` header.
2. `jose` verifies the signature (JWKS from the internal issuer), `iss`, `aud` and `exp`, with a
   5-second `clockTolerance`.
3. `authState.auth` is built from `sub`, `preferred_username`, `email` and `name`. **That is all
   the token contributes** — it carries no roles and no permissions.
4. The **access context** is resolved for that `sub`: read from Valkey under
   `clavis:v<version>:access:user:<sub>`, and on a miss from PostgreSQL in a single query that
   returns the user row, their role slugs and their effective permissions. The result is cached
   for `CACHE_TTL_SECONDS`.
5. Two refusals happen here, both `403` because authentication already succeeded: no row in
   `clavis.users` → `USER_NOT_PROVISIONED`; `status = 'disabled'` → `ACCOUNT_DISABLED`. There is
   **no just-in-time provisioning**: an identity does not become a user by showing up.
6. `authState.access` is set, and `last_seen_at` is refreshed fire-and-forget — never worth
   failing a request over.
7. `requirePermissions(...)` checks the AND of the permissions the route demands (root bypasses);
   on failure it returns `403` with the standard envelope, naming the missing keys.
8. The handler runs. Every handler that mutates roles, users or overrides bumps the `access`
   namespace after committing, so the change is visible on the **next** request.

The full model, including the effective-permission formula and the bump rule, is in
[`access-control.md`](access-control.md).

---

## 3. Database

Schema `clavis` in the `clavis` database. Keycloak uses a **separate** database (`keycloak`) on the same
PostgreSQL instance, created idempotently by `infra/postgres/00-init-databases.sh`. They share a
server but **not** a schema: identity and business data do not mix.

Seven tables, and every one of them exists to answer "what may this person do".

```mermaid
erDiagram
    users ||--o{ user_roles : "user_id"
    roles ||--o{ user_roles : "role_slug"
    roles ||--o{ role_permissions : "role_slug"
    permissions ||--o{ role_permissions : "permission_key"
    users ||--o{ user_permission_overrides : "user_id"
    permissions ||--o{ user_permission_overrides : "permission_key"

    users {
        uuid id PK "the id Keycloak assigned"
        text username UK
        text email UK
        text display_name
        boolean is_root
        text status "CHECK active / disabled"
        timestamptz created_at
        timestamptz updated_at
        timestamptz last_seen_at
    }
    permissions {
        text key PK "module:action"
        text module
        text description
        timestamptz created_at
    }
    roles {
        text slug PK
        text name
        text description
        boolean is_system
        timestamptz created_at
        timestamptz updated_at
    }
    role_permissions {
        text role_slug PK "FK CASCADE"
        text permission_key PK "FK CASCADE"
    }
    user_roles {
        uuid user_id PK "FK CASCADE"
        text role_slug PK "FK CASCADE"
    }
    user_permission_overrides {
        uuid user_id PK "FK CASCADE"
        text permission_key PK "FK CASCADE"
        text effect "CHECK grant / revoke"
        uuid created_by "no FK"
        timestamptz created_at
    }
    audit_log {
        bigint id PK "GENERATED ALWAYS AS IDENTITY"
        uuid actor_id "no FK"
        text action "entity.verb"
        text entity
        text entity_id
        jsonb payload
        timestamptz created_at
    }
```

### Modelling decisions

- **`clavis.users.id` is the id Keycloak assigned.** There is no parallel internal ID and no
  mapping table: the `sub` claim indexes the row directly. It is the only value the two systems
  share, and the application obtains it by creating the Keycloak user *first* and keeping what
  comes back.
- **`clavis.permissions` is a projection of code, not a configuration table.** The boot sync
  upserts `PERMISSION_DEFS` and deletes anything else, cascading into `role_permissions` and
  `user_permission_overrides`. It exists so the assignment tables can have real foreign keys and
  so the UI can render descriptions.
- **`status` and `effect` are `text` with `CHECK`, not PostgreSQL enums.** A `CHECK` constraint
  can be altered in a plain migration; an enum type cannot, not without a dance.
- **`audit_log.actor_id` and `user_permission_overrides.created_by` carry no foreign key.** The
  record of who did something must survive the deletion of the person who did it.
- **`gen_random_uuid()` is native in PostgreSQL 17**: neither `pgcrypto` nor `uuid-ossp` is
  installed. One extension fewer is one difference fewer between environments.
- **Indexes**: `user_roles(role_slug)` and `role_permissions(permission_key)` for the reverse
  lookups the Access screen makes, and `audit_log(created_at DESC)` for the trail paginated by
  date descending. The forward lookups are covered by the composite primary keys.
- **`updated_at` is maintained by the database**, not by the application: the
  `clavis.set_updated_at()` function plus `BEFORE UPDATE` triggers on `clavis.users` and
  `clavis.roles`.

The formula that reads all of this — `union(role permissions) ∪ grants − revokes`, with
`is_root` short-circuiting — is one query in `src/lib/access.ts` and is explained in
[`access-control.md`](access-control.md#2-the-data-model).

### Migrations

- Files under `packages/api/migrations/YYYYMMDDHHMMSS_name.sql`, applied in **lexicographic
  order** (`0001_init.sql` predates the convention and keeps its name forever):
  `0001_init.sql` — schema, the seven tables, indexes, function and triggers — followed by the
  timestamped ones.
- The `clavis.schema_migrations (version, checksum, applied_at)` registry **is created by the migrator
  itself**, not by a migration; that way the migrator can start against an empty database. It
  takes a PostgreSQL advisory lock first, so two API replicas starting at once do not race.
  The lock is taken with `pg_try_advisory_lock` in a retry loop that logs each attempt and gives
  up after a minute: a lock left behind by a session that never ended would otherwise stop every
  instance from ever starting, with nothing in the log to say why.
- It runs on a **connection of its own**, opened from `DATABASE_URL` and closed when it is done,
  not one borrowed from the application pool. Releasing a pooled client does not reset session
  state, so anything a migration `SET`s would reach whatever request picked that connection up
  next; and the pool's `statement_timeout` / `idle_in_transaction_session_timeout`, sized for
  requests, must not apply to DDL that may legitimately take minutes. Ending the session also
  releases the advisory lock.
- Each migration is applied exactly once and its **checksum** is stored. Editing a file that has
  already been applied fails at startup instead of silently diverging between environments. To
  change something you add a new migration (see
  [`operations.md`](operations.md#add-a-migration)).
- The check runs **both ways**, and where the missing version *sorts* decides what it means. A
  recorded version that sits **between** the files this build carries aborts startup: migrations
  are keyed by file name, so that is what a renamed or deleted migration looks like, and a
  renamed one would be applied again from scratch. A recorded version that sorts **after** every
  file on disk is a **rollback** — the previous image redeployed after a migration shipped — and
  it only warns. The schema is a superset of what the older code expects, which is precisely why
  rolling back works; aborting would put the container in a `restart: unless-stopped` loop with
  no way out at the worst possible moment.

> **The migration history was reset** when authorization moved into the database: the previous
> `0001`/`0002` pair is gone and `0001_init.sql` is a fresh file with a different checksum. An
> environment created before that commit refuses to start; the fix is `pnpm run reset` locally,
> and it needed a one-time `DROP SCHEMA clavis CASCADE` on the production database.

---

## 4. Versioned cache in Valkey

The most frequent read in the system is not a business query: it is **the access context**, which
every authenticated request resolves before it does anything else. It is cached in Valkey with a
**namespace version** strategy rather than key deletion.

**Key:**

```
clavis:v<version>:access:user:<sub>          TTL = CACHE_TTL_SECONDS (60 s)
```

- `<version>` — integer counter for the `access` namespace, obtained with
  `cache.version('access')` (created as `1` if it does not exist).
- `<sub>` — the user. One entry per person, holding the user row, their role slugs and their
  effective permission list.

**Invalidation:** every write that could change somebody's permissions calls
`cache.bumpVersion('access')`, which runs `INCR` on the counter. From that moment on every new
key is built with `v<version+1>` and **the old ones are orphaned**: nobody reads them and they
expire on their own by TTL.

The writes that bump it: creating, updating and deleting a user; replacing a user's overrides;
creating a role, replacing its permissions or deleting it; and the boot catalog sync.

```mermaid
sequenceDiagram
    participant B as Bob's client
    participant A as API
    participant V as Valkey
    participant R as Root's client

    B->>A: GET /api/users
    A->>V: version('access') → 7
    A->>V: GET clavis:v7:access:user:bob → null
    A->>A: resolve from PostgreSQL, cache it
    A-->>B: 403 (no users:read)

    R->>A: PUT /api/access/users/bob/overrides  (grant users:read)
    A->>V: bumpVersion('access') → 8

    B->>A: GET /api/users
    A->>V: version('access') → 8
    A->>V: GET clavis:v8:access:user:bob → null
    A->>A: resolve from PostgreSQL (now with the grant)
    A-->>B: 200
```

Bob never refreshed his token. That is the property the whole design is for.

Why a version instead of `DEL` by key:

- Deleting the right keys means knowing which users a change affected — for a role edit that is a
  join, and for a catalog sync it is everybody. `INCR` is O(1), atomic, and invalidates all of
  them at once.
- Invalidating with `SCAN` + `DEL` over a pattern is O(n) across the whole keyspace and hard to
  make atomic.
- The price is the temporary memory held by dead keys, bounded by the TTL.

Cache failures **degrade to a miss** rather than an error: every operation in the cache service
catches, logs and falls through to PostgreSQL, so Valkey being down makes the API slower and not
broken.

---

## 5. Blob storage

Azurite is the official Azure Storage emulator. It is used through `@azure/storage-blob` with the
standard development connection string (`AZURE_STORAGE_CONNECTION_STRING`), whose account key is
**public and documented by Microsoft**: it is not a secret, which is why it lives in
`.env.example`. Swapping Azurite for a real Azure Storage account means changing that string and
nothing else.

Container: `AZURE_STORAGE_CONTAINER` = `clavis-attachments`, created by the `storage` service at
startup if it does not exist (idempotent). The service exposes `upload`, `download`, `remove` and
`ping`, and `ping` is one of the four checks behind `GET /api/health/ready`.

**No feature uses it today.** The access-control base has nothing to attach. It stays wired, and
in the readiness probe, on purpose: it is the piece a business module would need on day one, and
a dependency that is only added when it is first needed is a dependency whose Docker wiring,
health check and production credentials all get debugged under pressure.

`MAX_UPLOAD_BYTES` (10 MiB) is the ceiling reserved for file uploads. It no longer bounds JSON
bodies: those are capped by `JSON_BODY_LIMIT_BYTES` (128 KiB by default), because a JSON body is
parsed whole on the event loop while an upload will stream past it — two different costs, two
different ceilings. The first route that accepts a file upload brings its own multipart middleware
(multer or busboy) and reuses `MAX_UPLOAD_BYTES`.

---

<a id="public-issuer-vs-internal-issuer"></a>

## 6. Public issuer vs internal issuer

This is the least obvious decision in the project and the one that prevents the most trouble.

The browser and the API **see Keycloak at different addresses**:

| Who | How it reaches Keycloak |
|---|---|
| Browser (outside Docker) | `http://localhost:8080` |
| API (inside `clavis-net`) | `http://keycloak:8080` — `localhost` would be the API container itself |

The catch is that the token carries **a single** `iss`, the one Keycloak considers its public
hostname: `http://localhost:8080/realms/clavis`. If the API validated `iss` against the URL it uses to
talk to Keycloak (`http://keycloak:8080/...`), **every token would be rejected** even though they
are perfectly valid. And the other way round: if it tried to download the JWKS from
`http://localhost:8080`, inside the container that resolves to nothing.

The solution is two variables with two separate uses:

| Variable | Value | Used for |
|---|---|---|
| `KEYCLOAK_ISSUER` | `http://localhost:8080/realms/clavis` | Comparing against the token's `iss` claim (it must match **exactly**, no extra trailing slash) |
| `KEYCLOAK_INTERNAL_ISSUER` | `http://keycloak:8080/realms/clavis` | Deriving the JWKS URL (`<internal>/protocol/openid-connect/certs`), the service-account token URL and the Admin REST base (`/realms/<realm>` → `/admin/realms/<realm>`) |

```mermaid
flowchart LR
    B["Browser"] -->|"gets a token from<br/>http://localhost:8080"| KC["Keycloak"]
    B -->|"Bearer with<br/>iss = http://localhost:8080/realms/clavis"| API["API"]
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
    T["realm-clavis.template.json<br/>__VARIABLE__ markers"] --> R
    R -->|"writes /import/realm-clavis.json"| VOL[("keycloak-import<br/>volume")]
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

### What the API does before it listens

`api` depends on `postgres`, `valkey`, `azurite` **and `keycloak`**, all with
`condition: service_healthy`. That last one is not decoration: the boot sequence talks to
Keycloak before the first request arrives.

```mermaid
flowchart LR
    M["migrator<br/>migrations/*.sql"] --> C["catalog sync<br/>PERMISSION_DEFS → clavis.permissions"]
    C --> R["system role 'admin'<br/>re-seeded with the full catalog"]
    R --> K["root<br/>found or created in Keycloak,<br/>password re-applied, row upserted"]
    K --> B["bumpVersion('access')"]
    B --> L["listen"]
```

Service creation order is `db → cache → storage → mailer → keycloak-admin`, then the seeding,
then the listener, and every step above is idempotent, so a restart is always safe. `keycloakAdmin.ready()` retries
the service-account token up to ten times at 1.5-second intervals, because `pnpm dev` outside
Docker has none of Compose's ordering guarantees.

The consequence to keep in mind: **a fresh database is never empty**. It always has the six
catalog rows, the `admin` role and root. See
[`access-control.md`](access-control.md#root).

---

## 8. The API image inside a pnpm monorepo

The `Dockerfile` in `packages/api` is multi-stage and has one quirk worth knowing before touching
it:

1. It copies `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `package.json`, `tsconfig.base.json` and
   **the `package.json` of every package**. If one is missing, `--frozen-lockfile` fails: the
   lockfile describes the whole workspace, not a single package.
2. It installs with `--filter @clavis/api...` — the trailing `...` is what pulls in
   `@clavis/shared`, which the API imports.
3. It builds with `tsc`, `@clavis/shared` first.
4. It reinstalls with `--prod` to drop the development dependencies.
5. The final stage copies **all of `/repo`**: the symlinks pnpm creates in `node_modules` are
   **relative**, so they stay valid when the whole tree is copied — but they break if you copy only
   `packages/api/node_modules`.

pnpm is installed into the image with `npm i -g pnpm@11.9.0` (exact version). Final command:
`node dist/main.js`.
