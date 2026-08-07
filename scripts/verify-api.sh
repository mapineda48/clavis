#!/usr/bin/env bash
# =============================================================================
# API regression: authentication and the permission model.
#
#   ./scripts/verify-api.sh
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

echo "=== 1. Tokens for the three users ==="
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
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/me")" 401 "GET /api/me without a token"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer not.a.jwt' "$API/api/me")" 401 "garbage token"

echo
echo "=== 6. Administration panel ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_MGR" "$API/api/admin/users")" 200 "manager on /admin/users"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_USR" "$API/api/admin/audit")" 403 "worker on /admin/audit"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_ADMIN" "$API/api/admin/users")" 200 "admin on /admin/users"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_ADMIN" "$API/api/admin/audit")" 200 "admin on /admin/audit"

summary "API"
