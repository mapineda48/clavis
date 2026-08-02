#!/usr/bin/env bash
# =============================================================================
# Copies the local ACME state back to the blob mount.
#
# Triggered by erp-acme-backup.path when Traefik rewrites the file, and by
# erp-acme-backup.timer as a safety net, because inotify events coalesce.
# =============================================================================
set -euo pipefail

# shellcheck disable=SC1091
. /etc/erp/deploy.env

SRC=/var/lib/traefik/acme.json
DEST_DIR="/mnt/deploy/${ERP_DEPLOY_PREFIX}/traefik"
DST="${DEST_DIR}/acme.json"

mountpoint -q /mnt/deploy || {
  echo "acme-backup: /mnt/deploy is not mounted; nothing to do" >&2
  exit 1
}

[ -s "$SRC" ] || { echo "acme-backup: local store is empty, nothing to copy"; exit 0; }

# Never publish a store that would fail to load on the next boot.
jq -e . "$SRC" >/dev/null 2>&1 || {
  echo "acme-backup: local acme.json is not valid JSON; refusing to publish it" >&2
  exit 1
}

# Skip when nothing changed: every copy is a PutBlob, and the timer fires every
# ten minutes whether or not Traefik touched anything.
if [ -s "$DST" ] && cmp -s "$SRC" "$DST"; then
  exit 0
fi

mkdir -p "$DEST_DIR"

# A single plain overwrite. Deliberately NOT write-to-temp-then-rename: on this
# filesystem rename is a copy followed by a delete, so the pattern buys nothing
# and doubles the number of operations that can fail halfway.
cp -- "$SRC" "$DST"

echo "acme-backup: published $(stat -c %s "$SRC") bytes to $DST"
