#!/usr/bin/env bash
# =============================================================================
# Assembles the deploy bundle: everything the droplet needs and nothing it can
# derive for itself.
#
#   dist/bundle.tar.gz
#     docker-compose.yml
#     .env                      every secret this stack needs
#     traefik/traefik.yml       rendered
#     traefik/dynamic/stack.yml rendered
#     realm/realm-clavis.json      rendered
#   dist/current.json           the pointer the host polls
#
# The rendered realm carries the Resend key as its SMTP password and the API
# client secret, which is exactly why it is built here and shipped through a
# private container rather than baked into a public image.
#
# Run by .github/workflows/deploy.yml; every input arrives through the
# environment.
# =============================================================================
set -euo pipefail

CLAVIS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CLAVIS_ROOT"

require() {
  local missing=0 name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then echo "missing required variable: $name" >&2; missing=1; fi
  done
  [ "$missing" -eq 0 ] || exit 1
}

require CLAVIS_APP_FQDN CLAVIS_API_FQDN CLAVIS_AUTH_FQDN CLAVIS_ACME_EMAIL CLAVIS_CERT_RESOLVER DEPLOY_SHA \
  CLAVIS_API_IMAGE CLAVIS_APP_IMAGE CLAVIS_AUTH_IMAGE \
  CLAVIS_DATABASE_URL CLAVIS_STORAGE_CONNECTION_STRING CLAVIS_ATTACHMENTS_CONTAINER \
  KC_BOOTSTRAP_ADMIN_USERNAME KC_BOOTSTRAP_ADMIN_PASSWORD \
  KEYCLOAK_API_CLIENT_SECRET DEMO_ADMIN_EMAIL DEMO_ADMIN_PASSWORD \
  DEMO_MANAGER_PASSWORD DEMO_USER_PASSWORD

umask 077
rm -rf dist
STAGE=dist/stage
mkdir -p "$STAGE/traefik/dynamic" "$STAGE/realm"

REALM="${CLAVIS_REALM:-clavis}"
APP_URL="https://${CLAVIS_APP_FQDN}"
AUTH_URL="https://${CLAVIS_AUTH_FQDN}"

# --- the database, split for two very different clients -----------------------
# The API takes the URL whole; Keycloak needs the parts, because its JDBC URL
# must carry only sslmode. Both point at the same Neon project, different
# databases.
DB_USER="$(printf '%s' "$CLAVIS_DATABASE_URL" | sed -E 's|^postgres(ql)?://([^:]+):.*|\2|')"
DB_PASSWORD="$(printf '%s' "$CLAVIS_DATABASE_URL" | sed -E 's|^postgres(ql)?://[^:]+:([^@]+)@.*|\2|')"
DB_HOST="$(printf '%s' "$CLAVIS_DATABASE_URL" | sed -E 's|^postgres(ql)?://[^@]+@([^/]+)/.*|\2|')"
[ -n "$DB_USER" ] && [ -n "$DB_PASSWORD" ] && [ -n "$DB_HOST" ] || {
  echo "could not parse CLAVIS_DATABASE_URL" >&2; exit 1; }

