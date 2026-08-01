#!/usr/bin/env bash
# =============================================================================
# Verifica el flujo completo de "he olvidado mi contraseña".
#
#   ./scripts/verify-password-reset.sh
#
# Recorrido real: solicitud desde el login → correo enviado por Keycloak vía
# SMTP → se LEE ese correo con la API de Resend → se sigue su enlace → se fija
# la contraseña → se comprueba que sirve para iniciar sesión.
#
# Requisitos añadidos respecto a los otros guiones:
#   - La CLI `resend`, autenticada (https://resend.com/docs) — para leer el correo.
#   - El realm con SMTP configurado y `resetPasswordAllowed: true`.
#   - DEMO_ADMIN_EMAIL apuntando a una dirección REAL.
#
# La contraseña se vuelve a fijar al MISMO valor que hay en .env, para no dejar
# la demostración inconsistente.
# =============================================================================
set -uo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_tools curl python3 resend
require_env
require_up "$KC/realms/$REALM/.well-known/openid-configuration" "Keycloak"

if ! resend whoami --json >/dev/null 2>&1; then
  echo "La CLI de Resend no está autenticada. Ejecuta: resend login" >&2
  exit 2
fi

JAR=$(mktemp "${TMPDIR:-/tmp}/erp-cookies-XXXXXX")
HTML=$(mktemp "${TMPDIR:-/tmp}/erp-login-XXXXXX.html")
RESETP=$(mktemp "${TMPDIR:-/tmp}/erp-reset-XXXXXX.html")
OUT=$(mktemp "${TMPDIR:-/tmp}/erp-out-XXXXXX")
trap 'rm -f "$JAR" "$HTML" "$RESETP" "$OUT"' EXIT

pkce_pair
AUTH=$(auth_url "reset")

last_email_id() {
  resend emails list --limit 1 --json 2>/dev/null |
    python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('data',[]);print(r[0]['id'] if r else '')"
}

