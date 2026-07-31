# syntax=docker/dockerfile:1
#
# Imagen de @erp/api.
# IMPORTANTE: el contexto de build es la RAIZ del monorepo, no esta carpeta.
#   docker build -f packages/api/Dockerfile .
# (docker-compose.yml ya lo hace asi: context "." + dockerfile
# "packages/api/Dockerfile").

# ------------------------------------------------------------------------------
# Etapa 1: instalacion de dependencias y compilacion TypeScript.
# ------------------------------------------------------------------------------
FROM node:22.23.1-alpine AS build

# Sin CI=true pnpm pide confirmacion interactiva antes de purgar node_modules en
# la reinstalacion `--prod` y aborta (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
ENV CI=true

RUN npm i -g pnpm@11.9.0

WORKDIR /repo

# Primero solo los manifiestos: asi la capa de instalacion se cachea mientras no
# cambien las dependencias. Hacen falta los package.json de AMBOS paquetes del
# workspace; si falta uno, `--frozen-lockfile` falla porque el lockfile describe
# el workspace completo.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/app/package.json packages/app/package.json

# Instala solo el subarbol de dependencias que necesita la API.
RUN pnpm install --frozen-lockfile --filter @erp/api...

# Ahora el codigo fuente del paquete (incluye migrations/, que deben viajar en
# la imagen porque el migrador las lee en tiempo de ejecucion).
COPY packages/api packages/api

RUN pnpm --filter @erp/api build

# Reinstalacion en modo produccion: elimina devDependencies del node_modules.
RUN pnpm install --frozen-lockfile --prod --filter @erp/api...

# ------------------------------------------------------------------------------
# Etapa 2: imagen final.
# ------------------------------------------------------------------------------
FROM node:22.23.1-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /repo

# Copiamos /repo entero: los node_modules de pnpm son enlaces simbolicos
# relativos dentro del propio repo, asi que solo siguen siendo validos si se
# mantiene la estructura completa del workspace.
COPY --from=build /repo /repo

WORKDIR /repo/packages/api

# Proceso sin privilegios (el usuario `node` ya existe en la imagen oficial).
USER node

EXPOSE 3000

# El healthcheck se declara en docker-compose.yml, no aqui.
CMD ["node", "dist/main.js"]
