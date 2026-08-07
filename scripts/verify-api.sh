#!/usr/bin/env bash
# =============================================================================
# API regression: authentication and the database-backed permission model.
#
#   ./scripts/verify-api.sh
#
# Requires the stack to be up (docker compose up -d) and a .env at the root.
# It never prints tokens or secrets.
#
# The walk: root proves the bypass, creates a throwaway user, and that user's
# access is then shaped live — override grant, revoke, role assignment,
# disable — asserting a 403/200 matrix at every step. Each transition also
# proves the cache invalidation: a change must be visible on the very next
# request, not a token refresh later.
# =============================================================================
set -uo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_tools curl python3
require_env
require_up "$KC/realms/$REALM/.well-known/openid-configuration" "Keycloak"
require_up "$API/api/health" "The API"

BOT_USER="verify.bot"
BOT_EMAIL="verify.bot@clavis.local"
BOT_PASSWORD="VerifyBot123!"
BOT_ROLE="verify-auditors"

# jq-lite: read one field from JSON on stdin.
jget() { python3 -c "import sys, json
data = json.load(sys.stdin)
for part in sys.argv[1].split('.'):
    data = data[int(part)] if isinstance(data, list) else data.get(part)
    if data is None: break
print('' if data is None else data)" "$1" 2>/dev/null; }

# Calls the API and leaves the result in the API_BODY / API_STATUS globals.
# A command substitution would run this in a subshell and lose both, which is
# why callers never capture its output. $1 method, $2 path, $3 token, $4 body.
api() {
  local method="$1" path="$2" token="$3" body="${4:-}"
  local args=(-s -w $'\n%{http_code}' -X "$method" -H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  local raw
  raw=$(curl "${args[@]}" "$API$path")
  API_STATUS="${raw##*$'\n'}"
  API_BODY="${raw%$'\n'*}"
}

echo "=== 1. Service health ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/health")" 200 "GET /api/health"
echo "  ready: $(curl -s "$API/api/health/ready" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("status"), json.dumps(d.get("checks"), ensure_ascii=False))' 2>/dev/null)"
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/health/ready")" 200 "GET /api/health/ready"
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/docs")" 200 "GET /api/docs (Swagger)"

echo
echo "=== 2. Authentication is mandatory ==="
chk "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/me")" 401 "GET /api/me without a token"
chk "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer not.a.jwt' "$API/api/me")" 401 "garbage token"

echo
echo "=== 3. Root: identity linked, full catalog ==="
T_ROOT=$(token_for "$(envval ROOT_USERNAME)" ROOT_PASSWORD)
[ -n "$T_ROOT" ] && ok "got the root token" || { bad "root token is EMPTY"; summary "API"; exit 1; }
api GET /api/me "$T_ROOT"; ME="$API_BODY"
chk "$API_STATUS" 200 "GET /api/me as root"
chk "$(printf '%s' "$ME" | jget user.isRoot)" True "me.user.isRoot"
PERM_COUNT=$(printf '%s' "$ME" | python3 -c 'import sys, json; print(len(json.load(sys.stdin)["permissions"]))')
[ "$PERM_COUNT" -ge 6 ] && ok "root sees the full catalog ($PERM_COUNT permissions)" || bad "root only sees $PERM_COUNT permissions"

