-- Receipt Vault — Tighten dedup to source_id alone
-- Message-IDs are globally unique per RFC 5322, so deduping on source_id
-- alone is safe and prevents re-import even if the source tag changes
-- (e.g. when Delivered-To detection reformats the source value).

DROP INDEX IF EXISTS idx_receipts_source_dedup;

CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_source_id_dedup
  ON receipts(source_id)
  WHERE source_id IS NOT NULL;
