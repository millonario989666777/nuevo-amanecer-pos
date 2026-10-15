CREATE TABLE IF NOT EXISTS canonical_expense_revisions (
  operation_id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES canonical_expenses(expense_id),
  promotion_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  action TEXT NOT NULL CHECK(action IN ('edit','void')),
  concept TEXT,
  category TEXT,
  note TEXT,
  expense_date TEXT,
  request_hash TEXT NOT NULL,
  device_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(expense_id,revision)
);
CREATE INDEX IF NOT EXISTS idx_canonical_expense_revisions_promotion
  ON canonical_expense_revisions(promotion_id,expense_id);
