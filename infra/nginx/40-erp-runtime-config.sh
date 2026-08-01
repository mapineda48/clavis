#!/bin/sh
#
# Generates /usr/share/nginx/html/config.js on every container start.
#
# The nginx entrypoint runs the scripts in /docker-entrypoint.d in alphabetical
# order before launching the server, so the SPA always finds an up-to-date
# configuration without rebuilding the image.
#
# index.html must load <script src="/config.js"></script> before the bundle;
# src/config.ts reads window.__ERP_CONFIG__ as its first source of truth.

set -eu

# Defaults aimed at the local demo.
ERP_KEYCLOAK_URL="${ERP_KEYCLOAK_URL:-http://localhost:8080}"
ERP_KEYCLOAK_REALM="${ERP_KEYCLOAK_REALM:-erp}"
ERP_KEYCLOAK_CLIENT_ID="${ERP_KEYCLOAK_CLIENT_ID:-erp-app}"
ERP_KEYCLOAK_API_CLIENT_ID="${ERP_KEYCLOAK_API_CLIENT_ID:-erp-api}"
ERP_API_URL="${ERP_API_URL:-http://localhost:3000}"

OUTPUT_FILE="${ERP_CONFIG_PATH:-/usr/share/nginx/html/config.js}"

# Escapes a value so it can be embedded inside JavaScript single quotes:
# backslashes first, then the single quotes.
escape_js() {
    printf '%s' "$1" | sed -e 's|\\|\\\\|g' -e "s|'|\\\\'|g"
}

KEYCLOAK_URL_JS="$(escape_js "$ERP_KEYCLOAK_URL")"
KEYCLOAK_REALM_JS="$(escape_js "$ERP_KEYCLOAK_REALM")"
KEYCLOAK_CLIENT_ID_JS="$(escape_js "$ERP_KEYCLOAK_CLIENT_ID")"
KEYCLOAK_API_CLIENT_ID_JS="$(escape_js "$ERP_KEYCLOAK_API_CLIENT_ID")"
API_URL_JS="$(escape_js "$ERP_API_URL")"

cat > "$OUTPUT_FILE" <<EOF
// File generated at startup by 40-erp-runtime-config.sh.
// Do not edit it by hand: it is overwritten on every container start.
window.__ERP_CONFIG__ = {
  keycloakUrl: '${KEYCLOAK_URL_JS}',
  keycloakRealm: '${KEYCLOAK_REALM_JS}',
  keycloakClientId: '${KEYCLOAK_CLIENT_ID_JS}',
  apiClientId: '${KEYCLOAK_API_CLIENT_ID_JS}',
  apiUrl: '${API_URL_JS}'
};
EOF

echo "[erp-runtime-config] wrote ${OUTPUT_FILE}"
echo "[erp-runtime-config]   keycloakUrl      = ${ERP_KEYCLOAK_URL}"
echo "[erp-runtime-config]   keycloakRealm    = ${ERP_KEYCLOAK_REALM}"
echo "[erp-runtime-config]   keycloakClientId = ${ERP_KEYCLOAK_CLIENT_ID}"
echo "[erp-runtime-config]   apiClientId      = ${ERP_KEYCLOAK_API_CLIENT_ID}"
echo "[erp-runtime-config]   apiUrl           = ${ERP_API_URL}"
