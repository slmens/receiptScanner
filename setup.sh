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
ok "Prerequisites satisfied"

# ── Step 2: Install worker dependencies ───────────────────────────────────────
step "Installing Worker dependencies"
cd "$WORKER_DIR"
npm install --silent
ok "Dependencies installed"

# ── Step 3: Cloudflare login ──────────────────────────────────────────────────
step "Cloudflare authentication"
info "Opening browser for Cloudflare login (skip if already authenticated)..."
$WRANGLER login || true
ok "Authenticated with Cloudflare"

# ── Step 4: Create D1 database ────────────────────────────────────────────────
step "Creating D1 database"

# Check if the database_id in wrangler.toml is still a placeholder
if grep -q "REPLACE_WITH_YOUR_D1_DATABASE_ID" "$WORKER_DIR/wrangler.toml"; then
  # Need to create the database and inject the ID
  if $WRANGLER d1 list 2>/dev/null | grep -q "receipt-vault"; then
    info "Database 'receipt-vault' already exists — extracting ID..."
    DB_ID=$($WRANGLER d1 list --json 2>/dev/null \
      | python3 -c "import sys,json; dbs=json.load(sys.stdin); print(next(d['uuid'] for d in dbs if d['name']=='receipt-vault'))" 2>/dev/null || echo "")
  else
    info "Creating D1 database 'receipt-vault'..."
    D1_OUTPUT=$($WRANGLER d1 create receipt-vault 2>&1)
    DB_ID=$(echo "$D1_OUTPUT" | grep 'database_id' | sed 's/.*database_id = "\(.*\)".*/\1/')
  fi

  if [[ -z "${DB_ID:-}" ]]; then
    echo -e "${AMBER}  Could not extract database ID automatically.${RESET}"
    echo -e "  Run: ${BOLD}$WRANGLER d1 list${RESET} — then paste the ID for 'receipt-vault' below:"
    read -r -p "  Database ID: " DB_ID
  fi

  sed -i.bak "s/REPLACE_WITH_YOUR_D1_DATABASE_ID/$DB_ID/" "$WORKER_DIR/wrangler.toml"
  rm -f "$WORKER_DIR/wrangler.toml.bak"
  info "Injected database_id: ${DB_ID:0:8}…"
else
  info "Database already configured in wrangler.toml — skipping"
fi

ok "D1 database ready"

# ── Step 5: Create R2 bucket ──────────────────────────────────────────────────
step "Creating R2 bucket"
if $WRANGLER r2 bucket list 2>/dev/null | grep -q "receipt-vault-images"; then
  info "Bucket 'receipt-vault-images' already exists — skipping"
else
  $WRANGLER r2 bucket create receipt-vault-images
fi
ok "R2 bucket ready"

# ── Step 5b: Create KV namespace for rate limiting ────────────────────────────
step "Creating KV namespace for login rate limiting"

if grep -q "REPLACE_WITH_RATE_LIMIT_KV_ID" "$WORKER_DIR/wrangler.toml"; then
  if $WRANGLER kv namespace list 2>/dev/null | grep -q '"RATE_LIMIT"'; then
    info "KV namespace 'RATE_LIMIT' already exists — extracting ID..."
    KV_ID=$($WRANGLER kv namespace list --json 2>/dev/null \
      | python3 -c "import sys,json; ns=json.load(sys.stdin); print(next(n['id'] for n in ns if n['title'].endswith('RATE_LIMIT')))" 2>/dev/null || echo "")
  else
    info "Creating KV namespace 'RATE_LIMIT'..."
    KV_OUTPUT=$($WRANGLER kv namespace create RATE_LIMIT 2>&1)
    echo "$KV_OUTPUT"
    KV_ID=$(echo "$KV_OUTPUT" | grep -oE 'id = "[a-f0-9]+"' | sed 's/id = "//;s/"//')
  fi

  if [[ -z "${KV_ID:-}" ]]; then
    echo -e "${AMBER}  Could not extract KV namespace ID automatically.${RESET}"
    echo -e "  Run: ${BOLD}$WRANGLER kv namespace list${RESET} — then paste the ID for 'RATE_LIMIT' below:"
    read -r -p "  KV Namespace ID: " KV_ID
  fi

  sed -i.bak "s/REPLACE_WITH_RATE_LIMIT_KV_ID/$KV_ID/" "$WORKER_DIR/wrangler.toml"
  rm -f "$WORKER_DIR/wrangler.toml.bak"
  info "Injected KV namespace ID: ${KV_ID:0:8}…"
else
  info "KV namespace already configured in wrangler.toml — skipping"
fi

ok "Rate-limit KV namespace ready"

