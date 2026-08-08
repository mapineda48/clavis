# Project instructions

Access-control lab built around Keycloak. pnpm monorepo with three packages
(`@clavis/api`, `@clavis/app` and `@clavis/shared`) and the whole infrastructure
in `docker compose`. Keycloak only AUTHENTICATES; authorization lives in the
application database, resolved per request from roles, per-user overrides and
the permission catalog declared in `@clavis/shared`.

---

## MANDATORY

These are not preferences: breaking them breaks the project or leaks data.

### 1. Language

Everything written **into this repository is in English**: source code, identifiers,
comments, log messages, error messages, UI strings, database comments, documentation,
documentation file names and commit messages.

- The user talks to the agent in Spanish. The agent **may reply to the user in the
  language the user writes in** — that is about the conversation, not about the
  artefacts. Nothing that lands in the repository is in Spanish.
- Two deliberate exceptions, and only these two: the Spanish translation catalogues,
  `packages/app/src/i18n/es.ts` and the Keycloak theme's `messages_es.properties`.
  They exist precisely so the product supports Spanish.
- Git history written before this policy stays exactly as it is, for traceability.
  **Do not rewrite it.**
- Why: this is a public portfolio lab. English makes it readable and auditable by
  anyone who lands on it.

### 2. Commit messages

- **NEVER** include a `Claude-Session:` trailer, or any session, conversation or tool
  URL, in a commit message. The history is public.
- `Co-Authored-By:` at the end is allowed.
- English, imperative mood, type prefix (`feat:`, `fix:`, `docs:`, `refactor:`,
  `chore:`). The body explains **why**, not just what.

### 3. Secrets

- The **only** real secret in this project is `RESEND_API_KEY`. It lives in `.env`
  only, which is in `.gitignore` and must **never** be committed.
- `.env.example` is committed with development values, never with real ones.
- Do not write passwords into the Keycloak theme, the code or the documentation.
  Always point at `.env.example` instead.
- Before publishing or pushing anything, audit the **full history**, not just the
  working tree: a secret in an old commit is still there even if the current file is
  clean.
- Keep personal data (real email addresses) out of committed file contents. Commits
  use the GitHub *noreply* address.

### 4. Determinism

- **Exact** versions in `package.json` (no `^`, no `~`) and Docker images pinned to a
  fixed tag. Never `latest`.
- `pnpm-lock.yaml` is committed. Approved install scripts are declared in
  `pnpm-workspace.yaml` (`allowBuilds`), not with a manual `pnpm approve-builds`.

---

## Commands

```bash
pnpm install                 # install the workspace
pnpm run up                  # docker compose up -d --build
pnpm run down                # stop the stack (keeps data)
pnpm run reset               # down -v: wipes volumes and REIMPORTS the realm
pnpm dev                     # API and SPA outside Docker, in parallel
pnpm build / pnpm typecheck  # both packages
pnpm test                    # unit tests (node:test); no service required
pnpm run verify              # the two suites that need no external CLI
```

Individual suites: `./scripts/verify-api.sh`, `./scripts/verify-login-theme.sh`,
`./scripts/verify-password-reset.sh`.
**Run the matching suite after touching the API, the theme or the realm.**

---

## Known traps

Every one of these cost a real failure. Do not rediscover them.

### API (`@clavis/api`)

- It is **ESM with `moduleResolution: NodeNext`**: every relative import carries the
  `.js` extension, even though the source is `.ts`.
- `ioredis` is CommonJS: under ESM you must use the **named** export
  (`import { Redis } from 'ioredis'`); the default export is not constructible.
  `ajv-formats` is the same trap in the other direction: Node hands its default
  binding the function, TypeScript types it as the namespace — the bridge lives in
  `http/validate.ts`, do not repeat the fight at call sites.
- The layering is one-way and it is the point of the structure: `routes.ts`
  (Express, validation, serialization) → `service.ts` (rules, Keycloak
  orchestration, `mutate()`) → `repository.ts` (SQL over an `Executor`).
  **No SQL and no Keycloak calls in routes; no Express in services.** Modules
  without rules (audit, health, me) skip the service layer, they do not fake one.
