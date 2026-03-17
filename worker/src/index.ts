import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import type { Env, Variables } from './types'
import { authMiddleware, loginHandler } from './auth'
import {
  createReceiptHandler,
  deleteReceiptHandler,
  extractReceiptHandler,
  getReceiptHandler,
  getStatsHandler,
  listReceiptsHandler,
  serveImageHandler,
  updateReceiptHandler,
} from './receipts'
import { exportHandler } from './export'

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── Global middleware ──────────────────────────────────────────────────────────

app.use('*', logger())

// Dynamic CORS: locked to the configured Pages origin.
// Falls back to the request origin only if ALLOWED_ORIGIN is not set (dev mode).
app.use('*', async (c, next) => {
  const allowedOrigin = c.env.ALLOWED_ORIGIN?.trim()
  return cors({
    origin: allowedOrigin || (origin => origin), // dev fallback — lock down in production
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
    credentials: false,
  })(c, next)
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

// Receipts — note: /extract must come before /:id to avoid param collision
app.post('/api/receipts/extract', extractReceiptHandler)
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