# ── Step 6: Run database migration ────────────────────────────────────────────
step "Running database migration"
$WRANGLER d1 execute receipt-vault --remote --file="$WORKER_DIR/schema.sql"
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
echo ""
read -r -p "  Choice [1/2]: " PROVIDER_CHOICE

if [[ "$PROVIDER_CHOICE" == "2" ]]; then
  echo ""
  echo -e "  ${BOLD}OpenRouter API Key${RESET}"
  echo -e "  ${DIM}Get yours at https://openrouter.ai/keys${RESET}"
  echo -e "  ${DIM}Default model: anthropic/claude-sonnet-4-5 (change OPENROUTER_MODEL in worker/src/extract.ts)${RESET}"
  read -r -s -p "  OPENROUTER_API_KEY: " OR_KEY
  echo ""
  echo "$OR_KEY" | $WRANGLER secret put OPENROUTER_API_KEY --env=""
  ok "OPENROUTER_API_KEY set"
  # Set Anthropic key to empty so it doesn't accidentally take precedence
  echo "unused" | $WRANGLER secret put ANTHROPIC_API_KEY --env="" 2>/dev/null || true
else
  echo ""
  echo -e "  ${BOLD}Anthropic API Key${RESET}"
  echo -e "  ${DIM}Get yours at https://console.anthropic.com/settings/api-keys${RESET}"
  read -r -s -p "  ANTHROPIC_API_KEY: " ANTHROPIC_KEY
  echo ""
  echo "$ANTHROPIC_KEY" | $WRANGLER secret put ANTHROPIC_API_KEY --env=""
  ok "ANTHROPIC_API_KEY set"
fi

echo ""
echo -e "  ${BOLD}2. App Passphrase${RESET}"
echo -e "  ${DIM}This is what you'll type to log in to the app. Choose something strong.${RESET}"
read -r -s -p "  AUTH_SECRET (passphrase): " AUTH_SECRET
echo ""
echo "$AUTH_SECRET" | $WRANGLER secret put AUTH_SECRET --env=""
ok "AUTH_SECRET set"

echo ""
echo -e "  ${BOLD}3. JWT Signing Secret${RESET}"
echo -e "  ${DIM}A random string for signing login tokens. Generating one automatically...${RESET}"
JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "$JWT_SECRET" | $WRANGLER secret put JWT_SECRET --env=""
ok "JWT_SECRET set (auto-generated)"

echo ""
echo -e "  ${BOLD}4. Data Encryption Key${RESET}"
echo -e "  ${DIM}AES-256-GCM key for encrypting sensitive receipt fields at rest. Generating automatically...${RESET}"
ENCRYPTION_KEY=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "$ENCRYPTION_KEY" | $WRANGLER secret put ENCRYPTION_KEY --env=""
ok "ENCRYPTION_KEY set (auto-generated)"

# ── Step 8: Deploy Worker ─────────────────────────────────────────────────────
step "Deploying Worker"
cd "$WORKER_DIR"

DEPLOY_OUTPUT=$($WRANGLER deploy --env="" 2>&1)
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
}
EOF
ok "config.js updated with Worker URL"

# ── Step 10: Deploy frontend to Cloudflare Pages ──────────────────────────────
step "Deploying frontend to Cloudflare Pages"
cd "$SCRIPT_DIR"

# Pre-create the Pages project so the deploy command has nothing interactive to ask
info "Creating Pages project (skipped if already exists)..."
$WRANGLER pages project create receipt-vault --production-branch=main 2>/dev/null || true

# Now deploy — project exists so no interactive prompt is needed
$WRANGLER pages deploy "$FRONTEND_DIR" --project-name receipt-vault --branch=main --commit-dirty=true 2>&1 | tee /tmp/pages_output.txt

PAGES_URL=$(grep -oE 'https://receipt-vault[a-zA-Z0-9._-]*\.pages\.dev' /tmp/pages_output.txt | head -1)

# ── Step 11: Lock CORS to the Pages origin ────────────────────────────────────
step "Locking API to Pages origin"
if [[ -n "${PAGES_URL:-}" ]]; then
  info "Setting ALLOWED_ORIGIN to $PAGES_URL..."
  echo "$PAGES_URL" | $WRANGLER secret put ALLOWED_ORIGIN --env="" 2>&1 | grep -v "^$" || true

  info "Redeploying Worker with locked CORS origin..."
  cd "$WORKER_DIR"
  $WRANGLER deploy --env="" > /dev/null 2>&1
  ok "CORS locked to $PAGES_URL"
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
fi
echo -e "  ${BOLD}Worker URL:${RESET} $WORKER_URL"
echo ""
echo -e "  ${DIM}On her phone: open the app URL → tap Share → Add to Home Screen${RESET}"
echo -e "  ${DIM}Log in with the passphrase you set above.${RESET}"
echo ""
