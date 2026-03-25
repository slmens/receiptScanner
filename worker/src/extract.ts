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

const SYSTEM_PROMPT = `You are a receipt and invoice data extractor. Extract all available information from the provided receipt or invoice and return it as valid JSON only.

The document may be a physical receipt photo, a PDF invoice, or an email receipt/trip summary from a service like Uber, Lyft, DoorDash, etc.

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
  "notes": "See notes rules below"
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
- If subtotal or HST are not visible, return null for those fields.
- If payment method is not visible, return "unknown".
- subtotal and hst may be null if only the final total is visible.
- total should be the amount actually charged (after discounts/credits). May be 0 if fully covered by credits.
- Output ONLY the raw JSON object. No markdown, no code fences, no explanation.

Notes field rules (always populate if any of these are present, otherwise null):
- Ride/transport receipts: include pickup location → dropoff location, driver name, vehicle, distance, and any promotions or credits applied (e.g. "From: Airport → Downtown. Driver: John D. Distance: 12 km. Uber One credit: -$0.60. Promo: -$1.07").
- Food delivery: include restaurant name if different from vendor, delivery address, and any discounts.
- Any receipt: include invoice/order reference numbers, discount codes, membership credits, or split-payment details not captured in other fields.
- Do NOT include generic commentary like "this is not a payment receipt" — just extract what is there.`

// OpenRouter uses the OpenAI-compatible chat completions API
const OPENROUTER_MODEL = 'anthropic/claude-sonnet-4-6'
const ANTHROPIC_MODEL  = 'claude-sonnet-4-6'

/**
 * Extract receipt data from an image or PDF.
 * Provider priority: MISTRAL_API_KEY → OPENROUTER_API_KEY → ANTHROPIC_API_KEY
 */
export async function extractReceipt(
  imageData: Uint8Array,
  mimeType: string,
  env: Pick<Env, 'ANTHROPIC_API_KEY' | 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY'>,
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

  if (env.MISTRAL_API_KEY && env.MISTRAL_API_KEY !== 'unused') {
    return extractViaMistral(imageData, mimeType, env.MISTRAL_API_KEY)
  }
  if (env.OPENROUTER_API_KEY && env.OPENROUTER_API_KEY !== 'unused') {
    return extractViaOpenRouter(imageData, mimeType, env.OPENROUTER_API_KEY)
  }
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY !== 'unused') {
    return extractViaAnthropic(imageData, mimeType, env.ANTHROPIC_API_KEY)
  }
  throw new Error('No API key configured. Set MISTRAL_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY.')
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

// ── Mistral OCR ────────────────────────────────────────────────────────────────

interface MistralOcrResponse {
  pages: { markdown: string; index: number }[]
  error?: { message: string }
}

interface MistralChatResponse {
  choices: { message: { content: string } }[]
  error?: { message: string }
}

const MISTRAL_CHAT_MODEL = 'mistral-small-latest'

async function extractViaMistral(
  imageData: Uint8Array,
  mimeType: string,
  apiKey: string,
): Promise<ExtractedData> {
  const b64 = toBase64(imageData)
  const isPdf = mimeType === 'application/pdf'

  // Step 1: OCR — extract raw text from the image/PDF
  const documentField = isPdf
    ? { type: 'document_url', document_url: `data:application/pdf;base64,${b64}` }
    : { type: 'image_url', image_url: `data:${mimeType};base64,${b64}` }

  const ocrResponse = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'mistral-ocr-latest',
      document: documentField,
    }),
  })

  if (!ocrResponse.ok) {
    const text = await ocrResponse.text()
    throw new Error(`Mistral OCR API error ${ocrResponse.status}: ${text}`)
  }

  const ocrResult = (await ocrResponse.json()) as MistralOcrResponse
  if (ocrResult.error) throw new Error(`Mistral OCR error: ${ocrResult.error.message}`)

  const ocrText = ocrResult.pages.map(p => p.markdown).join('\n\n').trim()
  if (!ocrText) throw new Error('Mistral OCR returned no text from the document.')

  // Step 2: Chat — parse OCR text into structured receipt JSON
  const chatResponse = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MISTRAL_CHAT_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Here is the OCR text extracted from a receipt:\n\n${ocrText}\n\nExtract the receipt data.` },
      ],
    }),
  })

  if (!chatResponse.ok) {
    const text = await chatResponse.text()
    throw new Error(`Mistral chat API error ${chatResponse.status}: ${text}`)
  }

  const chatResult = (await chatResponse.json()) as MistralChatResponse
  if (chatResult.error) throw new Error(`Mistral chat error: ${chatResult.error.message}`)

  return parseExtraction(chatResult.choices[0]?.message?.content?.trim() ?? '')
}

// ── Text-based extraction (email import) ──────────────────────────────────────

/**
 * Extract receipt data from plain text (email body).
 * Used by the email import flow — no vision/OCR needed, just a text prompt.
 */
export async function extractFromText(
  text: string,
  hint: { subject?: string; fromName?: string; date?: string },
  env: Pick<Env, 'ANTHROPIC_API_KEY' | 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY'>,
): Promise<ExtractedData> {
  const context = [
    hint.fromName ? `Sender: ${hint.fromName}` : '',
    hint.subject  ? `Subject: ${hint.subject}` : '',
    hint.date     ? `Email date: ${hint.date}` : '',
  ].filter(Boolean).join('\n')

  const prompt = `${context ? context + '\n\n' : ''}Email body:\n\n${text.slice(0, 6000)}`

  if (env.MISTRAL_API_KEY && env.MISTRAL_API_KEY !== 'unused') {
    return extractTextViaMistral(prompt, env.MISTRAL_API_KEY)
  }
  if (env.OPENROUTER_API_KEY && env.OPENROUTER_API_KEY !== 'unused') {
    return extractTextViaOpenRouter(prompt, env.OPENROUTER_API_KEY)
  }
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY !== 'unused') {
    return extractTextViaAnthropic(prompt, env.ANTHROPIC_API_KEY)
  }
  throw new Error('No API key configured.')
}

async function extractTextViaAnthropic(prompt: string, apiKey: string): Promise<ExtractedData> {
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
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!response.ok) throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`)
  const result = (await response.json()) as AnthropicResponse
  if (result.error) throw new Error(`Anthropic error: ${result.error.message}`)
  return parseExtraction(result.content[0]?.text?.trim() ?? '')
}

async function extractTextViaOpenRouter(prompt: string, apiKey: string): Promise<ExtractedData> {
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
        { role: 'user', content: prompt },
      ],
    }),
  })
  if (!response.ok) throw new Error(`OpenRouter API error ${response.status}: ${await response.text()}`)
  const result = (await response.json()) as OpenAIResponse
  if (result.error) throw new Error(`OpenRouter error: ${result.error.message}`)
  return parseExtraction(result.choices[0]?.message?.content?.trim() ?? '')
}

async function extractTextViaMistral(prompt: string, apiKey: string): Promise<ExtractedData> {
  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MISTRAL_CHAT_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  })
  if (!response.ok) throw new Error(`Mistral API error ${response.status}: ${await response.text()}`)
  const result = (await response.json()) as MistralChatResponse
  if (result.error) throw new Error(`Mistral error: ${result.error.message}`)
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
