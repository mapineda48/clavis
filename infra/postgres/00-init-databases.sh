#!/usr/bin/env bash
#
# Crea el rol y la base de datos de Keycloak dentro del mismo servidor
# PostgreSQL que usa el ERP.
#
# La imagen oficial de postgres ejecuta este archivo con bash desde
# /docker-entrypoint-initdb.d, y solo la primera vez que se inicializa el
# volumen de datos. Si el archivo tiene permiso de ejecucion se lanza como
# proceso; si no lo tiene, el entrypoint lo hace con `source`. En ambos casos
# el interprete es bash, que es lo que necesitamos.
#
# Para dejarlo ejecutable en tu copia de trabajo:
#   chmod +x infra/postgres/00-init-databases.sh
#
# El script es idempotente: se puede volver a lanzar sin efectos secundarios.

set -euo pipefail

KEYCLOAK_DB_NAME="${KEYCLOAK_DB_NAME:-keycloak}"
KEYCLOAK_DB_USER="${KEYCLOAK_DB_USER:-keycloak}"
KEYCLOAK_DB_PASSWORD="${KEYCLOAK_DB_PASSWORD:-keycloak_dev_password}"

echo "[init-databases] preparando base '${KEYCLOAK_DB_NAME}' y rol '${KEYCLOAK_DB_USER}'"

# Paso 1: rol y base de datos.
#
# Ni CREATE ROLE ni CREATE DATABASE admiten IF NOT EXISTS, y CREATE DATABASE
# tampoco puede ejecutarse dentro de un bloque DO (necesita autocommit). La
# solucion portable es generar la sentencia con format() y ejecutarla con \gexec,
# que corre cada sentencia por separado y solo si la consulta devuelve filas.
#
# Los valores se pasan como variables de psql: :'var' los inserta ya escapados
# como literal SQL (duplicando comillas simples) y :"var" como identificador
# entre comillas dobles.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --no-psqlrc --quiet \
  --set ON_ERROR_STOP=1 \
  --set kc_user="$KEYCLOAK_DB_USER" \
  --set kc_password="$KEYCLOAK_DB_PASSWORD" \
  --set kc_db="$KEYCLOAK_DB_NAME" <<'EOSQL'

-- Rol de Keycloak (solo si no existe).
SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', :'kc_user', :'kc_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'kc_user')
\gexec

-- Base de datos de Keycloak (solo si no existe), propiedad del rol anterior.
SELECT format('CREATE DATABASE %I OWNER %I', :'kc_db', :'kc_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'kc_db')
\gexec

-- GRANT es idempotente, se ejecuta siempre.
SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'kc_db', :'kc_user')
\gexec

EOSQL

# Paso 2: privilegios dentro de la base de Keycloak.
# Desde PostgreSQL 15 el esquema public ya no concede CREATE a PUBLIC, asi que
# hay que darselo explicitamente al rol para que Keycloak pueda crear su schema.
psql --username "$POSTGRES_USER" --dbname "$KEYCLOAK_DB_NAME" \
  --no-psqlrc --quiet \
  --set ON_ERROR_STOP=1 \
  --set kc_user="$KEYCLOAK_DB_USER" <<'EOSQL'

GRANT ALL ON SCHEMA public TO :"kc_user";
ALTER SCHEMA public OWNER TO :"kc_user";

EOSQL

echo "[init-databases] listo"
