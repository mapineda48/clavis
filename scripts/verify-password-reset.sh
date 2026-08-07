#!/usr/bin/env bash
# =============================================================================
# Verifies the whole "I forgot my password" flow.
#
#   ./scripts/verify-password-reset.sh
#
# The real journey: request from the login screen → email sent by Keycloak over
# SMTP → that email is READ back through the Resend API → its link is followed →
# the password is set → and we check it actually signs in.
#
# Extra requirements compared to the other scripts:
#   - The `resend` CLI, authenticated (https://resend.com/docs) — to read the email.
#   - The realm with SMTP configured and `resetPasswordAllowed: true`.
#   - ROOT_EMAIL pointing at a REAL address.
#
# The password is set back to the SAME value that is in .env, so the demo is
# never left inconsistent.
# =============================================================================
set -uo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_tools curl python3 resend
require_env
require_up "$KC/realms/$REALM/.well-known/openid-configuration" "Keycloak"

if ! resend whoami --json >/dev/null 2>&1; then
  echo "The Resend CLI is not authenticated. Run: resend login" >&2
  exit 2
fi

JAR=$(mktemp "${TMPDIR:-/tmp}/clavis-cookies-XXXXXX")
HTML=$(mktemp "${TMPDIR:-/tmp}/clavis-login-XXXXXX.html")
RESETP=$(mktemp "${TMPDIR:-/tmp}/clavis-reset-XXXXXX.html")
OUT=$(mktemp "${TMPDIR:-/tmp}/clavis-out-XXXXXX")
trap 'rm -f "$JAR" "$HTML" "$RESETP" "$OUT"' EXIT

pkce_pair
AUTH=$(auth_url "reset")

last_email_id() {
  resend emails list --limit 1 --json 2>/dev/null |
    python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('data',[]);print(r[0]['id'] if r else '')"
}

