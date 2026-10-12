-- P1-1: one digital payment voucher (Yape/Plin/transferencia operation number) can settle debt
-- only once per promotion. Additive and safe on existing data:
--   * a NEW append-only table (no change to canonical_financial_events or any existing row),
--   * the PRIMARY KEY is the uniqueness guarantee inside the Worker's atomic batch,
--   * the backfill uses INSERT OR IGNORE, so historical duplicates (if any) never make the
--     migration fail: the earliest use keeps the reference, later duplicates stay untouched and
--     simply block further reuse.
-- reference_norm = trim, whitespace removed, ASCII lower-case (same rule as the Worker).
-- A batch (cobro múltiple) inserts ONE row with the batch operation_id.
CREATE TABLE IF NOT EXISTS canonical_payment_references (
  promotion_id TEXT NOT NULL REFERENCES canonical_promotions(promotion_id),
  reference_norm TEXT NOT NULL CHECK(length(reference_norm) BETWEEN 1 AND 160),
  operation_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(promotion_id,reference_norm)
);
CREATE TRIGGER IF NOT EXISTS payment_reference_no_update
BEFORE UPDATE ON canonical_payment_references
BEGIN SELECT RAISE(ABORT,'immutable_payment_reference'); END;
CREATE TRIGGER IF NOT EXISTS payment_reference_no_delete
BEFORE DELETE ON canonical_payment_references
BEGIN SELECT RAISE(ABORT,'immutable_payment_reference'); END;

INSERT OR IGNORE INTO canonical_payment_references(promotion_id,reference_norm,operation_id,created_at)
SELECT e.promotion_id,
  lower(replace(replace(replace(replace(trim(e.reference),' ',''),char(9),''),char(10),''),char(13),'')),
  e.operation_id,e.created_at
FROM canonical_financial_events e
WHERE e.event_type='PAYMENT' AND e.payment_method IN ('yape','plin','transferencia')
  AND e.reference IS NOT NULL AND length(trim(e.reference))>0
  AND NOT EXISTS(SELECT 1 FROM canonical_financial_events c WHERE c.compensates_operation_id=e.operation_id)
ORDER BY e.created_at,e.operation_id;
