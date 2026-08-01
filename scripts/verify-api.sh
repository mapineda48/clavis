#!/usr/bin/env bash
# =============================================================================
# Regresión de la API: modelo de permisos, caché, adjuntos y correo.
#
#   ./scripts/verify-api.sh
#   MAIL_TEST_TO=tu@correo.com ./scripts/verify-api.sh   # prueba el envío real
#
# Requiere el stack arriba (docker compose up -d) y un .env en la raíz.
# No imprime tokens ni secretos.
# =============================================================================
set -uo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_tools curl python3
require_env
require_up "$KC/realms/$REALM/.well-known/openid-configuration" "Keycloak"
require_up "$API/health" "La API"

echo "=== 1. Tokens de los tres usuarios demo ==="
T_ADMIN=$(token_for "$(envval DEMO_ADMIN_USERNAME)" DEMO_ADMIN_PASSWORD)
T_MGR=$(token_for "$(envval DEMO_MANAGER_USERNAME)" DEMO_MANAGER_PASSWORD)
T_USR=$(token_for "$(envval DEMO_USER_USERNAME)" DEMO_USER_PASSWORD)
for n in ADMIN MGR USR; do
  v="T_$n"
  [ -n "${!v}" ] && ok "token $n obtenido" || bad "token $n VACIO"
done
[ -z "$T_USR" ] && { echo "Sin token de worker, se aborta."; exit 1; }

echo
echo "=== 2. Claims del token (worker) ==="
python3 - "$T_USR" <<'PY'
import sys, json, base64
p = sys.argv[1].split('.')[1]; p += '=' * (-len(p) % 4)
c = json.loads(base64.urlsafe_b64decode(p))
aud = c.get('aud'); aud = aud if isinstance(aud, list) else [aud]
print("  aud            :", aud)
print("  iss            :", c.get('iss'))
print("  realm_access   :", sorted(r for r in c.get('realm_access', {}).get('roles', []) if r.startswith('erp')))
print("  resource_access:", sorted(c.get('resource_access', {}).get('erp-api', {}).get('roles', [])))
PY

echo
echo "=== 3. Salud del servicio ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/health")" 200 "GET /health"
echo "  ready: $(curl -s "$API/health/ready" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("status"), json.dumps(d.get("checks"), ensure_ascii=False))' 2>/dev/null)"
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/health/ready")" 200 "GET /health/ready"
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/docs")" 200 "GET /docs (Swagger)"

echo
echo "=== 4. Permisos efectivos por usuario ==="
for pair in "worker:$T_USR" "manager:$T_MGR" "admin:$T_ADMIN"; do
  n="${pair%%:*}"; t="${pair#*:}"
  echo "  --- $n"
  curl -s -H "Authorization: Bearer $t" "$API/api/me" |
    python3 -c "import sys,json;print('     perms:', sorted(json.load(sys.stdin).get('permissions', [])))"
done

echo
echo "=== 5. Autenticación obligatoria ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/todos")" 401 "GET /api/todos sin token"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer no.es.un.jwt' "$API/api/todos")" 401 "token basura"

echo
echo "=== 6. Datos de ejemplo (idempotente) ==="
curl -s -X POST -H "Authorization: Bearer $T_USR" "$API/api/todos/seed-demo" >/dev/null
S2=$(curl -s -X POST -H "Authorization: Bearer $T_USR" "$API/api/todos/seed-demo" |
  python3 -c 'import sys,json;print(json.load(sys.stdin).get("created"))')
chk "$S2" "0" "segunda llamada a seed-demo no duplica"

echo
echo "=== 7. Caché en Valkey (X-Cache) ==="
C1=$(curl -s -D- -o /dev/null -H "Authorization: Bearer $T_USR" "$API/api/todos?pageSize=5" | grep -i '^x-cache:' | tr -d '\r' | awk '{print $2}')
C2=$(curl -s -D- -o /dev/null -H "Authorization: Bearer $T_USR" "$API/api/todos?pageSize=5" | grep -i '^x-cache:' | tr -d '\r' | awk '{print $2}')
[ "$C1" = "MISS" ] && ok "primera llamada MISS" || bad "primera llamada debería ser MISS (fue $C1)"
[ "$C2" = "HIT" ] && ok "segunda llamada HIT" || bad "segunda llamada debería ser HIT (fue $C2)"

echo
echo "=== 8. Alcance de visibilidad ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_USR" "$API/api/todos?scope=all")" 403 "worker con scope=all"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_MGR" "$API/api/todos?scope=all")" 200 "manager con scope=all"

echo
echo "=== 9. Escritura y borrado ==="
NEW=$(curl -s -X POST -H "Authorization: Bearer $T_USR" -H 'Content-Type: application/json' \
  -d '{"title":"Tarea de prueba e2e","description":"Creada por el guion de verificación","priority":2}' "$API/api/todos")
TID=$(echo "$NEW" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$TID" ] && ok "worker crea tarea (todos:write)" || bad "worker no pudo crear tarea: ${NEW:0:160}"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $T_USR" -H 'Content-Type: application/json' -d '{"status":"in_progress"}' "$API/api/todos/$TID")" 200 "worker actualiza su tarea"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $T_USR" "$API/api/todos/$TID")" 403 "worker NO puede borrar"

echo
echo "=== 10. Adjuntos en Azurite ==="
TMPF=$(mktemp "${TMPDIR:-/tmp}/erp-adjunto-XXXXXX.txt")
echo "Documento de prueba del ERP - $(date +%s)-$$" >"$TMPF"
UP=$(curl -s -X POST -H "Authorization: Bearer $T_USR" -F "file=@$TMPF;type=text/plain" "$API/api/todos/$TID/attachments")
AID=$(echo "$UP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$AID" ] && ok "subida de adjunto" || bad "falló la subida: ${UP:0:200}"
DL=$(curl -s -H "Authorization: Bearer $T_USR" "$API/api/attachments/$AID")
[ "$DL" = "$(cat "$TMPF")" ] && ok "descarga idéntica al original" || bad "el contenido descargado no coincide"
rm -f "$TMPF"

echo
echo "=== 11. Panel de administración ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_USR" "$API/api/admin/stats")" 403 "worker en /admin/stats"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_MGR" "$API/api/admin/users")" 200 "manager en /admin/users"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_MGR" "$API/api/admin/stats")" 403 "manager en /admin/stats"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_ADMIN" "$API/api/admin/stats")" 200 "admin en /admin/stats"

echo
echo "=== 12. Borrado con permiso (manager) ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $T_MGR" "$API/api/todos/$TID")" 200 "manager borra la tarea"

echo
echo "=== 13. Notificación por correo ==="
FIRST=$(curl -s -H "Authorization: Bearer $T_USR" "$API/api/todos?pageSize=1" |
  python3 -c 'import sys,json;i=json.load(sys.stdin).get("items",[]);print(i[0]["id"] if i else "")')
if [ -n "$FIRST" ] && [ -n "${MAIL_TEST_TO:-}" ]; then
  NOTIF=$(curl -s -X POST -H "Authorization: Bearer $T_USR" -H 'Content-Type: application/json' \
    -d "{\"to\":\"$MAIL_TEST_TO\"}" "$API/api/todos/$FIRST/notify")
  echo "$NOTIF" | grep -q '"delivered":true' && ok "correo entregado a Resend" || bad "el correo no se entregó: ${NOTIF:0:200}"
else
  echo "  (omitido: define MAIL_TEST_TO para probar el envío real)"
fi

summary "API"
