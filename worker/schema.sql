-- Receipt Vault — D1 Schema
-- Run with: wrangler d1 execute receipt-vault --file=./schema.sql

CREATE TABLE IF NOT EXISTS receipts (
  id               TEXT    PRIMARY KEY,
  date             TEXT    NOT NULL,                    -- YYYY-MM-DD
  vendor           TEXT    NOT NULL,
  category         TEXT    NOT NULL DEFAULT 'Other',
  subtotal         REAL,                               -- null if not visible
  hst              REAL,                               -- null if not visible
  total            REAL    NOT NULL,
  payment_method   TEXT    NOT NULL DEFAULT 'unknown', -- cash | debit | credit | unknown
  invoice_number   TEXT,
  notes            TEXT,
  image_key        TEXT    NOT NULL,                   -- R2 object key
  original_filename TEXT,
  file_type        TEXT    NOT NULL DEFAULT 'image/jpeg',
  raw_extraction   TEXT,                               -- Claude's JSON response (debug)
  is_edited        INTEGER NOT NULL DEFAULT 0,         -- 1 if user manually corrected
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at       TEXT                                -- soft delete
);

CREATE INDEX IF NOT EXISTS idx_receipts_date        ON receipts(date);
CREATE INDEX IF NOT EXISTS idx_receipts_vendor      ON receipts(vendor);
CREATE INDEX IF NOT EXISTS idx_receipts_category    ON receipts(category);
CREATE INDEX IF NOT EXISTS idx_receipts_deleted_at  ON receipts(deleted_at);
