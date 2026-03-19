#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Receipt Vault — Destroy everything deployed by setup.sh
#
# WARNING:
# - This deletes Cloudflare resources (data loss).
# - It is intended to reset your Cloudflare account to a clean slate for this app.
#
# Usage:
#   chmod +x destroy.sh
#   ./destroy.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
AMBER='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

ok()    { echo -e "${GREEN}✓ $*${RESET}"; }
info()  { echo -e "${DIM}  $*${RESET}"; }
warn()  { echo -e "${AMBER}⚠ $*${RESET}"; }
die()   { echo -e "${RED}✗ Error: $*${RESET}" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$SCRIPT_DIR/worker"

WRANGLER="npx wrangler"

# In some sandboxed IDE terminals, writing to your real home directory can fail.
# Pin $HOME to a workspace-local directory for the duration of this script.
SANDBOX_HOME="$SCRIPT_DIR/.home"
mkdir -p "$SANDBOX_HOME"
export HOME="$SANDBOX_HOME"

# Names default to the same conventions as setup.sh.
# You can override any of these:
#   PROJECT_NAME=... D1_NAME=... R2_BUCKET=... KV_TITLE=... WORKER_NAME=... ./destroy.sh
WORKER_NAME_FROM_TOML="$(grep -oP '^name\s*=\s*"\K[^"]+' "$WORKER_DIR/wrangler.toml" 2>/dev/null || echo "")"
WORKER_NAME="${WORKER_NAME:-${WORKER_NAME_FROM_TOML:-receipt-vault}}"
PROJECT_NAME="${PROJECT_NAME:-$WORKER_NAME}"
D1_NAME="${D1_NAME:-$PROJECT_NAME}"
R2_BUCKET="${R2_BUCKET:-${PROJECT_NAME}-images}"
KV_TITLE="${KV_TITLE:-RATE_LIMIT}"

echo ""
echo -e "${BOLD}${RED}DANGER ZONE${RESET}"
echo -e "${BOLD}${RED}This will delete ALL Receipt Vault data in Cloudflare.${RESET}"
echo ""
echo -e "${BOLD}Resources to delete:${RESET}"
echo -e "  - Pages project: ${BOLD}$PROJECT_NAME${RESET}"
echo -e "  - Worker: ${BOLD}$WORKER_NAME${RESET}"
echo -e "  - D1 database: ${BOLD}$D1_NAME${RESET}"
echo -e "  - R2 bucket: ${BOLD}$R2_BUCKET${RESET}"
echo -e "  - KV namespace: ${BOLD}$KV_TITLE${RESET}"
echo ""
read -r -p "Type DESTROY to continue: " CONFIRM
[[ "$CONFIRM" == "DESTROY" ]] || die "Cancelled."

info "Ensuring you are authenticated with Cloudflare..."
$WRANGLER login

# Delete Worker
warn "Deleting Worker..."
(
  cd "$WORKER_DIR"
  $WRANGLER delete --name "$WORKER_NAME" --force 2>/dev/null || true
)
ok "Worker delete requested (if it existed)"

# Delete Pages project
warn "Deleting Pages project..."
$WRANGLER pages project delete "$PROJECT_NAME" --yes 2>/dev/null || true
ok "Pages project delete requested (if it existed)"

# Delete D1 database
warn "Deleting D1 database..."
$WRANGLER d1 delete "$D1_NAME" --skip-confirmation 2>/dev/null || true
ok "D1 delete requested (if it existed)"

# Delete R2 bucket (must be empty)
warn "Deleting R2 bucket (must be empty)..."
if $WRANGLER r2 bucket delete "$R2_BUCKET" 2>/dev/null; then
  ok "R2 bucket deleted"
else
  warn "Could not delete R2 bucket. If it is not empty, empty it first in the Cloudflare dashboard, then re-run destroy.sh."
fi

# Delete KV namespace
warn "Deleting KV namespace..."
KV_ID=$($WRANGLER kv namespace list 2>/dev/null \
  | python3 -c "import sys,json; ns=json.load(sys.stdin); print(next((n['id'] for n in ns if n.get('title','').endswith('$KV_TITLE')), ''))" 2>/dev/null || echo "")
if [[ -n "${KV_ID:-}" ]]; then
  $WRANGLER kv namespace delete --namespace-id "$KV_ID" 2>/dev/null || true
  ok "KV namespace deleted"
else
  ok "KV namespace not found (already deleted)"
fi

echo ""
ok "Destroy complete (best-effort)."
echo -e "${DIM}If anything remains, it will usually be the R2 bucket (not empty) or a renamed project.${RESET}"

