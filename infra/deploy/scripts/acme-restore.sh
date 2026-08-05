#!/usr/bin/env bash
# =============================================================================
# Restores Traefik's ACME stores from the blob mount onto local disk, BEFORE
# docker starts.
#
# Why not point Traefik straight at the mount, which would be simpler: it cannot
# work. Traefik refuses any ACME store whose permissions have group or other
# bits set (`Perm()&0o077 != 0`), and on a flat-namespace blob container chmod
# returns success without doing anything, while `allow-other: true` — which the
# containers need — forces every entry to 0777 and overrides default-permission
# outright.
#
# The failure mode is the dangerous part: Traefik does NOT exit. It logs one
# line, drops the resolver and serves its built-in self-signed certificate, so
# every "is it up?" check still passes while HTTPS is broken for real browsers.
#
# One store per resolver, so switching between staging and production actually
# takes effect: Traefik loads every certificate it can find into a single store
# and serves by SNI, so a staging certificate in the same file would satisfy the
# request and the production resolver would never order anything.
# =============================================================================
set -euo pipefail

# shellcheck disable=SC1091
. /etc/clavis/deploy.env

SRC_DIR="/mnt/deploy/${CLAVIS_DEPLOY_PREFIX}/traefik"
DST_DIR=/var/lib/traefik

mountpoint -q /mnt/deploy || {
  echo "acme-restore: /mnt/deploy is not mounted; refusing to continue" >&2
  exit 1
}

install -d -m 0700 -o root -g root "$DST_DIR"

restored=0
for src in "$SRC_DIR"/*.json; do
  [ -e "$src" ] || continue
  name=$(basename "$src")
  dst="${DST_DIR}/${name}"

  tmp="$(mktemp "${DST_DIR}/.acme.XXXXXX")"
  chmod 0600 "$tmp"
  cp -- "$src" "$tmp"

  # A truncated or half-written restore is worse than none: Traefik would drop
  # the resolver and serve self-signed certificates, and re-ordering would eat
  # the weekly duplicate-certificate quota. Fail closed instead.
  if ! jq -e . "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    echo "acme-restore: ${name} is not valid JSON; refusing to install it" >&2
    exit 1
  fi

  # Atomic, and on the same ext4 filesystem — which is exactly the guarantee the
  # blob mount cannot give, where rename is a copy followed by a delete.
  mv -f -- "$tmp" "$dst"
  chmod 0600 "$dst"
  chown root:root "$dst"

  certs=$(jq '[.[]?.Certificates // [] | length] | add // 0' "$dst")
  echo "acme-restore: ${name} restored with ${certs} certificate(s)"
  restored=$((restored + 1))
done

# Traefik creates a missing store itself, at 0600, so there is nothing to
# pre-seed on a first boot.
[ "$restored" -gt 0 ] || echo "acme-restore: no stored state yet, Traefik will order from scratch"
