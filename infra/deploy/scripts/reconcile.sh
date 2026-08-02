#!/usr/bin/env bash
# =============================================================================
# Brings the running stack in line with the desired state published to blob.
#
# This is the entire deployment trigger. GitHub Actions writes current.json and
# a bundle to a private container; a timer on this host notices within a minute.
# Nothing ever connects TO the droplet, so no port is open for deployment and no
# private key lives in GitHub.
#
# Rolling back is rewriting current.json.
# =============================================================================
set -euo pipefail

# shellcheck disable=SC1091
. /etc/erp/deploy.env

MOUNT=/mnt/deploy
BASE="${MOUNT}/${ERP_DEPLOY_PREFIX}"
STACK=/opt/erp/stack
STATE=/var/lib/erp/deployed-commit

log() { echo "reconcile: $*"; }

# A failed blobfuse2 mount leaves /mnt/deploy as an ordinary empty directory, so
# without this guard the script would read "nothing published", exit 0 and
# report success forever while deploys silently stopped happening.
mountpoint -q "$MOUNT" || { echo "reconcile: $MOUNT is not a mount point" >&2; exit 1; }

CURRENT="${BASE}/current.json"
if [ ! -s "$CURRENT" ]; then
  log "no desired state published yet"
  exit 0
fi

commit=$(jq -r '.commit // empty' "$CURRENT")
bundle=$(jq -r '.bundle // empty' "$CURRENT")
[ -n "$commit" ] && [ -n "$bundle" ] || { echo "reconcile: current.json is malformed" >&2; exit 1; }

running() {
  [ -f "${STACK}/docker-compose.yml" ] || return 1
  [ -n "$(docker compose --project-directory "$STACK" ps --status running -q 2>/dev/null)" ]
}

if [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$commit" ] && running; then
  exit 0
fi

log "converging on ${commit} (bundle ${bundle})"

BUNDLE_PATH="${BASE}/bundles/${bundle}"
[ -s "$BUNDLE_PATH" ] || { echo "reconcile: bundle $BUNDLE_PATH is missing" >&2; exit 1; }

# The bundle carries the rendered realm and the .env: every secret this stack
# needs. Nothing here may become world-readable.
umask 077
work="$(mktemp -d /opt/erp/.stage.XXXXXX)"
trap 'rm -rf "$work"' EXIT

tar -xzf "$BUNDLE_PATH" -C "$work"

for required in docker-compose.yml .env traefik/traefik.yml traefik/dynamic/stack.yml realm/realm-erp.json; do
  [ -e "${work}/${required}" ] || { echo "reconcile: bundle is missing ${required}" >&2; exit 1; }
done

# Fail before touching the running stack if the file would not parse.
docker compose --project-directory "$work" config -q

# 0700 root-owned: this directory is what keeps the bundle private. The files
# inside carry their own modes from the bundle, which are deliberately readable
# by the containers that need them — Traefik runs without CAP_DAC_OVERRIDE and
# the Keycloak import container runs as uid 1000.
install -d -m 0700 -o root -g root "$STACK"
rm -rf "${STACK:?}/"*
cp -a "${work}/." "$STACK/"
chmod 0700 "$STACK"
chmod 0600 "${STACK}/.env"

cd "$STACK"

log "pulling images by digest"
docker compose pull --quiet

log "starting"
docker compose up -d --remove-orphans --wait --wait-timeout 300

printf '%s' "$commit" > "$STATE"
log "converged on ${commit}"

# Free the disk the previous release's images are holding. The droplet is small
# and every deploy adds three more layers sets.
docker image prune -af --filter "until=24h" >/dev/null 2>&1 || true
