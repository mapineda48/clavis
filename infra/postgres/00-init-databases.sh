#!/usr/bin/env bash
#
# Creates Keycloak's role and database inside the same PostgreSQL server Clavis
# uses.
#
# The official postgres image runs this file with bash from
# /docker-entrypoint-initdb.d, and only the first time the data volume is
# initialised. If the file is executable it is spawned as a process; if it is
# not, the entrypoint `source`s it instead. Either way the interpreter is bash,
# which is what we need.
#
# To make it executable in your working copy:
#   chmod +x infra/postgres/00-init-databases.sh
#
# The script is idempotent: re-running it has no side effects.

set -euo pipefail

KEYCLOAK_DB_NAME="${KEYCLOAK_DB_NAME:-keycloak}"
KEYCLOAK_DB_USER="${KEYCLOAK_DB_USER:-keycloak}"
KEYCLOAK_DB_PASSWORD="${KEYCLOAK_DB_PASSWORD:-keycloak_dev_password}"

echo "[init-databases] preparing database '${KEYCLOAK_DB_NAME}' and role '${KEYCLOAK_DB_USER}'"

# Step 1: role and database.
#
# Neither CREATE ROLE nor CREATE DATABASE accepts IF NOT EXISTS, and CREATE
# DATABASE cannot run inside a DO block either (it needs autocommit). The
# portable way out is to build the statement with format() and run it through
# \gexec, which executes each statement separately and only when the query
# returns rows.
#
# Values are passed as psql variables: :'var' inlines them already escaped as an
# SQL literal (doubling single quotes) and :"var" as a double-quoted identifier.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --no-psqlrc --quiet \
  --set ON_ERROR_STOP=1 \
  --set kc_user="$KEYCLOAK_DB_USER" \
  --set kc_password="$KEYCLOAK_DB_PASSWORD" \
  --set kc_db="$KEYCLOAK_DB_NAME" <<'EOSQL'

-- Keycloak role (only if it does not exist yet).
SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', :'kc_user', :'kc_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'kc_user')
\gexec

-- Keycloak database (only if it does not exist yet), owned by the role above.
SELECT format('CREATE DATABASE %I OWNER %I', :'kc_db', :'kc_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'kc_db')
\gexec

-- GRANT is idempotent, so it always runs.
SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'kc_db', :'kc_user')
\gexec

EOSQL

# Step 2: privileges inside the Keycloak database.
# Since PostgreSQL 15 the public schema no longer grants CREATE to PUBLIC, so the
# role needs it explicitly for Keycloak to create its schema.
psql --username "$POSTGRES_USER" --dbname "$KEYCLOAK_DB_NAME" \
  --no-psqlrc --quiet \
  --set ON_ERROR_STOP=1 \
  --set kc_user="$KEYCLOAK_DB_USER" <<'EOSQL'

GRANT ALL ON SCHEMA public TO :"kc_user";
ALTER SCHEMA public OWNER TO :"kc_user";

EOSQL

echo "[init-databases] done"
