# Operations

Day-to-day commands for working with this stack: start it, inspect it, reset it, migrate it and
unstick it. Everything runs from the repository root:

```bash
cd /home/mapineda48/Repo/mapineda48/clavis
```

Many examples use variables from `.env`. Load them into the session with:

```bash
set -a; source .env; set +a
```

---

## 1. Day-to-day commands

The `package.json` scripts and the `Makefile` targets are equivalent; use whichever you prefer.

| pnpm | make | Runs |
|---|---|---|
| `pnpm run up` | `make up` | `docker compose up -d --build` |
| `pnpm run up:full` | `make up-full` | `docker compose --profile full up -d --build` |
| `pnpm run down` | `make down` | `docker compose down` (keeps volumes) |
| `pnpm run reset` | `make reset` | `docker compose down -v` (**deletes** volumes) |
| `pnpm run logs` | `make logs` | `docker compose logs -f` |
| `pnpm run ps` | `make ps` | `docker compose ps` |
| `pnpm dev` | `make dev` | `pnpm -r --parallel dev` (API and SPA outside Docker) |
| `pnpm build` | `make build` | `pnpm -r build` |
| `pnpm typecheck` | `make typecheck` | `pnpm -r typecheck` |

> Make does not accept `:` in target names, which is why `up:full` is called `up-full` in the
> Makefile.

### Working on a single package

```bash
pnpm --filter @clavis/app dev          # only the SPA (http://localhost:5173)
pnpm --filter @clavis/api dev          # only the API with tsx watch (needs the rest of the stack up)
pnpm --filter @clavis/api typecheck
pnpm --filter @clavis/app build
```

The usual workflow is **infrastructure in Docker + SPA locally**: `docker compose up -d --build`
brings up postgres, keycloak, valkey, azurite and the API; `pnpm --filter @clavis/app dev` gives you
hot reload on the frontend.

If you would rather iterate on the API locally, stop the container to free port 3000:

```bash
docker compose stop api
pnpm --filter @clavis/api dev
```

Careful: the API running locally needs to reach the services through `localhost`, not through their
Docker network names. Adjust `DATABASE_URL`, `VALKEY_URL`, `KEYCLOAK_INTERNAL_ISSUER` and the host
part of `AZURE_STORAGE_CONNECTION_STRING` in `.env` (or export them in the session) so they point
at `localhost`.

### Short loop on individual services

```bash
docker compose up -d --build api        # rebuild and recreate only the API
docker compose restart api              # quick restart (re-runs the migrations)
docker compose stop keycloak            # stop without deleting anything
docker compose ps                       # status + health of every service
docker compose config                   # the compose file already interpolated with .env (very useful)
```

`docker compose config` is the fastest way to check the final value of the derived variables
(`DATABASE_URL`, `KEYCLOAK_ISSUER`, `CORS_ORIGINS`, …) without entering any container.