echo "=== 1. Recovery link on the login screen ==="
curl -s -c "$JAR" -o "$HTML" "$AUTH"
RESET=$(python3 -c "
import re, sys, html
h = open(sys.argv[1], encoding='utf-8', errors='replace').read()
m = re.search(r'href=\"([^\"]*reset-credentials[^\"]*)\"', h)
print(html.unescape(m.group(1)) if m else '')" "$HTML")
[ -n "$RESET" ] && ok "the login offers 'Forgot your password?'" || {
  bad "the link is missing (is resetPasswordAllowed set to false?)"
  summary "PASSWORD RESET"; exit 1
}

echo
echo "=== 2. Recovery screen uses the custom theme ==="
curl -s -b "$JAR" -c "$JAR" -o "$RESETP" "$KC$RESET"
grep -q 'clavis-layout' "$RESETP" && ok "uses the clavis theme" || bad "does not use the clavis theme"
grep -q 'id="kc-reset-password-form"' "$RESETP" && ok "recovery form intact" || bad "#kc-reset-password-form is missing"
grep -q 'clavis-card__subtitle' "$RESETP" && ok "theme's own subtitle" || bad "no custom subtitle"
grep -qi 'freemarker template error' "$RESETP" && bad "Freemarker error on the page" || ok "no Freemarker errors"
if grep -o '??[a-zA-Z][a-zA-Z0-9_.-]*??' "$RESETP" | sort -u | grep -q .; then
  bad "unresolved keys:"; grep -o '??[a-zA-Z][a-zA-Z0-9_.-]*??' "$RESETP" | sort -u | head -3
else
  ok "every message key resolves"
fi

echo
echo "=== 3. Reset request for 'admin' ==="
BEFORE=$(last_email_id)
curl -s -b "$JAR" -c "$JAR" -o "$OUT" -d "username=$(envval ROOT_USERNAME)" -X POST "$(form_action "$RESETP" "kc-reset-password-form")"
grep -q 'clavis-alert' "$OUT" && ok "Keycloak confirms the send inside the theme" || bad "no visible confirmation"
grep -q 'clavis-alert--error' "$OUT" && bad "Keycloak reports a delivery error" || ok "no delivery error"

echo
echo "=== 4. The email reaches Resend ==="
MSG=""
for _ in $(seq 1 12); do
  sleep 3
  CAND=$(last_email_id)
  [ -n "$CAND" ] && [ "$CAND" != "$BEFORE" ] && { MSG="$CAND"; break; }
done
if [ -z "$MSG" ]; then
  bad "no new email shows up in Resend"
  summary "PASSWORD RESET"; exit 1
fi
ok "new email recorded in Resend"
resend emails get "$MSG" --json 2>/dev/null >"$OUT"
python3 -c "
import sys, json
d = json.load(open(sys.argv[1]))
print('     subject:', d.get('subject'))
print('     from   :', d.get('from'))
print('     to     :', d.get('to'))
print('     status :', d.get('last_event'))" "$OUT"

echo
echo "=== 5. The email uses the custom layout ==="
HTMLBODY=$(python3 -c "import sys,json;print(json.load(open(sys.argv[1])).get('html') or '')" "$OUT")
[ -n "$HTMLBODY" ] || bad "Resend returns no HTML body"
echo "$HTMLBODY" | grep -q 'role="presentation"' && ok "table-based layout (works in email clients)" || bad "no layout tables"
echo "$HTMLBODY" | grep -qi '<style' && bad "it carries a <style> block (clients strip it)" || ok "CSS is fully inline"
echo "$HTMLBODY" | grep -qiE '<img[^>]+src="https?://|fonts\.(googleapis|gstatic)' && bad "it loads remote resources" || ok "no remote images or fonts"
echo "$HTMLBODY" | grep -qi 'Clavis' && ok "carries Clavis branding" || bad "the branding is missing"

echo
echo "=== 6. The email link opens the new-password screen ==="
LINK=$(echo "$HTMLBODY" | python3 -c "
import sys, re, html
h = sys.stdin.read()
m = re.search(r'href=\"([^\"]*login-actions/action-token[^\"]*)\"', h)
print(html.unescape(m.group(1)) if m else '')")
if [ -z "$LINK" ]; then
  bad "the action link was not found in the email"
  summary "PASSWORD RESET"; exit 1
fi
ok "action link found"
JAR2=$(mktemp "${TMPDIR:-/tmp}/clavis-cookies2-XXXXXX")
UPD=$(mktemp "${TMPDIR:-/tmp}/clavis-upd-XXXXXX.html")
curl -s -L -c "$JAR2" -b "$JAR2" -o "$UPD" "$LINK"
grep -q 'clavis-layout' "$UPD" && ok "the screen uses the clavis theme" || bad "does not use the clavis theme"
grep -q 'name="password-new"' "$UPD" && ok "new password field present" || bad "password-new is missing"
grep -q 'name="password-confirm"' "$UPD" && ok "confirmation field present" || bad "password-confirm is missing"
grep -q 'logout-sessions' "$UPD" && ok "option to sign out other sessions" || bad "logout-sessions is missing"

echo
echo "=== 7. The password is set and works ==="
NEWPW=$(envval ROOT_PASSWORD) # the same one, so the rest of the lab keeps working
if [ -z "$NEWPW" ]; then
  bad "ROOT_PASSWORD is empty in .env: aborting so the account is not left unusable"
  summary "PASSWORD RESET"; exit 1
fi
# The form is located by id: the page carries more than one <form> (the "try
# another way" one and the language one) and posting to the wrong one leaves the
# account half-updated.
UPD_ACTION=$(form_action "$UPD" "kc-passwd-update-form")
if [ -z "$UPD_ACTION" ]; then
  bad "the #kc-passwd-update-form form was not found"
  summary "PASSWORD RESET"; exit 1
fi
RES=$(curl -s -b "$JAR2" -c "$JAR2" -o /dev/null -w '%{http_code}' \
  --data-urlencode "password-new=$NEWPW" --data-urlencode "password-confirm=$NEWPW" \
  -X POST "$UPD_ACTION")
echo "     HTTP response: $RES"
sleep 1
TOK=$(curl -s -X POST "$KC/realms/$REALM/protocol/openid-connect/token" \
  -d "client_id=$CLIENT" -d "grant_type=password" -d "username=$(envval ROOT_USERNAME)" \
  --data-urlencode "password=$NEWPW" |
  python3 -c "import sys,json;print('OK' if json.load(sys.stdin).get('access_token') else 'FAILED')")
[ "$TOK" = "OK" ] && ok "admin signs in with the password that was set" || bad "cannot sign in after the change"
rm -f "$JAR2" "$UPD"

summary "PASSWORD RESET"
