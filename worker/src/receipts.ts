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

  const mimeType = file.type || 'image/jpeg'
  const bytes = new Uint8Array(await file.arrayBuffer())

  if (bytes.length === 0) return c.json({ error: 'File is empty' }, 400)
  if (bytes.length > 20 * 1024 * 1024) return c.json({ error: 'File exceeds 20 MB limit' }, 413)

  const tempId = crypto.randomUUID()
  const imageKey = buildTempKey(tempId, mimeType)

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

  const id = crypto.randomUUID()
  const mimeType = body.mimeType || 'image/jpeg'

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

  // Encrypt sensitive text fields before storing
  const encKey = await deriveEncryptionKey(c.env.ENCRYPTION_KEY)
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
      'Cache-Control': 'private, max-age=3600',
    },
  })
}

// ── Stats ──────────────────────────────────────────────────────────────────────

export async function getStatsHandler(c: AppContext) {
  const now = new Date()
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const [monthStats, allTimeStats, topCategories, recentReceipts] = await Promise.all([
    // Count by created_at (scan date) so receipts scanned this month always appear,
    // regardless of what date is printed on the receipt itself.
    c.env.DB.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total
      FROM receipts WHERE created_at LIKE ? AND deleted_at IS NULL
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
