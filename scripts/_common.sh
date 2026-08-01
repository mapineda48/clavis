#!/usr/bin/env bash
# =============================================================================
# Utilidades compartidas por los guiones de verificación.
#
# No se ejecuta directamente: cada guion hace `source` de este archivo.
# Resuelve la raíz del repositorio a partir de su propia ubicación, así que los
# guiones funcionan desde cualquier directorio de trabajo.
# =============================================================================

ERP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ERP_ROOT" || exit 1

# Se pueden sobrescribir por entorno para apuntar a otro despliegue.
KC="${KC_URL:-http://localhost:8080}"
API="${API_URL:-http://localhost:3000}"
REALM="${KEYCLOAK_REALM:-erp}"
CLIENT="${KEYCLOAK_APP_CLIENT_ID:-erp-app}"
REDIRECT_URI="${APP_DEV_URL:-http://localhost:5173}/"

pass=0
fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; fail=$((fail + 1)); }
chk() { [ "$1" = "$2" ] && ok "$3 (=$1)" || bad "$3 (esperado $2, obtenido $1)"; }

# Lee una variable del .env SIN usar `source`: MAIL_FROM contiene `<...>` y
# reventaría el shell. Quita las comillas envolventes si las hay.
envval() {
  sed -n "s/^$1=//p" "$ERP_ROOT/.env" 2>/dev/null | head -1 | sed 's/^"//; s/"$//'
}

require_tools() {
  local faltan=()
  local t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || faltan+=("$t")
  done
  if [ ${#faltan[@]} -gt 0 ]; then
    echo "Faltan herramientas necesarias: ${faltan[*]}" >&2
    exit 2
  fi
}

require_env() {
  [ -f "$ERP_ROOT/.env" ] || {
    echo "No existe .env en la raíz del repositorio." >&2
    echo "Créalo con: cp .env.example .env" >&2
    exit 2
  }
}

# Comprueba que un servicio responde algo por debajo de 500.
require_up() {
  local url="$1" nombre="$2" code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo 000)
  if [ "$code" = "000" ] || [ "$code" -ge 500 ] 2>/dev/null; then
    echo "$nombre no responde en $url (HTTP $code)." >&2
    echo "Arranca el stack con: docker compose up -d" >&2
    exit 2
  fi
}

# Genera un par PKCE S256 y deja PKCE_VERIFIER / PKCE_CHALLENGE en el entorno.
# El cliente erp-app EXIGE PKCE: sin code_challenge, Keycloak rechaza la petición.
pkce_pair() {
  read -r PKCE_VERIFIER PKCE_CHALLENGE <<<"$(python3 -c "
import base64, hashlib, secrets
v = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip('=')
c = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).decode().rstrip('=')
print(v, c)
")"
}

# URL de autorización con PKCE. $1 = state (opcional).
auth_url() {
  python3 -c "
import sys, urllib.parse as u
kc, realm, client, redir, state, ch = sys.argv[1:7]
q = u.urlencode({
    'client_id': client, 'redirect_uri': redir, 'response_type': 'code',
    'scope': 'openid', 'state': state,
    'code_challenge': ch, 'code_challenge_method': 'S256',
})
print(f'{kc}/realms/{realm}/protocol/openid-connect/auth?{q}')
" "$KC" "$REALM" "$CLIENT" "$REDIRECT_URI" "${1:-demo}" "$PKCE_CHALLENGE"
}

# Extrae el `action` de un formulario. $1 = archivo HTML, $2 = id del form (opcional).
form_action() {
  python3 -c "
import re, sys, html
h = open(sys.argv[1], encoding='utf-8', errors='replace').read()
fid = sys.argv[2] if len(sys.argv) > 2 else ''
pat = rf'<form[^>]*id=\"{re.escape(fid)}\"[^>]*>' if fid else r'<form[^>]*>'
m = re.search(pat, h)
if not m:
    print('')
else:
    a = re.search(r'action=\"([^\"]+)\"', m.group(0))
    print(html.unescape(a.group(1)) if a else '')
" "$@"
}

# Obtiene un access token por grant_type=password. $1 = usuario, $2 = variable del .env
# con la contraseña. Solo para pruebas: el cliente lo permite a propósito.
token_for() {
  curl -s -X POST "$KC/realms/$REALM/protocol/openid-connect/token" \
    -d "client_id=$CLIENT" -d "grant_type=password" \
    -d "username=$1" --data-urlencode "password=$(envval "$2")" |
    python3 -c "import sys, json; print(json.load(sys.stdin).get('access_token', ''))"
}

# Imprime el resumen y determina el código de salida del guion.
summary() {
  echo
  echo "==================== $1: $pass OK / $fail FALLOS ===================="
  [ "$fail" -eq 0 ]
}
