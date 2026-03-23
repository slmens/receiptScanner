-- Receipt Vault — Add source tracking + dedupe for imports
-- This schema is compatible with D1 (SQLite).

ALTER TABLE receipts ADD COLUMN source    TEXT;
ALTER TABLE receipts ADD COLUMN source_id TEXT;

-- Enforce at most one receipt per imported message.
-- Partial unique index lets existing rows (NULL source/source_id) coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_source_dedup
  ON receipts(source, source_id)
  WHERE source IS NOT NULL AND source_id IS NOT NULL;

