#!/usr/bin/env bash
# =============================================================================
# Five assertions against the live deployment.
#
# Each one exists because a cheaper check passes while the thing is broken:
#
#   1. The served certificate is not Traefik's self-signed default. Traefik does
#      NOT crash when its ACME store is unreadable — it logs one line, drops the
#      resolver and keeps serving. Every "is it up?" check stays green while
#      HTTPS is broken for every real browser.
#
#   2. /api/health/ready answers with JSON. The SPA replies to any unknown path
#      with index.html and HTTP 200, so a misrouted probe passes forever.
#
#   3. The runtime configuration handed to the browser is what the browser
#      actually needs. Everything else here builds its own URLs, so it all
#      stayed green while the SPA was told to call an apiUrl ending in /api and
#      every request after login went to /api/api/… and 404'd.
#
#   4. The discovery document reports the public issuer. This is the cheapest
#      single catch for the whole KC_HOSTNAME / proxy-headers / sslRequired
#      family: get it wrong and tokens are minted with an issuer the API
#      refuses.
#
#   5. A real token is granted and spends successfully on a protected route.
#      Without this, nothing has verified the thing the lab exists to show.
#
# Even five is not everything: none of them opens the application in a browser,
# which is how a frame-options header that made login impossible passed the
# whole suite. See docs/deployment.md.
# =============================================================================
set -uo pipefail

: "${CLAVIS_APP_FQDN:?}"
: "${CLAVIS_API_FQDN:?}"
: "${CLAVIS_AUTH_FQDN:?}"
REALM="${CLAVIS_REALM:-clavis}"
RESOLVER="${CLAVIS_CERT_RESOLVER:-staging}"
CLIENT="${KEYCLOAK_APP_CLIENT_ID:-clavis-app}"

INSECURE=""
[ "$RESOLVER" = "staging" ] && INSECURE="-k"

pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }

echo "=== 1. TLS certificate ==="
issuer=$(echo | openssl s_client -connect "${CLAVIS_APP_FQDN}:443" -servername "${CLAVIS_APP_FQDN}" 2>/dev/null \
  | openssl x509 -noout -issuer 2>/dev/null)
echo "  issuer: ${issuer:-<none>}"
if [ -z "$issuer" ]; then
  bad "no certificate was served"
elif printf '%s' "$issuer" | grep -qi "TRAEFIK DEFAULT CERT"; then
  bad "Traefik is serving its self-signed default: the ACME resolver was dropped"
elif [ "$RESOLVER" = "staging" ]; then
  printf '%s' "$issuer" | grep -qi "STAGING" \
    && ok "issued by the Let's Encrypt staging CA, as configured" \
    || bad "expected a staging certificate, got: $issuer"
else
  printf '%s' "$issuer" | grep -qiE "let's encrypt|ISRG" \
    && ok "issued by Let's Encrypt" \
    || bad "expected a Let's Encrypt certificate, got: $issuer"
fi

# The same certificate must cover the API and Keycloak hostnames: the three
# names are one SAN set precisely so they share a single rate-limit bucket.
for host in "${CLAVIS_API_FQDN}" "${CLAVIS_AUTH_FQDN}"; do
  sans=$(echo | openssl s_client -connect "${host}:443" -servername "${host}" 2>/dev/null \
    | openssl x509 -noout -ext subjectAltName 2>/dev/null | tr -d ' ')
  printf '%s' "$sans" | grep -q "DNS:${host}" \
    && ok "the certificate covers ${host}" \
    || bad "the certificate does not cover ${host} (SANs: ${sans:-<none>})"
done

echo "=== 2. API readiness ==="
ready=$(curl -s $INSECURE --max-time 15 "https://${CLAVIS_API_FQDN}/api/health/ready")
if printf '%s' "$ready" | jq -e . >/dev/null 2>&1; then
  ok "/api/health/ready returned JSON, not the SPA's HTML"
  echo "  checks: $(printf '%s' "$ready" | jq -c '.checks')"
  [ "$(printf '%s' "$ready" | jq -r '.status')" = "ok" ] \
    && ok "every critical dependency is healthy" \
    || bad "readiness reports $(printf '%s' "$ready" | jq -r '.status')"
else
  bad "/api/health/ready did not return JSON (the SPA is probably answering it)"
fi

echo "=== 3. Runtime configuration served to the SPA ==="
# The assertions above build their own URLs, so they pass regardless of what the
# browser is actually told to call. That is how an apiUrl with a trailing /api
# shipped: the client prepends /api to every path itself, so the first request
# after login went to /api/api/todos and 404'd while everything here stayed
# green.
cfg=$(curl -s $INSECURE --max-time 15 "https://${CLAVIS_APP_FQDN}/config.js")
cfg_val() { printf '%s' "$cfg" | sed -n "s/.*$1: *'\([^']*\)'.*/\1/p"; }
api_url=$(cfg_val apiUrl)
kc_url=$(cfg_val keycloakUrl)
[ "$api_url" = "https://${CLAVIS_API_FQDN}" ] \
  && ok "apiUrl is the bare API origin (${api_url})" \
  || bad "apiUrl is '${api_url}', expected 'https://${CLAVIS_API_FQDN}' with no path — the client adds /api itself"
[ "$kc_url" = "https://${CLAVIS_AUTH_FQDN}" ] \
  && ok "keycloakUrl is ${kc_url}" \
  || bad "keycloakUrl is '${kc_url}', expected 'https://${CLAVIS_AUTH_FQDN}'"

echo "=== 4. OIDC discovery ==="
expected="https://${CLAVIS_AUTH_FQDN}/realms/${REALM}"
issuer_claim=$(curl -s $INSECURE --max-time 15 \
  "${expected}/.well-known/openid-configuration" | jq -r '.issuer // empty')
[ "$issuer_claim" = "$expected" ] \
  && ok "issuer is ${issuer_claim}" \
  || bad "issuer is '${issuer_claim:-<none>}', expected '${expected}'"

echo "=== 5. End-to-end token ==="
token_for() {
  curl -s $INSECURE --max-time 20 \
    -d "client_id=${CLIENT}" -d "username=$1" -d "password=$2" -d grant_type=password \
    "${expected}/protocol/openid-connect/token" | jq -r '.access_token // empty'
}
T_USER=$(token_for "${DEMO_USER_USERNAME:-worker}" "${DEMO_USER_PASSWORD:?}")
if [ -z "$T_USER" ]; then
  bad "could not obtain a token for the demo user"
else
  ok "token granted"
  code=$(curl -s $INSECURE -o /tmp/me.json -w '%{http_code}' --max-time 15 \
    -H "Authorization: Bearer $T_USER" "https://${CLAVIS_API_FQDN}/api/me")
  if [ "$code" = "200" ]; then
    ok "GET /api/me accepted the token (roles: $(jq -c '.permissions // .roles // empty' /tmp/me.json 2>/dev/null))"
  else
    bad "GET /api/me returned ${code}"
  fi
  # Anonymous access must still be refused: proves the route is genuinely
  # protected rather than merely reachable.
  anon=$(curl -s $INSECURE -o /dev/null -w '%{http_code}' --max-time 15 "https://${CLAVIS_API_FQDN}/api/me")
  [ "$anon" = "401" ] && ok "GET /api/me without a token is rejected (401)" \
                      || bad "GET /api/me without a token returned ${anon}, expected 401"
fi

echo
echo "==================== SMOKE: ${pass} OK / ${fail} FAILED ===================="
[ "$fail" -eq 0 ]
