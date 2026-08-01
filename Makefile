# Atajos del ciclo de vida del demo. Son equivalentes a los scripts de package.json.
# Requisitos: pnpm, docker compose, curl y node (para `make token`).
# Uso: make <target>   — sin argumentos muestra la tabla de ayuda.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# Raiz del repo deducida de la ruta de este Makefile: los targets funcionan
# aunque se invoquen con `make -f /ruta/Makefile` desde otro directorio.
ROOT_DIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

PNPM := pnpm -C $(ROOT_DIR)
COMPOSE := docker compose -f $(ROOT_DIR)/docker-compose.yml --project-directory $(ROOT_DIR)

# Usuario demo con el que autentica `make token`: admin | manager | worker
KC_USER ?= admin

.DEFAULT_GOAL := help
.PHONY: help install dev build typecheck up up-full down reset logs ps token \
        verify verify-api verify-theme verify-reset

help: ## Muestra esta tabla de targets
	@printf '\n\033[1mERP Demo\033[0m — targets disponibles\n\n'
	@grep -hE '^[a-zA-Z][a-zA-Z0-9_-]*:.*##' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN { FS = ":.*##[ ]?" } { printf "  \033[36m%-10s\033[0m  %s\n", $$1, $$2 }'
	@printf '\n  Variables: \033[36mKC_USER\033[0m=admin|manager|worker (target token)\n\n'

install: ## Instala las dependencias del workspace
	$(PNPM) install

dev: ## Arranca api y app en modo desarrollo (en paralelo)
	$(PNPM) -r --parallel dev

build: ## Compila todos los paquetes
	$(PNPM) -r build

typecheck: ## Comprueba los tipos de todos los paquetes
	$(PNPM) -r typecheck

verify: verify-api verify-theme ## Verificacion end-to-end (API + tema de login)

verify-api: ## Verifica permisos, cache, adjuntos y correo de la API
	@bash $(ROOT_DIR)/scripts/verify-api.sh

verify-theme: ## Verifica que el tema de login sigue autenticando
	@bash $(ROOT_DIR)/scripts/verify-login-theme.sh

verify-reset: ## Verifica el flujo de recuperar contrasena (requiere la CLI resend)
	@bash $(ROOT_DIR)/scripts/verify-password-reset.sh

up: ## Levanta la infraestructura y la API (docker compose)
	$(COMPOSE) up -d --build

up-full: ## Levanta todo incluida la app servida por nginx (perfil full)
	$(COMPOSE) --profile full up -d --build

down: ## Para y elimina los contenedores (conserva los volumenes)
	$(COMPOSE) down

reset: ## Para los contenedores y BORRA los volumenes (datos y realm)
	$(COMPOSE) down -v

logs: ## Sigue los logs de todos los servicios
	$(COMPOSE) logs -f

ps: ## Lista el estado de los servicios
	$(COMPOSE) ps

# Imprime SOLO el access token en stdout, para poder encadenarlo:
#   TOKEN=$(make token KC_USER=manager)
#   curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/me
token: ## Access token del usuario demo via grant_type=password
	@env_file='$(ROOT_DIR)/.env'; \
	if [[ ! -f "$$env_file" ]]; then \
		echo "No existe $$env_file. Ejecuta primero: cp .env.example .env" >&2; \
		exit 1; \
	fi; \
	read_var() { sed -n "s/^$$1=//p" "$$env_file" | tail -n 1; }; \
	kc_url="$$(read_var KEYCLOAK_PUBLIC_URL)"; \
	realm="$$(read_var KEYCLOAK_REALM)"; \
	client="$$(read_var KEYCLOAK_APP_CLIENT_ID)"; \
	case '$(KC_USER)' in \
		admin)   user="$$(read_var DEMO_ADMIN_USERNAME)";   pass="$$(read_var DEMO_ADMIN_PASSWORD)";; \
		manager) user="$$(read_var DEMO_MANAGER_USERNAME)"; pass="$$(read_var DEMO_MANAGER_PASSWORD)";; \
		worker)  user="$$(read_var DEMO_USER_USERNAME)";    pass="$$(read_var DEMO_USER_PASSWORD)";; \
		*) echo 'KC_USER debe ser admin, manager o worker' >&2; exit 1;; \
	esac; \
	response="$$(curl -sS -X POST \
		"$${kc_url:-http://localhost:8080}/realms/$${realm:-erp}/protocol/openid-connect/token" \
		-H 'Content-Type: application/x-www-form-urlencoded' \
		-d 'grant_type=password' \
		-d "client_id=$${client:-erp-app}" \
		--data-urlencode "username=$$user" \
		--data-urlencode "password=$$pass")"; \
	printf '%s' "$$response" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let j;try{j=JSON.parse(s)}catch{console.error("Respuesta no JSON de Keycloak:\n"+s);process.exit(1)}if(!j.access_token){console.error("Keycloak no devolvio token:\n"+s);process.exit(1)}process.stdout.write(j.access_token+"\n")})'
