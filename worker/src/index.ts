import { Hono } from 'hono'
import { logger } from 'hono/logger'

import type { Env, Variables } from './types'
import { authMiddleware, loginHandler } from './auth'
import {
  createReceiptHandler,
  discardPendingHandler,
  deleteReceiptHandler,
  extractReceiptHandler,
  getReceiptHandler,
  getStatsHandler,
  importEmailHandler,
  listReceiptsHandler,
  serveImageHandler,
  updateReceiptHandler,
} from './receipts'
import { exportHandler } from './export'

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── Global middleware ──────────────────────────────────────────────────────────

app.use('*', logger())

// CORS: explicit allowlist only (no reflect fallback).
// Set ALLOWED_ORIGIN to your stable Pages production origin, e.g.:
//   https://receipt-vault.pages.dev
// You may also provide a comma-separated list for dev, e.g.:
//   https://receipt-vault.pages.dev,http://localhost:3000
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin')
  const raw = (c.env.ALLOWED_ORIGIN ?? '').trim()
  const allowed = new Set(
    raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  )

  // Always pass through non-browser requests (no Origin header), e.g. curl.
  if (!origin) {
    await next()
    return
  }

  // Reject cross-origin requests when allowlist isn't configured.
  if (allowed.size === 0) {
    return c.json({ error: 'CORS is not configured' }, 403)
  }

  if (!allowed.has(origin)) {
    // Do not reflect untrusted origins. Browsers will block without CORS headers.
    return c.json({ error: 'Origin not allowed' }, 403)
  }

  // Handle preflight
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
      },
    })
  }

  await next()
  c.res.headers.set('Access-Control-Allow-Origin', origin)
  c.res.headers.set('Vary', 'Origin')
  return c.res
})

// Security headers on every response
app.use('*', async (c, next) => {
  await next()
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('X-Frame-Options', 'DENY')
  c.res.headers.set('Referrer-Policy', 'no-referrer')
  c.res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  // Prevent caching of API responses that contain sensitive data
  if (!c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'no-store')
  }
})

// ── Public routes ──────────────────────────────────────────────────────────────

// Minimal health check — intentionally reveals nothing about the service
app.get('/health', c => c.json({ ok: true }))

app.post('/auth/login', loginHandler)

// ── Protected routes ───────────────────────────────────────────────────────────

app.use('/api/*', authMiddleware)

// Receipts — note: /extract and /import must come before /:id to avoid param collision
app.post('/api/receipts/extract', extractReceiptHandler)
app.post('/api/receipts/import', importEmailHandler)
app.post('/api/receipts/discard', discardPendingHandler)
app.get('/api/receipts', listReceiptsHandler)
app.post('/api/receipts', createReceiptHandler)
app.get('/api/receipts/:id', getReceiptHandler)
app.put('/api/receipts/:id', updateReceiptHandler)
app.delete('/api/receipts/:id', deleteReceiptHandler)

// Image serving (JWT required)
app.get('/api/receipts/:id/image', serveImageHandler)

// Stats & export
app.get('/api/stats', getStatsHandler)
app.get('/api/export', exportHandler)

// Distinct import sources — used by the export UI to build source filter checkboxes
app.get('/api/sources', async c => {
  const rows = await c.env.DB.prepare(
    `SELECT DISTINCT source FROM receipts
     WHERE source IS NOT NULL AND deleted_at IS NULL
     ORDER BY source ASC`,
  ).all<{ source: string }>()
  return c.json({ sources: rows.results.map(r => r.source) })
})

// ── 404 handler ────────────────────────────────────────────────────────────────

app.notFound(c => c.json({ error: 'Not found' }, 404))

app.onError((err, c) => {
  console.error('[error]', err.message)
  return c.json({ error: 'Internal server error' }, 500)
})

// ── Scheduled cron: clean up orphaned pending/ objects ─────────────────────────
// Runs daily at 03:00 UTC. Deletes any pending/ upload older than 24 hours
// that was never finalised into a saved receipt (e.g. scan abandoned mid-flow).

async function cleanPending(env: Env): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000 // 24 hours ago
  let cursor: string | undefined
  let deleted = 0

  do {
    const listed = await env.RECEIPTS.list({ prefix: 'pending/', cursor, limit: 1000 })

    const toDelete = listed.objects.filter(
      obj => obj.uploaded.getTime() < cutoff,
    )

    await Promise.all(toDelete.map(obj => env.RECEIPTS.delete(obj.key)))
    deleted += toDelete.length

    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)

  console.log(`[cron] pending/ cleanup: deleted ${deleted} orphaned object(s)`)
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanPending(env))
  },
}
