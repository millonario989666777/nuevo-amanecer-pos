-- Append-only product metadata edits (product.update). Additive only: the
-- sealed import image (products) and LIVE rows (canonical_live_products) are
-- never updated. Reads overlay the latest revision per product. Stock is NOT
-- editable here; it keeps changing only through sales and inventory.adjust.
CREATE TABLE IF NOT EXISTS canonical_product_revisions (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 160),
  promotion_id TEXT NOT NULL REFERENCES canonical_promotions(promotion_id),
  product_id TEXT NOT NULL CHECK(length(product_id) BETWEEN 1 AND 160),
  command TEXT NOT NULL CHECK(command='product.update'),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  revision INTEGER NOT NULL CHECK(revision>=1),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 240),
  sku TEXT CHECK(sku IS NULL OR length(trim(sku)) BETWEEN 1 AND 160),
  barcode TEXT CHECK(barcode IS NULL OR length(trim(barcode)) BETWEEN 1 AND 160),
  alternate_codes_json TEXT NOT NULL CHECK(json_valid(alternate_codes_json) AND json_type(alternate_codes_json)='array' AND json_array_length(alternate_codes_json)<=10),
  category TEXT,
  brand TEXT,
  description TEXT,
  icon TEXT,
  cost_cents INTEGER NOT NULL CHECK(cost_cents>=0 AND cost_cents<=9007199254740991),
  price_cents INTEGER NOT NULL CHECK(price_cents>0 AND price_cents<=9007199254740991),
  box_price_cents INTEGER CHECK(box_price_cents IS NULL OR (box_price_cents>0 AND box_price_cents<=9007199254740991)),
  units_per_box REAL CHECK(units_per_box IS NULL OR (units_per_box=units_per_box AND units_per_box>0 AND abs(units_per_box)<1.7976931348623157e308)),
  stock_min_quantity REAL NOT NULL CHECK(stock_min_quantity=stock_min_quantity AND stock_min_quantity>=0),
  expiry_date TEXT CHECK(expiry_date IS NULL OR expiry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  authority_epoch INTEGER NOT NULL CHECK(authority_epoch>=0),
  control_revision INTEGER NOT NULL CHECK(control_revision>=0),
  client_contract TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES devices(device_id),
  credential_hash TEXT NOT NULL CHECK(length(credential_hash)=64 AND credential_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE(promotion_id,product_id,revision)
);
CREATE TRIGGER IF NOT EXISTS canonical_product_revision_authorized_insert
BEFORE INSERT ON canonical_product_revisions
WHEN NOT EXISTS(
  SELECT 1 FROM canonical_control c JOIN devices d ON d.device_id=NEW.principal_id
  WHERE c.id=1 AND c.mode='ACTIVE' AND c.active_promotion_id=NEW.promotion_id
    AND c.authority_epoch=NEW.authority_epoch AND c.revision=NEW.control_revision
    AND c.minimum_client_contract=NEW.client_contract AND d.role='writer'
    AND d.status='active' AND d.credential_hash=NEW.credential_hash
)
BEGIN SELECT RAISE(ABORT,'stale_authority'); END;
CREATE TRIGGER IF NOT EXISTS canonical_product_revision_sequence_insert
BEFORE INSERT ON canonical_product_revisions
WHEN NEW.revision <> COALESCE((SELECT MAX(revision) FROM canonical_product_revisions
  WHERE promotion_id=NEW.promotion_id AND product_id=NEW.product_id),0)+1
BEGIN SELECT RAISE(ABORT,'stale_product'); END;
CREATE TRIGGER IF NOT EXISTS canonical_product_revision_target_insert
BEFORE INSERT ON canonical_product_revisions
WHEN NOT EXISTS(SELECT 1 FROM products p WHERE p.promotion_id=NEW.promotion_id AND p.product_id=NEW.product_id)
 AND NOT EXISTS(SELECT 1 FROM canonical_live_products p WHERE p.promotion_id=NEW.promotion_id AND p.product_id=NEW.product_id)
BEGIN SELECT RAISE(ABORT,'product_not_found'); END;
CREATE TRIGGER IF NOT EXISTS canonical_product_revision_stock_min_insert
BEFORE INSERT ON canonical_product_revisions
WHEN NEW.stock_min_quantity<>0 AND (
  EXISTS(SELECT 1 FROM products p WHERE p.promotion_id=NEW.promotion_id AND p.product_id=NEW.product_id AND p.tracks_inventory=0)
  OR EXISTS(SELECT 1 FROM canonical_live_products p WHERE p.promotion_id=NEW.promotion_id AND p.product_id=NEW.product_id AND p.tracks_inventory=0)
)
BEGIN SELECT RAISE(ABORT,'invalid_product_update'); END;
-- Codes stay globally unique (case-insensitive) against the EFFECTIVE codes of
-- every other product: its latest revision if it has one, else its base row.
CREATE TRIGGER IF NOT EXISTS canonical_product_revision_codes_insert
BEFORE INSERT ON canonical_product_revisions
WHEN EXISTS(SELECT 1 FROM json_each(NEW.alternate_codes_json) WHERE type<>'text' OR trim(CAST(value AS TEXT))='')
  OR (
    SELECT COUNT(*) FROM json_each(json_insert(json_insert(NEW.alternate_codes_json,'$[#]',NEW.sku),'$[#]',NEW.barcode))
    WHERE type='text' AND trim(CAST(value AS TEXT))<>''
  ) <> (
    SELECT COUNT(DISTINCT lower(trim(CAST(value AS TEXT)))) FROM json_each(json_insert(json_insert(NEW.alternate_codes_json,'$[#]',NEW.sku),'$[#]',NEW.barcode))
    WHERE type='text' AND trim(CAST(value AS TEXT))<>''
  )
  OR EXISTS(
    SELECT 1 FROM json_each(json_insert(json_insert(NEW.alternate_codes_json,'$[#]',NEW.sku),'$[#]',NEW.barcode)) incoming
    WHERE incoming.type='text' AND trim(CAST(incoming.value AS TEXT))<>''
    -- Codes this product already carries stay valid (legacy imports may share codes).
    AND lower(trim(CAST(incoming.value AS TEXT))) NOT IN (
      SELECT lower(trim(CAST(c.value AS TEXT))) FROM canonical_product_revisions r
        JOIN json_each(json_insert(json_insert(r.alternate_codes_json,'$[#]',r.sku),'$[#]',r.barcode)) c
        WHERE r.promotion_id=NEW.promotion_id AND r.product_id=NEW.product_id AND r.revision=NEW.revision-1 AND c.type='text'
      UNION ALL
      SELECT lower(trim(CAST(c.value AS TEXT))) FROM products p
        JOIN json_each(json_insert(json_insert(json_insert(COALESCE(p.alternate_codes_json,'[]'),'$[#]',p.sku),'$[#]',p.barcode),'$[#]',p.legacy_alternate_code)) c
        WHERE NEW.revision=1 AND p.promotion_id=NEW.promotion_id AND p.product_id=NEW.product_id AND c.type='text'
      UNION ALL
      SELECT lower(trim(CAST(c.value AS TEXT))) FROM canonical_live_products p
        JOIN json_each(json_insert(json_insert(COALESCE(p.alternate_codes_json,'[]'),'$[#]',p.sku),'$[#]',p.barcode)) c
        WHERE NEW.revision=1 AND p.promotion_id=NEW.promotion_id AND p.product_id=NEW.product_id AND c.type='text'
    ) AND (
      EXISTS(SELECT 1 FROM products p
        WHERE p.promotion_id=NEW.promotion_id AND p.product_id<>NEW.product_id
          AND NOT EXISTS(SELECT 1 FROM canonical_product_revisions r WHERE r.promotion_id=p.promotion_id AND r.product_id=p.product_id)
          AND (lower(trim(COALESCE(p.sku,'')))=lower(trim(CAST(incoming.value AS TEXT)))
            OR lower(trim(COALESCE(p.barcode,'')))=lower(trim(CAST(incoming.value AS TEXT)))
            OR lower(trim(COALESCE(p.legacy_alternate_code,'')))=lower(trim(CAST(incoming.value AS TEXT)))
            OR EXISTS(SELECT 1 FROM json_each(p.alternate_codes_json) e WHERE e.type='text' AND lower(trim(CAST(e.value AS TEXT)))=lower(trim(CAST(incoming.value AS TEXT))))))
      OR EXISTS(SELECT 1 FROM canonical_live_products p
        WHERE p.promotion_id=NEW.promotion_id AND p.product_id<>NEW.product_id
          AND NOT EXISTS(SELECT 1 FROM canonical_product_revisions r WHERE r.promotion_id=p.promotion_id AND r.product_id=p.product_id)
          AND (lower(trim(COALESCE(p.sku,'')))=lower(trim(CAST(incoming.value AS TEXT)))
            OR lower(trim(COALESCE(p.barcode,'')))=lower(trim(CAST(incoming.value AS TEXT)))
            OR EXISTS(SELECT 1 FROM json_each(p.alternate_codes_json) e WHERE e.type='text' AND lower(trim(CAST(e.value AS TEXT)))=lower(trim(CAST(incoming.value AS TEXT))))))
      OR EXISTS(SELECT 1 FROM canonical_product_revisions r
        WHERE r.promotion_id=NEW.promotion_id AND r.product_id<>NEW.product_id
          AND r.revision=(SELECT MAX(x.revision) FROM canonical_product_revisions x WHERE x.promotion_id=r.promotion_id AND x.product_id=r.product_id)
          AND (lower(trim(COALESCE(r.sku,'')))=lower(trim(CAST(incoming.value AS TEXT)))
            OR lower(trim(COALESCE(r.barcode,'')))=lower(trim(CAST(incoming.value AS TEXT)))
            OR EXISTS(SELECT 1 FROM json_each(r.alternate_codes_json) e WHERE e.type='text' AND lower(trim(CAST(e.value AS TEXT)))=lower(trim(CAST(incoming.value AS TEXT))))))
    )
  )
BEGIN SELECT RAISE(ABORT,'product_code_conflict'); END;
-- A new LIVE product may not reuse a code that an edited product now carries.
CREATE TRIGGER IF NOT EXISTS canonical_live_products_revision_codes_insert
BEFORE INSERT ON canonical_live_products
WHEN EXISTS(
  SELECT 1 FROM json_each(json_insert(json_insert(COALESCE(NEW.alternate_codes_json,'[]'),'$[#]',NEW.sku),'$[#]',NEW.barcode)) incoming
  JOIN canonical_product_revisions r ON r.promotion_id=NEW.promotion_id
    AND r.revision=(SELECT MAX(x.revision) FROM canonical_product_revisions x WHERE x.promotion_id=r.promotion_id AND x.product_id=r.product_id)
  WHERE incoming.type='text' AND trim(CAST(incoming.value AS TEXT))<>'' AND (
    lower(trim(COALESCE(r.sku,'')))=lower(trim(CAST(incoming.value AS TEXT)))
    OR lower(trim(COALESCE(r.barcode,'')))=lower(trim(CAST(incoming.value AS TEXT)))
    OR EXISTS(SELECT 1 FROM json_each(r.alternate_codes_json) e WHERE e.type='text' AND lower(trim(CAST(e.value AS TEXT)))=lower(trim(CAST(incoming.value AS TEXT)))))
)
BEGIN SELECT RAISE(ABORT,'invalid_live_product'); END;
CREATE TRIGGER IF NOT EXISTS canonical_product_revision_no_update
BEFORE UPDATE ON canonical_product_revisions
BEGIN SELECT RAISE(ABORT,'immutable_product_revision'); END;
CREATE TRIGGER IF NOT EXISTS canonical_product_revision_no_delete
BEFORE DELETE ON canonical_product_revisions
BEGIN SELECT RAISE(ABORT,'immutable_product_revision'); END;
CREATE TRIGGER IF NOT EXISTS canonical_product_revision_no_replace
BEFORE INSERT ON canonical_product_revisions
WHEN EXISTS(SELECT 1 FROM canonical_product_revisions WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS canonical_product_revision_namespace_insert
BEFORE INSERT ON canonical_product_revisions
WHEN EXISTS(SELECT 1 FROM sales WHERE operation_id=NEW.operation_id) OR
EXISTS(SELECT 1 FROM canonical_financial_operations WHERE operation_id=NEW.operation_id) OR
EXISTS(SELECT 1 FROM canonical_expense_operations WHERE operation_id=NEW.operation_id) OR
EXISTS(SELECT 1 FROM canonical_product_operations WHERE operation_id=NEW.operation_id) OR
EXISTS(SELECT 1 FROM canonical_inventory_operations WHERE operation_id=NEW.operation_id) OR
EXISTS(SELECT 1 FROM canonical_credit_accounts WHERE operation_id=NEW.operation_id) OR
EXISTS(SELECT 1 FROM canonical_credit_metadata WHERE operation_id=NEW.operation_id) OR
EXISTS(SELECT 1 FROM canonical_customer_operations WHERE operation_id=NEW.operation_id) OR
EXISTS(SELECT 1 FROM canonical_customer_credit_policy_operations WHERE operation_id=NEW.operation_id) OR
EXISTS(SELECT 1 FROM canonical_customer_contacts WHERE operation_id=NEW.operation_id) OR
EXISTS(SELECT 1 FROM canonical_command_receipts WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS sales_product_revision_collision
BEFORE INSERT ON sales
WHEN EXISTS(SELECT 1 FROM canonical_product_revisions WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS canonical_financial_operations_product_revision_collision
BEFORE INSERT ON canonical_financial_operations
WHEN EXISTS(SELECT 1 FROM canonical_product_revisions WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS canonical_expense_operations_product_revision_collision
BEFORE INSERT ON canonical_expense_operations
WHEN EXISTS(SELECT 1 FROM canonical_product_revisions WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS canonical_product_operations_product_revision_collision
BEFORE INSERT ON canonical_product_operations
WHEN EXISTS(SELECT 1 FROM canonical_product_revisions WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS canonical_inventory_operations_product_revision_collision
BEFORE INSERT ON canonical_inventory_operations
WHEN EXISTS(SELECT 1 FROM canonical_product_revisions WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS canonical_credit_accounts_product_revision_collision
BEFORE INSERT ON canonical_credit_accounts
WHEN EXISTS(SELECT 1 FROM canonical_product_revisions WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS canonical_credit_metadata_product_revision_collision
BEFORE INSERT ON canonical_credit_metadata
WHEN EXISTS(SELECT 1 FROM canonical_product_revisions WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS canonical_customer_operations_product_revision_collision
BEFORE INSERT ON canonical_customer_operations
WHEN EXISTS(SELECT 1 FROM canonical_product_revisions WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS canonical_customer_credit_policy_operations_product_revision_collision
BEFORE INSERT ON canonical_customer_credit_policy_operations
WHEN EXISTS(SELECT 1 FROM canonical_product_revisions WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS canonical_customer_contacts_product_revision_collision
BEFORE INSERT ON canonical_customer_contacts
WHEN EXISTS(SELECT 1 FROM canonical_product_revisions WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS canonical_command_receipts_product_revision_collision
BEFORE INSERT ON canonical_command_receipts
WHEN EXISTS(SELECT 1 FROM canonical_product_revisions WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation_id_conflict'); END;
