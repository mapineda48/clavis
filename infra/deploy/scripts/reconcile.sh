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

# The pointer is read over HTTPS, NOT through the mount, and that is the single
# most important line in this script.
#
# blobfuse2 caches file CONTENT. current.json is overwritten in place on every
# deploy, keeping its name and roughly its size, and the cached copy is served
# long after the blob changed — measured on this host: the directory listing
# showed the new bundle while the pointer still returned the previous commit
# nineteen minutes later. Deploys simply stop happening, and nothing reports an
# error, because from the host's point of view there is nothing new to do.
#
# The bundle itself still comes through the mount: its name carries the commit,
# so a new deploy is a new filename and stale content is impossible.
# One cleanup handler for the whole script: a second `trap ... EXIT` would
# silently replace this one and leak the staging directory.
CURRENT_JSON=$(mktemp)
work=""
cleanup() { rm -f "$CURRENT_JSON"; [ -n "$work" ] && rm -rf "$work"; }
trap cleanup EXIT

SAS=$(sed -n 's/^[[:space:]]*sas:[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' /etc/blobfuse2.yaml)
if [ -n "$SAS" ]; then
  POINTER_URL="https://${ERP_STORAGE_ACCOUNT}.blob.core.windows.net/${ERP_DEPLOY_CONTAINER}/${ERP_DEPLOY_PREFIX}/current.json?${SAS#\?}"
  curl -fsS --max-time 30 -H 'Cache-Control: no-cache' -o "$CURRENT_JSON" "$POINTER_URL" || : > "$CURRENT_JSON"
fi

# Fall back to the mount only if the direct read failed outright, so a transient
# network problem degrades to "possibly stale" instead of "no deploys at all".
if [ ! -s "$CURRENT_JSON" ]; then
  log "could not read the pointer over HTTPS; falling back to the mount (may be stale)"
  [ -s "${BASE}/current.json" ] || { log "no desired state published yet"; exit 0; }
  cp "${BASE}/current.json" "$CURRENT_JSON"
fi

commit=$(jq -r '.commit // empty' "$CURRENT_JSON")
bundle=$(jq -r '.bundle // empty' "$CURRENT_JSON")
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

# Realm convergence, before anything serves traffic.
#
# `start --import-realm` is hard-wired to IGNORE_EXISTING: against a database
# that outlives the host it imports once and skips silently ever after, so the
# realm would freeze at whatever the first droplet produced while every later
# deploy reported success. `import --override` is what actually converges, and
# it runs as a one-shot under a compose profile so it can never be part of `up`.
log "converging the realm"
docker compose --profile import run --rm --no-deps keycloak-import

log "starting"
docker compose up -d --remove-orphans --wait --wait-timeout 300

printf '%s' "$commit" > "$STATE"
log "converged on ${commit}"

# Free the disk the previous release's images are holding. The droplet is small
# and every deploy adds three more layers sets.
docker image prune -af --filter "until=24h" >/dev/null 2>&1 || true
