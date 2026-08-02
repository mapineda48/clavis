#!/usr/bin/env bash
# =============================================================================
# Restores Traefik's ACME state from the blob mount onto local disk, BEFORE
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
# =============================================================================
set -euo pipefail

# shellcheck disable=SC1091
. /etc/erp/deploy.env

SRC="/mnt/deploy/${ERP_DEPLOY_PREFIX}/traefik/acme.json"
DST=/var/lib/traefik/acme.json

mountpoint -q /mnt/deploy || {
  echo "acme-restore: /mnt/deploy is not mounted; refusing to continue" >&2
  exit 1
}

install -d -m 0700 -o root -g root /var/lib/traefik

if [ ! -s "$SRC" ]; then
  echo "acme-restore: no stored state, starting from an empty store"
  : > "$DST"
  chmod 0600 "$DST"
  exit 0
fi

tmp="$(mktemp /var/lib/traefik/.acme.XXXXXX)"
chmod 0600 "$tmp"
trap 'rm -f "$tmp"' EXIT

cp -- "$SRC" "$tmp"

# A truncated or half-written restore is worse than none: Traefik would drop the
# resolver and serve self-signed certificates, and re-ordering would eat the
# weekly duplicate-certificate quota. Fail closed instead.
if ! jq -e . "$tmp" >/dev/null 2>&1; then
  echo "acme-restore: stored acme.json is not valid JSON; refusing to install it" >&2
  exit 1
fi

# Atomic, and on the same ext4 filesystem — which is exactly the guarantee the
# blob mount cannot give, where rename is a copy followed by a delete.
mv -f -- "$tmp" "$DST"
trap - EXIT
chmod 0600 "$DST"
chown root:root "$DST"

certs=$(jq '[.[]?.Certificates // [] | length] | add // 0' "$DST")
echo "acme-restore: installed $DST with ${certs} certificate(s)"
