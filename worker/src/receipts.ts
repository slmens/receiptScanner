import type { Context } from 'hono'
import type { Env, ListReceiptsQuery, ReceiptRow, Variables } from './types'
import { extractReceipt } from './extract'
import {
  buildImageKey,
  buildTempKey,
  streamFromR2,
  uploadToR2,
} from './r2'
import {
  deriveEncryptionKey,
  decryptField,
  encryptField,
  maybeDecrypt,
  maybeEncrypt,
} from './crypto'

type AppContext = Context<{ Bindings: Env; Variables: Variables }>

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Decrypt the sensitive text fields of a receipt row in-place.
 * Numeric fields (subtotal, hst, total) and enum fields (category,
 * payment_method) are never encrypted and need no decryption.
 */
async function decryptRow(row: ReceiptRow, encKey: CryptoKey): Promise<ReceiptRow> {
  const [vendor, notes, invoiceNumber, originalFilename] = await Promise.all([
    decryptField(row.vendor, encKey),
    maybeDecrypt(row.notes, encKey),
    maybeDecrypt(row.invoice_number, encKey),
    maybeDecrypt(row.original_filename, encKey),
  ])
  return { ...row, vendor, notes, invoice_number: invoiceNumber, original_filename: originalFilename }
}

async function decryptRows(rows: ReceiptRow[], encKey: CryptoKey): Promise<ReceiptRow[]> {
  return Promise.all(rows.map(r => decryptRow(r, encKey)))
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
}

function canonicalMime(mimeType: string): string {
  if (mimeType === 'image/jpg') return 'image/jpeg'
  return mimeType
}

// ── Extract (step 1 of 2-step scan flow) ──────────────────────────────────────

/**
 * POST /api/receipts/extract
 * Accepts a multipart file, uploads it to R2 (pending/), calls Claude, returns extracted data.
 * The client reviews the data, then calls POST /api/receipts to finalize.
 */
export async function extractReceiptHandler(c: AppContext) {
  const formData = await c.req.formData().catch(() => null)
  if (!formData) return c.json({ error: 'Multipart form data required' }, 400)

  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'Field "file" is required' }, 400)

  const mimeType = canonicalMime(file.type || 'image/jpeg')
  const bytes = new Uint8Array(await file.arrayBuffer())

  if (bytes.length === 0) return c.json({ error: 'File is empty' }, 400)
  if (bytes.length > 20 * 1024 * 1024) return c.json({ error: 'File exceeds 20 MB limit' }, 413)

  // Basic content sniffing (magic bytes) to prevent obvious type spoofing.
  // This is not an antivirus. It just ensures the upload is plausibly the declared format.
  const sniffed = sniffMime(bytes)
  if (!sniffed) {
    return c.json({ error: 'Unsupported or unrecognized file format' }, 415)
  }
  if (canonicalMime(sniffed) !== mimeType) {
    return c.json({ error: `File type mismatch. Detected ${sniffed}, got ${mimeType}` }, 415)
  }

  const tempId = crypto.randomUUID()
  const imageKey = buildTempKey(tempId, mimeType)

  try {
    // Upload to R2 and extract in parallel
    const [, extracted] = await Promise.all([
      uploadToR2(c.env.RECEIPTS, imageKey, bytes.buffer, mimeType),
      extractReceipt(bytes, mimeType, c.env),
    ])

    return c.json({
      imageKey,
      originalFilename: file.name,
      mimeType,
      extracted,
    })
  } catch (err) {
    await c.env.RECEIPTS.delete(imageKey).catch(() => null)
    const message =
      err instanceof Error ? err.message : 'Unknown error'
    console.error('extractReceiptHandler failed', err)
    // Most failures here are upstream AI/provider problems; return a clear error
    // instead of an opaque 500 so the client can show a useful message.
    return c.json(
      { error: 'Receipt analysis failed', detail: message },
      502,
    )
  }
}

function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null

  // PDF: %PDF-
  if (
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46 && bytes[4] === 0x2d
  ) return 'application/pdf'

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png'

  // GIF: GIF87a / GIF89a
  if (
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) return 'image/gif'

  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp'

  return null
}

