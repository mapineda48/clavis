# syntax=docker/dockerfile:1
#
# Image for @clavis/app (the SPA built with Vite and served by nginx).
# IMPORTANT: the build context is the ROOT of the monorepo, not this folder.
#   docker build -f packages/app/Dockerfile .
# Only built under the `full` docker compose profile.

# ------------------------------------------------------------------------------
# Stage 1: Vite build.
# ------------------------------------------------------------------------------
FROM node:22.23.1-alpine AS build

# pnpm in non-interactive mode: without this it asks for confirmation on
# operations that touch node_modules and aborts because there is no TTY.
ENV CI=true

RUN npm i -g pnpm@11.9.0

WORKDIR /repo

# Same pattern as the API: the manifests of the whole workspace first, both to
# exploit the layer cache and so `--frozen-lockfile` does not fail.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/app/package.json packages/app/package.json

RUN pnpm install --frozen-lockfile --filter @clavis/app...

COPY packages/app packages/app

# `build` runs typecheck + vite build and leaves the output in packages/app/dist.
# The Keycloak and API configuration is NOT baked in here: it arrives at runtime
# through /config.js (window.__CLAVIS_CONFIG__).
RUN pnpm --filter @clavis/app build

# ------------------------------------------------------------------------------
# Stage 2: static server.
# ------------------------------------------------------------------------------
FROM nginx:1.29-alpine AS runtime

COPY --from=build /repo/packages/app/dist /usr/share/nginx/html
COPY infra/nginx/app.conf /etc/nginx/conf.d/default.conf

# The nginx entrypoint runs the scripts in /docker-entrypoint.d in alphabetical
# order, and only if they are executable.
COPY infra/nginx/40-clavis-runtime-config.sh /docker-entrypoint.d/40-clavis-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-clavis-runtime-config.sh

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
