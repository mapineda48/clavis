#!/usr/bin/env bash
# =============================================================================
# Copies the local ACME stores back to the blob mount.
#
# Triggered by clavis-acme-backup.path when Traefik rewrites one of them, and by
# clavis-acme-backup.timer as a safety net, because inotify events coalesce.
#
# This is what makes an on-demand droplet viable at all: Let's Encrypt grants
# five certificates per week for the same set of names, so a host that
# re-ordered on every boot would lock the hostname out by the sixth run.
# =============================================================================
set -euo pipefail

# shellcheck disable=SC1091
. /etc/clavis/deploy.env

SRC_DIR=/var/lib/traefik
DEST_DIR="/mnt/deploy/${CLAVIS_DEPLOY_PREFIX}/traefik"

mountpoint -q /mnt/deploy || {
  echo "acme-backup: /mnt/deploy is not mounted; nothing to do" >&2
  exit 1
}

mkdir -p "$DEST_DIR"

published=0
for src in "$SRC_DIR"/*.json; do
  [ -e "$src" ] || continue
  [ -s "$src" ] || continue
  name=$(basename "$src")
  dst="${DEST_DIR}/${name}"

  # Never publish a store that would fail to load on the next boot.
  jq -e . "$src" >/dev/null 2>&1 || {
    echo "acme-backup: ${name} is not valid JSON; refusing to publish it" >&2
    continue
  }

  # Skip when nothing changed: every copy is a PutBlob, and the timer fires
  # every ten minutes whether or not Traefik touched anything.
  if [ -s "$dst" ] && cmp -s "$src" "$dst"; then
    continue
  fi

  # A single plain overwrite. Deliberately NOT write-to-temp-then-rename: on
  # this filesystem rename is a copy followed by a delete, so the pattern buys
  # nothing and doubles the number of operations that can fail halfway.
  cp -- "$src" "$dst"
  echo "acme-backup: published ${name} ($(stat -c %s "$src") bytes)"
  published=$((published + 1))
done

[ "$published" -gt 0 ] || echo "acme-backup: nothing to publish"