// ── Create (step 2 of 2-step scan flow) ───────────────────────────────────────

/**
 * POST /api/receipts
 * Accepts the imageKey from the extract step + (possibly edited) receipt data.
 * Moves image from pending/ to receipts/, inserts DB row with encrypted fields.
 */
export async function createReceiptHandler(c: AppContext) {
  let body: {
    imageKey: string
    originalFilename: string
    mimeType: string
    date: string
    vendor: string
    category: string
    subtotal: number | null
    hst: number | null
    total: number
    paymentMethod: string
    invoiceNumber: string | null
    notes: string | null
    confirmDuplicate?: boolean
  }

  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!body.imageKey) return c.json({ error: 'imageKey is required' }, 400)
  if (!body.date) return c.json({ error: 'date is required' }, 400)
  if (!body.vendor) return c.json({ error: 'vendor is required' }, 400)
  if (typeof body.total !== 'number') return c.json({ error: 'total must be a number' }, 400)
  if (body.total <= 0) return c.json({ error: 'total must be greater than 0' }, 400)

  const encKey = await deriveEncryptionKey(c.env.ENCRYPTION_KEY)

  // Warn before likely duplicates are created.
  if (!body.confirmDuplicate) {
    const candidateRows = await c.env.DB.prepare(`
      SELECT id, date, vendor, category, subtotal, hst, total, payment_method,
             invoice_number, notes, image_key, original_filename, file_type,
             is_edited, created_at, updated_at, deleted_at
      FROM receipts
      WHERE deleted_at IS NULL
        AND date = ?
        AND ABS(total - ?) < 0.009
      ORDER BY created_at DESC
      LIMIT 12
    `)
      .bind(body.date, body.total)
      .all<ReceiptRow>()

    const decryptedCandidates = await decryptRows(candidateRows.results, encKey)
    const vendorNorm = normalizeText(body.vendor)
    const invoiceNorm = normalizeText(body.invoiceNumber)
    const filenameNorm = normalizeText(body.originalFilename)

    const duplicates = decryptedCandidates.filter(row => {
      const sameVendor = normalizeText(row.vendor) === vendorNorm
      const sameInvoice =
        invoiceNorm &&
        normalizeText(row.invoice_number) === invoiceNorm
      const sameFilename =
        filenameNorm &&
        normalizeText(row.original_filename) === filenameNorm

      return sameVendor || sameInvoice || sameFilename
    })

    if (duplicates.length > 0) {
      return c.json({
        error: 'Possible duplicate receipt detected',
        duplicates: duplicates.slice(0, 3).map(row => ({
          id: row.id,
          date: row.date,
          vendor: row.vendor,
          total: row.total,
          created_at: row.created_at,
        })),
      }, 409)
    }
  }

  const id = crypto.randomUUID()
  const mimeType = canonicalMime(body.mimeType || 'image/jpeg')

  // Move from pending/ to receipts/
  let finalKey = body.imageKey
  if (body.imageKey.startsWith('pending/')) {
    const obj = await c.env.RECEIPTS.get(body.imageKey)
    if (obj) {
      finalKey = buildImageKey(id, mimeType)
      const data = await obj.arrayBuffer()
      await Promise.all([
        uploadToR2(c.env.RECEIPTS, finalKey, data, mimeType),
        c.env.RECEIPTS.delete(body.imageKey),
      ])
    }
  }

  const [encVendor, encNotes, encInvoiceNumber, encOriginalFilename] = await Promise.all([
    encryptField(body.vendor.trim(), encKey),
    maybeEncrypt(body.notes?.trim() ?? null, encKey),
    maybeEncrypt(body.invoiceNumber ?? null, encKey),
    maybeEncrypt(body.originalFilename ?? null, encKey),
  ])

  await c.env.DB.prepare(`
    INSERT INTO receipts
      (id, date, vendor, category, subtotal, hst, total, payment_method,
       invoice_number, notes, image_key, original_filename, file_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      id,
      body.date,
      encVendor,
      body.category ?? 'Other',
      body.subtotal ?? null,
      body.hst ?? null,
      body.total,
      body.paymentMethod ?? 'unknown',
      encInvoiceNumber,
      encNotes,
      finalKey,
      encOriginalFilename,
      mimeType,
    )
    .run()

  const row = await c.env.DB.prepare('SELECT * FROM receipts WHERE id = ?')
    .bind(id)
    .first<ReceiptRow>()

  if (!row) return c.json({ error: 'Failed to retrieve saved receipt' }, 500)

  return c.json({ receipt: await decryptRow(row, encKey) }, 201)
}

export async function discardPendingHandler(c: AppContext) {
  let body: { imageKey?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const imageKey = body.imageKey?.trim()
  if (!imageKey) return c.json({ error: 'imageKey is required' }, 400)
  if (!imageKey.startsWith('pending/')) {
    return c.json({ error: 'Only pending uploads can be discarded' }, 400)
  }

  await c.env.RECEIPTS.delete(imageKey)
  return c.json({ ok: true })
}

// ── List ───────────────────────────────────────────────────────────────────────

export async function listReceiptsHandler(c: AppContext) {
  const query = c.req.query() as ListReceiptsQuery
  const limit = Math.min(parseInt(query.limit ?? '50'), 200)
  const offset = parseInt(query.offset ?? '0')

  const conditions = ['deleted_at IS NULL']
  const params: (string | number)[] = []

  if (query.from) {
    conditions.push('date >= ?')
    params.push(query.from)
  }
  if (query.to) {
    conditions.push('date <= ?')
    params.push(query.to)
  }
  if (query.category) {
    conditions.push('category = ?')
    params.push(query.category)
  }
  // Note: vendor search is not supported when field-level encryption is enabled.
  // Filter client-side on the decrypted results if needed.

  const where = conditions.join(' AND ')

  const [countResult, dataResult] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM receipts WHERE ${where}`)
      .bind(...params)
      .first<{ total: number }>(),
    c.env.DB.prepare(`
      SELECT id, date, vendor, category, subtotal, hst, total, payment_method,
             invoice_number, notes, image_key, original_filename, file_type,
             is_edited, created_at, updated_at
      FROM receipts
      WHERE ${where}
      ORDER BY date DESC, created_at DESC
      LIMIT ? OFFSET ?
    `)
      .bind(...params, limit, offset)
      .all<ReceiptRow>(),
  ])

  const encKey = await deriveEncryptionKey(c.env.ENCRYPTION_KEY)
  const decrypted = await decryptRows(dataResult.results, encKey)

  return c.json({
    receipts: decrypted,
    total: countResult?.total ?? 0,
    limit,
    offset,
  })
}

