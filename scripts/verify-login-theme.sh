#!/usr/bin/env bash
# =============================================================================
# Verifica el tema de login propio.
#
#   ./scripts/verify-login-theme.sh
#
# No comprueba solo que la página "se vea": completa el flujo OIDC entero
# (autorización con PKCE → formulario → código → canje por token), que es lo que
# de verdad se rompe al sustituir las plantillas Freemarker.
# =============================================================================
set -uo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_tools curl python3
require_env
require_up "$KC/realms/$REALM/.well-known/openid-configuration" "Keycloak"

JAR=$(mktemp "${TMPDIR:-/tmp}/erp-cookies-XXXXXX")
HTML=$(mktemp "${TMPDIR:-/tmp}/erp-login-XXXXXX.html")
trap 'rm -f "$JAR" "$HTML"' EXIT

pkce_pair
AUTH=$(auth_url "verify")

echo "=== 0. PKCE es obligatorio ==="
NOPKCE=$(curl -s -o /dev/null -w '%{redirect_url}' \
  "$KC/realms/$REALM/protocol/openid-connect/auth?client_id=$CLIENT&redirect_uri=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$REDIRECT_URI")&response_type=code&scope=openid&state=x")
case "$NOPKCE" in
  *code_challenge*) ok "sin code_challenge Keycloak rechaza la petición" ;;
  *) bad "el cliente acepta autorización sin PKCE" ;;
esac

echo
echo "=== 1. La página de login responde ==="
CODE=$(curl -s -c "$JAR" -o "$HTML" -w '%{http_code}' "$AUTH")
chk "$CODE" 200 "GET /auth"

echo
echo "=== 2. Es el tema propio, no el de Keycloak ==="
grep -q 'erp-layout' "$HTML" && ok "layout propio (.erp-layout) presente" || bad "no aparece .erp-layout"
grep -q 'erp-brand' "$HTML" && ok "panel de marca (.erp-brand) presente" || bad "no aparece .erp-brand"
grep -q 'erp-login.css' "$HTML" && ok "hoja de estilos propia enlazada" || bad "no se enlaza erp-login.css"
grep -q 'data-erp-username' "$HTML" && ok "chuleta de usuarios demo presente" || bad "no hay botones data-erp-username"
grep -qi 'patternfly' "$HTML" && bad "arrastra CSS de PatternFly" || ok "sin restos del tema por defecto"

echo
echo "=== 3. Ningún error de Freemarker ==="
if grep -qi 'FreeMarker template error\|Internal Server Error\|We are sorry' "$HTML"; then
  bad "la plantilla lanzó un error de renderizado"
  grep -io 'freemarker[^<]\{0,200\}' "$HTML" | head -3
else
  ok "la plantilla renderiza sin errores"
fi
if grep -o '??[a-zA-Z][a-zA-Z0-9_.-]*??' "$HTML" | sort -u | grep -q .; then
  bad "hay claves de mensaje sin resolver:"
  grep -o '??[a-zA-Z][a-zA-Z0-9_.-]*??' "$HTML" | sort -u | head -5
else
  ok "todas las claves de mensaje resuelven"
fi

echo
echo "=== 4. Recursos estáticos ==="
for r in "erp-login.css" "erp-login.js"; do
  U=$(grep -o "[^\"']*${r}[^\"']*" "$HTML" | head -1)
  if [ -n "$U" ]; then
    chk "$(curl -s -o /dev/null -w '%{http_code}' "$KC$U")" 200 "$r sirve"
  else
    bad "$r no aparece enlazado en el HTML"
  fi
done
BASEJS=$(grep -o "[^\"']*/js/authChecker.js" "$HTML" | head -1)
if [ -n "$BASEJS" ]; then
  chk "$(curl -s -o /dev/null -w '%{http_code}' "$KC$BASEJS")" 200 "authChecker.js heredado de base sirve"
else
  bad "no se enlaza authChecker.js (se pierde la detección de sesión en otra pestaña)"
fi

echo
echo "=== 5. El formulario AUTENTICA de verdad (flujo OIDC completo) ==="
ACTION=$(form_action "$HTML" "kc-form-login")
if [ -z "$ACTION" ]; then
  bad "no se encontró el formulario #kc-form-login"
