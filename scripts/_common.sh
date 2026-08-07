#!/usr/bin/env bash
# =============================================================================
# Helpers shared by the verification scripts.
#
# Not meant to be run directly: each script `source`s this file.
# It resolves the repository root from its own location, so the scripts work
# from any working directory.
# =============================================================================

CLAVIS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CLAVIS_ROOT" || exit 1

# Can be overridden from the environment to point at another deployment.
KC="${KC_URL:-http://localhost:8080}"
API="${API_URL:-http://localhost:3000}"
REALM="${KEYCLOAK_REALM:-clavis}"
CLIENT="${KEYCLOAK_APP_CLIENT_ID:-clavis-app}"
REDIRECT_URI="${APP_DEV_URL:-http://localhost:5173}/"

pass=0
fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; fail=$((fail + 1)); }
chk() { [ "$1" = "$2" ] && ok "$3 (=$1)" || bad "$3 (expected $2, got $1)"; }

# Reads a variable from the .env WITHOUT using `source`: MAIL_FROM contains
# `<...>` and would blow up the shell. Strips the wrapping quotes if present.
envval() {
  sed -n "s/^$1=//p" "$CLAVIS_ROOT/.env" 2>/dev/null | head -1 | sed 's/^"//; s/"$//'
}

require_tools() {
  local missing=()
  local t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || missing+=("$t")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "Missing required tools: ${missing[*]}" >&2
    exit 2
  fi
}

require_env() {
  [ -f "$CLAVIS_ROOT/.env" ] || {
    echo "There is no .env at the repository root." >&2
    echo "Create it with: cp .env.example .env" >&2
    exit 2
  }
}

# Checks that a service answers with anything below 500.
require_up() {
  local url="$1" name="$2" code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo 000)
  if [ "$code" = "000" ] || [ "$code" -ge 500 ] 2>/dev/null; then
    echo "$name is not answering at $url (HTTP $code)." >&2
    echo "Start the stack with: docker compose up -d" >&2
    exit 2
  fi
}

# Generates a PKCE S256 pair and leaves PKCE_VERIFIER / PKCE_CHALLENGE in the
# environment. The clavis-app client REQUIRES PKCE: without a code_challenge,
# Keycloak rejects the request.
pkce_pair() {
  read -r PKCE_VERIFIER PKCE_CHALLENGE <<<"$(python3 -c "
import base64, hashlib, secrets
v = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip('=')
c = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).decode().rstrip('=')
print(v, c)
")"
}

# Authorization URL with PKCE. $1 = state (optional).
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

# Extracts the `action` of a form. $1 = HTML file, $2 = form id (optional).
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

# Gets an access token through grant_type=password. $1 = username, $2 = name of
# the .env variable holding the password. Test-only: the client allows this
# grant on purpose.
token_for() {
  token_with "$1" "$(envval "$2")"
}

# Same as token_for but with a literal password. $1 = username, $2 = password.
token_with() {
  curl -s -X POST "$KC/realms/$REALM/protocol/openid-connect/token" \
    -d "client_id=$CLIENT" -d "grant_type=password" \
    -d "username=$1" --data-urlencode "password=$2" |
    python3 -c "import sys, json; print(json.load(sys.stdin).get('access_token', ''))"
}

# Token of the Keycloak bootstrap administrator (admin-cli on the master realm).
# Only the verification scripts use it, to complete flows a browser would.
kc_admin_token() {
  curl -s -X POST "$KC/realms/master/protocol/openid-connect/token" \
    -d "client_id=admin-cli" -d "grant_type=password" \
    -d "username=$(envval KC_BOOTSTRAP_ADMIN_USERNAME)" \
    --data-urlencode "password=$(envval KC_BOOTSTRAP_ADMIN_PASSWORD)" |
    python3 -c "import sys, json; print(json.load(sys.stdin).get('access_token', ''))"
}

# Completes a user's first login administratively: clears the pending required
# actions and sets a PERMANENT password. Users created with a temporary
# password (or by invitation) cannot use the password grant until then —
# Keycloak answers "Account is not fully set up". $1 = username, $2 = password.
kc_finish_setup() {
  local at uid
  at=$(kc_admin_token)
  [ -n "$at" ] || return 1
  uid=$(curl -s -H "Authorization: Bearer $at" \
    "$KC/admin/realms/$REALM/users?username=$1&exact=true" |
    python3 -c "import sys, json; users = json.load(sys.stdin); print(users[0]['id'] if users else '')")
  [ -n "$uid" ] || return 1
  curl -s -o /dev/null -X PUT -H "Authorization: Bearer $at" -H 'Content-Type: application/json' \
    -d '{"requiredActions": []}' "$KC/admin/realms/$REALM/users/$uid"
  curl -s -o /dev/null -X PUT -H "Authorization: Bearer $at" -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json, sys; print(json.dumps({'type': 'password', 'value': sys.argv[1], 'temporary': False}))" "$2")" \
    "$KC/admin/realms/$REALM/users/$uid/reset-password"
}

# Prints the summary and decides the exit code of the script.
summary() {
  echo
  echo "==================== $1: $pass OK / $fail FAILED ===================="
  [ "$fail" -eq 0 ]
}
