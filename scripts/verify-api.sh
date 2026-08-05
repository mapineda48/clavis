#!/usr/bin/env bash
# =============================================================================
# API regression: permission model, cache, attachments and email.
#
#   ./scripts/verify-api.sh
#   MAIL_TEST_TO=you@example.com ./scripts/verify-api.sh   # exercises real delivery
#
# Requires the stack to be up (docker compose up -d) and a .env at the root.
# It never prints tokens or secrets.
# =============================================================================
set -uo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_tools curl python3
require_env
require_up "$KC/realms/$REALM/.well-known/openid-configuration" "Keycloak"
require_up "$API/api/health" "The API"

echo "=== 1. Tokens for the three demo users ==="
T_ADMIN=$(token_for "$(envval DEMO_ADMIN_USERNAME)" DEMO_ADMIN_PASSWORD)
T_MGR=$(token_for "$(envval DEMO_MANAGER_USERNAME)" DEMO_MANAGER_PASSWORD)
T_USR=$(token_for "$(envval DEMO_USER_USERNAME)" DEMO_USER_PASSWORD)
for n in ADMIN MGR USR; do
  v="T_$n"
  [ -n "${!v}" ] && ok "got the $n token" || bad "$n token is EMPTY"
done
[ -z "$T_USR" ] && { echo "No worker token, aborting."; exit 1; }

echo
echo "=== 2. Token claims (worker) ==="
python3 - "$T_USR" <<'PY'
import sys, json, base64
p = sys.argv[1].split('.')[1]; p += '=' * (-len(p) % 4)
c = json.loads(base64.urlsafe_b64decode(p))
aud = c.get('aud'); aud = aud if isinstance(aud, list) else [aud]
print("  aud            :", aud)
print("  iss            :", c.get('iss'))
print("  realm_access   :", sorted(r for r in c.get('realm_access', {}).get('roles', []) if r.startswith('clavis')))
print("  resource_access:", sorted(c.get('resource_access', {}).get('clavis-api', {}).get('roles', [])))
PY

echo
echo "=== 3. Service health ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/health")" 200 "GET /api/health"
echo "  ready: $(curl -s "$API/api/health/ready" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("status"), json.dumps(d.get("checks"), ensure_ascii=False))' 2>/dev/null)"
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/health/ready")" 200 "GET /api/health/ready"
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/docs")" 200 "GET /api/docs (Swagger)"

echo
echo "=== 4. Effective permissions per user ==="
for pair in "worker:$T_USR" "manager:$T_MGR" "admin:$T_ADMIN"; do
  n="${pair%%:*}"; t="${pair#*:}"
  echo "  --- $n"
  curl -s -H "Authorization: Bearer $t" "$API/api/me" |
    python3 -c "import sys,json;print('     perms:', sorted(json.load(sys.stdin).get('permissions', [])))"
done

echo
echo "=== 5. Authentication is mandatory ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/todos")" 401 "GET /api/todos without a token"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer not.a.jwt' "$API/api/todos")" 401 "garbage token"

echo
echo "=== 6. Demo data (idempotent) ==="
curl -s -X POST -H "Authorization: Bearer $T_USR" "$API/api/todos/seed-demo" >/dev/null
S2=$(curl -s -X POST -H "Authorization: Bearer $T_USR" "$API/api/todos/seed-demo" |
  python3 -c 'import sys,json;print(json.load(sys.stdin).get("created"))')
chk "$S2" "0" "a second seed-demo call creates no duplicates"

echo
echo "=== 7. Valkey cache (X-Cache) ==="
C1=$(curl -s -D- -o /dev/null -H "Authorization: Bearer $T_USR" "$API/api/todos?pageSize=5" | grep -i '^x-cache:' | tr -d '\r' | awk '{print $2}')
C2=$(curl -s -D- -o /dev/null -H "Authorization: Bearer $T_USR" "$API/api/todos?pageSize=5" | grep -i '^x-cache:' | tr -d '\r' | awk '{print $2}')
[ "$C1" = "MISS" ] && ok "first call is a MISS" || bad "first call should be a MISS (was $C1)"
[ "$C2" = "HIT" ] && ok "second call is a HIT" || bad "second call should be a HIT (was $C2)"

echo
echo "=== 8. Visibility scope ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_USR" "$API/api/todos?scope=all")" 403 "worker with scope=all"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_MGR" "$API/api/todos?scope=all")" 200 "manager with scope=all"

echo
echo "=== 9. Write and delete ==="
NEW=$(curl -s -X POST -H "Authorization: Bearer $T_USR" -H 'Content-Type: application/json' \
  -d '{"title":"End-to-end test task","description":"Created by the verification script","priority":2}' "$API/api/todos")
TID=$(echo "$NEW" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$TID" ] && ok "worker creates a task (todos:write)" || bad "worker could not create the task: ${NEW:0:160}"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $T_USR" -H 'Content-Type: application/json' -d '{"status":"in_progress"}' "$API/api/todos/$TID")" 200 "worker updates their own task"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $T_USR" "$API/api/todos/$TID")" 403 "worker CANNOT delete"

echo
echo "=== 10. Attachments in Azurite ==="
TMPF=$(mktemp "${TMPDIR:-/tmp}/clavis-attachment-XXXXXX.txt")
echo "Clavis test document - $(date +%s)-$$" >"$TMPF"
UP=$(curl -s -X POST -H "Authorization: Bearer $T_USR" -F "file=@$TMPF;type=text/plain" "$API/api/todos/$TID/attachments")
AID=$(echo "$UP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$AID" ] && ok "attachment uploaded" || bad "the upload failed: ${UP:0:200}"
DL=$(curl -s -H "Authorization: Bearer $T_USR" "$API/api/attachments/$AID")
[ "$DL" = "$(cat "$TMPF")" ] && ok "download is identical to the original" || bad "the downloaded content does not match"
rm -f "$TMPF"

echo
echo "=== 11. Administration panel ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_USR" "$API/api/admin/stats")" 403 "worker on /admin/stats"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_MGR" "$API/api/admin/users")" 200 "manager on /admin/users"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_MGR" "$API/api/admin/stats")" 403 "manager on /admin/stats"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_ADMIN" "$API/api/admin/stats")" 200 "admin on /admin/stats"

echo
echo "=== 12. Delete with permission (manager) ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $T_MGR" "$API/api/todos/$TID")" 200 "manager deletes the task"

echo
echo "=== 13. Email notification ==="
FIRST=$(curl -s -H "Authorization: Bearer $T_USR" "$API/api/todos?pageSize=1" |
  python3 -c 'import sys,json;i=json.load(sys.stdin).get("items",[]);print(i[0]["id"] if i else "")')
if [ -n "$FIRST" ] && [ -n "${MAIL_TEST_TO:-}" ]; then
  NOTIF=$(curl -s -X POST -H "Authorization: Bearer $T_USR" -H 'Content-Type: application/json' \
    -d "{\"to\":\"$MAIL_TEST_TO\"}" "$API/api/todos/$FIRST/notify")
  echo "$NOTIF" | grep -q '"delivered":true' && ok "email handed over to Resend" || bad "the email was not delivered: ${NOTIF:0:200}"
else
  echo "  (skipped: set MAIL_TEST_TO to exercise real delivery)"
fi

summary "API"
