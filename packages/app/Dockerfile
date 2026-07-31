# syntax=docker/dockerfile:1
#
# Imagen de @erp/app (SPA compilado con Vite y servido por nginx).
# IMPORTANTE: el contexto de build es la RAIZ del monorepo, no esta carpeta.
#   docker build -f packages/app/Dockerfile .
# Solo se construye con el perfil `full` de docker compose.

# ------------------------------------------------------------------------------
# Etapa 1: build con Vite.
# ------------------------------------------------------------------------------
FROM node:22.23.1-alpine AS build

# pnpm en modo no interactivo: sin esto pide confirmacion en operaciones que
# tocan node_modules y aborta al no haber TTY.
ENV CI=true

RUN npm i -g pnpm@11.9.0

WORKDIR /repo

# Mismo patron que la API: primero los manifiestos de todo el workspace para
# aprovechar la cache de capas y para que `--frozen-lockfile` no falle.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/app/package.json packages/app/package.json

RUN pnpm install --frozen-lockfile --filter @erp/app...

COPY packages/app packages/app

# `build` hace typecheck + vite build y deja el resultado en packages/app/dist.
# La configuracion de Keycloak y de la API NO se incrusta aqui: llega en runtime
# via /config.js (window.__ERP_CONFIG__).
RUN pnpm --filter @erp/app build

# ------------------------------------------------------------------------------
# Etapa 2: servidor estatico.
# ------------------------------------------------------------------------------
FROM nginx:1.29-alpine AS runtime

COPY --from=build /repo/packages/app/dist /usr/share/nginx/html
COPY infra/nginx/app.conf /etc/nginx/conf.d/default.conf

# El entrypoint de nginx ejecuta los scripts de /docker-entrypoint.d en orden
# alfabetico, y solo si tienen permiso de ejecucion.
COPY infra/nginx/40-erp-runtime-config.sh /docker-entrypoint.d/40-erp-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-erp-runtime-config.sh

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
