/**
 * Field-level AES-256-GCM encryption for sensitive D1 columns.
 *
 * Encrypted values are stored as:  enc:<base64url(12-byte-IV || ciphertext)>
 * The "enc:" prefix lets us transparently read legacy plaintext rows that
 * existed before encryption was enabled.
 *
 * Key derivation: HKDF-SHA-256 over the ENCRYPTION_KEY secret.  The key
 * material is already high-entropy (openssl rand -hex 32), so HKDF's single
 * hash expand step is sufficient — no need for slow PBKDF2.
 */

const ENCRYPTED_PREFIX = 'enc:'

function toB64Url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function fromB64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = (4 - (padded.length % 4)) % 4
  return Uint8Array.from(atob(padded + '='.repeat(pad)), c => c.charCodeAt(0))
}

export async function deriveEncryptionKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('vault-field-encryption-v1'),
      info: new TextEncoder().encode('aes-256-gcm'),
    },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptField(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  const combined = new Uint8Array(12 + ct.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ct), 12)
  return ENCRYPTED_PREFIX + toB64Url(combined.buffer as ArrayBuffer)
}

export async function decryptField(value: string, key: CryptoKey): Promise<string> {
  // Transparently pass through legacy plaintext rows
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value
  const combined = fromB64Url(value.slice(ENCRYPTED_PREFIX.length))
  const iv = combined.slice(0, 12)
  const ct = combined.slice(12)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return new TextDecoder().decode(plain)
}

/** Decrypt a nullable field; returns null if the input is null/undefined. */
export async function maybeDecrypt(
  value: string | null | undefined,
  key: CryptoKey,
): Promise<string | null> {
  if (!value) return null
  return decryptField(value, key)
}

/** Encrypt a nullable field; returns null if the input is null/empty. */
export async function maybeEncrypt(
  value: string | null | undefined,
  key: CryptoKey,
): Promise<string | null> {
  if (!value) return null
  return encryptField(value, key)
}
