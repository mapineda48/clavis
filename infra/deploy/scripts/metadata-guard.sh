#!/usr/bin/env bash
# =============================================================================
# Stops containers from reaching the DigitalOcean metadata service.
#
# user-data is served unauthenticated at 169.254.169.254 to anything that can
# route there, for the droplet's entire life, and DigitalOcean offers no way to
# clear it. This host's user-data holds the SAS that unlocks the deploy
# container, so any code execution inside any container would otherwise hand it
# over with a single curl.
#
# It has to be DOCKER-USER. A rule appended to FORWARD is never reached, because
# Docker jumps out of FORWARD into its own chains first; and ufw does not see
# this traffic at all, since published ports are DNAT'd in the nat table before
# the filter chain ufw guards.
# =============================================================================
set -euo pipefail

METADATA=169.254.169.254

# The chain only exists once dockerd has started, which is why the unit that
# runs this is ordered After=docker.service.
for _ in $(seq 1 30); do
  iptables -n -L DOCKER-USER >/dev/null 2>&1 && break
  sleep 1
done

iptables -n -L DOCKER-USER >/dev/null 2>&1 || {
  echo "metadata-guard: the DOCKER-USER chain never appeared" >&2
  exit 1
}

# Idempotent: the unit may be restarted, and a duplicate rule is noise that
# hides the real one.
if ! iptables -C DOCKER-USER -d "$METADATA" -j DROP 2>/dev/null; then
  iptables -I DOCKER-USER 1 -d "$METADATA" -j DROP
  echo "metadata-guard: containers can no longer reach ${METADATA}"
else
  echo "metadata-guard: rule already present"
fi