# --- realm --------------------------------------------------------------------
echo "==> rendering the realm"
OUTPUT_DIR="$STAGE/realm" \
KEYCLOAK_REALM="$REALM" \
KEYCLOAK_APP_CLIENT_ID="${KEYCLOAK_APP_CLIENT_ID:-clavis-app}" \
KEYCLOAK_API_CLIENT_ID="${KEYCLOAK_API_CLIENT_ID:-clavis-api}" \
KEYCLOAK_API_CLIENT_SECRET="$KEYCLOAK_API_CLIENT_SECRET" \
KEYCLOAK_PUBLIC_URL="$AUTH_URL" \
KEYCLOAK_LOGIN_THEME="${KEYCLOAK_LOGIN_THEME:-clavis}" \
KEYCLOAK_EMAIL_THEME="${KEYCLOAK_EMAIL_THEME:-clavis}" \
KEYCLOAK_SMTP_HOST="${KEYCLOAK_SMTP_HOST:-smtp.resend.com}" \
KEYCLOAK_SMTP_PORT="${KEYCLOAK_SMTP_PORT:-587}" \
KEYCLOAK_SMTP_FROM="${KEYCLOAK_SMTP_FROM:-onboarding@resend.dev}" \
KEYCLOAK_SMTP_FROM_DISPLAY_NAME="${KEYCLOAK_SMTP_FROM_DISPLAY_NAME:-Clavis}" \
KEYCLOAK_SMTP_SSL="${KEYCLOAK_SMTP_SSL:-false}" \
KEYCLOAK_SMTP_STARTTLS="${KEYCLOAK_SMTP_STARTTLS:-true}" \
KEYCLOAK_SMTP_AUTH="${KEYCLOAK_SMTP_AUTH:-true}" \
KEYCLOAK_SMTP_USER="${KEYCLOAK_SMTP_USER:-resend}" \
KEYCLOAK_SMTP_PASSWORD="${RESEND_API_KEY:-not-configured}" \
APP_DEV_URL="$APP_URL" \
APP_PROD_URL="$APP_URL" \
DEMO_ADMIN_USERNAME="${DEMO_ADMIN_USERNAME:-admin}" \
DEMO_ADMIN_EMAIL="$DEMO_ADMIN_EMAIL" \
DEMO_ADMIN_PASSWORD="$DEMO_ADMIN_PASSWORD" \
DEMO_MANAGER_USERNAME="${DEMO_MANAGER_USERNAME:-manager}" \
DEMO_MANAGER_EMAIL="${DEMO_MANAGER_EMAIL:-manager@clavis.local}" \
DEMO_MANAGER_PASSWORD="$DEMO_MANAGER_PASSWORD" \
DEMO_USER_USERNAME="${DEMO_USER_USERNAME:-worker}" \
DEMO_USER_EMAIL="${DEMO_USER_EMAIL:-worker@clavis.local}" \
DEMO_USER_PASSWORD="$DEMO_USER_PASSWORD" \
  node infra/keycloak/render-realm.mjs >/dev/null

[ -s "$STAGE/realm/realm-clavis.json" ] || { echo "the realm did not render" >&2; exit 1; }

# --- traefik ------------------------------------------------------------------
echo "==> rendering the Traefik configuration"
# Defaults to loopback, which reaches nobody: on a public demo the admin console
# must be opened deliberately.
ADMIN_LIST=$(
  if [ -z "${CLAVIS_ADMIN_ALLOWLIST_RAW:-}" ]; then echo '"127.0.0.1/32"'
  else printf '%s' "$CLAVIS_ADMIN_ALLOWLIST_RAW" | tr ',' '\n' | sed 's/^ *//; s/ *$//' \
       | grep -v '^$' | sed 's/.*/"&"/' | paste -sd, -
  fi
)
export CLAVIS_ADMIN_ALLOWLIST="$ADMIN_LIST" CLAVIS_REALM="$REALM"

envsubst '${CLAVIS_APP_FQDN} ${CLAVIS_API_FQDN} ${CLAVIS_AUTH_FQDN} ${CLAVIS_ACME_EMAIL} ${CLAVIS_CERT_RESOLVER}' \
  < infra/deploy/traefik/traefik.yml.tpl > "$STAGE/traefik/traefik.yml"
envsubst '${CLAVIS_APP_FQDN} ${CLAVIS_API_FQDN} ${CLAVIS_AUTH_FQDN} ${CLAVIS_ADMIN_ALLOWLIST} ${CLAVIS_REALM}' \
  < infra/deploy/traefik/dynamic/stack.yml.tpl > "$STAGE/traefik/dynamic/stack.yml"

# An unresolved placeholder means Traefik would start with a literal ${...} in
# its routing rules and match nothing.
if grep -n '\${' "$STAGE/traefik/traefik.yml" "$STAGE/traefik/dynamic/stack.yml"; then
  echo "unresolved placeholders in the Traefik configuration" >&2
  exit 1
fi

# --- compose and environment --------------------------------------------------
# No Cloudflare credential travels to the host: ACME uses HTTP-01, so the
# droplet never holds a token that could rewrite the zone.
cp infra/deploy/docker-compose.prod.yml "$STAGE/docker-compose.yml"