echo "=== 1. Enlace de recuperación en el login ==="
curl -s -c "$JAR" -o "$HTML" "$AUTH"
RESET=$(python3 -c "
import re, sys, html
h = open(sys.argv[1], encoding='utf-8', errors='replace').read()
m = re.search(r'href=\"([^\"]*reset-credentials[^\"]*)\"', h)
print(html.unescape(m.group(1)) if m else '')" "$HTML")
[ -n "$RESET" ] && ok "el login ofrece '¿Has olvidado la contraseña?'" || {
  bad "no aparece el enlace (¿resetPasswordAllowed está en false?)"
  summary "RECUPERACIÓN"; exit 1
}

echo
echo "=== 2. Pantalla de recuperación con el tema propio ==="
curl -s -b "$JAR" -c "$JAR" -o "$RESETP" "$KC$RESET"
grep -q 'erp-layout' "$RESETP" && ok "usa el tema erp" || bad "no usa el tema erp"
grep -q 'id="kc-reset-password-form"' "$RESETP" && ok "formulario de recuperación intacto" || bad "falta #kc-reset-password-form"
grep -q 'erp-card__subtitle' "$RESETP" && ok "subtítulo propio del tema" || bad "sin subtítulo propio"
grep -qi 'freemarker template error' "$RESETP" && bad "error de Freemarker en la página" || ok "sin errores de Freemarker"
if grep -o '??[a-zA-Z][a-zA-Z0-9_.-]*??' "$RESETP" | sort -u | grep -q .; then
  bad "claves sin resolver:"; grep -o '??[a-zA-Z][a-zA-Z0-9_.-]*??' "$RESETP" | sort -u | head -3
else
  ok "todas las claves de mensaje resuelven"
fi

echo
echo "=== 3. Solicitud de restablecimiento para 'admin' ==="
BEFORE=$(last_email_id)
curl -s -b "$JAR" -c "$JAR" -o "$OUT" -d "username=$(envval DEMO_ADMIN_USERNAME)" -X POST "$(form_action "$RESETP" "kc-reset-password-form")"
grep -q 'erp-alert' "$OUT" && ok "Keycloak confirma el envío en el tema" || bad "sin confirmación visible"
grep -q 'erp-alert--error' "$OUT" && bad "Keycloak reporta un error de envío" || ok "sin error de envío"

echo
echo "=== 4. El correo llega a Resend ==="
MSG=""
for _ in $(seq 1 12); do
  sleep 3
  CAND=$(last_email_id)
  [ -n "$CAND" ] && [ "$CAND" != "$BEFORE" ] && { MSG="$CAND"; break; }
done
if [ -z "$MSG" ]; then
  bad "no aparece ningún correo nuevo en Resend"
  summary "RECUPERACIÓN"; exit 1
fi
ok "correo nuevo registrado en Resend"
resend emails get "$MSG" --json 2>/dev/null >"$OUT"
python3 -c "
import sys, json
d = json.load(open(sys.argv[1]))
print('     asunto :', d.get('subject'))
print('     de     :', d.get('from'))
print('     para   :', d.get('to'))
print('     estado :', d.get('last_event'))" "$OUT"

echo
echo "=== 5. El correo usa la maqueta propia ==="
HTMLBODY=$(python3 -c "import sys,json;print(json.load(open(sys.argv[1])).get('html') or '')" "$OUT")
[ -n "$HTMLBODY" ] || bad "Resend no devuelve el cuerpo HTML"
echo "$HTMLBODY" | grep -q 'role="presentation"' && ok "maquetado con tablas (compatible con clientes de correo)" || bad "sin tablas de maquetación"
echo "$HTMLBODY" | grep -qi '<style' && bad "lleva <style> (los clientes lo descartan)" || ok "CSS totalmente en línea"
echo "$HTMLBODY" | grep -qiE '<img[^>]+src="https?://|fonts\.(googleapis|gstatic)' && bad "carga recursos remotos" || ok "sin imágenes ni fuentes remotas"
echo "$HTMLBODY" | grep -qi 'ERP Demo' && ok "lleva la marca del ERP" || bad "no aparece la marca"

echo
echo "=== 6. El enlace del correo abre la pantalla de nueva contraseña ==="
LINK=$(echo "$HTMLBODY" | python3 -c "
import sys, re, html
h = sys.stdin.read()
m = re.search(r'href=\"([^\"]*login-actions/action-token[^\"]*)\"', h)
print(html.unescape(m.group(1)) if m else '')")
if [ -z "$LINK" ]; then
  bad "no se encontró el enlace de acción en el correo"
  summary "RECUPERACIÓN"; exit 1
fi
ok "enlace de acción encontrado"
JAR2=$(mktemp "${TMPDIR:-/tmp}/erp-cookies2-XXXXXX")
UPD=$(mktemp "${TMPDIR:-/tmp}/erp-upd-XXXXXX.html")
curl -s -L -c "$JAR2" -b "$JAR2" -o "$UPD" "$LINK"
grep -q 'erp-layout' "$UPD" && ok "la pantalla usa el tema erp" || bad "no usa el tema erp"
grep -q 'name="password-new"' "$UPD" && ok "campo de nueva contraseña presente" || bad "falta password-new"
grep -q 'name="password-confirm"' "$UPD" && ok "campo de confirmación presente" || bad "falta password-confirm"
grep -q 'logout-sessions' "$UPD" && ok "opción de cerrar otras sesiones" || bad "falta logout-sessions"

echo
echo "=== 7. Se fija la contraseña y queda operativa ==="
NEWPW=$(envval DEMO_ADMIN_PASSWORD) # la misma: así no se rompe el resto de la demo
if [ -z "$NEWPW" ]; then
  bad "DEMO_ADMIN_PASSWORD está vacío en .env: se aborta para no dejar la cuenta inservible"
  summary "RECUPERACIÓN"; exit 1
fi
# El formulario se localiza por id: la página lleva más de un <form> (el de
# "probar otra forma" y el del idioma) y enviar al equivocado deja la cuenta a medias.
UPD_ACTION=$(form_action "$UPD" "kc-passwd-update-form")
if [ -z "$UPD_ACTION" ]; then
  bad "no se encontró el formulario #kc-passwd-update-form"
  summary "RECUPERACIÓN"; exit 1
fi
RES=$(curl -s -b "$JAR2" -c "$JAR2" -o /dev/null -w '%{http_code}' \
  --data-urlencode "password-new=$NEWPW" --data-urlencode "password-confirm=$NEWPW" \
  -X POST "$UPD_ACTION")
echo "     respuesta HTTP: $RES"
sleep 1
TOK=$(curl -s -X POST "$KC/realms/$REALM/protocol/openid-connect/token" \
  -d "client_id=$CLIENT" -d "grant_type=password" -d "username=$(envval DEMO_ADMIN_USERNAME)" \
  --data-urlencode "password=$NEWPW" |
  python3 -c "import sys,json;print('OK' if json.load(sys.stdin).get('access_token') else 'FALLO')")
[ "$TOK" = "OK" ] && ok "admin inicia sesión con la contraseña establecida" || bad "no se puede iniciar sesión tras el cambio"
rm -f "$JAR2" "$UPD"

summary "RECUPERACIÓN"
