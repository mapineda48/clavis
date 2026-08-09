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
#
# The last three sections check the boundaries that are not about having a
# permission at all: that a revoke override beats the role granting the same
# permission, and the guards that sit BEHIND a permission the caller does hold
# — role assignment needs `access:manage` on create as well as on update,
# nobody edits their own roles, status, overrides or account, and no caller
# hands out a permission they do not hold themselves. Two of the cases in that
# last section are escalations that were live: they must fail against the code
# that shipped before the privilege-delta guard, or they are testing nothing.
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
# A second role, created by the throwaway user rather than by root: the
# privilege-delta section needs a role somebody other than root authored.
BOT_ROLE2="verify-delegated"
# A second user, never logged in: something for the first one to try to edit
# that is neither root (immutable) nor itself (self-modification), so a refusal
# can only be about the permission being tested.
BOT2_USER="verify.bot2"
BOT2_EMAIL="verify.bot2@clavis.local"
# A third one that must NEVER exist: the account the escalation test tries to
# create already carrying a role. It is named so the sweep below can prove it.
BOT3_USER="verify.bot3"
BOT3_EMAIL="verify.bot3@clavis.local"
# A fourth user: a victim for the effective-set escalation. Root gives it the
# full-catalog `admin` role masked by revoke overrides; a non-root actor then
# tries to unmask it. Never logs in.
BOT4_USER="verify.victim"
BOT4_EMAIL="verify.victim@clavis.local"

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
OLD_IDS=$(printf '%s' "$API_BODY" | python3 -c "import sys, json
items = json.load(sys.stdin)['items']
print(' '.join(u['id'] for u in items if u['username'] in ('$BOT_USER', '$BOT2_USER', '$BOT3_USER', '$BOT4_USER')))")
for old_id in $OLD_IDS; do api DELETE "/api/users/$old_id" "$T_ROOT"; done
api DELETE "/api/access/roles/$BOT_ROLE" "$T_ROOT"
api DELETE "/api/access/roles/$BOT_ROLE2" "$T_ROOT"

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
echo "=== 11. A revoke override beats the role that grants the same key ==="
# Effective = union(role permissions) + grants - revokes, so the subtraction
# has to come last. The suite already covers a grant and its removal; this is
# the combination where an exception has to win against a role.
api GET /api/audit "$T_BOT"
chk "$API_STATUS" 200 "audit:read still arrives through the role"
api PUT "/api/access/users/$BOT_ID/overrides" "$T_ROOT" '{"overrides": [{"permissionKey": "audit:read", "effect": "revoke"}]}'
chk "$API_STATUS" 200 "override revoke audit:read"
# Asserted positively, and on purpose. Read as a `case` over a substituted
# string, a Python fragment that raised produced an empty string, which matched
# the fall-through branch and reported success: the check could only ever fail
# when the permission WAS listed. Printing a definite word means a broken
# fragment prints nothing and the comparison fails, like any other assertion.
REVOKED=$(printf '%s' "$API_BODY" | python3 -c "import sys, json
perms = json.load(sys.stdin)['effectivePermissions']
print('absent' if 'audit:read' not in perms else 'present')")
chk "$REVOKED" absent "the resolved answer no longer lists audit:read"
api GET /api/audit "$T_BOT"
chk "$API_STATUS" 403 "the revoke wins over the role that grants it"
api PUT "/api/access/users/$BOT_ID/overrides" "$T_ROOT" '{"overrides": []}'
api GET /api/audit "$T_BOT"
chk "$API_STATUS" 200 "dropping the revoke gives the role permission back"

echo
echo "=== 12. The guards behind the permissions: role assignment and self-editing ==="
# The `admin` role is seeded with the whole catalog, so a users:* route that
# assigned roles would be a route around access:*. The target is a second user
# so a 403 cannot come from the root or self-modification checks instead.
api POST /api/users "$T_ROOT" "{\"email\": \"$BOT2_EMAIL\", \"displayName\": \"Verification Target\", \"username\": \"$BOT2_USER\", \"credentialMode\": \"temporary_password\", \"temporaryPassword\": \"$BOT_PASSWORD\"}"
chk "$API_STATUS" 201 "root creates the second throwaway user"
BOT2_ID=$(printf '%s' "$API_BODY" | jget user.id)
[ -n "$BOT2_ID" ] && ok "second user id received" || bad "no id came back for the second user"

api PUT "/api/access/users/$BOT_ID/overrides" "$T_ROOT" '{"overrides": [{"permissionKey": "users:update", "effect": "grant"}]}'
chk "$API_STATUS" 200 "the first user is granted users:update and nothing else"

api PATCH "/api/users/$BOT2_ID" "$T_BOT" "{\"roles\": [\"$BOT_ROLE\"]}"
chk "$API_STATUS" 403 "assigning a role without access:manage"
chk "$(printf '%s' "$API_BODY" | jget error.code)" ROLE_ASSIGNMENT_DENIED "refused as a role assignment"

api PATCH "/api/users/$BOT_ID" "$T_BOT" '{"status": "disabled"}'
chk "$API_STATUS" 403 "changing your own status"
chk "$(printf '%s' "$API_BODY" | jget error.code)" SELF_MODIFICATION "refused as a self-modification"

api PATCH "/api/users/$BOT_ID" "$T_BOT" '{"displayName": "Verification Bot"}'
chk "$API_STATUS" 200 "editing your own display name is still allowed"

api DELETE "/api/users/$BOT2_ID" "$T_BOT"
chk "$API_STATUS" 403 "users:update does not carry users:delete"

# POST is the same escalation as PATCH, one step further away: create an
# account that already carries the role, with a temporary password you chose,
# and sign in as it. The refusal happens before Keycloak is touched, so the
# sweep below proves nothing was left behind either.
api PUT "/api/access/users/$BOT_ID/overrides" "$T_ROOT" '{"overrides": [{"permissionKey": "users:update", "effect": "grant"}, {"permissionKey": "users:create", "effect": "grant"}]}'
chk "$API_STATUS" 200 "the first user is also granted users:create"
api POST /api/users "$T_BOT" "{\"email\": \"$BOT3_EMAIL\", \"displayName\": \"Escalation Attempt\", \"username\": \"$BOT3_USER\", \"credentialMode\": \"temporary_password\", \"temporaryPassword\": \"$BOT_PASSWORD\", \"roles\": [\"$BOT_ROLE\"]}"
chk "$API_STATUS" 403 "creating a user WITH roles, without access:manage"
chk "$(printf '%s' "$API_BODY" | jget error.code)" ROLE_ASSIGNMENT_DENIED "refused as a role assignment"
api GET '/api/users?limit=500' "$T_ROOT"
LEFTOVER=$(printf '%s' "$API_BODY" | python3 -c "import sys, json
items = json.load(sys.stdin)['items']
print('absent' if all(u['username'] != '$BOT3_USER' for u in items) else 'present')")
chk "$LEFTOVER" absent "the refused creation left no user behind"

api PATCH "/api/users/$BOT_ID" "$T_BOT" "{\"roles\": [\"$BOT_ROLE\"]}"
chk "$API_STATUS" 403 "changing your own roles"
chk "$(printf '%s' "$API_BODY" | jget error.code)" SELF_MODIFICATION "refused as a self-modification"

# users:delete is what gets past the permission middleware here: without it the
# 403 would come from the missing permission and prove nothing about the self check.
api PUT "/api/access/users/$BOT_ID/overrides" "$T_ROOT" '{"overrides": [{"permissionKey": "users:delete", "effect": "grant"}]}'
chk "$API_STATUS" 200 "the first user is granted users:delete"
api DELETE "/api/users/$BOT_ID" "$T_BOT"
chk "$API_STATUS" 403 "deleting your own account"
chk "$(printf '%s' "$API_BODY" | jget error.code)" SELF_MODIFICATION "refused as a self-modification"

# The overrides route reaches further than PATCH does — it writes permission
# keys one by one — so it carries the same self check. Granting access:manage
# is what makes the refusal come from that check and not from the permission.
#
# The key being self-granted is `audit:read` on purpose: the user already holds
# it through $BOT_ROLE, so the privilege-delta check that runs ahead of the self
# check (section 13) has nothing to object to and the refusal can only be about
# the target being the caller. Grant an unheld key here and the answer becomes
# PRIVILEGE_ESCALATION, which would be a correct refusal for the wrong reason.
api PUT "/api/access/users/$BOT_ID/overrides" "$T_ROOT" '{"overrides": [{"permissionKey": "access:manage", "effect": "grant"}]}'
chk "$API_STATUS" 200 "the first user is granted access:manage"
api PUT "/api/access/users/$BOT_ID/overrides" "$T_BOT" '{"overrides": [{"permissionKey": "audit:read", "effect": "grant"}]}'
chk "$API_STATUS" 403 "rewriting your own overrides"
chk "$(printf '%s' "$API_BODY" | jget error.code)" SELF_MODIFICATION "refused as a self-modification"

echo
echo "=== 13. Nobody hands out a permission they do not hold ==="
# The guard that replaced the identity check as the PRIMARY one. `assertNotSelf`
# answers "are you editing yourself?" — answerable about one of the three tables
# feeding the effective union, silent about the other two, and defeated by two
# accounts editing each other. This rule is stated over the permission set
# instead: an actor may only introduce a capability they already hold, whoever
# the target is and whichever table the write lands in.
#
# The first two cases below were LIVE escalations, reproduced against a running
# stack. They answer 200 on the code that shipped before this guard. A green run
# of this section means nothing unless it is red against that code.
api PUT "/api/access/users/$BOT_ID/overrides" "$T_ROOT" '{"overrides": [{"permissionKey": "access:manage", "effect": "grant"}, {"permissionKey": "users:update", "effect": "grant"}, {"permissionKey": "users:create", "effect": "grant"}]}'
chk "$API_STATUS" 200 "the first user is granted access:manage, users:update and users:create"
api GET /api/me "$T_BOT"
HELD=$(printf '%s' "$API_BODY" | python3 -c "import sys, json
print(','.join(sorted(json.load(sys.stdin)['permissions'])))")
chk "$HELD" "access:manage,audit:read,users:create,users:update" "and holds exactly those plus audit:read from the role"

# --- Live escalation 1: a self-override addressed with a case-varied uuid.
# PostgreSQL resolves 'A1B2…'::uuid and 'a1b2…'::uuid to the same row, so this
# id reaches the caller's own account while a string comparison sees somebody
# else — which is how one request used to write the whole catalog onto it. The
# delta rule does not ask whose row it is, so the trick buys nothing.
UPPER_ID=$(printf '%s' "$BOT_ID" | tr 'a-f' 'A-F')
api PUT "/api/access/users/$UPPER_ID/overrides" "$T_BOT" '{"overrides": [{"permissionKey": "audit:read", "effect": "grant"}, {"permissionKey": "users:read", "effect": "grant"}, {"permissionKey": "users:delete", "effect": "grant"}]}'
chk "$API_STATUS" 403 "granting yourself the catalog through a case-varied uuid"
chk "$(printf '%s' "$API_BODY" | jget error.code)" PRIVILEGE_ESCALATION "refused as a privilege escalation"
api GET /api/me "$T_BOT"
ESCALATED=$(printf '%s' "$API_BODY" | python3 -c "import sys, json
perms = json.load(sys.stdin)['permissions']
print('unchanged' if 'users:delete' not in perms else 'ESCALATED')")
chk "$ESCALATED" unchanged "and wrote nothing"

# --- Live escalation 2: raise a non-system role you hold. There is no self-id
# anywhere in this request, which is exactly why an identity-keyed check never
# saw it: role_permissions is the first branch of the union, so raising the role
# raises every holder — the caller included.
api PUT "/api/access/roles/$BOT_ROLE/permissions" "$T_BOT" '{"permissions": ["audit:read", "users:read", "users:delete"]}'
chk "$API_STATUS" 403 "raising a role you hold beyond your own permissions"
chk "$(printf '%s' "$API_BODY" | jget error.code)" PRIVILEGE_ESCALATION "refused as a privilege escalation"
api GET /api/me "$T_BOT"
ESCALATED=$(printf '%s' "$API_BODY" | python3 -c "import sys, json
perms = json.load(sys.stdin)['permissions']
print('unchanged' if 'users:delete' not in perms else 'ESCALATED')")
chk "$ESCALATED" unchanged "and wrote nothing"

# --- It is a DELTA, not a ban. These sets are replaced whole, so a rule stated
# over the result would stop an administrator trimming a role, or even resaving
# an unchanged one, whenever the role carried anything they lack.
api PUT "/api/access/roles/$BOT_ROLE/permissions" "$T_BOT" '{"permissions": ["audit:read", "access:manage"]}'
chk "$API_STATUS" 200 "adding to that same role a key you DO hold"
api PUT "/api/access/roles/$BOT_ROLE/permissions" "$T_BOT" '{"permissions": ["audit:read"]}'
chk "$API_STATUS" 200 "and reducing it again"

# --- The same rule on the other writers of the union. Delegating what you hold
# still works, which is the honest bound: two accounts can pool what they have
# between them, and no more.
api PUT "/api/access/users/$BOT2_ID/overrides" "$T_BOT" '{"overrides": [{"permissionKey": "audit:read", "effect": "grant"}]}'
chk "$API_STATUS" 200 "granting another user a permission you hold"
api PUT "/api/access/users/$BOT2_ID/overrides" "$T_BOT" '{"overrides": [{"permissionKey": "users:delete", "effect": "grant"}]}'
chk "$API_STATUS" 403 "granting another user one you do not"
chk "$(printf '%s' "$API_BODY" | jget error.code)" PRIVILEGE_ESCALATION "refused as a privilege escalation"

# Assigning a role grants everything it carries, and `admin` carries the whole
# catalog. This is the `users:create` + `access:manage` path the docs used to
# concede: promote an account into `admin`, or create one already holding it
# with a password you chose, and sign in as it.
api PATCH "/api/users/$BOT2_ID" "$T_BOT" '{"roles": ["admin"]}'
chk "$API_STATUS" 403 "assigning a role that carries more than you hold"
chk "$(printf '%s' "$API_BODY" | jget error.code)" PRIVILEGE_ESCALATION "refused as a privilege escalation"
api POST /api/users "$T_BOT" "{\"email\": \"$BOT3_EMAIL\", \"displayName\": \"Escalation Attempt\", \"username\": \"$BOT3_USER\", \"credentialMode\": \"temporary_password\", \"temporaryPassword\": \"$BOT_PASSWORD\", \"roles\": [\"admin\"]}"
chk "$API_STATUS" 403 "creating an account that already carries it"
chk "$(printf '%s' "$API_BODY" | jget error.code)" PRIVILEGE_ESCALATION "refused as a privilege escalation"
api GET '/api/users?limit=500' "$T_ROOT"
LEFTOVER=$(printf '%s' "$API_BODY" | python3 -c "import sys, json
items = json.load(sys.stdin)['items']
print('absent' if all(u['username'] != '$BOT3_USER' for u in items) else 'present')")
chk "$LEFTOVER" absent "the refusal came before Keycloak, so no user was left behind"

# A role is created empty, so its whole initial set is what it adds. Without
# this the rule would be one hop away from useless: mint the role, then assign it.
api POST /api/access/roles "$T_BOT" "{\"slug\": \"$BOT_ROLE2\", \"name\": \"Escalation Attempt\", \"permissions\": [\"users:delete\"]}"
chk "$API_STATUS" 403 "creating a role carrying a permission you do not hold"
chk "$(printf '%s' "$API_BODY" | jget error.code)" PRIVILEGE_ESCALATION "refused as a privilege escalation"
api POST /api/access/roles "$T_BOT" "{\"slug\": \"$BOT_ROLE2\", \"name\": \"Delegated auditors\", \"permissions\": [\"audit:read\"]}"
chk "$API_STATUS" 201 "creating one that stays within them"

# --- The overrides writer checks the DELTA, not the whole set. PUT is a full
# replace and the UI re-sends every existing exception, so a grant already on
# the target is preserved, not introduced: the actor is not handing it out and
# need not hold it. This is the same delta the role routes check. Set the second
# user up, through root who may grant anything, with a grant for a key the first
# user holds nothing of.
api PUT "/api/access/users/$BOT2_ID/overrides" "$T_ROOT" '{"overrides": [{"permissionKey": "users:delete", "effect": "grant"}]}'
chk "$API_STATUS" 200 "root grants the second user users:delete, which the first user lacks"
# The first user (no users:delete) re-sends that pre-existing grant AND adds one
# it does hold. The pre-existing grant is preserved, nothing is stripped, and
# the request is NOT refused. On the code before this fix the whole set was
# checked and this answered 403 — the regression the delta closes.
api PUT "/api/access/users/$BOT2_ID/overrides" "$T_BOT" '{"overrides": [{"permissionKey": "users:delete", "effect": "grant"}, {"permissionKey": "audit:read", "effect": "grant"}]}'
chk "$API_STATUS" 200 "editing a target that already holds a grant the actor lacks"
api GET "/api/access/users/$BOT2_ID" "$T_ROOT"
KEPT=$(printf '%s' "$API_BODY" | python3 -c "import sys, json
grants = {o['permissionKey'] for o in json.load(sys.stdin)['overrides'] if o['effect'] == 'grant'}
print('kept' if {'users:delete', 'audit:read'} <= grants else 'LOST')")
chk "$KEPT" kept "the pre-existing grant was preserved and the held one added"
# But introducing a NEW grant for a key the actor lacks is still refused:
# users:read is neither already on the target nor held by the first user, so it
# is the capability being handed out, and the delta rule catches it.
api PUT "/api/access/users/$BOT2_ID/overrides" "$T_BOT" '{"overrides": [{"permissionKey": "users:delete", "effect": "grant"}, {"permissionKey": "audit:read", "effect": "grant"}, {"permissionKey": "users:read", "effect": "grant"}]}'
chk "$API_STATUS" 403 "adding a NEW grant for a key the actor lacks is still refused"
chk "$(printf '%s' "$API_BODY" | jget error.code)" PRIVILEGE_ESCALATION "refused as a privilege escalation"
api GET "/api/access/users/$BOT2_ID" "$T_ROOT"
UNTOUCHED=$(printf '%s' "$API_BODY" | python3 -c "import sys, json
grants = {o['permissionKey'] for o in json.load(sys.stdin)['overrides'] if o['effect'] == 'grant'}
print('untouched' if 'users:read' not in grants and 'users:delete' in grants else 'CHANGED')")
chk "$UNTOUCHED" untouched "the refused write left the target's overrides untouched"

# --- The delta is over the EFFECTIVE set, not the submitted rows. The sharpest
# escalation a body-shaped rule misses: a victim holding a full-catalog role
# masked by revoke overrides jumps to the whole catalog when an actor merely
# EMPTIES the overrides — a dropped revoke is an omission, never a grant row. It
# must be reproduced by a NON-ROOT access:manage holder, since root
# short-circuits the guard. Root builds the victim: assign `admin` (the whole
# catalog), then mask every key with a revoke so the effective set is empty.
api POST /api/users "$T_ROOT" "{\"email\": \"$BOT4_EMAIL\", \"displayName\": \"Masked Admin\", \"username\": \"$BOT4_USER\", \"credentialMode\": \"temporary_password\", \"temporaryPassword\": \"$BOT_PASSWORD\"}"
chk "$API_STATUS" 201 "root creates the victim user"
BOT4_ID=$(printf '%s' "$API_BODY" | jget user.id)
[ -n "$BOT4_ID" ] && ok "victim id received" || bad "no id came back for the victim"
api PATCH "/api/users/$BOT4_ID" "$T_ROOT" '{"roles": ["admin"]}'
chk "$API_STATUS" 200 "root gives the victim the full-catalog admin role"
api PUT "/api/access/users/$BOT4_ID/overrides" "$T_ROOT" '{"overrides": [{"permissionKey": "access:manage", "effect": "revoke"}, {"permissionKey": "access:read", "effect": "revoke"}, {"permissionKey": "audit:read", "effect": "revoke"}, {"permissionKey": "users:create", "effect": "revoke"}, {"permissionKey": "users:delete", "effect": "revoke"}, {"permissionKey": "users:read", "effect": "revoke"}, {"permissionKey": "users:update", "effect": "revoke"}]}'
chk "$API_STATUS" 200 "root masks every permission with a revoke"
api GET "/api/access/users/$BOT4_ID" "$T_ROOT"
MASKED=$(printf '%s' "$API_BODY" | python3 -c "import sys, json
print('empty' if len(json.load(sys.stdin)['effectivePermissions']) == 0 else 'NONEMPTY')")
chk "$MASKED" empty "the victim's effective set is empty while the revokes stand"

# Exploit: emptying the overrides deletes the revokes and unmasks the catalog.
# The delta over the effective set sees the whole catalog being added; the
# actor holds only four keys of it, so it is refused.
api PUT "/api/access/users/$BOT4_ID/overrides" "$T_BOT" '{"overrides": []}'
chk "$API_STATUS" 403 "emptying the overrides to unmask a full-catalog role"
chk "$(printf '%s' "$API_BODY" | jget error.code)" PRIVILEGE_ESCALATION "refused as a privilege escalation"
# refuse-cleanly vs refuse-but-already-wrote are DIFFERENT bugs; only this
# second assertion tells them apart. The victim must still be masked.
api GET "/api/access/users/$BOT4_ID" "$T_ROOT"
STILL=$(printf '%s' "$API_BODY" | python3 -c "import sys, json
print('empty' if len(json.load(sys.stdin)['effectivePermissions']) == 0 else 'ESCALATED')")
chk "$STILL" empty "the refused write rolled back: the victim is still masked"

# revoke->grant flip on a key the actor lacks: keep the mask on every other key
# but flip users:read to a grant. The flip unmasks users:read, which the actor
# does not hold, so the net effect is still an addition and still refused.
api PUT "/api/access/users/$BOT4_ID/overrides" "$T_BOT" '{"overrides": [{"permissionKey": "access:manage", "effect": "revoke"}, {"permissionKey": "access:read", "effect": "revoke"}, {"permissionKey": "audit:read", "effect": "revoke"}, {"permissionKey": "users:create", "effect": "revoke"}, {"permissionKey": "users:delete", "effect": "revoke"}, {"permissionKey": "users:read", "effect": "grant"}, {"permissionKey": "users:update", "effect": "revoke"}]}'
chk "$API_STATUS" 403 "flipping a masking revoke to a grant on a key the actor lacks"
chk "$(printf '%s' "$API_BODY" | jget error.code)" PRIVILEGE_ESCALATION "refused as a privilege escalation"

echo
echo "=== 14. Cleanup ==="
api DELETE "/api/users/$BOT_ID" "$T_ROOT"
chk "$API_STATUS" 204 "throwaway user deleted"
api DELETE "/api/users/$BOT2_ID" "$T_ROOT"
chk "$API_STATUS" 204 "second throwaway user deleted"
api DELETE "/api/users/$BOT4_ID" "$T_ROOT"
chk "$API_STATUS" 204 "the masked-admin victim deleted"
api DELETE "/api/access/roles/$BOT_ROLE" "$T_ROOT"
chk "$API_STATUS" 204 "throwaway role deleted"
api DELETE "/api/access/roles/$BOT_ROLE2" "$T_ROOT"
chk "$API_STATUS" 204 "the role the throwaway user created deleted too"

summary "API"