// ── Get single ─────────────────────────────────────────────────────────────────

export async function getReceiptHandler(c: AppContext) {
  const { id } = c.req.param()
  const row = await c.env.DB.prepare(
    'SELECT * FROM receipts WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first<ReceiptRow>()

  if (!row) return c.json({ error: 'Receipt not found' }, 404)

  const encKey = await deriveEncryptionKey(c.env.ENCRYPTION_KEY)
  return c.json({ receipt: await decryptRow(row, encKey) })
}

// ── Update ─────────────────────────────────────────────────────────────────────

export async function updateReceiptHandler(c: AppContext) {
  const { id } = c.req.param()
  const existing = await c.env.DB.prepare(
    'SELECT id FROM receipts WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first<{ id: string }>()

  if (!existing) return c.json({ error: 'Receipt not found' }, 404)

  let body: Partial<{
    date: string
    vendor: string
    category: string
    subtotal: number | null
    hst: number | null
    total: number
    paymentMethod: string
    invoiceNumber: string | null
    notes: string | null
  }>

  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const encKey = await deriveEncryptionKey(c.env.ENCRYPTION_KEY)
  const [encVendor, encNotes, encInvoiceNumber] = await Promise.all([
    body.vendor ? encryptField(body.vendor, encKey) : Promise.resolve(null),
    body.notes !== undefined ? maybeEncrypt(body.notes, encKey) : Promise.resolve(null),
    body.invoiceNumber !== undefined ? maybeEncrypt(body.invoiceNumber, encKey) : Promise.resolve(null),
  ])

  await c.env.DB.prepare(`
    UPDATE receipts SET
      date           = COALESCE(?, date),
      vendor         = COALESCE(?, vendor),
      category       = COALESCE(?, category),
      subtotal       = COALESCE(?, subtotal),
      hst            = COALESCE(?, hst),
      total          = COALESCE(?, total),
      payment_method = COALESCE(?, payment_method),
      invoice_number = COALESCE(?, invoice_number),
      notes          = COALESCE(?, notes),
      is_edited      = 1,
      updated_at     = datetime('now')
    WHERE id = ?
  `)
    .bind(
      body.date ?? null,
      encVendor,
      body.category ?? null,
      body.subtotal ?? null,
      body.hst ?? null,
      body.total ?? null,
      body.paymentMethod ?? null,
      encInvoiceNumber,
      encNotes,
      id,
    )
    .run()

  const row = await c.env.DB.prepare('SELECT * FROM receipts WHERE id = ?')
    .bind(id)
    .first<ReceiptRow>()

  if (!row) return c.json({ error: 'Failed to retrieve updated receipt' }, 500)

  return c.json({ receipt: await decryptRow(row, encKey) })
}

// ── Delete (soft) ──────────────────────────────────────────────────────────────

export async function deleteReceiptHandler(c: AppContext) {
  const { id } = c.req.param()
  const existing = await c.env.DB.prepare(
    'SELECT id FROM receipts WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first<{ id: string }>()

  if (!existing) return c.json({ error: 'Receipt not found' }, 404)

  await c.env.DB.prepare(
    "UPDATE receipts SET deleted_at = datetime('now') WHERE id = ?",
  )
    .bind(id)
    .run()

  return c.json({ ok: true })
}

// ── Serve image ────────────────────────────────────────────────────────────────

export async function serveImageHandler(c: AppContext) {
  const { id } = c.req.param()
  const row = await c.env.DB.prepare(
    'SELECT image_key, file_type FROM receipts WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first<{ image_key: string; file_type: string }>()

  if (!row) return c.json({ error: 'Receipt not found' }, 404)

  const file = await streamFromR2(c.env.RECEIPTS, row.image_key)
  if (!file) return c.json({ error: 'Image not found in storage' }, 404)

  return new Response(file.body, {
    headers: {
      'Content-Type': file.contentType,
      // Receipts are sensitive; don't allow caching.
      'Cache-Control': 'no-store',
    },
  })
}

// ── Stats ──────────────────────────────────────────────────────────────────────

export async function getStatsHandler(c: AppContext) {
  const now = new Date()
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const [monthStats, allTimeStats, topCategories, recentReceipts] = await Promise.all([
    // Count by the receipt's actual `date` (printed date), not when it was scanned/imported.
    c.env.DB.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total
      FROM receipts WHERE date LIKE ? AND deleted_at IS NULL
    `)
      .bind(`${thisMonth}%`)
      .first<{ count: number; total: number }>(),

    c.env.DB.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total
      FROM receipts WHERE deleted_at IS NULL
    `).first<{ count: number; total: number }>(),

    c.env.DB.prepare(`
      SELECT category, COUNT(*) as count, COALESCE(SUM(total), 0) as total
      FROM receipts WHERE deleted_at IS NULL
      GROUP BY category ORDER BY total DESC LIMIT 5
    `).all<{ category: string; count: number; total: number }>(),

    c.env.DB.prepare(`
      SELECT id, date, vendor, category, total, payment_method
      FROM receipts WHERE deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 5
    `).all<Pick<ReceiptRow, 'id' | 'date' | 'vendor' | 'category' | 'total' | 'payment_method'>>(),
  ])

  // Decrypt vendor names in recent receipts
  const encKey = await deriveEncryptionKey(c.env.ENCRYPTION_KEY)
  const decryptedRecent = await Promise.all(
    recentReceipts.results.map(async r => ({
      ...r,
      vendor: await decryptField(r.vendor, encKey),
    })),
  )

  return c.json({
    thisMonth: monthStats ?? { count: 0, total: 0 },
    allTime: allTimeStats ?? { count: 0, total: 0 },
    topCategories: topCategories.results,
    recentReceipts: decryptedRecent,
  })
}
