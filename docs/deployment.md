# Deployment

The lab runs on demand at <https://erp-keycloak.mapineda48.com>, with Keycloak at
<https://auth.erp-keycloak.mapineda48.com>. It is brought up when it is needed
and destroyed afterwards; nothing but the certificates and the database survives
in between.

---

## 1. Shape

```
GitHub Actions
├── ci.yml       typecheck, build, both verification suites        on PR / push
├── images.yml   buildx matrix -> ghcr.io, deployed by digest      on push to main
├── deploy.yml   render bundle -> Azure Blob -> smoke test         after images.yml
└── infra.yml    terraform plan / apply / destroy                  workflow_dispatch
                        |
    Azure OIDC ---------+  (federated, no client secret stored anywhere)
                        v
   Azure Blob  sti0bagdhl / data-ay4o7m96  (private)
     erp-keycloak/current.json          desired state: commit + bundle name
     erp-keycloak/bundles/<sha>.tar.gz  compose + traefik conf + rendered realm + .env
     erp-keycloak/traefik/*.json        persisted ACME stores, one per resolver
                        |
        blobfuse2, container-scoped SAS
                        v
   DigitalOcean droplet   ubuntu-24-04-x64 - s-2vcpu-4gb - nyc3
     systemd: erp-blobfuse2 -> erp-acme-restore -> docker -> erp-deploy.timer (60 s)
     docker compose:
       traefik    :80 :443        the only published ports
       app        nginx SPA       erp-keycloak.mapineda48.com/
       api        fastify         erp-keycloak.mapineda48.com/api
       keycloak   26.4.0          auth.erp-keycloak.mapineda48.com
       valkey     cache, no persistence
                        |
        +---------------+----------------+
        v                v               v
   Neon Postgres    Azure Blob        Resend
   erp + keycloak   erp-attachments   HTTP API (app) - SMTP relay (Keycloak)
```

**The pipeline never connects to the droplet.** It writes a bundle and a pointer
to a private container, and a timer on the host converges within a minute. No
port is open for deploying, no private key is stored in GitHub, and a rollback
is republishing an older pointer. That is not only a preference: a DigitalOcean
firewall rule takes at most 1000 source CIDRs and GitHub's runner ranges are
about 7300, so allow-listing runners for SSH is arithmetically impossible.

---

## 2. Running it

Everything is manual, from the Actions tab:

| Workflow | Input | What happens |
|---|---|---|
| **Infra** | `apply` | Creates the droplet, the firewall and both DNS records. ~2 min, plus ~3 min of cloud-init. |
| **Deploy** | — | Publishes a bundle and waits for the host to serve it, then runs the smoke test. Runs automatically after **Images**. |
| **Infra** | `destroy` | Removes the droplet and the records. The certificates and the database survive. |

`Infra apply` on an existing droplet is a no-op unless cloud-init changed, in
which case the droplet is **replaced** — that is deliberate, since DigitalOcean
user-data is immutable for a droplet's life.

Cost while it is up is the droplet by the hour. Neon's free tier, the blob
storage and the Cloudflare zone are effectively free, and its scale-to-zero is a
feature here rather than a problem: with the stack down most of the time, the
100 CU-hour monthly allowance is never at risk.

---

## 3. What a successful deploy means

`scripts/smoke-production.sh` asserts five things, and each one exists because a
cheaper check passes while the thing is broken:

1. **The served certificate is not Traefik's self-signed default.** Traefik does
   not crash when its ACME store is unreadable — it logs one line, drops the
   resolver and keeps serving. Every "is it up?" check stays green while HTTPS
   is broken for every real browser.
2. **`/api/health/ready` answers with JSON.** The SPA replies to any unknown
   path with `index.html` and HTTP 200, so a misrouted probe passes forever.
3. **The runtime configuration handed to the browser is what the browser needs.**
   Everything else builds its own URLs, so it all stays green while the SPA is
   pointed somewhere useless.
4. **The discovery document reports the public issuer.** The cheapest single
   catch for the whole `KC_HOSTNAME` / proxy-headers / `sslRequired` family.
