// R2 image storage — upload, serve, delete

export async function uploadToR2(
  bucket: R2Bucket,
  key: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<void> {
  await bucket.put(key, data, {
    httpMetadata: { contentType },
  })
}

export async function streamFromR2(
  bucket: R2Bucket,
  key: string,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  const object = await bucket.get(key)
  if (!object) return null
  return {
    body: object.body,
    contentType: object.httpMetadata?.contentType ?? 'image/jpeg',
  }
}

export async function deleteFromR2(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key)
}

/**
 * Generate an R2 object key for a receipt image.
 * Format: receipts/YYYY-MM/UUID.ext
 */
export function buildImageKey(id: string, mimeType: string): string {
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return `receipts/${month}/${id}.${extensionFromMime(mimeType)}`
}

/**
 * Generate a temporary R2 key for the extract → review → save flow.
 * Orphaned temp files can be cleaned up with a cron job later.
 */
export function buildTempKey(id: string, mimeType: string): string {
  return `pending/${id}.${extensionFromMime(mimeType)}`
}

export function extensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'application/pdf': 'pdf',
  }
  return map[mimeType] ?? 'jpg'
}
