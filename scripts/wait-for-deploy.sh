#!/usr/bin/env bash
# =============================================================================
# Waits until the droplet has converged on the commit just published.
#
# There is nothing to poll on the host itself — no port is open for it — so this
# polls the public surface instead and matches the commit the API reports.
# =============================================================================
set -uo pipefail

: "${ERP_APP_FQDN:?}"
: "${DEPLOY_SHA:?}"

TIMEOUT_SECONDS="${DEPLOY_TIMEOUT_SECONDS:-900}"
INTERVAL=10

# Under the staging resolver the chain is signed by Let's Encrypt's test CA and
# is not in any trust store. Certificate VALIDITY is asserted separately, by
# smoke-production.sh; here we only need to reach the service.
INSECURE=""
[ "${ERP_CERT_RESOLVER:-staging}" = "staging" ] && INSECURE="-k"

echo "Waiting for https://${ERP_APP_FQDN} to serve ${DEPLOY_SHA} (up to ${TIMEOUT_SECONDS}s)"

deadline=$(( SECONDS + TIMEOUT_SECONDS ))
last=""
while [ "$SECONDS" -lt "$deadline" ]; do
  # The commit the host is actually serving, published into the SPA's runtime
  # configuration at container start.
  #
  # Waiting on health alone is not enough, and that is not hypothetical: the
  # PREVIOUS deployment answers /api/health perfectly well, so the wait returned
  # immediately and the smoke suite ran against the old stack — passing, or
  # failing, for reasons that had nothing to do with what was just published.
  served=$(curl -s $INSECURE --max-time 10 "https://${ERP_APP_FQDN}/config.js" 2>/dev/null \
    | sed -n "s/.*commit: *'\([^']*\)'.*/\1/p")

  if [ "$served" = "$DEPLOY_SHA" ]; then
    ready=$(curl -s $INSECURE --max-time 10 "https://${ERP_APP_FQDN}/api/health/ready" 2>/dev/null)
    status=$(printf '%s' "$ready" | jq -r '.status // empty' 2>/dev/null)
    if [ "$status" = "ok" ]; then
      echo "Converged after $((SECONDS))s: serving ${served}, readiness ok."
      exit 0
    fi
    state="serving the new commit, readiness=${status:-<not json>}"
  elif [ -n "$served" ]; then
    state="still serving ${served}"
  else
    state="no runtime configuration yet"
  fi

  [ "$state" != "$last" ] && echo "  [$SECONDS s] ${state}"
  last="$state"
  sleep "$INTERVAL"
done

echo "The deployment never became ready within ${TIMEOUT_SECONDS}s." >&2
echo "The host polls every 60s, so a bundle published moments ago may simply" >&2
echo "not have been picked up; check the droplet's erp-deploy.service." >&2
exit 1
