# Receipt Vault

A self-hosted PWA for scanning, extracting, and archiving receipts and invoices.  
Built on Cloudflare Pages + Workers + R2 + D1, powered by Claude Vision.

**Features**

- Scan paper receipts with your phone camera or upload PDFs/images
- Claude Vision extracts structured data (date, vendor, category, amounts, HST)
- Browse, search, and filter all archived receipts
- Edit extracted data when Claude gets something wrong
- Export any date range as an Excel file (with clickable links back to the app)
- Works offline as a PWA — add to Home Screen on iOS/Android
- Single-user passphrase authentication with JWT sessions
- All data stored in Cloudflare infrastructure (free tier covers personal use)

---

## Quick start (recommended)

One script does everything: creates Cloudflare resources, sets secrets, and deploys.

```bash
git clone https://github.com/YOUR/receipt-vault
cd receipt-vault/scanner
chmod +x setup.sh
./setup.sh
```

### Customizing resource names (optional)

By default, `setup.sh` creates Cloudflare resources with generalized names based on the Worker name in `worker/wrangler.toml`.
You can override names via environment variables:

```bash
cd scanner
PROJECT_NAME=my-vault D1_NAME=my-vault R2_BUCKET=my-vault-images KV_TITLE=RATE_LIMIT ./setup.sh
```

### Reset / start from scratch (destroys all data)

This project includes a destructive cleanup script:

```bash
cd scanner
chmod +x destroy.sh
./destroy.sh
```

It deletes the Pages project, Worker, D1 database, R2 bucket, and KV namespace created by `setup.sh`.
You can also override names the same way:

```bash
PROJECT_NAME=my-vault D1_NAME=my-vault R2_BUCKET=my-vault-images KV_TITLE=RATE_LIMIT ./destroy.sh
```

The script will ask for:
1. Your AI provider choice (Anthropic or OpenRouter) + API key
2. A passphrase you'll use to log in to the app

Everything else (database, storage, encryption keys, JWT secret, rate-limit store) is created and configured automatically.

---

## Manual setup (for contributors / understanding what setup.sh does)

### Prerequisites

