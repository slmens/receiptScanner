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
WORKER_DIR="$SCRIPT_DIR/worker"

# In some sandboxed IDE terminals, writing to your real home directory can fail.
# Pin $HOME to a workspace-local directory for the duration of this script.
SANDBOX_HOME="$SCRIPT_DIR/.home"
mkdir -p "$SANDBOX_HOME"
export HOME="$SANDBOX_HOME"

# Generalized: default Pages project name matches Worker name in wrangler.toml.
# Override via env:
#   PROJECT_NAME=... ./redeploy.sh
WORKER_NAME_FROM_TOML="$(grep -oP '^name\s*=\s*"\K[^"]+' "$WORKER_DIR/wrangler.toml" 2>/dev/null || echo "")"
PROJECT_NAME="${PROJECT_NAME:-${WORKER_NAME_FROM_TOML:-receipt-vault}}"

step "Deploying Worker"
cd "$WORKER_DIR"
npx wrangler deploy
ok "Worker deployed"

step "Deploying Frontend"
cd "$SCRIPT_DIR"
npx wrangler pages deploy frontend --project-name "$PROJECT_NAME" --commit-dirty=true
ok "Frontend deployed"

echo -e "\n${BOLD}${GREEN}✓ Redeploy complete${RESET}\n"
