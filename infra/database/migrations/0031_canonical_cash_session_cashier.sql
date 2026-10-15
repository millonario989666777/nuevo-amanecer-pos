ALTER TABLE canonical_cash_sessions ADD COLUMN opened_by_user_id TEXT;
ALTER TABLE canonical_cash_sessions ADD COLUMN opened_by_name TEXT;
ALTER TABLE canonical_cash_closures ADD COLUMN closed_by_user_id TEXT;
ALTER TABLE canonical_cash_closures ADD COLUMN closed_by_name TEXT;
