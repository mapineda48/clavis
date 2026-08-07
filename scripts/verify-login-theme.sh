#!/usr/bin/env bash
# =============================================================================
# Verifies the custom login theme.
#
#   ./scripts/verify-login-theme.sh
#
# It does not just check that the page "looks right": it walks the whole OIDC
# flow (PKCE authorization → form → code → token exchange), which is what
# actually breaks when the Freemarker templates are replaced.
# =============================================================================
set -uo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_tools curl python3
require_env
require_up "$KC/realms/$REALM/.well-known/openid-configuration" "Keycloak"

JAR=$(mktemp "${TMPDIR:-/tmp}/clavis-cookies-XXXXXX")
HTML=$(mktemp "${TMPDIR:-/tmp}/clavis-login-XXXXXX.html")
trap 'rm -f "$JAR" "$HTML"' EXIT

pkce_pair
AUTH=$(auth_url "verify")

echo "=== 0. PKCE is mandatory ==="
NOPKCE=$(curl -s -o /dev/null -w '%{redirect_url}' \
  "$KC/realms/$REALM/protocol/openid-connect/auth?client_id=$CLIENT&redirect_uri=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$REDIRECT_URI")&response_type=code&scope=openid&state=x")
case "$NOPKCE" in
  *code_challenge*) ok "without a code_challenge Keycloak rejects the request" ;;
  *) bad "the client accepts authorization without PKCE" ;;
esac

echo
echo "=== 1. The login page responds ==="
CODE=$(curl -s -c "$JAR" -o "$HTML" -w '%{http_code}' "$AUTH")
chk "$CODE" 200 "GET /auth"

echo
echo "=== 2. It is the custom theme, not Keycloak's ==="
grep -q 'clavis-layout' "$HTML" && ok "custom layout (.clavis-layout) present" || bad ".clavis-layout is missing"
grep -q 'clavis-brand' "$HTML" && ok "brand panel (.clavis-brand) present" || bad ".clavis-brand is missing"
grep -q 'clavis-login.css' "$HTML" && ok "custom stylesheet linked" || bad "clavis-login.css is not linked"
grep -qi 'patternfly' "$HTML" && bad "still pulling in PatternFly CSS" || ok "no leftovers from the default theme"

echo
echo "=== 3. No Freemarker errors ==="
if grep -qi 'FreeMarker template error\|Internal Server Error\|We are sorry' "$HTML"; then
  bad "the template threw a rendering error"
  grep -io 'freemarker[^<]\{0,200\}' "$HTML" | head -3
else
  ok "the template renders without errors"
fi
if grep -o '??[a-zA-Z][a-zA-Z0-9_.-]*??' "$HTML" | sort -u | grep -q .; then
  bad "there are unresolved message keys:"
  grep -o '??[a-zA-Z][a-zA-Z0-9_.-]*??' "$HTML" | sort -u | head -5
else
  ok "every message key resolves"
fi

echo
echo "=== 4. Static resources ==="
for r in "clavis-login.css"; do
  U=$(grep -o "[^\"']*${r}[^\"']*" "$HTML" | head -1)
  if [ -n "$U" ]; then
    chk "$(curl -s -o /dev/null -w '%{http_code}' "$KC$U")" 200 "$r is served"
  else
    bad "$r is not linked in the HTML"
  fi
done
BASEJS=$(grep -o "[^\"']*/js/authChecker.js" "$HTML" | head -1)
if [ -n "$BASEJS" ]; then
  chk "$(curl -s -o /dev/null -w '%{http_code}' "$KC$BASEJS")" 200 "authChecker.js inherited from base is served"
else
  bad "authChecker.js is not linked (session detection in another tab is lost)"
fi

echo
echo "=== 5. The form really AUTHENTICATES (full OIDC flow) ==="
ACTION=$(form_action "$HTML" "kc-form-login")
if [ -z "$ACTION" ]; then
  bad "the #kc-form-login form was not found"
