#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Receipt Vault — Redeploy script
# Use this after making code changes. Skips all first-time setup.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

BOLD='\033[1m'; GREEN='\033[0;32m'; AMBER='\033[0;33m'; RESET='\033[0m'
step() { echo -e "\n${BOLD}${AMBER}▶ $*${RESET}"; }
ok()   { echo -e "${GREEN}✓ $*${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step "Deploying Worker"
cd "$SCRIPT_DIR/worker"
npx wrangler deploy --env=""
ok "Worker deployed"

step "Deploying Frontend"
cd "$SCRIPT_DIR"
npx wrangler pages deploy frontend --project-name receipt-vault --commit-dirty=true
ok "Frontend deployed"

echo -e "\n${BOLD}${GREEN}✓ Redeploy complete${RESET}\n"
