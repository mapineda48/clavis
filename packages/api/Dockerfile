# syntax=docker/dockerfile:1
#
# Image for @clavis/api.
# IMPORTANT: the build context is the ROOT of the monorepo, not this folder.
#   docker build -f packages/api/Dockerfile .
# (docker-compose.yml already does it this way: context "." + dockerfile
# "packages/api/Dockerfile".)

# ------------------------------------------------------------------------------
# Stage 1: dependency install and TypeScript build.
# ------------------------------------------------------------------------------
FROM node:22.23.1-alpine AS build

# Without CI=true pnpm asks for interactive confirmation before wiping
# node_modules during the `--prod` reinstall, and aborts
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
ENV CI=true

RUN npm i -g pnpm@11.9.0

WORKDIR /repo

# Manifests first: that way the install layer stays cached as long as the
# dependencies do not change. The package.json of BOTH workspace packages is
# required; if one is missing, `--frozen-lockfile` fails because the lockfile
# describes the whole workspace.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/app/package.json packages/app/package.json

# Install only the dependency subtree the API needs.
RUN pnpm install --frozen-lockfile --filter @clavis/api...

# Now the package source (including migrations/, which must ship in the image
# because the migrator reads them at runtime).
COPY packages/api packages/api

RUN pnpm --filter @clavis/api build

# Production reinstall: drops the devDependencies from node_modules.
RUN pnpm install --frozen-lockfile --prod --filter @clavis/api...

# ------------------------------------------------------------------------------
# Stage 2: final image.
# ------------------------------------------------------------------------------
FROM node:22.23.1-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /repo

# The whole /repo is copied over: pnpm's node_modules are relative symlinks
# inside the repo itself, so they only stay valid if the full workspace layout
# is preserved.
COPY --from=build /repo /repo

WORKDIR /repo/packages/api

# Unprivileged process (the `node` user already exists in the official image).
USER node

EXPOSE 3000

# The healthcheck is declared in docker-compose.yml, not here.
CMD ["node", "dist/main.js"]
