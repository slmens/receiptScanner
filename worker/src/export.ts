import type { Context } from 'hono'
import type { Env, ReceiptRow, Variables } from './types'
import { deriveEncryptionKey, decryptField, maybeDecrypt } from './crypto'

type AppContext = Context<{ Bindings: Env; Variables: Variables }>

/**
 * GET /api/export
 * Returns a JSON array of receipts matching the given filters.
 * The frontend converts this to Excel using SheetJS.
 *
 * Query params: from, to, category
 * Note: vendor filter is not supported — vendor names are encrypted at rest.
 */
export async function exportHandler(c: AppContext) {
  const { from, to, category, sources: sourcesParam, scanned } = c.req.query()

  const conditions = ['deleted_at IS NULL']
  const params: (string | number)[] = []

  // Source filtering:
  //   sources=gmail:a@x.com,gmail:b@y.com  → specific email accounts (comma-separated)
  //   scanned=1                             → include source IS NULL rows
  //   (no params)                           → scanned only (default safe behaviour)
  const wantScanned = scanned === '1'
  const wantSources = sourcesParam ? sourcesParam.split(',').map(s => s.trim()).filter(Boolean) : []

  if (wantSources.length > 0 && wantScanned) {
    // Mix: scanned + selected email accounts
    const placeholders = wantSources.map(() => '?').join(', ')
    conditions.push(`(source IS NULL OR source IN (${placeholders}))`)
    params.push(...wantSources)
  } else if (wantSources.length > 0) {
    // Email account(s) only
    const placeholders = wantSources.map(() => '?').join(', ')
    conditions.push(`source IN (${placeholders})`)
    params.push(...wantSources)
  } else if (wantScanned) {
    // Scanned physical receipts only
    conditions.push('source IS NULL')
  } else {
    // Default (no params sent) → scanned only
    conditions.push('source IS NULL')
  }

  if (from) {
    conditions.push('date >= ?')
    params.push(from)
  }
  if (to) {
    conditions.push('date <= ?')
    params.push(to)
  }
  if (category) {
    conditions.push('category = ?')
    params.push(category)
  }

  const where = conditions.join(' AND ')

  const result = await c.env.DB.prepare(`
    SELECT
      id, date, vendor, category,
      subtotal, hst, total, payment_method,
      invoice_number, notes,
      file_type, original_filename, is_edited, created_at
    FROM receipts
    WHERE ${where}
    ORDER BY date ASC, vendor ASC
  `)
    .bind(...params)
    .all<
      Pick<
        ReceiptRow,
        | 'id'
        | 'date'
        | 'vendor'
        | 'category'
        | 'subtotal'
        | 'hst'
        | 'total'
        | 'payment_method'
        | 'invoice_number'
        | 'notes'
        | 'file_type'
        | 'original_filename'
        | 'is_edited'
        | 'created_at'
      >
    >()

  // Decrypt sensitive fields before returning to the authenticated client
  const encKey = await deriveEncryptionKey(c.env.ENCRYPTION_KEY)
  const decrypted = await Promise.all(
    result.results.map(async row => ({
      ...row,
      vendor:            await decryptField(row.vendor, encKey),
      notes:             await maybeDecrypt(row.notes, encKey),
      invoice_number:    await maybeDecrypt(row.invoice_number, encKey),
      original_filename: await maybeDecrypt(row.original_filename, encKey),
    })),
  )

  return c.json({
    receipts: decrypted,
    count: decrypted.length,
    generatedAt: new Date().toISOString(),
  })
}
