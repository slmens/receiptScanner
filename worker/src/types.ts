export interface Env {
  DB: D1Database
  RECEIPTS: R2Bucket
  // Set one of these — MISTRAL_API_KEY > OPENROUTER_API_KEY > ANTHROPIC_API_KEY
  ANTHROPIC_API_KEY: string
  OPENROUTER_API_KEY: string
  MISTRAL_API_KEY: string
  AUTH_SECRET: string
  JWT_SECRET: string
  // AES-256-GCM key for field-level encryption of sensitive D1 columns
  ENCRYPTION_KEY: string
  // CORS allowed origin — set to your Pages URL (e.g. https://receipt-vault.pages.dev)
  ALLOWED_ORIGIN: string
  // Optional: Cloudflare Turnstile secret for login bot protection
  TURNSTILE_SECRET?: string
  // KV namespace for login rate limiting
  RATE_LIMIT: KVNamespace
}

export type Variables = {
  jwtPayload: JwtPayload
}

export interface ReceiptRow {
  id: string
  date: string
  vendor: string
  category: string
  subtotal: number | null
  hst: number | null
  total: number
  payment_method: string
  invoice_number: string | null
  notes: string | null
  image_key: string
  original_filename: string | null
  file_type: string
  raw_extraction: string | null
  is_edited: number
  created_at: string
  updated_at: string
  deleted_at: string | null
  source: string | null
  source_id: string | null
}

export interface ExtractedData {
  date: string
  vendor: string
  category: string
  subtotal: number | null
  hst: number | null
  total: number
  payment_method: string
  invoice_number: string | null
  notes: string | null
}

export interface JwtPayload {
  sub: string
  iat: number
  exp: number
}

export interface ListReceiptsQuery {
  from?: string
  to?: string
  category?: string
  vendor?: string
  limit?: string
  offset?: string
}