else
  ok "#kc-form-login form found"
  LOC=$(curl -s -b "$JAR" -c "$JAR" -o /dev/null -w '%{redirect_url}' \
    -d "username=$(envval ROOT_USERNAME)" \
    --data-urlencode "password=$(envval ROOT_PASSWORD)" \
    -X POST "$ACTION")
  case "$LOC" in
    *code=*)
      ok "login succeeded: Keycloak redirects with an authorization code"
      AUTHCODE=$(python3 -c "
import sys, urllib.parse as u
print(u.parse_qs(u.urlparse(sys.argv[1]).query).get('code', [''])[0])" "$LOC")
      TOK=$(curl -s -X POST "$KC/realms/$REALM/protocol/openid-connect/token" \
        -d "grant_type=authorization_code" -d "client_id=$CLIENT" \
        -d "code=$AUTHCODE" -d "redirect_uri=$REDIRECT_URI" -d "code_verifier=$PKCE_VERIFIER" |
        python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token','') or ('ERR:'+str(d.get('error_description') or d.get('error'))))")
      case "$TOK" in
        ERR:* | "") bad "exchanging the code for a token failed: ${TOK:0:140}" ;;
        *)
          ok "the code is exchanged for a valid access token (full PKCE)"
          python3 -c "
import sys, json, base64
p = sys.argv[1].split('.')[1]; p += '=' * (-len(p) % 4)
c = json.loads(base64.urlsafe_b64decode(p))
print('     user:', c.get('preferred_username'), '| aud:', c.get('aud'))
print('     permissions:', sorted(c.get('resource_access', {}).get('clavis-api', {}).get('roles', [])))" "$TOK"
          ;;
      esac
      ;;
    "") bad "the POST did not redirect (credentials rejected or broken form)" ;;
    *) bad "unexpected redirect: ${LOC:0:140}" ;;
  esac
fi

echo
echo "=== 6. Invalid credentials → error inside the theme ==="
# Keycloak suppresses the global alert when the failure is username/password
# (displayMessage=!messagesPerField.existsError) and shows it next to the field.
ERRHTML=$(mktemp "${TMPDIR:-/tmp}/clavis-err-XXXXXX.html")
JAR2=$(mktemp "${TMPDIR:-/tmp}/clavis-cookies2-XXXXXX")
H2=$(mktemp "${TMPDIR:-/tmp}/clavis-login2-XXXXXX.html")
curl -s -c "$JAR2" -o "$H2" "$AUTH"
ACTION2=$(form_action "$H2" "kc-form-login")
if [ -n "$ACTION2" ]; then
  curl -s -b "$JAR2" -c "$JAR2" -o "$ERRHTML" -d "username=$(envval ROOT_USERNAME)" -d "password=wrong-password" -X POST "$ACTION2"
  grep -q 'clavis-layout' "$ERRHTML" && ok "the error is shown inside the custom theme" || bad "the error page does not use the theme"
  grep -q 'clavis-field-error' "$ERRHTML" && ok "field-level error (.clavis-field-error)" || bad "the field error is missing"
  grep -q 'aria-invalid="true"' "$ERRHTML" && ok "the field is marked aria-invalid" || bad "aria-invalid is missing on the field"
  grep -qi 'username or password' "$ERRHTML" && ok "the message comes from the theme catalogue" || bad "the message is not the translated one"
else
  bad "could not fetch the form again for the error test"
fi
rm -f "$ERRHTML" "$JAR2" "$H2"

echo
echo "=== 7. Localisation: the page answers in English with ui_locales=en ==="
H3=$(mktemp "${TMPDIR:-/tmp}/clavis-en-XXXXXX.html")
curl -s -o "$H3" "${AUTH}&ui_locales=en"
grep -q 'clavis-layout' "$H3" && ok "the English version also uses the theme" || bad "the English version fails"
rm -f "$H3"

summary "LOGIN THEME"