- Route validation uses **JSON Schema compiled with ajv** (`http/validate.ts`),
  not zod. `zod` is only used in `src/config/env.ts`. The ajv options mirror the
  previous Fastify behaviour on purpose: query/params coerce, defaults fill in,
  and `additionalProperties: false` **strips** extras instead of rejecting.
- **Nothing filters a response against its schema at runtime** (that Fastify
  behaviour is gone): `responses` in a `RouteDef` is documentation, the
  serializer in `schemas.ts` is the contract, and the unit test comparing them
  field for field is the guarantee. Add a field in both or that test fails.
  For error statuses use `errorResponses(401, 403, 404)` from `http/openapi.ts`,
  not a copy of the `$ref`.
- A `RouteDef.permissions` field wires the middleware AND documents `security`:
  `null` = public, `[]` = any authenticated user, keys = authenticated + all of
  them. There is no separate security annotation to forget.
- **Configuration is passed, never imported.** `loadConfig(env)` is pure — it
  returns or throws, it does not read `process.env` and it does not exit.
  `src/main.ts` is the only file that may do either. Every factory takes its
  slice as options (`Pick<AppConfig, …>`); a module that imports the
  configuration puts an exit back behind every import of it.
- Adding an OpenAPI tag or a route module means adding **one entry** to the
  `modules` list in `app.ts`, which is read for the routers and for the
  document (tags and paths).
- Express 5 exposes `req.query` through a **getter**: assigning it throws and
  in-place coercion does not stick. `http/validate.ts` validates a copy and
  shadows the property with `Object.defineProperty` — new middleware that
  normalises request data must do the same.
- pino-http's DEFAULT `req` serializer logs **every request header**, and every
  authenticated request here carries `Authorization: Bearer <live token>` — the
  default writes a replayable credential into the logs. The slim `req`/`res`
  serializers in `app.ts` are the fix; removing them reintroduces the leak.
- Express matches routes case-insensitively and ignores trailing slashes by
  default, and a Router does **not** inherit the app's settings. The app sets
  `strict routing` + `case sensitive routing` and `createModuleRouter` passes
  `{ caseSensitive: true, strict: true }`; a new Router needs the same flags or
  `/API/users/` quietly becomes an alias.
