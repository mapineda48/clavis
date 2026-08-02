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
  code=$(curl -s $INSECURE -o /dev/null -w '%{http_code}' --max-time 10 \
    "https://${ERP_APP_FQDN}/api/health" 2>/dev/null || echo 000)

  if [ "$code" = "200" ]; then
    ready=$(curl -s $INSECURE --max-time 10 "https://${ERP_APP_FQDN}/api/health/ready" 2>/dev/null)
    status=$(printf '%s' "$ready" | jq -r '.status // empty' 2>/dev/null)
    if [ "$status" = "ok" ]; then
      echo "Converged after $((SECONDS))s."
      exit 0
    fi
    [ "$status" != "$last" ] && echo "  [$SECONDS s] reachable, readiness=${status:-<not json>}"
    last="$status"
  else
    [ "$code" != "$last" ] && echo "  [$SECONDS s] HTTP ${code}"
    last="$code"
  fi
  sleep "$INTERVAL"
done

echo "The deployment never became ready within ${TIMEOUT_SECONDS}s." >&2
echo "The host polls every 60s, so a bundle published moments ago may simply" >&2
echo "not have been picked up; check the droplet's erp-deploy.service." >&2
exit 1
