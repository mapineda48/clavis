#!/bin/sh
#
# Generates /usr/share/nginx/html/config.js on every container start.
#
# The nginx entrypoint runs the scripts in /docker-entrypoint.d in alphabetical
# order before launching the server, so the SPA always finds an up-to-date
# configuration without rebuilding the image.
#
# index.html must load <script src="/config.js"></script> before the bundle;
# src/config.ts reads window.__CLAVIS_CONFIG__ as its first source of truth.

set -eu

# Defaults aimed at the local demo.
CLAVIS_KEYCLOAK_URL="${CLAVIS_KEYCLOAK_URL:-http://localhost:8080}"
CLAVIS_KEYCLOAK_REALM="${CLAVIS_KEYCLOAK_REALM:-clavis}"
CLAVIS_KEYCLOAK_CLIENT_ID="${CLAVIS_KEYCLOAK_CLIENT_ID:-clavis-app}"
CLAVIS_KEYCLOAK_API_CLIENT_ID="${CLAVIS_KEYCLOAK_API_CLIENT_ID:-clavis-api}"
CLAVIS_API_URL="${CLAVIS_API_URL:-http://localhost:3000}"
# Commit this build was deployed from. It is what lets the pipeline tell a
# converged host from one that merely answers.
CLAVIS_COMMIT="${CLAVIS_COMMIT:-dev}"

# Written OUTSIDE the document root, and served through an `alias` in app.conf.
# The root belongs to the image and stays read-only, so in production the whole
# container can run with `read_only: true` and a tmpfs on /run. Writing into
# /usr/share/nginx/html would abort this script (it runs under `set -eu`) and
# take the container down at startup.
OUTPUT_FILE="${CLAVIS_CONFIG_PATH:-/run/clavis/config.js}"

mkdir -p "$(dirname "$OUTPUT_FILE")"

# Escapes a value so it can be embedded inside JavaScript single quotes:
# backslashes first, then the single quotes.
escape_js() {
    printf '%s' "$1" | sed -e 's|\\|\\\\|g' -e "s|'|\\\\'|g"
}

KEYCLOAK_URL_JS="$(escape_js "$CLAVIS_KEYCLOAK_URL")"
KEYCLOAK_REALM_JS="$(escape_js "$CLAVIS_KEYCLOAK_REALM")"
KEYCLOAK_CLIENT_ID_JS="$(escape_js "$CLAVIS_KEYCLOAK_CLIENT_ID")"
KEYCLOAK_API_CLIENT_ID_JS="$(escape_js "$CLAVIS_KEYCLOAK_API_CLIENT_ID")"
API_URL_JS="$(escape_js "$CLAVIS_API_URL")"
COMMIT_JS="$(escape_js "$CLAVIS_COMMIT")"

cat > "$OUTPUT_FILE" <<EOF
// File generated at startup by 40-clavis-runtime-config.sh.
// Do not edit it by hand: it is overwritten on every container start.
window.__CLAVIS_CONFIG__ = {
  keycloakUrl: '${KEYCLOAK_URL_JS}',
  keycloakRealm: '${KEYCLOAK_REALM_JS}',
  keycloakClientId: '${KEYCLOAK_CLIENT_ID_JS}',
  apiClientId: '${KEYCLOAK_API_CLIENT_ID_JS}',
  apiUrl: '${API_URL_JS}',
  commit: '${COMMIT_JS}'
};
EOF

echo "[clavis-runtime-config] wrote ${OUTPUT_FILE}"
echo "[clavis-runtime-config]   keycloakUrl      = ${CLAVIS_KEYCLOAK_URL}"
echo "[clavis-runtime-config]   keycloakRealm    = ${CLAVIS_KEYCLOAK_REALM}"
echo "[clavis-runtime-config]   keycloakClientId = ${CLAVIS_KEYCLOAK_CLIENT_ID}"
echo "[clavis-runtime-config]   apiClientId      = ${CLAVIS_KEYCLOAK_API_CLIENT_ID}"
echo "[clavis-runtime-config]   apiUrl           = ${CLAVIS_API_URL}"
echo "[clavis-runtime-config]   commit           = ${CLAVIS_COMMIT}"