- Node's HTTP server closes idle keep-alive sockets after **5 seconds**; the
  reverse proxy reuses them for ~90. `main.ts` sets `keepAliveTimeout` to 72 s
  (Fastify's default, the reason this never bit before) with `headersTimeout`
  just above it — losing that race surfaces as intermittent 502/ECONNRESET
  under real traffic only.
- Unit tests live in `packages/api/test/` and run with `node --import tsx --test`
  (`node:test`, no new dependency). They cover **pure logic only** — the live
  stack is `scripts/verify-api.sh`'s job, and it already runs in CI.
  `tsconfig.test.json` typechecks them; the build config still compiles `src`
  alone so `dist` keeps its shape.
- The public issuer (`KEYCLOAK_ISSUER`) and the internal one
  (`KEYCLOAK_INTERNAL_ISSUER`) differ on purpose: the browser sees `localhost:8080`
  and the container sees `keycloak:8080`. JWKS is fetched over the internal one; `iss`
  is validated against the public one.

### Access control (the base every module builds on)

- Permission KEYS are declared in `packages/shared/src/permissions.ts` and synced
  into `clavis.permissions` at boot. Adding a permission = add it there, gate the
  route with `requirePermissions('<key>')`, reference it from the SPA
  (`NAV_ITEMS`, guards, labels). The database owns ASSIGNMENTS only.
- Effective permissions are resolved per request from Postgres through the
  Valkey `access` namespace (versioned keys). **Every mutation of users, roles
  or overrides must invalidate `access`** or the change waits out the TTL.
  Request mutations get that from `mutate()`, whose `invalidate` is required
  rather than optional; anything outside a request (boot seeding) still calls
  `cache.bumpVersion('access')` by hand. `is_root` bypasses everything and root
  is immutable through the API.
- **Nobody edits their own privileges**, and the check is `assertNotSelf`
  (`lib/access.ts`), not a copy per route. It guards `PATCH /users/:id`
  (`roles`, `status`), `DELETE /users/:id` and
  `PUT /access/users/:id/overrides` — a new route that changes what somebody
  may do needs it too. It is keyed on identity, so it stops one account raising
  itself in one request and nothing more: two accounts can still grant each
  other, and `POST /users` can still create a privileged account. Say that in
  the docs rather than implying the guard is stronger than it is.
- Request mutations go through `mutate()` (`lib/mutate.ts`): one transaction
  carrying the write **and** its `audit_log` row, then the bump after COMMIT.
  So an `audit_log` insert failure fails the user's write — deliberate: in an
  access-control system an unaudited privileged write is worse than a failed
  one. Bumping before the commit would let a concurrent request repopulate the
  new version with the pre-commit state.
- **Tripwire: partition `clavis.audit_log` by month before it carries real
  volume.** It is the only unbounded table in the schema, its
  `created_at DESC` index is monotonic (so its rightmost page is a contention
  point), and every domain write now waits on that insert. Retrofitting a
  partition onto a large live table is the expensive version of this job; doing
  it while the table is small is not.
- Every function that touches the database takes an `Executor` first
  (`lib/executor.ts`) and **never opens a transaction of its own**: whether a
  statement runs alone (`app.db`) or inside one somebody else began (`client`)
  is the caller's decision. A function that opens its own cannot be composed
  into a larger unit of work, which is exactly how the audit row ended up
  outside the transaction it describes.
- **No network I/O inside `tx()`.** An open transaction across a Keycloak REST
  round trip pins `backend_xmin`, stops vacuum database-wide and holds every row
  lock it has taken for the length of an HTTP call to another system. Keycloak
  calls go before or after the `tx`, never inside it — and a two-system write
  that fails on the second system compensates the first (see `POST`/`PATCH`
  `/api/users`).
- Users are created FROM the app: Keycloak first (the id it assigns is the PK of
  `clavis.users`), database second, compensating delete on failure. The realm is
  re-imported with `--override` on every prod deploy, so app-created Keycloak
  users do NOT survive it — the app database is the authority; root is re-seeded
  by the API at boot from `ROOT_*`.
- A user with a pending required action (temporary password, invitation) gets
  "Account is not fully set up" from the password grant. That is the contract,
  not a bug; the verify suite completes first logins via `kc_finish_setup`.
- The realm declares its user profile with firstName/lastName OPTIONAL. Keycloak's
  default profile requires both, and a user created without a last name cannot
  log in ("Account is not fully set up") — do not remove that `components` block.

### PostgreSQL and migrations

- New migrations are named **`YYYYMMDDHHMMSS_description.sql`** (UTC). Sequential
  numbering collides across branches; a timestamp cannot, and it still sorts
  after `0001_init.sql`.
- **`0001_init.sql` is never renamed.** The migrator keys migrations by file
  name, so a rename reads as a brand new migration and the whole file runs again
  against a schema that already has it. Startup aborts on a recorded version
  that sits **between** the files on disk, which is what that mistake looks like
  from the database. A recorded version **after** all of them is a rollback (the
  previous image, redeployed) and only warns: the schema is a superset the older
  code runs fine against, and aborting would be a `restart: unless-stopped` loop
  with no escape hatch.
- An applied migration is **immutable**: its sha256 is recorded, and editing it
  fails startup. Change something by adding a file.
- The migrator runs on a **connection of its own**, not one from the pool.
  Releasing a pooled client does not reset session state, and the pool's
  timeouts must not apply to DDL. It takes the advisory lock with
  `pg_try_advisory_lock` in a bounded retry loop — the blocking version waits
  forever, and a lock from a session that never ended then stops every instance
  from starting with nothing in the log.
- `SET LOCAL` **before** `BEGIN` is a silent no-op: it applies to the implicit
  transaction of that statement alone and is gone by the time the real one
  starts. Reproduced against this project's PostgreSQL.
- The application pool sets `statement_timeout` and
  `idle_in_transaction_session_timeout` on every connection
  (`DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`; `0` disables
  them). They are `SET` statements through pg-pool's `onConnect`, which the pool
  awaits — a listener on the `connect` event races the first query instead. Do
  not move them into `-c` startup options: a pooler that does not know the
  parameter refuses the connection, while one that resets a `SET` merely leaves
  the timeout unapplied.
- The pool also sets `connectionTimeoutMillis` (`DB_CONNECTION_TIMEOUT_MS`).
  Without it `pool.connect()` has **no timer**: a saturated pool queues callers
  forever and the symptom is requests that never answer, with nothing logged and
  no failing statement to point at.
- A FATAL from the server (that idle timeout, an administrative terminate)
  arrives as an `error` **event** on a client with no query in flight, and the
  pool takes its own listener off while a client is checked out. `db.tx()`
  attaches one for the length of the checkout; without it the event is unhandled
  and the process dies.
- `client.release()` with **no argument** returns the client to the idle pool
  unless it is unqueryable. So a failed ROLLBACK must be passed to `release()`:
  otherwise the connection goes back inside an aborted transaction and the next
  checkout answers `25P02` to every statement, on a request that did nothing
  wrong.

### Keycloak and the theme

- The theme's `.properties` files are read as **ISO-8859-1**: write accented letters
  and `ñ` as Java unicode escapes — a backslash followed by `u00e1`, `u00f1` and so
  on — never as literal accented characters. That includes comments. English wording
  needs no escapes, which is why only `messages_es.properties` carries them.
- `start-dev` **does not cache** `.ftl` templates or the CSS: edit and reload is
  enough. But `theme.properties` **is** cached: it needs a container restart.
- The base theme's `passwordVisibility.js` **replaces the icon's whole `className`**,
  so `kcFormPasswordVisibilityIconShow/Hide` must stand on their own.
- The realm only reads `loginTheme`, `emailTheme`, `smtpServer`,
  `resetPasswordAllowed`, `defaultLocale` and friends **at import time**. For a realm
  that already exists, apply them with `kcadm.sh` (see `docs/operations.md`) or run
  `pnpm run reset`.
- `actionTokenGeneratedByUserLifespan` is a **top-level** realm field, not an
  `attributes.*` entry. With `-s attributes.…` it silently does nothing.
- Composite realm roles must declare `offline_access` and `uma_authorization`
  explicitly in `roles.realm`, or the import fails with
  "Unable to find composite realm role".

### Language and i18n

- Translating prose must never touch identifiers. The database schema (`clavis.users`,
  `clavis.roles`, `clavis.permissions`, `clavis.user_permission_overrides`, …), the realm
  and its clients (`clavis`, `clavis-app`, `clavis-api`), the permission keys
  (`users:read`, `users:create`, `access:manage`, `audit:read`, …), env var names,
  service names, ports, `clavis-*` CSS classes and source file names are already
  English and are part of the contract. Renaming any of them is a behaviour
  change, not a translation.
- The SPA catalogues live in `packages/app/src/i18n/`. `en.ts` is the **source of
  truth**: `TranslationKey` is derived from it, and `es.ts` is typed
  `Record<TranslationKey, string>`, so a missing or extra key fails `pnpm typecheck`
  instead of showing up as a blank label at runtime. Add the key to `en.ts` first.
- The Keycloak theme mirrors the same rule: `messages_en.properties` is the reference
  catalogue, `messages_es.properties` must carry every key it has.
- OpenAPI tag names are shared state. Each module declares its tag once, in its
  `ModuleDef` (`modules/<name>/routes.ts`), and every route in the module is
  published under it; renaming the tag is that one edit, and the routers and the
  document cannot disagree because both are derived from the same list.
- Renaming a documentation file means fixing **every** reference to it across the
  repo (`README.md`, the other docs, this file, source comments). Heading anchors
  change too when the headings change language, so the deep links break with them.

### Deployment (`infra/terraform`, `infra/deploy`)

Full detail in `docs/deployment.md`. The ones that bite hardest:

- cloud-init runs `runcmd` with **dash**. `set -euxo pipefail` aborts on the
  `set` line itself and nothing below it runs; the only symptom is
  `cloud-init status: error` on a host where nothing was installed.
- **blobfuse2 serves stale file content.** A blob overwritten in place keeps
  reading as its previous version while the directory listing refreshes
  normally. Anything whose freshness matters is fetched over HTTPS with the SAS,
  not through the mount.
- `libfuse.mount-options` is **not a real key** and is ignored silently; the
  real ones are the scalars `libfuse.uid` / `libfuse.gid`. Declaring
  `components:` replaces the default pipeline, so `file_cache` and `attr_cache`
  have to be listed explicitly.
- Traefik refuses any ACME store with group or other permission bits, and
  `chmod` on a flat-namespace container returns success without doing anything.
  The store lives on local ext4 at 0600 and is copied to and from the mount.
  **One store per resolver**: Traefik serves by SNI from a single merged store,
  so a staging certificate stops the production resolver ever ordering.
- Never `rm -rf` the stack directory: bind mounts resolve to an inode at
  container start, and Traefik would keep reading a deleted path while serving
  its old configuration.
- An EXIT trap whose last command fails **replaces** the script's exit status.
- `cap_drop: ALL` removes `CAP_DAC_OVERRIDE` (root can no longer read files it
  does not own) and `CAP_CHOWN`. Keycloak cannot run `read_only`; everything
  else can.
- `kc.sh import` needs `--optimized`, and `start --import-realm` is hard-wired
  to IGNORE_EXISTING — which is why a one-shot `import --override` runs on every
  deploy and the demo users carry **fixed ids**.
- `frameDeny: true` sends `X-Frame-Options: DENY` on `/silent-check-sso.html`
  and hangs the SPA on "checking session" with nothing logged. Use SAMEORIGIN.
- Cloudflare's `/user/tokens/verify` does **not** evaluate the token's IP
  condition, so it proves nothing as a preflight.
- A redeploy of the **same commit** never reaches the host: reconcile converges
  on the commit, and the overwritten bundle reads stale through blobfuse2.
  Configuration-only changes (e.g. the cert resolver) need a new commit.
- A staging certificate **shadows** the production resolver even with one store
  per resolver: Traefik merges every store into one SNI map and never orders.
  Retire the staging store (local and blob) when flipping to production.
- The Azure OIDC federated subjects embed the **repository name** (both
  formats). Renaming the repo means updating both credentials, and the change
  propagates eventually — expect AADSTS700213 flapping for a few minutes.

### Mail

These are **two different paths**: the API sends through Resend's **HTTP API**, and
Keycloak can only send over **SMTP**. That is why the realm points at Resend's SMTP
relay, reusing `RESEND_API_KEY` as the password.

### Shell

`.env` **cannot simply be `source`d**: `MAIL_FROM` contains `<...>`. Values with
spaces are quoted (Docker Compose strips the quotes when interpolating). To read a
single variable, use `envval` from `scripts/_common.sh`.

---

## Structure

```
packages/api/     Express 5 + TypeScript (ESM). Validates the token, resolves access from Postgres.
packages/app/     React 19 + Vite + keycloak-js (PKCE S256) + @tanstack/react-router.
packages/shared/  The typed permission catalog: source of truth for API and SPA.
infra/keycloak/   Realm template (__VAR__ placeholders) and the custom theme.
infra/postgres/   Init for Keycloak's database.
scripts/          End-to-end verification suites.
docs/             architecture.md, authentication.md, operations.md.
```

The realm is rendered at startup: `render-realm.mjs` replaces the `__VARIABLE__`
placeholders with environment variables and **fails if any of them is left
unresolved**.

---

## When you finish a task

1. `pnpm typecheck && pnpm build`.
2. The verification suite that applies.
3. Check you added no secrets and no personal data.
4. Check nothing you wrote landed in Spanish outside the two translation catalogues.
5. Commit following the rules above.
