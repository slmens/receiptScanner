#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Receipt Vault — One-shot setup & deployment script
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh
#
# Prerequisites:
#   - Node.js 18+  (https://nodejs.org)
#   - Wrangler CLI (installed automatically if missing)
#   - Cloudflare account (https://dash.cloudflare.com/sign-up)
#   - Anthropic or OpenRouter API key
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
AMBER='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

step()  { echo -e "\n${BOLD}${AMBER}▶ $*${RESET}"; }
ok()    { echo -e "${GREEN}✓ $*${RESET}"; }
info()  { echo -e "${DIM}  $*${RESET}"; }
die()   { echo -e "${RED}✗ Error: $*${RESET}" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$SCRIPT_DIR/worker"
FRONTEND_DIR="$SCRIPT_DIR/frontend"

# In some sandboxed IDE terminals, writing to your real home directory can fail.
# Wrangler uses $HOME to decide where to write `~/.wrangler/...` logs/config.
# Pin $HOME to a workspace-local directory for the duration of this script.
SANDBOX_HOME="$SCRIPT_DIR/.home"
mkdir -p "$SANDBOX_HOME"
export HOME="$SANDBOX_HOME"

# ── Resource names (generalized, override via env) ─────────────────────────────
# Defaults are chosen so this repo works out-of-the-box for others:
# - Worker name comes from worker/wrangler.toml
# - Pages project defaults to the same name as the Worker
#
# You can override any of these:
#   PROJECT_NAME=... D1_NAME=... R2_BUCKET=... KV_TITLE=... ./setup.sh
WORKER_NAME_FROM_TOML="$(grep -oP '^name\s*=\s*"\K[^"]+' "$WORKER_DIR/wrangler.toml" 2>/dev/null || echo "")"
PROJECT_NAME="${PROJECT_NAME:-${WORKER_NAME_FROM_TOML:-receipt-vault}}"
D1_NAME="${D1_NAME:-$PROJECT_NAME}"
R2_BUCKET="${R2_BUCKET:-${PROJECT_NAME}-images}"
KV_TITLE="${KV_TITLE:-RATE_LIMIT}"

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${AMBER}  ██╗   ██╗ █████╗ ██╗   ██╗██╗  ████████╗${RESET}"
echo -e "${BOLD}${AMBER}  ██║   ██║██╔══██╗██║   ██║██║  ╚══██╔══╝${RESET}"
echo -e "${BOLD}${AMBER}  ██║   ██║███████║██║   ██║██║     ██║   ${RESET}"
echo -e "${BOLD}${AMBER}  ╚██╗ ██╔╝██╔══██║██║   ██║██║     ██║   ${RESET}"
echo -e "${BOLD}${AMBER}   ╚████╔╝ ██║  ██║╚██████╔╝███████╗██║   ${RESET}"
echo -e "${BOLD}${AMBER}    ╚═══╝  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝   ${RESET}"
echo ""
echo -e "  Receipt Vault — Setup & Deployment"
echo -e "  ${DIM}This script will deploy everything to Cloudflare in ~5 minutes.${RESET}"
echo ""

# ── Step 1: Check prerequisites ───────────────────────────────────────────────
step "Checking prerequisites"

command -v node &>/dev/null || die "Node.js is not installed. Get it at https://nodejs.org"
NODE_VER=$(node -e "process.stdout.write(process.version)")
info "Node.js $NODE_VER"

# Install/update wrangler if needed
if ! command -v wrangler &>/dev/null && ! npx --yes wrangler --version &>/dev/null; then
  info "Installing Wrangler CLI..."
  npm install -g wrangler
fi

WRANGLER="npx wrangler"
WRANGLER_VER=$($WRANGLER --version 2>/dev/null | head -1 || echo "unknown")
info "Wrangler $WRANGLER_VER"

# Wrangler writes debug logs under ~/.wrangler by default. In some sandboxed
# environments (like certain IDE runners), writing outside the workspace can
# fail with EPERM. Pin Wrangler's home into the project to keep it writable.
export WRANGLER_HOME="${WRANGLER_HOME:-$SCRIPT_DIR/.wrangler}"
ok "Prerequisites satisfied"

# ── Step 2: Install worker dependencies ───────────────────────────────────────
step "Installing Worker dependencies"
cd "$WORKER_DIR"
npm install --silent
ok "Dependencies installed"

# ── Step 3: Cloudflare login ──────────────────────────────────────────────────
step "Cloudflare authentication"
info "Opening browser for Cloudflare login (skip if already authenticated)..."
$WRANGLER login
ok "Authenticated with Cloudflare"

# ── Step 4: Create D1 database ────────────────────────────────────────────────
step "Creating D1 database"

# Ensure the D1 database exists even if wrangler.toml already has an ID.
# This prevents stale IDs after running destroy.sh.
CURRENT_DB_ID="$(grep -oE 'database_id\s*=\s*"[a-f0-9-]+"' "$WORKER_DIR/wrangler.toml" | head -1 | sed 's/.*"\(.*\)"/\1/' || true)"
DB_ID="$CURRENT_DB_ID"

DB_ID_FROM_LIST=$($WRANGLER d1 list --json 2>/dev/null \
  | python3 -c "import sys,json; dbs=json.load(sys.stdin); print(next((d['uuid'] for d in dbs if d['name']=='$D1_NAME'), ''))" 2>/dev/null || echo "")

if [[ -n "$DB_ID_FROM_LIST" ]]; then
  DB_ID="$DB_ID_FROM_LIST"
  info "Database '$D1_NAME' exists — using ID: ${DB_ID:0:8}…"
else
  info "Creating D1 database '$D1_NAME'..."
  D1_OUTPUT=$($WRANGLER d1 create "$D1_NAME" 2>&1)
  DB_ID=$(echo "$D1_OUTPUT" | grep 'database_id' | sed 's/.*database_id = "\(.*\)".*/\1/')
fi

if [[ -z "${DB_ID:-}" ]]; then
  echo -e "${AMBER}  Could not determine D1 database ID automatically.${RESET}"
  echo -e "  Run: ${BOLD}$WRANGLER d1 list${RESET} — then paste the ID for '$D1_NAME' below:"
  read -r -p "  Database ID: " DB_ID
fi

if grep -q "REPLACE_WITH_YOUR_D1_DATABASE_ID" "$WORKER_DIR/wrangler.toml"; then
  sed -i.bak "s/REPLACE_WITH_YOUR_D1_DATABASE_ID/$DB_ID/" "$WORKER_DIR/wrangler.toml"
else
  sed -i.bak -E "s/database_id[[:space:]]*=[[:space:]]*\"[a-f0-9-]+\"/database_id = \"$DB_ID\"/" "$WORKER_DIR/wrangler.toml"
fi
rm -f "$WORKER_DIR/wrangler.toml.bak"

ok "D1 database ready"

# ── Step 5: Create R2 bucket ──────────────────────────────────────────────────
step "Creating R2 bucket"
if $WRANGLER r2 bucket list 2>/dev/null | grep -q "$R2_BUCKET"; then
  info "Bucket '$R2_BUCKET' already exists — skipping"
else
  $WRANGLER r2 bucket create "$R2_BUCKET"
fi
ok "R2 bucket ready"

# ── Step 5b: Create KV namespace for rate limiting ────────────────────────────
step "Creating KV namespace for login rate limiting"

CURRENT_KV_ID="$(grep -oE '^id\s*=\s*"[a-f0-9]+"' "$WORKER_DIR/wrangler.toml" | head -1 | sed 's/.*"\(.*\)"/\1/' || true)"
KV_ID="$CURRENT_KV_ID"

# Ensure the KV namespace exists even if wrangler.toml already has an ID.
KV_ID_FROM_LIST=$($WRANGLER kv namespace list 2>/dev/null \
  | python3 -c "import sys,json; ns=json.load(sys.stdin); print(next((n['id'] for n in ns if n.get('title','').endswith('$KV_TITLE')), ''))" 2>/dev/null || echo "")

if [[ -n "$KV_ID_FROM_LIST" ]]; then
  KV_ID="$KV_ID_FROM_LIST"
  info "KV namespace '$KV_TITLE' exists — using ID: ${KV_ID:0:8}…"
else
  info "Creating KV namespace '$KV_TITLE'..."
  KV_OUTPUT=$($WRANGLER kv namespace create "$KV_TITLE" 2>&1)
  echo "$KV_OUTPUT"
  KV_ID=$(echo "$KV_OUTPUT" | grep -oE 'id = "[a-f0-9]+"' | sed 's/id = "//;s/"//')
fi

if [[ -z "${KV_ID:-}" ]]; then
  echo -e "${AMBER}  Could not determine KV namespace ID automatically.${RESET}"
  echo -e "  Run: ${BOLD}$WRANGLER kv namespace list${RESET} — then paste the ID for '$KV_TITLE' below:"
  read -r -p "  KV Namespace ID: " KV_ID
fi

if grep -q "REPLACE_WITH_RATE_LIMIT_KV_ID" "$WORKER_DIR/wrangler.toml"; then
  sed -i.bak "s/REPLACE_WITH_RATE_LIMIT_KV_ID/$KV_ID/" "$WORKER_DIR/wrangler.toml"
else
  sed -i.bak -E "s/^id[[:space:]]*=[[:space:]]*\"[a-f0-9]+\"/id = \"$KV_ID\"/" "$WORKER_DIR/wrangler.toml"
fi
rm -f "$WORKER_DIR/wrangler.toml.bak"

ok "Rate-limit KV namespace ready"

# ── Step 6: Run database migration ────────────────────────────────────────────
step "Running database migration"
$WRANGLER d1 execute "$D1_NAME" --remote --file="$WORKER_DIR/schema.sql"
ok "Schema applied"

# ── Step 7: Set secrets ───────────────────────────────────────────────────────
step "Setting Worker secrets"
echo ""
echo -e "  You need to provide a few secrets. They are stored encrypted in Cloudflare"
echo -e "  and never written to disk here.\n"

echo -e "  ${BOLD}1. AI Provider${RESET}"
echo -e "  Which API do you want to use for receipt extraction?\n"
echo -e "    ${BOLD}1)${RESET} Anthropic direct  ${DIM}(https://console.anthropic.com)${RESET}"
echo -e "    ${BOLD}2)${RESET} OpenRouter        ${DIM}(https://openrouter.ai/keys — supports many models)${RESET}"
echo -e "    ${BOLD}3)${RESET} Mistral OCR       ${DIM}(https://console.mistral.ai — mistral-ocr-latest)${RESET}"
echo ""
read -r -p "  Choice [1/2/3]: " PROVIDER_CHOICE

if [[ "$PROVIDER_CHOICE" == "2" ]]; then
  echo ""
  echo -e "  ${BOLD}OpenRouter API Key${RESET}"
  echo -e "  ${DIM}Get yours at https://openrouter.ai/keys${RESET}"
  echo -e "  ${DIM}Default model: anthropic/claude-sonnet-4-5 (change OPENROUTER_MODEL in worker/src/extract.ts)${RESET}"
  read -r -s -p "  OPENROUTER_API_KEY: " OR_KEY
  echo ""
  echo "$OR_KEY" | $WRANGLER secret put OPENROUTER_API_KEY
  ok "OPENROUTER_API_KEY set"
  # Disable unused providers
  echo "unused" | $WRANGLER secret put ANTHROPIC_API_KEY 2>/dev/null || true
  echo "unused" | $WRANGLER secret put MISTRAL_API_KEY 2>/dev/null || true
elif [[ "$PROVIDER_CHOICE" == "3" ]]; then
  echo ""
  echo -e "  ${BOLD}Mistral API Key${RESET}"
  echo -e "  ${DIM}Get yours at https://console.mistral.ai/api-keys${RESET}"
  echo -e "  ${DIM}Uses mistral-ocr-latest for text extraction + mistral-small-latest for parsing${RESET}"
  read -r -s -p "  MISTRAL_API_KEY: " MISTRAL_KEY
  echo ""
  echo "$MISTRAL_KEY" | $WRANGLER secret put MISTRAL_API_KEY
  ok "MISTRAL_API_KEY set"
  # Disable unused providers
  echo "unused" | $WRANGLER secret put ANTHROPIC_API_KEY 2>/dev/null || true
  echo "unused" | $WRANGLER secret put OPENROUTER_API_KEY 2>/dev/null || true
else
  echo ""
  echo -e "  ${BOLD}Anthropic API Key${RESET}"
  echo -e "  ${DIM}Get yours at https://console.anthropic.com/settings/api-keys${RESET}"
  read -r -s -p "  ANTHROPIC_API_KEY: " ANTHROPIC_KEY
  echo ""
  echo "$ANTHROPIC_KEY" | $WRANGLER secret put ANTHROPIC_API_KEY
  ok "ANTHROPIC_API_KEY set"
  # Disable unused providers
  echo "unused" | $WRANGLER secret put OPENROUTER_API_KEY 2>/dev/null || true
  echo "unused" | $WRANGLER secret put MISTRAL_API_KEY 2>/dev/null || true
fi

echo ""
echo -e "  ${BOLD}2. App Passphrase${RESET}"
echo -e "  ${DIM}This is what you'll type to log in to the app. Choose something strong.${RESET}"
read -r -s -p "  AUTH_SECRET (passphrase): " AUTH_SECRET
echo ""
echo "$AUTH_SECRET" | $WRANGLER secret put AUTH_SECRET
ok "AUTH_SECRET set"

echo ""
echo -e "  ${BOLD}3. JWT Signing Secret${RESET}"
echo -e "  ${DIM}A random string for signing login tokens. Generating one automatically...${RESET}"
JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "$JWT_SECRET" | $WRANGLER secret put JWT_SECRET
ok "JWT_SECRET set (auto-generated)"

echo ""
echo -e "  ${BOLD}4. Data Encryption Key${RESET}"
echo -e "  ${DIM}AES-256-GCM key for encrypting sensitive receipt fields at rest. Generating automatically...${RESET}"
ENCRYPTION_KEY=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "$ENCRYPTION_KEY" | $WRANGLER secret put ENCRYPTION_KEY
ok "ENCRYPTION_KEY set (auto-generated)"

# ── Step 8: Deploy Worker ─────────────────────────────────────────────────────
step "Deploying Worker"
cd "$WORKER_DIR"

DEPLOY_OUTPUT=$($WRANGLER deploy 2>&1)
echo "$DEPLOY_OUTPUT"

WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)

if [[ -z "${WORKER_URL:-}" ]]; then
  echo ""
  echo -e "${AMBER}  Could not extract Worker URL automatically from the output above.${RESET}"
  echo -e "  Paste it here (format: https://receipt-vault.YOUR-ACCOUNT.workers.dev):"
  read -r -p "  Worker URL: " WORKER_URL
fi

ok "Worker deployed at $WORKER_URL"

# ── Step 9: Update frontend config ────────────────────────────────────────────
step "Configuring frontend"
cat > "$FRONTEND_DIR/config.js" <<EOF
/**
 * Receipt Vault — Frontend Configuration
 * Auto-generated by setup.sh — do not edit manually.
 */
window.VAULT_CONFIG = {
  API_URL: '$WORKER_URL',
  // Optional: Turnstile bot protection (set this manually if you enable it)
  // TURNSTILE_SITE_KEY: '0x4AAAAAA....',
}
EOF
ok "config.js updated with Worker URL"

# ── Step 10: Deploy frontend to Cloudflare Pages ──────────────────────────────
step "Deploying frontend to Cloudflare Pages"
cd "$SCRIPT_DIR"

# Detect account ID from wrangler.toml so Pages commands hit the correct account
CF_ACCOUNT_ID=$(grep -oP 'account_id\s*=\s*"\K[^"]+' "$WORKER_DIR/wrangler.toml" 2>/dev/null || echo "")
PAGES_ENV=()
if [[ -n "$CF_ACCOUNT_ID" ]]; then
  export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
  info "Using account $CF_ACCOUNT_ID"
fi

# Pre-create the Pages project so the deploy command has nothing interactive to ask
info "Creating Pages project (skipped if already exists)..."
$WRANGLER pages project create "$PROJECT_NAME" --production-branch=main 2>/dev/null || true

# Now deploy — project exists so no interactive prompt is needed
PAGES_OUTPUT_FILE="$(mktemp -t receipt-vault-pages.XXXXXX)"
trap 'rm -f "$PAGES_OUTPUT_FILE"' EXIT
$WRANGLER pages deploy "$FRONTEND_DIR" --project-name "$PROJECT_NAME" --branch=main --commit-dirty=true 2>&1 | tee "$PAGES_OUTPUT_FILE"

PAGES_URL=$(grep -oE "https://[a-zA-Z0-9._-]+\.pages\.dev" "$PAGES_OUTPUT_FILE" | head -1)

# Prefer the stable production origin (https://<project>.pages.dev) for CORS.
# Wrangler deploy output is often a per-deployment preview URL like:
#   https://<hash>.<project>.pages.dev
# which changes every deploy. We strip the leading hash if present.
PAGES_ORIGIN="$PAGES_URL"
if [[ "$PAGES_ORIGIN" =~ ^https://[a-f0-9]+\.(.+\.pages\.dev)$ ]]; then
  PAGES_ORIGIN="https://${BASH_REMATCH[1]}"
fi

# ── Step 11: Lock CORS to the Pages origin ────────────────────────────────────
step "Locking API to Pages origin"
if [[ -n "${PAGES_ORIGIN:-}" ]]; then
  info "Setting ALLOWED_ORIGIN to $PAGES_ORIGIN..."
  # Ensure Wrangler can infer the Worker name from worker/wrangler.toml
  cd "$WORKER_DIR"
  echo "$PAGES_ORIGIN" | $WRANGLER secret put ALLOWED_ORIGIN

  info "Redeploying Worker with locked CORS origin..."
  $WRANGLER deploy
  ok "CORS locked to $PAGES_ORIGIN"
else
  echo -e "${AMBER}  Could not detect Pages URL. CORS is open (anyone who knows the Worker URL can make API requests).${RESET}"
  echo -e "  After deployment, run: echo 'https://your-pages-url.pages.dev' | npx wrangler secret put ALLOWED_ORIGIN"
  echo -e "  Then redeploy: cd scanner/worker && npx wrangler deploy"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}${GREEN}  ✓ Receipt Vault is live!${RESET}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
if [[ -n "${PAGES_URL:-}" ]]; then
  echo -e "  ${BOLD}App URL:${RESET}    $PAGES_URL"
  echo -e "  ${BOLD}App Origin:${RESET} $PAGES_ORIGIN"
fi
echo -e "  ${BOLD}Worker URL:${RESET} $WORKER_URL"
echo ""
echo -e "  ${DIM}On your phone: open the app URL → tap Share → Add to Home Screen${RESET}"
echo -e "  ${DIM}Log in with the passphrase you set above.${RESET}"
echo ""