cat > "$STAGE/.env" <<EOF
# Generated by scripts/build-deploy-bundle.sh for ${DEPLOY_SHA}.
# Contains live credentials. Never leaves the private blob container.
CLAVIS_APP_FQDN=${CLAVIS_APP_FQDN}
CLAVIS_API_FQDN=${CLAVIS_API_FQDN}
CLAVIS_AUTH_FQDN=${CLAVIS_AUTH_FQDN}
CLAVIS_COMMIT=${DEPLOY_SHA}

CLAVIS_API_IMAGE=${CLAVIS_API_IMAGE}
CLAVIS_APP_IMAGE=${CLAVIS_APP_IMAGE}
CLAVIS_AUTH_IMAGE=${CLAVIS_AUTH_IMAGE}

KEYCLOAK_REALM=${REALM}
KEYCLOAK_APP_CLIENT_ID=${KEYCLOAK_APP_CLIENT_ID:-clavis-app}
KEYCLOAK_API_CLIENT_ID=${KEYCLOAK_API_CLIENT_ID:-clavis-api}

CLAVIS_DATABASE_URL=${CLAVIS_DATABASE_URL}
CLAVIS_DB_HOST=${DB_HOST}
CLAVIS_DB_USER=${DB_USER}
CLAVIS_DB_PASSWORD=${DB_PASSWORD}
CLAVIS_KC_DB_NAME=${CLAVIS_KC_DB_NAME:-keycloak}

KC_BOOTSTRAP_ADMIN_USERNAME=${KC_BOOTSTRAP_ADMIN_USERNAME}
KC_BOOTSTRAP_ADMIN_PASSWORD=${KC_BOOTSTRAP_ADMIN_PASSWORD}

CLAVIS_STORAGE_CONNECTION_STRING=${CLAVIS_STORAGE_CONNECTION_STRING}
CLAVIS_ATTACHMENTS_CONTAINER=${CLAVIS_ATTACHMENTS_CONTAINER}

RESEND_API_KEY=${RESEND_API_KEY:-}
# Quoted because it contains <...>. Compose strips the quotes when it
# interpolates, but an unquoted value makes the file impossible to \`source\`
# from a shell — which is the same trap the repository root .env already
# documents.
MAIL_FROM="${MAIL_FROM:-Clavis <onboarding@resend.dev>}"
MAIL_ENABLED=${MAIL_ENABLED:-true}

LOG_LEVEL=${LOG_LEVEL:-info}
CACHE_TTL_SECONDS=${CACHE_TTL_SECONDS:-60}
MAX_UPLOAD_BYTES=${MAX_UPLOAD_BYTES:-10485760}
EOF
chmod 600 "$STAGE/.env"

# Catch a missing substitution here rather than on the host, where the symptom
# is a compose file that refuses to parse two minutes into a deploy.
docker compose --project-directory "$STAGE" config -q

# Explicit modes, because `umask 077` above would otherwise ship everything as
# 0600 and two containers could not read what they need:
#
#   * Traefik runs as root but with cap_drop: ALL, which takes CAP_DAC_OVERRIDE
#     away — so root can no longer read a file it does not own.
#   * the Keycloak import container runs as uid 1000 and has to read the realm.
#
# Confidentiality comes from the host instead: reconcile.sh keeps
# /opt/clavis/stack at 0700 root-owned, so nothing here is reachable by a non-root
# user on the droplet.
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f -exec chmod 0644 {} +
# The one file that really is a secret, and only root reads it.
chmod 0600 "$STAGE/.env"

tar -czf dist/bundle.tar.gz -C "$STAGE" .

cat > dist/current.json <<EOF
{
  "commit": "${DEPLOY_SHA}",
  "bundle": "${DEPLOY_SHA}.tar.gz",
  "images": {
    "api": "${CLAVIS_API_IMAGE}",
    "app": "${CLAVIS_APP_IMAGE}",
    "auth": "${CLAVIS_AUTH_IMAGE}"
  }
}
EOF

echo "==> bundle ready ($(stat -c %s dist/bundle.tar.gz) bytes) for ${DEPLOY_SHA}"