| Tool | Version |
|------|---------|
| [Node.js](https://nodejs.org/) | 18+ |
| [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) | auto-installed by setup.sh |
| [Cloudflare account](https://dash.cloudflare.com/sign-up) | free plan works |
| Anthropic or [OpenRouter](https://openrouter.ai) API key | pay-as-you-go |

### Step 1 — Install dependencies

```bash
cd worker && npm install
```

### Step 2 — Create Cloudflare resources

```bash
npx wrangler login

# D1 database
npx wrangler d1 create receipt-vault
# → Copy the database_id from the output into worker/wrangler.toml

# R2 bucket
npx wrangler r2 bucket create receipt-vault-images

# KV namespace (used for login rate limiting)
npx wrangler kv namespace create RATE_LIMIT
# → Copy the id from the output into worker/wrangler.toml
```

### Step 3 — Update `worker/wrangler.toml`

Replace the two placeholders with the real IDs you got above:

```toml
[[d1_databases]]
database_id = "PASTE_YOUR_D1_ID_HERE"

[[kv_namespaces]]
id = "PASTE_YOUR_KV_ID_HERE"
```

> Tip: this repo includes `worker/wrangler.example.toml` as a safe template for GitHub.
> Copy it to `worker/wrangler.toml` and fill in your IDs.

### Step 4 — Run database migration

```bash
npx wrangler d1 execute receipt-vault --remote --file=worker/schema.sql
```

### Step 5 — Set secrets

All secrets are stored encrypted in Cloudflare — never in files.

```bash
cd worker

# AI provider (pick one)
npx wrangler secret put ANTHROPIC_API_KEY
# or: npx wrangler secret put OPENROUTER_API_KEY

# Login passphrase
npx wrangler secret put AUTH_SECRET

# JWT signing key (generate: openssl rand -hex 32)
npx wrangler secret put JWT_SECRET

# AES-256-GCM key for field-level encryption of sensitive DB columns
# (generate: openssl rand -hex 32)
npx wrangler secret put ENCRYPTION_KEY

# CORS allowed origin — set AFTER you deploy Pages and know your Pages URL
# e.g. https://receipt-vault.pages.dev
npx wrangler secret put ALLOWED_ORIGIN
```

### Step 6 — Create `frontend/config.js`

This file is gitignored because it contains your live Worker URL.  
Copy the example and fill in your Worker URL:

```bash
cp frontend/config.example.js frontend/config.js
# Then edit it:
```

```js
window.VAULT_CONFIG = {
  API_URL: 'https://receipt-vault.YOUR-ACCOUNT.workers.dev',
}
```

### Step 7 — Deploy

```bash
# Deploy the Worker
cd worker && npx wrangler deploy

# Deploy the frontend to Cloudflare Pages
npx wrangler pages deploy frontend --project-name receipt-vault
```

---

## Gitignored files — what contributors need to know

| File / Pattern | Why gitignored | What to do |
|---|---|---|
| `frontend/config.js` | Contains your live Worker URL | Copy `frontend/config.example.js` → `frontend/config.js` and fill in your URL |
| `node_modules/` | Dependencies | Run `npm install` in root and `worker/` |
| `worker/.wrangler/` | Local Wrangler dev state | Auto-created on first `wrangler dev` |
| `*.bak` | Temp files from `sed -i.bak` in setup.sh | Safe to ignore |
| `.env*` | Any local env files | Use `wrangler secret put` for all secrets |

> **Secrets are never in files.** All sensitive values (`AUTH_SECRET`, `JWT_SECRET`, `ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, `ALLOWED_ORIGIN`) are stored as [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) — encrypted at rest, injected at runtime.

---

## Local development

```bash
# Terminal 1 — Worker API (http://localhost:8787)
cd worker && npx wrangler dev

# Terminal 2 — Frontend (any static server)
npx serve frontend -p 3000
```

Set `frontend/config.js` to `http://localhost:8787` while developing locally.

---

## Project structure

```
scanner/
├── setup.sh                    One-command setup + deploy
├── redeploy.sh                 Redeploy after code changes
│
├── frontend/                   PWA — deployed to Cloudflare Pages
│   ├── index.html              App shell (SPA)
│   ├── app.js                  All views, routing, API client
│   ├── style.css               Design system + component styles
│   ├── sw.js                   Service worker (offline caching)
│   ├── config.js               ← GITIGNORED: your Worker URL (auto-generated)
│   ├── config.example.js       Template for config.js
│   ├── _headers                Cloudflare Pages security headers
│   └── manifest.json           PWA manifest
│
└── worker/                     Cloudflare Worker — TypeScript API
    ├── src/
    │   ├── index.ts            Hono router + CORS + security headers
    │   ├── auth.ts             Passphrase login, JWT sign/verify, rate limiting
    │   ├── crypto.ts           AES-256-GCM field-level encryption helpers
    │   ├── receipts.ts         Receipt CRUD, image serving, stats
    │   ├── extract.ts          Claude Vision integration
    │   ├── export.ts           Excel export endpoint
    │   ├── r2.ts               R2 storage helpers
    │   └── types.ts            TypeScript interfaces
    ├── schema.sql              D1 database schema
    ├── wrangler.toml           Cloudflare config (placeholder IDs, no secrets)
    └── package.json
```

---

## Security

| Layer | What's in place |
|---|---|
| **Authentication** | Single passphrase → JWT (HS256, 7-day expiry). Constant-time comparison prevents timing attacks. |
| **Rate limiting** | 10 failed login attempts per IP per 15 min → 429. Tracked in Cloudflare KV. |
| **CORS** | Locked to an explicit allowlist via `ALLOWED_ORIGIN` secret (no reflect fallback). |
| **Data encryption** | Sensitive D1 columns (`vendor`, `notes`, `invoice_number`, `original_filename`) encrypted at rest with AES-256-GCM. Key derived from `ENCRYPTION_KEY` secret via HKDF-SHA-256. |
| **Image privacy** | R2 bucket is private. Images are streamed through the authenticated Worker — no public R2 URLs. |
| **Security headers** | `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` on every response. |
| **CSP** | Content Security Policy on Pages responses restricts script/style/font/connect sources. |
| **Secrets** | All credentials stored as Cloudflare Worker secrets — never in code or config files. |

### Important notes (read this)

- **CORS is not access control.** Setting `ALLOWED_ORIGIN` stops *other websites* from calling your API from a browser. It does **not** make the site private and it does **not** stop someone from visiting your Pages URL.
- **Use the stable Pages production URL**, not a per-deployment preview URL.
  - Stable: `https://<your-project>.pages.dev`
  - Preview (changes every deploy): `https://<hash>.<your-project>.pages.dev`
- **If the app is public, brute force is still possible** (rate limiting helps, but a distributed attacker can try from many IPs). Use a strong passphrase and strongly consider Cloudflare Access + Turnstile.

### Lock CORS to the stable Pages origin

Set `ALLOWED_ORIGIN` to your **production** Pages origin (stable):

```bash
cd worker
npx wrangler secret put ALLOWED_ORIGIN
```

Example value:

```text
https://receipt-vault.pages.dev
```

You can provide a comma-separated list for local dev:

```text
https://receipt-vault.pages.dev,http://localhost:3000
```

### Add bot protection on login (Turnstile)

This project supports optional Turnstile verification on `/auth/login`.

1. Create a Turnstile widget in Cloudflare (Zero Trust / Turnstile).
2. Set the secrets/config:
   - Worker secret: `TURNSTILE_SECRET` (required to enforce Turnstile server-side)
   - Frontend config: `TURNSTILE_SITE_KEY` (shows the widget on the login page)

```bash
cd worker
npx wrangler secret put TURNSTILE_SECRET
```

In `frontend/config.js` (generated, gitignored), add:

```js
window.VAULT_CONFIG = {
  API_URL: 'https://...workers.dev',
  TURNSTILE_SITE_KEY: '0x4AAAAAA....',
}
```

### Make it “private like Tailscale” (Cloudflare Access)

If you want the app to be **unreachable** to the public internet (recommended), put the Pages site behind **Cloudflare Access**:

- Create an Access application for your Pages domain (e.g. `https://receipt-vault.pages.dev`)
- Add a policy that allows only your identity (email / Google / GitHub)

This blocks anonymous visitors before they ever see the login page.

### About `workers.dev` exposure

Without a custom domain/route, your Worker API is typically reachable on `*.workers.dev`.
To reduce the exposed surface:

- Keep auth strong (passphrase, rate limiting, Turnstile)
- Consider protecting the Worker hostname with Access as well (if your plan supports it)
- If you later add a custom domain, you can disable `workers_dev` and route traffic only through that domain

---

## API reference

All `/api/*` routes require `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/login` | Exchange passphrase for JWT |
| `POST` | `/api/receipts/extract` | Upload image → Claude extraction → temp R2 key |
| `POST` | `/api/receipts` | Save receipt (finalises temp key from extract step) |
| `GET`  | `/api/receipts` | List receipts (`from`, `to`, `category`, `limit`, `offset`) |
| `GET`  | `/api/receipts/:id` | Get single receipt |
| `PUT`  | `/api/receipts/:id` | Update receipt fields |
| `DELETE` | `/api/receipts/:id` | Soft-delete receipt |
| `GET`  | `/api/receipts/:id/image` | Stream receipt image from R2 |
| `GET`  | `/api/stats` | Dashboard stats (this month, all-time, top categories) |
| `GET`  | `/api/export` | Export receipts as JSON (`from`, `to`, `category`) |
| `GET`  | `/health` | Health check (public) |

---

## Cost estimate

| Service | Free tier | Typical monthly (personal use) |
|---------|-----------|-------------------------------|
| Cloudflare Pages | Unlimited | Free |
| Cloudflare Workers | 100k req/day | Free |
| Cloudflare D1 | 5 GB, 5M reads/day | Free |
| Cloudflare R2 | 10 GB storage, 10M reads | Free |
| Cloudflare KV | 100k reads/day | Free |
| Anthropic Claude | — | ~$0.30 USD |
| **Total** | | **~$0.30/month** |

---

## License

MIT