5. **A real token is granted and spends on a protected route**, and is refused
   without one.

And `wait-for-deploy.sh` polls for the *commit* the host is serving, published
into `/config.js` at container start — not merely for a 200. The previous
release answers health checks perfectly well, so waiting on health alone hands
the smoke suite the old stack and every result afterwards describes the wrong
thing.

Even five is not everything, and that is not a hedge. Two defects passed the
whole suite and were only found by driving a real browser:

- a frame-options header at the edge broke Keycloak's third-party-cookie iframe,
  so `keycloak-js` never finished initialising and **logging in was impossible**.
  The assertions above use the direct grant and never touch the browser's
  framing rules.
- the SPA was handed an `apiUrl` ending in `/api`, and its client prepends `/api`
  itself, so every request after login went to `/api/api/...` and 404'd. The
  assertions build their own URLs and never read what the browser is told to
  call. Assertion 3 exists because of this one.

Anything that only a browser can see needs a browser. `chrome-devtools-mcp`
drives one; the flow worth walking is landing page → login → task list → create
→ confirm the API refuses what the UI hides.

---

## 4. Certificates

Let's Encrypt grants **five certificates per week for the same set of names**,
and Traefik has no ARI support. A host that re-ordered on every boot would lock
the hostname out by the sixth run of the week, which is why the ACME state is
persisted to blob storage and restored before Docker starts.

It cannot live *on* the blob mount, which is what the obvious design would do:

- Traefik refuses any ACME store whose permissions have group or other bits set.
- `chmod` on a flat-namespace blob container **returns success and does
  nothing**.
- `allow-other: true`, which the containers need, forces every entry to 0777 and
  overrides `default-permission` outright.

So the store lives on local ext4 at 0600, `erp-acme-restore.service` copies it
in before `docker.service`, and a `.path` unit plus a timer copy it back.

Two resolvers are declared, `staging` and `production`, **each with its own
store**. Sharing one file does not work: Traefik loads every certificate it
finds into a single store and serves by SNI, so a staging certificate satisfies
the request and the production resolver never orders anything.

Switch with the `ERP_CERT_RESOLVER` environment variable. Use `staging` while
changing anything about the edge.

---

## 5. Secrets

The only credential in cloud-init user-data is a SAS **scoped to one blob
container**. DigitalOcean serves user-data unauthenticated on the metadata
endpoint for the droplet's entire life and offers no way to clear it, so
everything else is fetched from the private container at boot instead. A
`DOCKER-USER` rule blocks containers from reaching the metadata service at all.

The rendered realm carries the Resend key as its SMTP password and the API
client secret, which is why it is built in CI and shipped through the private
container rather than baked into a public image.

Azure is authenticated by OIDC federation, so no client secret exists. The
repository was created after GitHub's 2026-07-15 cutover to immutable subject
claims, so the app registration carries **both** subject formats.

---

## 6. Access

`SSH_ALLOWED_CIDRS` is empty by default and no port 22 rule is created; the
pipeline never needs it and DigitalOcean's browser console remains available.
`ADMIN_ALLOWED_CIDRS` defaults to loopback, which reaches nobody: on a public
demo the Keycloak administration console must be opened deliberately, never by
forgetting to close it.

Both are repository variables on the `production` environment.

---

## 7. Traps

Every one of these cost a real failure during the first deployment.

**cloud-init runs `runcmd` with `/bin/sh`, which is dash.** A leading
`set -euxo pipefail` aborts on the `set` line itself and not one command below
it ever runs. The only symptom is `cloud-init status: error` on a host where
nothing was installed.

**blobfuse2 serves stale file content.** A blob overwritten in place keeps being
read as its previous version long after it changed, while the directory listing
refreshes normally. `current.json` is therefore fetched over HTTPS with the SAS,
not through the mount; the bundle still comes through the mount, where its name
carries the commit and stale content is impossible.

**`libfuse.mount-options` is not a real key** in blobfuse2 2.5.4. It parses
without error and does nothing, so a uid/gid/umask written there is silently
ignored. The real keys are scalars: `libfuse.uid`, `libfuse.gid`.

