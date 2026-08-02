# Project instructions

Access-control lab built around Keycloak. pnpm monorepo with two packages
(`@erp/api` and `@erp/app`) and the whole infrastructure in `docker compose`.

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
pnpm run verify              # the two suites that need no external CLI
```

Individual suites: `./scripts/verify-api.sh`, `./scripts/verify-login-theme.sh`,
`./scripts/verify-password-reset.sh`.
**Run the matching suite after touching the API, the theme or the realm.**

---

## Known traps

Every one of these cost a real failure. Do not rediscover them.

### API (`@erp/api`)

- It is **ESM with `moduleResolution: NodeNext`**: every relative import carries the
  `.js` extension, even though the source is `.ts`.
- `ioredis` is CommonJS: under ESM you must use the **named** export
  (`import { Redis } from 'ioredis'`); the default export is not constructible.
- Route validation uses **Fastify JSON Schema**, not zod. `zod` is only used in
  `src/config/env.ts`.
- If you declare `response` in a route `schema`, Fastify **serialises and drops** the
  fields you did not declare. Declare them all, or do not declare `response` at all.
- The public issuer (`KEYCLOAK_ISSUER`) and the internal one
  (`KEYCLOAK_INTERNAL_ISSUER`) differ on purpose: the browser sees `localhost:8080`
  and the container sees `keycloak:8080`. JWKS is fetched over the internal one; `iss`
  is validated against the public one.

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

- Translating prose must never touch identifiers. The database schema (`erp.users`,
  `erp.todos`, `owner_id`, …), the realm and its clients and roles (`erp`, `erp-app`,
  `erp-api`, `erp-user`, `erp-manager`, `erp-admin`, `todos:read`, `admin:manage`, …),
  env var names, service names, ports, `erp-*` CSS classes and source file names are
  already English and are part of the contract. Renaming any of them is a behaviour
  change, not a translation.
- The SPA catalogues live in `packages/app/src/i18n/`. `en.ts` is the **source of
  truth**: `TranslationKey` is derived from it, and `es.ts` is typed
  `Record<TranslationKey, string>`, so a missing or extra key fails `pnpm typecheck`
  instead of showing up as a blank label at runtime. Add the key to `en.ts` first.
- The Keycloak theme mirrors the same rule: `messages_en.properties` is the reference
  catalogue, `messages_es.properties` must carry every key it has.
- OpenAPI tag names are shared state. Renaming a tag means renaming it in **every**
  route that uses it *and* in the `tags` array of `server.ts`; miss one and the docs
  silently grow a duplicate section.
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
packages/api/     Fastify 5 + TypeScript (ESM). Validates the token, never issues it.
packages/app/     React 19 + Vite + keycloak-js (PKCE S256).
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
