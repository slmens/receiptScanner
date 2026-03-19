import type { Env, ExtractedData } from './types'

// MIME types the Claude vision API accepts directly
const SUPPORTED_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
])

/**
 * Safe base64 encoding for large binary files.
 * btoa(String.fromCharCode(...bytes)) blows the call stack above ~1 MB
 * because it spreads the entire array as function arguments.
 */
function toBase64(data: Uint8Array): string {
  const CHUNK = 8192
  let binary = ''
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

const SYSTEM_PROMPT = `You are a receipt and invoice data extractor. Extract all available information from the provided receipt or invoice image and return it as valid JSON only.

The image may be a long receipt photographed in multiple parts and stitched together vertically. Treat the entire image as one single receipt and extract the combined totals.

Return a single JSON object with exactly these fields:
{
  "date": "YYYY-MM-DD",
  "vendor": "Business name",
  "category": "Category from the list below",
  "subtotal": 0.00,
  "hst": 0.00,
  "total": 0.00,
  "payment_method": "cash|debit|credit|e-transfer|unknown",
  "invoice_number": "INV-123 or null",
  "notes": "Any relevant notes or null"
}

Valid categories (pick the closest match):
Food & Ingredients, Alcohol & Beverages, Kitchen Equipment, Cleaning & Supplies,
Packaging & Takeout, Utilities, Rent, Insurance, Marketing,
Maintenance & Repair, Licensing & Permits, Delivery & Transport, Other

Rules:
- Read the document conservatively. Do not invent values that are not visible.
- Ontario, Canada context: HST is 13%. If HST is not shown, calculate as subtotal * 0.13.
- If the date is missing or illegible, use today's date.
- If the vendor name is unclear, make your best guess from any visible text or logo.
- Prefer the printed final total over any inferred arithmetic if they conflict.
- If subtotal, HST, invoice number, or notes are not visible, return null for those nullable fields.
- If payment method is not visible, return "unknown".
- subtotal and hst may be null if only the final total is visible.
- total must always be a number greater than 0.
- Output ONLY the raw JSON object. No markdown, no code fences, no explanation.`

// OpenRouter uses the OpenAI-compatible chat completions API
const OPENROUTER_MODEL = 'anthropic/claude-sonnet-4-6'
const ANTHROPIC_MODEL  = 'claude-sonnet-4-6'

/**
 * Extract receipt data from an image or PDF.
 * Uses OpenRouter if OPENROUTER_API_KEY is set, otherwise falls back to Anthropic direct.
 */
export async function extractReceipt(
  imageData: Uint8Array,
  mimeType: string,
  env: Pick<Env, 'ANTHROPIC_API_KEY' | 'OPENROUTER_API_KEY'>,
): Promise<ExtractedData> {
  // HEIC/HEIF are not supported by the Claude vision API.
  // The PWA converts them automatically when using the camera button,
  // but a direct file upload on desktop may bypass conversion.
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    throw new Error(
      'HEIC/HEIF format is not supported by the AI vision API. ' +
      'Please use the camera capture button (converts automatically) or ' +
      'export the photo as JPEG from your Photos app before uploading.',
    )
  }

  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(
      `Unsupported file type: ${mimeType}. Supported formats: JPEG, PNG, WebP, GIF, PDF.`,
    )
  }

  if (env.OPENROUTER_API_KEY) {
    return extractViaOpenRouter(imageData, mimeType, env.OPENROUTER_API_KEY)
  }
  if (env.ANTHROPIC_API_KEY) {
    return extractViaAnthropic(imageData, mimeType, env.ANTHROPIC_API_KEY)
  }
  throw new Error('No API key configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.')
}

// ── Anthropic direct ───────────────────────────────────────────────────────────

interface AnthropicResponse {
  content: { type: string; text: string }[]
  error?: { message: string }
}

async function extractViaAnthropic(
  imageData: Uint8Array,
  mimeType: string,
  apiKey: string,
): Promise<ExtractedData> {
  const b64 = toBase64(imageData)
  const isPdf = mimeType === 'application/pdf'

  const imageContent = isPdf
    ? {
        type: 'document' as const,
        source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: b64 },
      }
    : {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
          data: b64,
        },
      }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            imageContent,
            { type: 'text', text: 'Extract the receipt data.' },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Anthropic API error ${response.status}: ${text}`)
  }

  const result = (await response.json()) as AnthropicResponse
  if (result.error) throw new Error(`Anthropic error: ${result.error.message}`)

  return parseExtraction(result.content[0]?.text?.trim() ?? '')
}

// ── OpenRouter (OpenAI-compatible) ─────────────────────────────────────────────

interface OpenAIResponse {
  choices: { message: { content: string } }[]
  error?: { message: string }
}

async function extractViaOpenRouter(
  imageData: Uint8Array,
  mimeType: string,
  apiKey: string,
): Promise<ExtractedData> {
  const b64 = toBase64(imageData)
  const dataUrl = `data:${mimeType};base64,${b64}`

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/receipt-vault',
      'X-Title': 'Receipt Vault',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: 'Extract the receipt data.' },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`OpenRouter API error ${response.status}: ${text}`)
  }

  const result = (await response.json()) as OpenAIResponse
  if (result.error) throw new Error(`OpenRouter error: ${result.error.message}`)

  return parseExtraction(result.choices[0]?.message?.content?.trim() ?? '')
}

function parseExtraction(raw: string): ExtractedData {
  // Strip accidental markdown code fences
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  let data: Partial<ExtractedData>
  try {
    data = JSON.parse(cleaned)
  } catch {
    throw new Error(`Failed to parse Claude response as JSON: ${raw.slice(0, 200)}`)
  }

  return {
    date: validateDate(data.date),
    vendor: (data.vendor?.trim()) || 'Unknown Vendor',
    category: validateCategory(data.category),
    subtotal: typeof data.subtotal === 'number' ? data.subtotal : null,
    hst: typeof data.hst === 'number' ? data.hst : null,
    total: typeof data.total === 'number' && data.total > 0 ? data.total : 0,
    payment_method: validatePayment(data.payment_method),
    invoice_number: data.invoice_number?.trim() || null,
    notes: data.notes?.trim() || null,
  }
}

function validateDate(raw?: string | null): string {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  return new Date().toISOString().slice(0, 10)
}

const VALID_CATEGORIES = [
  'Food & Ingredients',
  'Alcohol & Beverages',
  'Kitchen Equipment',
  'Cleaning & Supplies',
  'Packaging & Takeout',
  'Utilities',
  'Rent',
  'Insurance',
  'Marketing',
  'Maintenance & Repair',
  'Licensing & Permits',
  'Delivery & Transport',
  'Other',
] as const

function validateCategory(raw?: string | null): string {
  if (raw && VALID_CATEGORIES.includes(raw as typeof VALID_CATEGORIES[number])) return raw
  return 'Other'
}

function validatePayment(raw?: string | null): string {
  const v = (raw ?? '').toLowerCase().replace(/\s+/g, '-').trim()
  if (v === 'cash' || v === 'debit' || v === 'credit') return v
  // Normalize common e-transfer/etransfer variants.
  if (v === 'e-transfer' || v === 'etransfer' || v === 'interac-e-transfer') {
    return 'e-transfer'
  }
  if (v.includes('etransfer') || v.includes('e-transfer')) return 'e-transfer'
  return 'unknown'
}