else
  ok "formulario #kc-form-login encontrado"
  LOC=$(curl -s -b "$JAR" -c "$JAR" -o /dev/null -w '%{redirect_url}' \
    -d "username=$(envval DEMO_USER_USERNAME)" \
    --data-urlencode "password=$(envval DEMO_USER_PASSWORD)" \
    -X POST "$ACTION")
  case "$LOC" in
    *code=*)
      ok "login correcto: Keycloak redirige con authorization code"
      AUTHCODE=$(python3 -c "
import sys, urllib.parse as u
print(u.parse_qs(u.urlparse(sys.argv[1]).query).get('code', [''])[0])" "$LOC")
      TOK=$(curl -s -X POST "$KC/realms/$REALM/protocol/openid-connect/token" \
        -d "grant_type=authorization_code" -d "client_id=$CLIENT" \
        -d "code=$AUTHCODE" -d "redirect_uri=$REDIRECT_URI" -d "code_verifier=$PKCE_VERIFIER" |
        python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token','') or ('ERR:'+str(d.get('error_description') or d.get('error'))))")
      case "$TOK" in
        ERR:* | "") bad "el canje del código por token falló: ${TOK:0:140}" ;;
        *)
          ok "el código se canjea por un access token válido (PKCE completo)"
          python3 -c "
import sys, json, base64
p = sys.argv[1].split('.')[1]; p += '=' * (-len(p) % 4)
c = json.loads(base64.urlsafe_b64decode(p))
print('     usuario:', c.get('preferred_username'), '| aud:', c.get('aud'))
print('     permisos:', sorted(c.get('resource_access', {}).get('erp-api', {}).get('roles', [])))" "$TOK"
          ;;
      esac
      ;;
    "") bad "el POST no redirigió (credenciales rechazadas o formulario roto)" ;;
    *) bad "redirección inesperada: ${LOC:0:140}" ;;
  esac
fi

echo
echo "=== 6. Credenciales inválidas → error dentro del tema ==="
# Keycloak suprime la alerta global cuando el fallo es de usuario/contraseña
# (displayMessage=!messagesPerField.existsError) y lo muestra junto al campo.
ERRHTML=$(mktemp "${TMPDIR:-/tmp}/erp-err-XXXXXX.html")
JAR2=$(mktemp "${TMPDIR:-/tmp}/erp-cookies2-XXXXXX")
H2=$(mktemp "${TMPDIR:-/tmp}/erp-login2-XXXXXX.html")
curl -s -c "$JAR2" -o "$H2" "$AUTH"
ACTION2=$(form_action "$H2" "kc-form-login")
if [ -n "$ACTION2" ]; then
  curl -s -b "$JAR2" -c "$JAR2" -o "$ERRHTML" -d "username=worker" -d "password=incorrecta" -X POST "$ACTION2"
  grep -q 'erp-layout' "$ERRHTML" && ok "el error se muestra dentro del tema propio" || bad "la página de error no usa el tema"
  grep -q 'erp-field-error' "$ERRHTML" && ok "error a nivel de campo (.erp-field-error)" || bad "no se ve el error de campo"
  grep -q 'aria-invalid="true"' "$ERRHTML" && ok "el campo se marca aria-invalid" || bad "falta aria-invalid en el campo"
  grep -qi 'contrase' "$ERRHTML" && ok "el mensaje sale traducido al español" || bad "el mensaje no está traducido"
else
  bad "no se pudo repetir el formulario para la prueba de error"
fi
rm -f "$ERRHTML" "$JAR2" "$H2"

echo
echo "=== 7. Traducción: la página responde en inglés con ui_locales=en ==="
H3=$(mktemp "${TMPDIR:-/tmp}/erp-en-XXXXXX.html")
curl -s -o "$H3" "${AUTH}&ui_locales=en"
grep -q 'erp-layout' "$H3" && ok "la versión en inglés también usa el tema" || bad "la versión en inglés falla"
rm -f "$H3"

summary "TEMA"