**Declaring `components:` replaces the default pipeline.** Omitting `file_cache`
and `attr_cache` makes every read and write its own REST round trip.

**`rm -rf` next to the stack directory breaks Traefik.** Bind mounts resolve to
an inode when the container starts; deleting and recreating the directory leaves
the running container reading a path that no longer exists, and it keeps serving
its previous configuration. The bundle is copied over the tree in place, and
containers are recreated explicitly, because Compose leaves a container alone
when its service definition has not changed and Traefik never re-reads its
static configuration.

**An EXIT trap whose last command fails replaces the script's exit status.** A
clean `exit 0` became a silent `exit 1`, and systemd reported the deploy timer
failing every minute against a perfectly healthy stack.

**`cap_drop: ALL` takes `CAP_DAC_OVERRIDE` from root**, so root can no longer
read a file it does not own — and `CAP_CHOWN`, which is what the valkey
entrypoint needs. Valkey runs as its own user instead, which skips that branch
entirely; nginx keeps exactly four capabilities and nothing more.

**Keycloak cannot run with `read_only: true`**: Quarkus writes under `data/tmp`
even with `--optimized`. Traefik, the SPA, the API and Valkey all can.

**`kc.sh import` needs `--optimized`.** Without it Keycloak re-augments the
image, the baked `KC_DB=postgres` does not apply to that run, and it fails with
"Driver does not support the provided URL" followed by a thoroughly misleading
"No such file or directory" for a file that is present and readable.

**`start --import-realm` is hard-wired to IGNORE_EXISTING.** Against a database
that outlives the host it imports once and skips silently ever after, so the
realm would freeze at whatever the first droplet produced while every later
deploy reported success. A one-shot `import --override` runs before the stack
comes up. The cost, stated plainly: realm state created at runtime is discarded
on every deploy. The demo users carry **fixed ids** so that re-importing does
not mint new subjects and orphan the `erp.users` rows keyed by them.

**Do not set frame-options at the edge at all.** It applies to both hostnames,
and Keycloak serves endpoints that MUST be framable from the application's
origin — `/protocol/openid-connect/3p-cookies/step1.html` above all, which
keycloak-js loads on startup. Any value, `DENY` or even `SAMEORIGIN`, makes the
browser refuse the frame; keycloak-js then fails with "Timeout when waiting for
3rd party check iframe message" and login becomes impossible while every
container stays healthy. nginx and Keycloak each declare their own policy
correctly; the edge only gets in the way.

**The SPA's `apiUrl` is the bare origin.** Its client prepends `/api` to every
path itself, so an origin with `/api` on the end yields `/api/api/todos`.
Development gets this right by accident, since `VITE_API_URL` has no path.

**`/user/tokens/verify` does not evaluate a Cloudflare token's IP condition.** It
returns success from a source the token would reject for any real operation, so
it is worthless as a preflight. The workflow creates and deletes a record
instead.

---

## 8. Known limits

- **Rolling back does not cover state.** The digest tuple rolls back cleanly for
  the SPA and mostly for the API, but the API has already migrated a persistent
  schema, and a Keycloak downgrade will not start against a database Liquibase
  has migrated forward. Gate Keycloak version bumps behind a verified backup.
- **The records are DNS-only**, so the droplet's address is public and the
  Traefik rate limits plus the DigitalOcean firewall are the only protection
  against L7 traffic. Cloudflare's free Universal SSL does not cover a
  fourth-level name like `auth.erp-keycloak.mapineda48.com`, and proxying it
  would need Advanced Certificate Manager at $10/month per zone.
- **HSTS is deliberately short** (300 s). This host is destroyed and rebuilt
  regularly, and a year-long policy would turn one bad deploy into a lockout
  nobody can click through — during a live demo.
- **The password-reset form is reachable by anyone**, since the demo publishes
  its credentials. Keycloak only mails registered users, so the blast radius is
  the three demo accounts, and the reset endpoint carries its own much tighter
  rate limit.
