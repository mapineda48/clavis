# syntax=docker/dockerfile:1
#
# Keycloak image for production, with the `erp` theme baked in.
# IMPORTANT: the build context is the ROOT of the monorepo, not this folder.
#   docker build -f infra/keycloak/Dockerfile .
#
# Why a custom image at all: in development docker-compose.yml bind-mounts
# ./infra/keycloak/themes into the container, but the production host has no
# checkout of this repository — the theme has to travel inside the image.
#
# What does NOT travel inside the image: the RENDERED realm. It carries the
# Resend key as the SMTP password and the API client secret, and this package is
# public. The realm is rendered at deploy time and mounted at
# /opt/keycloak/data/import instead.
#
# Consequence to keep in mind: editing a .ftl or the CSS no longer means "reload
# the browser" as it does with `start-dev` locally. In production it means
# rebuilding this image and redeploying.

ARG KEYCLOAK_VERSION=26.4.0

# ------------------------------------------------------------------------------
# Stage 1: augmentation. Everything set here is FROZEN into the image.
# ------------------------------------------------------------------------------
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION} AS build

# Build-time options: `kc.sh build` bakes these in so that `start --optimized`
# skips re-augmentation at boot. They must NOT be repeated as runtime
# environment variables — a value that differs from the baked one aborts
# startup.
ENV KC_DB=postgres
ENV KC_HEALTH_ENABLED=true
ENV KC_METRICS_ENABLED=true

# Runtime options (KC_HOSTNAME, KC_DB_URL_*, KC_PROXY_HEADERS, KC_CACHE…) are
# deliberately absent: `kc.sh build` ignores them, and baking them would only
# hardcode defaults the deployment then has to match.

# Folder themes need no augmentation, but copying before the build step means
# the single COPY in stage 2 carries them across with everything else.
COPY --chown=1000:0 infra/keycloak/themes/ /opt/keycloak/themes/

RUN /opt/keycloak/bin/kc.sh build

# ------------------------------------------------------------------------------
# Stage 2: runtime.
# ------------------------------------------------------------------------------
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}

COPY --from=build --chown=1000:0 /opt/keycloak/ /opt/keycloak/

# The health endpoints live on the management port (9000), never on 8080, and
# the image ships neither curl nor wget: the healthcheck is declared in the
# compose file using bash's /dev/tcp, as it already is for development.
EXPOSE 8080 9000

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized"]