Iterating on the **login theme** (`infra/keycloak/themes/clavis`) needs none of these commands: with
`start-dev` themes are not cached, so reloading the browser is enough unless you touch
`theme.properties` or add files. Details in [section 8](#login-theme).

### Health checks

```bash
curl -s http://localhost:3000/api/health | jq
curl -s http://localhost:3000/api/health/ready | jq
curl -sf http://localhost:8080/realms/clavis/.well-known/openid-configuration >/dev/null && echo "realm clavis OK"
```

`/api/health/ready` returns `200` when database, cache and storage answer, and `503` when any of
those three fails, with the breakdown in `checks`. The mailer is reported too — `resend`,
`dry-run` or `disabled` — but it is **not** critical: email being unavailable never makes the
service unready.

---

## 2. Resetting the stack to zero

```bash
docker compose down -v
docker compose up -d --build
```

`down -v` removes the four volumes of the project: `pg-data`, `valkey-data`, `azurite-data` and
`keycloak-import`.

### Why that re-imports the realm

Keycloak imports a realm with `--import-realm` **only if that realm does not exist yet in its
database**. If it already exists, it is silently ignored: that is what stops a restart from
wiping out changes made through the console.

Keycloak's database lives inside the `pg-data` volume. Therefore:

| Command | What happens to the realm |
|---|---|
| `docker compose restart keycloak` | The realm already exists → **no import**. Template changes are not applied. |
| `docker compose down` + `up` | `pg-data` is still there → **no import**. |
| `docker compose down -v` + `up` | `pg-data` is gone → Keycloak starts empty and **does import** `realm-clavis.json`. |

The one-shot `keycloak-realm` service does run on every `up`, so the `/import/realm-clavis.json` file
inside the `keycloak-import` volume is **always up to date** with the template and with `.env`.
What does not refresh without `-v` is whatever Keycloak already stored in Postgres.

Rule of thumb: **any change to `infra/keycloak/realm-clavis.template.json` or to the `DEMO_*`,
`KEYCLOAK_*`, `APP_*_URL` variables requires `down -v`.** That includes `KEYCLOAK_LOGIN_THEME`,
which feeds the realm's `loginTheme` field; for that particular case there is a live alternative
with `kcadm.sh` that destroys no data, in [section 8](#login-theme).

The login theme files (`infra/keycloak/themes/`) are **not** covered by that rule: they arrive via
bind mount, not through the realm, and reload without re-importing anything.

A reset also wipes the tasks, the attachments and the audit log. To repopulate, open the SPA and
press "Create sample data", or call `POST /api/todos/seed-demo`.

### Selective reset

```bash
# Only the application and Keycloak databases
docker compose down
docker volume rm clavis_pg-data
docker compose up -d --build

# Only the cache (harmless: it rebuilds itself)
docker compose exec valkey valkey-cli FLUSHALL

# Only the attachments
docker compose down
docker volume rm clavis_azurite-data
docker compose up -d
```

The `clavis_` prefix comes from `COMPOSE_PROJECT_NAME`. Check the real names with
`docker volume ls | grep clavis`.

---

## 3. Logs

```bash
docker compose logs -f                      # everything, live
docker compose logs -f api                  # only the API
docker compose logs -f keycloak
docker compose logs --tail=200 api          # last 200 lines
docker compose logs --since=10m keycloak    # last 10 minutes
docker compose logs keycloak-realm          # one-shot: this is where the realm render shows up
docker compose logs -f api valkey           # several services at once
```

The API logs with **pino** (`LOG_LEVEL` in `.env`, `info` by default). To debug, raise the level and
recreate:

```bash
LOG_LEVEL=debug docker compose up -d --force-recreate api
docker compose logs -f api
```

Useful filters:

```bash
docker compose logs api | grep -i mail          # outgoing email (dry-run included)
docker compose logs api | grep -i migration     # migrations applied at startup
docker compose logs keycloak | grep -i import   # realm import
```

In local development (`pnpm --filter @clavis/api dev`) the output goes through `pino-pretty` and comes
out readable and coloured.

---

## 4. PostgreSQL with psql

```bash
set -a; source .env; set +a

# Application database
docker compose exec -it postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# Keycloak database (identity)
docker compose exec -it postgres psql -U "$POSTGRES_USER" -d "$KEYCLOAK_DB_NAME"
```

With literal values, if you would rather not load `.env`:

```bash
docker compose exec -it postgres psql -U clavis -d clavis
```

Inside `psql`:

```sql
\dn                          -- schemas
\dt clavis.*                    -- tables in the clavis schema
\d clavis.todos                 -- structure of a table
\di clavis.*                    -- indexes
\x on                        -- vertical output, handy for wide rows

SELECT version, applied_at FROM clavis.schema_migrations ORDER BY version;

SELECT id, username, email, last_seen_at FROM clavis.users ORDER BY last_seen_at DESC NULLS LAST;

SELECT t.id, t.title, t.status, t.priority, o.username AS owner, a.username AS assignee
  FROM clavis.todos t
  JOIN clavis.users o ON o.id = t.owner_id
  LEFT JOIN clavis.users a ON a.id = t.assignee_id
 ORDER BY t.created_at DESC
 LIMIT 20;

SELECT * FROM clavis.v_todo_stats;

SELECT created_at, actor_id, action, entity, entity_id
  FROM clavis.audit_log
 ORDER BY created_at DESC
 LIMIT 20;

SELECT a.file_name, a.content_type, a.size_bytes, a.blob_name
  FROM clavis.todo_attachments a
 ORDER BY a.created_at DESC;
```

One-off queries without opening an interactive session:

```bash
docker compose exec postgres psql -U clavis -d clavis -c "SELECT count(*) FROM clavis.todos;"
docker compose exec postgres psql -U clavis -d clavis -Atc "SELECT status, count(*) FROM clavis.todos GROUP BY status;"
```

Backup and restore:

```bash
docker compose exec postgres pg_dump -U clavis -d clavis --schema=clavis > /tmp/clavis-backup.sql
cat /tmp/clavis-backup.sql | docker compose exec -T postgres psql -U clavis -d clavis
```

---

## 5. Valkey with valkey-cli

```bash
docker compose exec -it valkey valkey-cli
```

Useful commands inside the session (or with `docker compose exec valkey valkey-cli <command>`):

```bash
PING                                    # PONG
DBSIZE                                  # number of keys
SCAN 0 MATCH 'clavis:*' COUNT 100          # walk the keys without blocking the server
KEYS 'clavis:v*:todos:*'                   # convenient in development, avoid it in production
TTL  'clavis:v3:todos:<sub>:mine:_:_:1:20' # seconds left (= CACHE_TTL_SECONDS when created)
GET  'clavis:v3:todos:<sub>:mine:_:_:1:20' # the cached JSON
INFO keyspace
MONITOR                                 # watch every command live (Ctrl-C to quit)
FLUSHALL                                # empty the whole cache
```

Version-based invalidation, demonstrated step by step:

```bash
# 1. Look at the current version of the 'todos' namespace and the existing keys
docker compose exec valkey valkey-cli --scan --pattern 'clavis:*'

# 2. In another terminal, watch what the API does, live
docker compose exec valkey valkey-cli MONITOR

# 3. Run the same listing twice: MISS and then HIT
curl -si http://localhost:3000/api/todos -H "Authorization: Bearer $TOKEN" | grep -i '^x-cache'
curl -si http://localhost:3000/api/todos -H "Authorization: Bearer $TOKEN" | grep -i '^x-cache'

# 4. Create a task: the API runs INCR on the version (visible in MONITOR)
curl -s -X POST http://localhost:3000/api/todos -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"title":"cache test"}' >/dev/null

# 5. The same listing is a MISS again, and the keys with the previous version are still there
#    (orphaned) until their TTL expires
curl -si http://localhost:3000/api/todos -H "Authorization: Bearer $TOKEN" | grep -i '^x-cache'
```

Flushing the cache **never** loses data: it only forces the next listing to go to PostgreSQL.

---

<a id="list-azurite-blobs"></a>

## 6. Listing Azurite blobs

The most direct way is to use the SDK from the API container itself, which already has it installed
and has the connection string in its environment:

```bash
docker compose exec api node --input-type=module -e "
import { BlobServiceClient } from '@azure/storage-blob';
const svc = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const c = svc.getContainerClient(process.env.AZURE_STORAGE_CONTAINER);
for await (const b of c.listBlobsFlat()) {
  console.log(b.properties.contentLength.toString().padStart(9), b.properties.contentType, b.name);
}
"
```

If module resolution fails, force the package's working directory:

```bash
docker compose exec -w /repo/packages/api api node --input-type=module -e "…"
```

Listing only the attachments of one task (the prefix is part of the naming convention,
`todos/<todo_id>/…`):

```bash
docker compose exec api node --input-type=module -e "
import { BlobServiceClient } from '@azure/storage-blob';
const svc = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const c = svc.getContainerClient(process.env.AZURE_STORAGE_CONTAINER);
for await (const b of c.listBlobsFlat({ prefix: 'todos/' + process.argv[1] + '/' })) console.log(b.name);
" "<todo_id>"
```

Cross-check it against what the database says (they must match one to one):

```bash
docker compose exec postgres psql -U clavis -d clavis -Atc \
  "SELECT blob_name FROM clavis.todo_attachments ORDER BY blob_name;"
```

With the **Azure CLI** installed on the host it also works, replacing the internal host `azurite`
with `127.0.0.1` in the connection string:

```bash
set -a; source .env; set +a
CONN="${AZURE_STORAGE_CONNECTION_STRING//azurite/127.0.0.1}"
az storage blob list --container-name "$AZURE_STORAGE_CONTAINER" --connection-string "$CONN" -o table
```

Azurite data persists in the `azurite-data` volume; to throw it away, delete that volume (see
[selective reset](#selective-reset)).

---

<a id="add-a-migration"></a>

## 7. Adding a migration

Migrations live in `packages/api/migrations/` following the `NNNN_name.sql` pattern and are applied
**in lexicographic order** when the API starts. Each one is recorded in `clavis.schema_migrations`
with its **checksum**.

### Procedure

1. Create the next file in the sequence (four digits, descriptive name):

   ```
   packages/api/migrations/0003_add_todo_tags.sql
   ```

2. Write SQL that is **idempotent where it makes sense**, and always inside the `clavis` schema:

   ```sql
   -- 0003: free-form tags for tasks
   ALTER TABLE clavis.todos
     ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

   CREATE INDEX IF NOT EXISTS todos_tags_idx ON clavis.todos USING gin (tags);
   ```

3. Apply it by restarting the API (the migrator runs at startup):

   ```bash
   docker compose restart api
   docker compose logs --tail=50 api | grep -i migration
   ```

   Or, if you develop outside Docker, just relaunch `pnpm --filter @clavis/api dev`.

4. Verify the record:

   ```bash
   docker compose exec postgres psql -U clavis -d clavis -c \
     "SELECT version, applied_at FROM clavis.schema_migrations ORDER BY version;"
   ```

### Rules

- **Never edit a migration that has already been applied.** The checksum would stop matching and
  startup would fail with a "migration modified" error. Always fix things with a new file.
- **Do not create `clavis.schema_migrations`** in a migration: the migrator creates it itself.
- **Do not add extensions** for UUIDs: `gen_random_uuid()` is native in PostgreSQL 17.
- If you get the migration wrong while still in development, the clean way out is
  `docker compose down -v && docker compose up -d --build`. As a last resort, delete the row:

  ```bash
  docker compose exec postgres psql -U clavis -d clavis -c \
    "DELETE FROM clavis.schema_migrations WHERE version = '0003_add_todo_tags';"
  ```

  …but remember to also undo by hand whatever the migration had already applied.

---

<a id="login-theme"></a>

## 8. Login theme

The realm's sign-in screen uses a custom Freemarker theme called **`clavis`**.

### Where it lives and how it reaches the container

```
infra/keycloak/themes/clavis/
├── theme.properties            # types=login
└── login/
    ├── theme.properties        # parent=base, styles, scripts, locales and kc* class mapping
    ├── template.ftl            # split-screen layout (registrationLayout macro)
    ├── login.ftl               # sign-in form + demo user cheat sheet
    ├── footer.ftl  error.ftl  info.ftl
    ├── login-page-expired.ftl  logout-confirm.ftl
    ├── messages/               # messages_en.properties + messages_es.properties
    └── resources/
        ├── css/clavis-login.css
        └── js/clavis-login.js
```

The `keycloak` service in `docker-compose.yml` mounts it read-only:

```yaml
volumes:
  - keycloak-import:/opt/keycloak/data/import
  - ./infra/keycloak/themes:/opt/keycloak/themes:ro
```

Mounting over `/opt/keycloak/themes` breaks nothing: in the official image that directory
**contains only a README**; the built-in themes (`base`, `keycloak`, `keycloak.v2`) travel inside
the server JARs. That is why `parent=base` still resolves, and the pages the `clavis` theme does not
override (OTP, update password, verify email…) are served by `base` with the `kc*` class mapping
declared in `login/theme.properties`.

Checking that the mount is there:

```bash
docker compose exec keycloak ls /opt/keycloak/themes/clavis/login
# error.ftl  footer.ftl  info.ftl  login.ftl  login-page-expired.ftl
# logout-confirm.ftl  messages  resources  template.ftl  theme.properties
```

What selects the theme: the realm's `loginTheme` field, which comes from
`infra/keycloak/realm-clavis.template.json` (`"loginTheme": "__KEYCLOAK_LOGIN_THEME__"`) and which
`render-realm.mjs` replaces with the `KEYCLOAK_LOGIN_THEME` variable (`.env`, `clavis` by default).
The same block enables the languages: `internationalizationEnabled: true`,
`supportedLocales: ["en", "es"]`, `defaultLocale: "en"`.

### Editing the theme live

Keycloak starts with `start-dev`, and in that mode **themes are not cached**:

| What you touch | What is needed |
|---|---|
| A `.ftl`, `resources/css/clavis-login.css`, `resources/js/clavis-login.js` | Nothing. Save and reload the browser with `Ctrl+Shift+R` |
| A `messages_*.properties` | Nothing, reload the page |
| Either of the two `theme.properties` | `docker compose restart keycloak` |
| Adding a new file or directory | `docker compose restart keycloak` |
| Adding or changing the mount in `docker-compose.yml` | `docker compose up -d --force-recreate keycloak` (a `restart` does **not** apply new volumes) |

To see the screen without starting the SPA, open <http://localhost:8080/realms/clavis/account> in a
private window: the realm's account console requires a login and uses the same theme.

<a id="change-the-theme-of-an-existing-realm"></a>

### Switching themes (or going back to the default)

In `.env`:

```dotenv
KEYCLOAK_LOGIN_THEME=clavis          # the custom theme
# KEYCLOAK_LOGIN_THEME=keycloak   # the classic built-in theme
# KEYCLOAK_LOGIN_THEME=keycloak.v2
```

And then **one of these two routes**:

**A) Re-import the realm** (clean, but it wipes the demo data):

```bash
docker compose down -v
docker compose up -d --build
```

**B) Apply it live with `kcadm.sh`** (keeps users, tasks, attachments and audit log).
A realm that already exists is **not** imported again, so editing the template is not enough:

```bash
set -a; source .env; set +a

# 1. Authenticate against the master realm with the bootstrap admin.
#    --config sets where the token is stored; /tmp is always writable in the container.
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --config /tmp/kcadm.config \
  --server http://localhost:8080 \
  --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" \
  --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"

# 2. Apply theme and languages to the clavis realm (touching nothing else)
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update "realms/$KEYCLOAK_REALM" \
  --config /tmp/kcadm.config \
  -s "loginTheme=$KEYCLOAK_LOGIN_THEME" \
  -s 'internationalizationEnabled=true' \
  -s 'supportedLocales=["en","es"]' \
  -s 'defaultLocale=en'

# 3. Verify
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh get "realms/$KEYCLOAK_REALM" \
  --config /tmp/kcadm.config \
  --fields realm,loginTheme,internationalizationEnabled,supportedLocales,defaultLocale
# {
#   "realm" : "clavis",
#   "loginTheme" : "clavis",
#   "internationalizationEnabled" : true,
#   "supportedLocales" : [ "en", "es" ],
#   "defaultLocale" : "en"
# }
```

The change takes effect the next time the login screen loads; no restart needed.

Notes:

- This is the console admin (`KC_BOOTSTRAP_ADMIN_*`), not a demo user of the `clavis` realm.
- The `kcadm` token lives in `/tmp/kcadm.config` **inside** the container: it is lost when the
  container is recreated, and then you have to repeat step 1.
- The same thing can be done from the console: <http://localhost:8080/admin> → realm `clavis` →
  *Realm settings* → *Themes* → *Login theme*.
- A change applied with `kcadm` or through the console **is not versioned**. Mirror it in `.env` /
  `realm-clavis.template.json` so the next clean start keeps it.

---

<a id="spa-language"></a>

## 9. SPA language

The application ships in **English (default) and Spanish**, mirroring the two message catalogs of
the login theme so the whole journey — sign-in screen, application, password-reset email — speaks
the same language.

There is no i18n library. `packages/app/src/i18n/` holds one flat catalog per locale (`en.ts` is
the source of truth, `es.ts` is typed against it) plus a small provider that exposes `useI18n()`.

### How the initial language is decided

| Order | Source | Notes |
|---|---|---|
| 1 | `?lang=` in the URL | `?lang=es` forces Spanish, `?lang=en` forces English. This is how you share a link in a given language, and how the app comes back from Keycloak still speaking it. |
| 2 | `localStorage['clavis.locale']` | The last explicit choice made in the selector. |
| 3 | `navigator.languages` / `navigator.language` | Region subtags are ignored: `es-CO` matches `es`. |
| 4 | `DEFAULT_LOCALE` | `en`. |

The selector is a native `<select>` in the application header, next to the user menu, so it is
reachable by keyboard with no extra wiring. Choosing a language applies it immediately (no reload),
writes it to `localStorage` under **`clavis.locale`** and updates `document.documentElement.lang`.

Signing in and out carries the choice over to Keycloak: `keycloak.login({ locale })` becomes the
OIDC `ui_locales` parameter, and the return URL keeps `?lang=`, so the login screen and the
application never disagree — including when `localStorage` is unavailable (private browsing).

Quick checks:

```
http://localhost:5173/?lang=es      # force Spanish
http://localhost:5173/?lang=en      # force English
```

From the browser console:

```js
localStorage.getItem('clavis.locale')     // what is remembered
localStorage.removeItem('clavis.locale')  // forget it and fall back to the browser language
```

Adding a string: add the key to `packages/app/src/i18n/en.ts` first, then to `es.ts`. Forgetting the
second one is a `pnpm typecheck` failure, not a blank label discovered in production.

The Keycloak side is independent: it lives in the realm (`supportedLocales`, `defaultLocale`) and in
the theme catalogs `messages_en.properties` / `messages_es.properties`, covered in
[section 8](#login-theme).

---

<a id="password-reset"></a>

## 10. Password reset and Keycloak email

### Two different email paths

| Who sends it | How | What it sends |
|---|---|---|
| The API (`@clavis/api`) | Resend's **HTTP** API | Task notifications |
| **Keycloak** | **SMTP** | Password reset, email verification |

Keycloak does not speak Resend's HTTP API, only SMTP. That is why the realm points at
`smtp.resend.com:587` (STARTTLS) and `docker-compose.yml` reuses `RESEND_API_KEY` as the SMTP
password: one secret for both paths.

### What each variable controls

| Variable | Effect |
|---|---|
| `KEYCLOAK_SMTP_HOST` / `_PORT` | SMTP server (`smtp.resend.com` / `587`) |
| `KEYCLOAK_SMTP_USER` | Always `resend` on the Resend relay |
| `KEYCLOAK_SMTP_FROM` | Sender; it **must** belong to a verified domain |
| `KEYCLOAK_EMAIL_THEME` | Theme for the emails (`clavis` = the custom one) |
| `DEMO_ADMIN_EMAIL` | Must be a real address for the flow to be testable |

The SMTP password is not in `.env`: it comes from `RESEND_API_KEY`.

### Checking that SMTP answers

```bash
python3 - <<'PY'
import smtplib, re, pathlib, ssl
key = re.search(r'^RESEND_API_KEY=(.*)$', pathlib.Path('.env').read_text(), re.M).group(1).strip()
s = smtplib.SMTP('smtp.resend.com', 587, timeout=20)
s.starttls(context=ssl.create_default_context()); s.login('resend', key)
print('AUTH OK'); s.quit()
PY
```

### Applying it to a realm that ALREADY exists

`smtpServer`, `resetPasswordAllowed` and `emailTheme` are only read **when the realm is imported**.
For a running realm, without losing data:

```bash
set -a; source .env; set +a

docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"

# Reset flow + email theme + link lifetime (30 min)
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update realms/clavis \
  -s resetPasswordAllowed=true \
  -s emailTheme=clavis \
  -s actionTokenGeneratedByUserLifespan=1800

# SMTP (careful: it is a JSON object, not individual fields)
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update realms/clavis \
  -s "smtpServer={\"host\":\"$KEYCLOAK_SMTP_HOST\",\"port\":\"$KEYCLOAK_SMTP_PORT\",\"from\":\"$KEYCLOAK_SMTP_FROM\",\"fromDisplayName\":\"$KEYCLOAK_SMTP_FROM_DISPLAY_NAME\",\"ssl\":\"false\",\"starttls\":\"true\",\"auth\":\"true\",\"user\":\"$KEYCLOAK_SMTP_USER\",\"password\":\"$RESEND_API_KEY\"}"
```

Changing a user's email address:

```bash
UID=$(docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh get users -r clavis \
        -q username=admin --fields id | grep -o '"id" : "[^"]*"' | cut -d'"' -f4)
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update "users/$UID" -r clavis \
  -s 'email=you@example.com' -s 'emailVerified=true'
```

`actionTokenGeneratedByUserLifespan` is a **top-level** realm field, not an `attributes.*` one:
with `-s attributes.actionToken…` it is not applied and nothing warns you.

### Where the screens and the email live

```
infra/keycloak/themes/clavis/login/login-reset-password.ftl   ← request the link
infra/keycloak/themes/clavis/login/login-update-password.ftl  ← set the new password
infra/keycloak/themes/clavis/email/html/password-reset.ftl    ← the email body
infra/keycloak/themes/clavis/email/html/template.ftl          ← shared layout
infra/keycloak/themes/clavis/email/messages/                  ← subject and copy
```

The email is laid out with tables and inline CSS on purpose: email clients drop `<style>` blocks
and external stylesheets.

### Reading the sent email without opening a mailbox

```bash
resend emails list --limit 3
resend emails get <id>            # includes the HTML and the action link
```

---

<a id="troubleshooting"></a>

## 11. Troubleshooting

### Keycloak takes a long time to start or shows up as `unhealthy`

**Normal the first time**: it creates its schema in PostgreSQL and imports the realm; 40–90 seconds
is expected, more on the first image pull.

```bash
docker compose ps                      # STATUS column: (health: starting) → (healthy)
docker compose logs -f keycloak        # look for "Listening on" and "Imported realm clavis"
```

If it stays in `starting` forever:

- Check that `postgres` is `healthy`: Keycloak depends on it with `service_healthy`.
- Read `docker compose logs keycloak-realm`: if the render failed, there is no file to import.
- The healthcheck uses **bash with `/dev/tcp`** against the management port `9000` and
  `/health/ready`, because the Keycloak image ships **neither `curl` nor `wget`**. If you swapped it
  for `curl`, it will always be `unhealthy`.

Active wait from the host:

```bash
until curl -sf http://localhost:8080/realms/clavis/.well-known/openid-configuration >/dev/null; do
  sleep 2
done; echo ready
```

### `401` because of an invalid audience in the token

Symptom: login works, but every call to `/api/*` returns `401`.

1. Decode the token and look at `aud`:

   ```bash
   node -e "
     const [,,t]=process.argv;
     const p=JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString());
     console.log({ iss: p.iss, aud: p.aud, azp: p.azp });
   " "$TOKEN"
   ```

2. `aud` **must contain `clavis-api`**. If it does not, the `oidc-audience-mapper` protocol mapper is
   missing on the `clavis-app` client, or it was lost because the realm was not re-imported. Fix:
   review `infra/keycloak/realm-clavis.template.json` and run
   `docker compose down -v && docker compose up -d --build`.
3. Check what the API sees:

   ```bash
   docker compose config | grep -E 'KEYCLOAK_(ISSUER|INTERNAL_ISSUER|AUDIENCE)'
   ```

   `KEYCLOAK_AUDIENCE` must be `clavis-api`, and `KEYCLOAK_ISSUER` must match the token's `iss`
   **character for character** (watch out for `127.0.0.1` versus `localhost`, and for the trailing
   slash).

### CORS errors in the browser

Typical message: *"has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header"*.

There are **two** CORS layers and you have to look at both:

| Blocked request | Who decides | Where it is fixed |
|---|---|---|
| Towards `localhost:8080` (Keycloak) | *Web origins* of the `clavis-app` client | `realm-clavis.template.json`, derived from `APP_DEV_URL` / `APP_PROD_URL`; requires `down -v` |
| Towards `localhost:3000` (API) | `@fastify/cors` with `CORS_ORIGINS` | `.env` (`APP_DEV_URL`, `APP_PROD_URL`) + `docker compose up -d --force-recreate api` |

```bash
docker compose config | grep CORS_ORIGINS
# CORS_ORIGINS: http://localhost:5173,http://localhost:8081
```

Common cause: opening the SPA at `http://127.0.0.1:5173` instead of `http://localhost:5173`. To the
browser those are **different origins** and neither is configured for the other. Always use
`localhost`.

### Port already in use

```
Error: bind: address already in use
```

Find the culprit:

```bash
ss -ltnp | grep -E ':(3000|5173|5432|6379|8080|8081|10000|10001|10002)\b'
# alternative: sudo lsof -i :5432
```

Frequent cases:

- **5432**: a PostgreSQL installed on the machine. Stop the local service
  (`sudo systemctl stop postgresql`) or change the port mapping in `docker-compose.yml`.
- **6379**: a local Redis.
- **8080**: another container, or a Tomcat/Jenkins.
- **5173**: another Vite instance. `vite.config.ts` uses `strictPort: true`, so it **fails instead
  of jumping to 5174** — that is intentional: the redirect URI registered in Keycloak is the 5173
  one, and a different port would break login with `invalid_redirect_uri`.

Leftovers from a previous run:

```bash
docker compose ps -a
docker compose down --remove-orphans
```

### The realm is not re-imported because the volume already exists

Symptom: you change `realm-clavis.template.json` (or a `DEMO_*` variable), restart, and **nothing
happens**: the new user does not exist, the new permission does not appear in the token.

Cause: Keycloak only imports a realm that does **not** already exist in its database, and that
database lives in the `pg-data` volume, which `docker compose down` (without `-v`) keeps.

```bash
docker compose down -v
docker compose up -d --build
```

Check that the import happened:

```bash
docker compose logs keycloak | grep -i "import"
docker compose logs keycloak-realm            # the render must finish with no pending markers
```

If you do not want to lose the demo data, the alternative is to apply the change by hand in the
admin console (<http://localhost:8080/admin>) **and also** mirror it in the template, so the next
clean start keeps it.

### The login screen renders unstyled (or with the Keycloak theme)

Work through this in order; each step rules out a different cause.

**1. Browser cache.** The server does not cache themes under `start-dev`, but the browser does
cache `clavis-login.css` and `clavis-login.js` by URL. Reload with `Ctrl+Shift+R`, or open dev tools →
*Network* tab → *Disable cache*, or use a private window. In *Network*, `clavis-login.css` must answer
**200**; a **404** means the file is not where `styles=` in `login/theme.properties` says it is.

**2. Did the mount reach the container?**

```bash
docker compose exec keycloak ls /opt/keycloak/themes/clavis/login
```

It must list `template.ftl`, `login.ftl`, `theme.properties`, `messages` and `resources`. If it
answers `No such file or directory`:

```bash
docker compose config | grep -A6 'keycloak:' | grep themes   # is the bind mount there?
docker compose up -d --force-recreate keycloak               # adding a volume requires RECREATING
```

A `docker compose restart keycloak` does **not** apply new volumes: the container has to be
recreated.

**3. Which theme does the realm actually have?**

```bash
set -a; source .env; set +a
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh get "realms/$KEYCLOAK_REALM" \
  --config /tmp/kcadm.config --fields realm,loginTheme
```

(If you have not authenticated yet, run step 1 of
[section 8](#change-the-theme-of-an-existing-realm) first.)

If `loginTheme` is not `clavis`, the cause is almost always this: **an already-imported realm does not
change theme just because you edited the template**. Keycloak only imports a realm that does not
exist yet in its database, and that database lives in the `pg-data` volume. Two ways out:

```bash
# Re-import from scratch (wipes the demo data)
docker compose down -v && docker compose up -d --build
```

or apply it live without losing data with `kcadm.sh`, as explained in
[section 8](#change-the-theme-of-an-existing-realm).

**4. Did you touch `theme.properties` or add files?** Those changes do need a restart:

```bash
docker compose restart keycloak
docker compose logs --since=2m keycloak | grep -i -e theme -e freemarker
```

A Freemarker error in a template shows up in that log and makes the page render the server's error
message instead of the form.

**5. Half-styled pages that are not the login page** (OTP, update password, verify email). Those
templates are served by the `base` theme and only pick up Clavis look through the `kc*` mapping in
`infra/keycloak/themes/clavis/login/theme.properties`. If a property is missing, that element renders
without a class. Add it there and restart the container.

### `render-realm.mjs` fails with "unsubstituted marker"

The renderer exits with a non-zero code on purpose when some `__VARIABLE__` is left unresolved. It
is almost always an incomplete `.env` (copied from an older version of `.env.example`) or a new
variable added to the template.

```bash
docker compose logs keycloak-realm            # the message says which marker is missing
diff <(grep -o '^[A-Z_]*' .env | sort -u) <(grep -o '^[A-Z_]*' .env.example | sort -u)
```

Add the missing variables to your `.env` and bring the stack up again.

### The API image build fails with `ERR_PNPM_OUTDATED_LOCKFILE`

The Dockerfile installs with `--frozen-lockfile`. If you changed dependencies in some
`package.json` without updating the lockfile:

```bash
pnpm install                 # regenerates pnpm-lock.yaml
docker compose build api
```

If the error mentions a `package.json` that "does not exist", make sure the Dockerfile copies **the
`package.json` of both packages**: the lockfile describes the whole workspace.

### `api` starts and crashes in a loop

```bash
docker compose logs --tail=100 api
```

Typical causes, in order of frequency:

1. **Invalid or missing environment variable** — zod aborts the startup with the exact variable
   name. Compare your `.env` against `.env.example`.
2. **Failed migration** — the message names the file. See [section 7](#add-a-migration).
3. **Modified migration checksum** — you edited a migration that was already applied. The
   migrator refuses to continue and names the file.

   > This is exactly what happens when you pull the commit that translated the repository to
   > English: the `COMMENT ON` statements inside `0001_init.sql` and `0002_views.sql` changed, so
   > their sha256 changed too. An environment created before that commit will refuse to start.
   > The fix for a lab is `make reset` (`docker compose down -v`), which rebuilds the database
   > from scratch. If you need to keep the data, update the stored checksum by hand instead:
   >
   > ```sql
   > SELECT version, checksum FROM clavis.schema_migrations;
   > ```

4. **Unhealthy dependency** — `docker compose ps` will show which service is `unhealthy`.

### The listing always returns `X-Cache: MISS`

- Every write bumps the namespace version: if something (or someone) is writing continuously, there
  will never be a `HIT`.
- `CACHE_TTL_SECONDS` too low. Check the effective value with
  `docker compose config | grep CACHE_TTL`.
- Valkey down: `curl -s http://localhost:3000/api/health/ready | jq '.checks.cache'`.
- Remember the key includes `sub`, scope, filters and pagination: changing any filter is
  legitimately a new key and therefore a `MISS`.

### The email does not arrive

1. Check which mode the *mailer* is in:

   ```bash
   curl -s http://localhost:3000/api/health/ready | jq '.checks.mailer'
   docker compose logs api | grep -i mail
   ```

2. With `provider: "dry-run"` the email is **never sent** and the request still answers `200`: that
   is the expected behaviour without `RESEND_API_KEY`.
3. With `provider: "resend"` and no verified domain, Resend only allows sending to the address you
   signed up with. Check your domains with `resend domains` and adjust `MAIL_FROM`.
4. After changing `RESEND_API_KEY` the container has to be recreated; a `restart` is not enough:

   ```bash
   docker compose up -d --force-recreate api
   ```

### `InvalidHeaderValue: The API version … is not supported by Azurite`

The `@azure/storage-blob` SDK negotiates a Storage API version newer than the one the emulator
knows, and Azurite rejects the request with `400`. That is why the `azurite` service in
`docker-compose.yml` starts with `--skipApiVersionCheck`:

```yaml
command:
  - azurite
  # …
  - --skipApiVersionCheck
```

It is the emulator's official workaround and it has no effect on real Azure. If the error comes
back while uploading an attachment, check that the flag is still in `command` and recreate the
container:

```bash
docker compose up -d --force-recreate azurite
```

While the blob container does not exist, `GET /api/health/ready` reports `storage: "error"` and answers
`503`. The probe is self-healing: it recreates the container idempotently, so retrying once Azurite
is healthy is enough.

### `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: esbuild`

pnpm 10+ blocks install scripts of dependencies. The approved ones are declared in a versioned way
in `pnpm-workspace.yaml`, so installing is reproducible without answering any prompt:

```yaml
allowBuilds:
  esbuild: true
```

If another package shows up in that message after a dependency update, add it to that list instead
of running `pnpm approve-builds` by hand: the latter leaves no trace in the repository.

The `Dockerfile`s also set `ENV CI=true`; without it pnpm asks for interactive confirmation to
purge `node_modules` and the build fails with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.

### Start over, no doubts

```bash
docker compose down -v --remove-orphans
rm -rf node_modules packages/*/node_modules
pnpm install
docker compose up -d --build
```