echo
echo "=== 4. Root creates a user (temporary password) ==="
# Idempotence across runs: remove the leftovers of a previous execution first.
api GET '/api/users?limit=500' "$T_ROOT"
OLD_ID=$(printf '%s' "$API_BODY" | python3 -c "import sys, json
items = json.load(sys.stdin)['items']
print(next((u['id'] for u in items if u['username'] == '$BOT_USER'), ''))")
[ -n "$OLD_ID" ] && api DELETE "/api/users/$OLD_ID" "$T_ROOT"
api DELETE "/api/access/roles/$BOT_ROLE" "$T_ROOT"

api POST /api/users "$T_ROOT" "{\"email\": \"$BOT_EMAIL\", \"displayName\": \"Verification Bot\", \"username\": \"$BOT_USER\", \"credentialMode\": \"temporary_password\", \"temporaryPassword\": \"$BOT_PASSWORD\"}"
CREATED="$API_BODY"
chk "$API_STATUS" 201 "POST /api/users"
BOT_ID=$(printf '%s' "$CREATED" | jget user.id)
[ -n "$BOT_ID" ] && ok "Keycloak assigned the id" || bad "no user id came back"
api POST /api/users "$T_ROOT" "{\"email\": \"$BOT_EMAIL\", \"displayName\": \"Duplicate\", \"credentialMode\": \"invite\"}"
chk "$API_STATUS" 409 "duplicate email is refused"

echo
echo "=== 5. First login: the temporary password demands a change ==="
T_BOT=$(token_with "$BOT_USER" "$BOT_PASSWORD")
[ -z "$T_BOT" ] && ok "password grant refused while UPDATE_PASSWORD is pending" || bad "the grant should be refused before the password change"
kc_finish_setup "$BOT_USER" "$BOT_PASSWORD" || bad "could not complete the first login administratively"
T_BOT=$(token_with "$BOT_USER" "$BOT_PASSWORD")
[ -n "$T_BOT" ] && ok "token granted after completing the setup" || { bad "still no token for the created user"; summary "API"; exit 1; }

echo
echo "=== 6. No roles, no permissions ==="
api GET /api/me "$T_BOT"; ME_BOT="$API_BODY"
chk "$API_STATUS" 200 "GET /api/me as the new user"
chk "$(printf '%s' "$ME_BOT" | python3 -c 'import sys, json; print(len(json.load(sys.stdin)["permissions"]))')" 0 "effective permissions are empty"
api GET /api/users "$T_BOT";          chk "$API_STATUS" 403 "GET /api/users"
api GET /api/access/catalog "$T_BOT"; chk "$API_STATUS" 403 "GET /api/access/catalog"
api GET /api/audit "$T_BOT";          chk "$API_STATUS" 403 "GET /api/audit"

echo
echo "=== 7. Exceptions: grant, then revoke ==="
api PUT "/api/access/users/$BOT_ID/overrides" "$T_ROOT" '{"overrides": [{"permissionKey": "users:read", "effect": "grant"}]}'
chk "$API_STATUS" 200 "override grant users:read"
api GET /api/users "$T_BOT"
chk "$API_STATUS" 200 "the grant applies on the NEXT request (cache invalidated)"
api PUT "/api/access/users/$BOT_ID/overrides" "$T_ROOT" '{"overrides": []}'
api GET /api/users "$T_BOT"
chk "$API_STATUS" 403 "removing the override closes the door again"

echo
echo "=== 8. Roles: create, assign, verify the boundary ==="
api POST /api/access/roles "$T_ROOT" "{\"slug\": \"$BOT_ROLE\", \"name\": \"Verification auditors\", \"permissions\": [\"audit:read\"]}"
chk "$API_STATUS" 201 "POST /api/access/roles"
api PATCH "/api/users/$BOT_ID" "$T_ROOT" "{\"roles\": [\"$BOT_ROLE\"]}"
chk "$API_STATUS" 200 "role assigned"
api GET /api/audit "$T_BOT"; chk "$API_STATUS" 200 "audit:read arrives through the role"
api GET /api/users "$T_BOT"; chk "$API_STATUS" 403 "the role grants nothing else"

echo
echo "=== 9. Disable and re-enable ==="
api PATCH "/api/users/$BOT_ID" "$T_ROOT" '{"status": "disabled"}'
chk "$API_STATUS" 200 "user disabled"
api GET /api/audit "$T_BOT"
chk "$API_STATUS" 403 "a disabled user is refused everywhere"
api PATCH "/api/users/$BOT_ID" "$T_ROOT" '{"status": "active"}'
api GET /api/audit "$T_BOT"
chk "$API_STATUS" 200 "re-enabling restores the access"

echo
echo "=== 10. What must stay immutable ==="
ROOT_ID=$(printf '%s' "$ME" | jget user.id)
api PATCH "/api/users/$ROOT_ID" "$T_ROOT" '{"displayName": "Nope"}'
chk "$API_STATUS" 403 "root cannot be edited through the API"
api DELETE /api/access/roles/admin "$T_ROOT"
chk "$API_STATUS" 403 "system roles cannot be deleted"

echo
echo "=== 11. Cleanup ==="
api DELETE "/api/users/$BOT_ID" "$T_ROOT"
chk "$API_STATUS" 204 "throwaway user deleted"
api DELETE "/api/access/roles/$BOT_ROLE" "$T_ROOT"
chk "$API_STATUS" 204 "throwaway role deleted"

summary "API"
