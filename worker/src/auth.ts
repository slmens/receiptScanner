import type { Context, Next } from 'hono'
import type { Env, JwtPayload, Variables } from './types'

const TOKEN_EXPIRY_SECONDS = 60 * 60 * 24 * 7 // 7 days

// ── Rate limiting ─────────────────────────────────────────────────────────────

const RL_WINDOW_SECONDS = 15 * 60   // 15-minute window
const RL_MAX_ATTEMPTS   = 10        // max failed attempts per window
const RL_LOCKOUT_MSG    = 'Too many failed login attempts. Try again later.'

interface RateLimitEntry {
  count: number
  windowStart: number
}

async function checkRateLimit(
  kv: KVNamespace | undefined,
  ip: string,
): Promise<{ allowed: boolean; retryAfter: number }> {
  if (!kv) return { allowed: true, retryAfter: 0 }

  const key = `rl:${ip}`
  const now = Math.floor(Date.now() / 1000)

  const raw = await kv.get(key)
  const entry: RateLimitEntry = raw
    ? (JSON.parse(raw) as RateLimitEntry)
    : { count: 0, windowStart: now }

  // Reset counter if window has passed
  if (now - entry.windowStart >= RL_WINDOW_SECONDS) {
    return { allowed: true, retryAfter: 0 }
  }

  if (entry.count >= RL_MAX_ATTEMPTS) {
    const retryAfter = RL_WINDOW_SECONDS - (now - entry.windowStart)
    return { allowed: false, retryAfter }
  }

  return { allowed: true, retryAfter: 0 }
}

async function recordFailedAttempt(kv: KVNamespace | undefined, ip: string): Promise<void> {
  if (!kv) return

  const key = `rl:${ip}`
  const now = Math.floor(Date.now() / 1000)

  const raw = await kv.get(key)
  let entry: RateLimitEntry = raw
    ? (JSON.parse(raw) as RateLimitEntry)
    : { count: 0, windowStart: now }

  // Reset if window has passed
  if (now - entry.windowStart >= RL_WINDOW_SECONDS) {
    entry = { count: 0, windowStart: now }
  }

  entry.count += 1
  await kv.put(key, JSON.stringify(entry), { expirationTtl: RL_WINDOW_SECONDS })
}

async function clearRateLimit(kv: KVNamespace | undefined, ip: string): Promise<void> {
  if (!kv) return
  await kv.delete(`rl:${ip}`)
}

// ── Crypto helpers ─────────────────────────────────────────────────────────────

function toBase64Url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (padded.length % 4)) % 4
  return Uint8Array.from(atob(padded + '='.repeat(padLen)), c => c.charCodeAt(0))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret).buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

// ── JWT ────────────────────────────────────────────────────────────────────────

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const header = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).buffer as ArrayBuffer)
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer)
  const data = `${header}.${body}`
  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return `${data}.${toBase64Url(sig)}`
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [header, body, sig] = parts
  const data = `${header}.${body}`

  try {
    const key = await hmacKey(secret)
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64Url(sig),
      new TextEncoder().encode(data),
    )
    if (!valid) return null

    const payload: JwtPayload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(body)),
    )
    if (payload.exp < Math.floor(Date.now() / 1000)) return null

    return payload
  } catch {
    return null
  }
}

// ── Route handlers ─────────────────────────────────────────────────────────────

export async function loginHandler(c: Context<{ Bindings: Env }>) {
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown'

  // Check rate limit before doing any work
  const { allowed, retryAfter } = await checkRateLimit(c.env.RATE_LIMIT, ip)
  if (!allowed) {
    return c.json({ error: RL_LOCKOUT_MSG }, 429, {
      'Retry-After': String(retryAfter),
    })
  }

  let body: { passphrase?: string; turnstileToken?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!body.passphrase) {
    await recordFailedAttempt(c.env.RATE_LIMIT, ip)
    return c.json({ error: 'Passphrase is required' }, 400)
  }

  // Optional Turnstile bot protection (highly recommended if the app stays public)
  if (c.env.TURNSTILE_SECRET?.trim()) {
    if (!body.turnstileToken) {
      await recordFailedAttempt(c.env.RATE_LIMIT, ip)
      return c.json({ error: 'Turnstile token is required' }, 400)
    }

    const ok = await verifyTurnstile(body.turnstileToken, c.env.TURNSTILE_SECRET, ip)
    if (!ok) {
      await recordFailedAttempt(c.env.RATE_LIMIT, ip)
      return c.json({ error: 'Turnstile verification failed' }, 401)
    }
  }

  // Constant-time comparison to prevent timing attacks
  const provided = new TextEncoder().encode(body.passphrase)
  const expected = new TextEncoder().encode(c.env.AUTH_SECRET)

  let diff = provided.length !== expected.length ? 1 : 0
  // Always iterate the same number of bytes to prevent length-based timing leaks
  const len = Math.max(provided.length, expected.length)
  for (let i = 0; i < len; i++) {
    diff |= (provided[i] ?? 0) ^ (expected[i] ?? 0)
  }

  if (diff !== 0) {
    await recordFailedAttempt(c.env.RATE_LIMIT, ip)
    return c.json({ error: 'Invalid passphrase' }, 401)
  }

  // Success — clear the rate limit counter so legitimate retries don't accumulate
  await clearRateLimit(c.env.RATE_LIMIT, ip)

  const now = Math.floor(Date.now() / 1000)
  const token = await signJwt(
    { sub: 'vault-user', iat: now, exp: now + TOKEN_EXPIRY_SECONDS },
    c.env.JWT_SECRET,
  )

  return c.json({
    token,
    expiresAt: new Date((now + TOKEN_EXPIRY_SECONDS) * 1000).toISOString(),
  })
}

interface TurnstileVerifyResponse {
  success: boolean
  // eslint-disable-next-line @typescript-eslint/naming-convention
  'error-codes'?: string[]
}

async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  const body = new URLSearchParams()
  body.set('secret', secret)
  body.set('response', token)
  if (ip && ip !== 'unknown') body.set('remoteip', ip)

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) return false
  const data = (await res.json()) as TurnstileVerifyResponse
  return data.success === true
}

export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
): Promise<Response | void> {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization header required' }, 401)
  }

  const token = header.slice(7)
  const payload = await verifyJwt(token, c.env.JWT_SECRET)

  if (!payload) {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }

  c.set('jwtPayload', payload)
  await next()
}
