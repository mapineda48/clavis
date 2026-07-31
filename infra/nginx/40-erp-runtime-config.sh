#!/bin/sh
#
# Genera /usr/share/nginx/html/config.js en cada arranque del contenedor.
#
# El entrypoint de nginx ejecuta los scripts de /docker-entrypoint.d en orden
# alfabetico antes de lanzar el servidor, asi que el SPA siempre encuentra la
# configuracion actualizada sin necesidad de recompilar la imagen.
#
# index.html debe cargar <script src="/config.js"></script> antes del bundle;
# src/config.ts lee window.__ERP_CONFIG__ como primera fuente de verdad.

set -eu

# Valores por defecto pensados para la demo local.
ERP_KEYCLOAK_URL="${ERP_KEYCLOAK_URL:-http://localhost:8080}"
ERP_KEYCLOAK_REALM="${ERP_KEYCLOAK_REALM:-erp}"
ERP_KEYCLOAK_CLIENT_ID="${ERP_KEYCLOAK_CLIENT_ID:-erp-app}"
ERP_KEYCLOAK_API_CLIENT_ID="${ERP_KEYCLOAK_API_CLIENT_ID:-erp-api}"
ERP_API_URL="${ERP_API_URL:-http://localhost:3000}"

OUTPUT_FILE="${ERP_CONFIG_PATH:-/usr/share/nginx/html/config.js}"

# Escapa un valor para incrustarlo dentro de comillas simples de JavaScript:
# primero las barras invertidas, despues las comillas simples.
escape_js() {
    printf '%s' "$1" | sed -e 's|\\|\\\\|g' -e "s|'|\\\\'|g"
}

KEYCLOAK_URL_JS="$(escape_js "$ERP_KEYCLOAK_URL")"
KEYCLOAK_REALM_JS="$(escape_js "$ERP_KEYCLOAK_REALM")"
KEYCLOAK_CLIENT_ID_JS="$(escape_js "$ERP_KEYCLOAK_CLIENT_ID")"
KEYCLOAK_API_CLIENT_ID_JS="$(escape_js "$ERP_KEYCLOAK_API_CLIENT_ID")"
API_URL_JS="$(escape_js "$ERP_API_URL")"

cat > "$OUTPUT_FILE" <<EOF
// Archivo generado en el arranque por 40-erp-runtime-config.sh.
// No lo edites a mano: se sobrescribe en cada inicio del contenedor.
window.__ERP_CONFIG__ = {
  keycloakUrl: '${KEYCLOAK_URL_JS}',
  keycloakRealm: '${KEYCLOAK_REALM_JS}',
  keycloakClientId: '${KEYCLOAK_CLIENT_ID_JS}',
  apiClientId: '${KEYCLOAK_API_CLIENT_ID_JS}',
  apiUrl: '${API_URL_JS}'
};
EOF

echo "[erp-runtime-config] escrito ${OUTPUT_FILE}"
echo "[erp-runtime-config]   keycloakUrl      = ${ERP_KEYCLOAK_URL}"
echo "[erp-runtime-config]   keycloakRealm    = ${ERP_KEYCLOAK_REALM}"
echo "[erp-runtime-config]   keycloakClientId = ${ERP_KEYCLOAK_CLIENT_ID}"
echo "[erp-runtime-config]   apiClientId      = ${ERP_KEYCLOAK_API_CLIENT_ID}"
echo "[erp-runtime-config]   apiUrl           = ${ERP_API_URL}"
