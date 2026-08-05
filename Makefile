# Shortcuts for the demo lifecycle. Equivalent to the package.json scripts.
# Requires: pnpm, docker compose, curl and node (for `make token`).
# Usage: make <target>   — with no arguments it prints the help table.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# Repo root derived from the path of this Makefile: the targets work even when
# invoked as `make -f /path/Makefile` from another directory.
ROOT_DIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

PNPM := pnpm -C $(ROOT_DIR)
COMPOSE := docker compose -f $(ROOT_DIR)/docker-compose.yml --project-directory $(ROOT_DIR)

# Demo user `make token` authenticates as: admin | manager | worker
KC_USER ?= admin

.DEFAULT_GOAL := help
.PHONY: help install dev build typecheck up up-full down reset logs ps token \
        verify verify-api verify-theme verify-reset

help: ## Print this table of targets
	@printf '\n\033[1mClavis\033[0m — available targets\n\n'
	@grep -hE '^[a-zA-Z][a-zA-Z0-9_-]*:.*##' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN { FS = ":.*##[ ]?" } { printf "  \033[36m%-10s\033[0m  %s\n", $$1, $$2 }'
	@printf '\n  Variables: \033[36mKC_USER\033[0m=admin|manager|worker (token target)\n\n'

install: ## Install the workspace dependencies
	$(PNPM) install

dev: ## Run api and app in development mode (in parallel)
	$(PNPM) -r --parallel dev

build: ## Build every package
	$(PNPM) -r build

typecheck: ## Type-check every package
	$(PNPM) -r typecheck

verify: verify-api verify-theme ## End-to-end verification (API + login theme)

verify-api: ## Verify the API permissions, cache, attachments and email
	@bash $(ROOT_DIR)/scripts/verify-api.sh

verify-theme: ## Verify the login theme still authenticates
	@bash $(ROOT_DIR)/scripts/verify-login-theme.sh

verify-reset: ## Verify the password reset flow (needs the resend CLI)
	@bash $(ROOT_DIR)/scripts/verify-password-reset.sh

up: ## Start the infrastructure and the API (docker compose)
	$(COMPOSE) up -d --build

up-full: ## Start everything including the app served by nginx (full profile)
	$(COMPOSE) --profile full up -d --build

down: ## Stop and remove the containers (keeps the volumes)
	$(COMPOSE) down

reset: ## Stop the containers and DELETE the volumes (data and realm)
	$(COMPOSE) down -v

logs: ## Follow the logs of every service
	$(COMPOSE) logs -f

ps: ## List the state of the services
	$(COMPOSE) ps

# Prints ONLY the access token on stdout so it can be chained:
#   TOKEN=$(make token KC_USER=manager)
#   curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/me
token: ## Access token for the demo user via grant_type=password
	@env_file='$(ROOT_DIR)/.env'; \
	if [[ ! -f "$$env_file" ]]; then \
		echo "$$env_file does not exist. Run this first: cp .env.example .env" >&2; \
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
		*) echo 'KC_USER must be admin, manager or worker' >&2; exit 1;; \
	esac; \
	response="$$(curl -sS -X POST \
		"$${kc_url:-http://localhost:8080}/realms/$${realm:-clavis}/protocol/openid-connect/token" \
		-H 'Content-Type: application/x-www-form-urlencoded' \
		-d 'grant_type=password' \
		-d "client_id=$${client:-clavis-app}" \
		--data-urlencode "username=$$user" \
		--data-urlencode "password=$$pass")"; \
	printf '%s' "$$response" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let j;try{j=JSON.parse(s)}catch{console.error("Non-JSON response from Keycloak:\n"+s);process.exit(1)}if(!j.access_token){console.error("Keycloak returned no token:\n"+s);process.exit(1)}process.stdout.write(j.access_token+"\n")})'
