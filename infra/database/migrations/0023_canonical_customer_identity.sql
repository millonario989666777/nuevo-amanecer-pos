-- Editable DNI/RUC and address (CANON). Purely additive: one append-only table
-- written in the SAME batch as a customer.contact.set revision (shares its
-- operation_id, CAS revision and authorization). Imports, contacts and
-- financial history are never modified.
CREATE TABLE IF NOT EXISTS canonical_customer_identities (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES canonical_customer_contacts(operation_id),
  promotion_id TEXT NOT NULL REFERENCES canonical_promotions(promotion_id),
  customer_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  document TEXT CHECK(document IS NULL OR ((length(document)=8 OR length(document)=11) AND document NOT GLOB '*[^0-9]*')),
  address TEXT CHECK(address IS NULL OR length(trim(address)) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL,
  UNIQUE(promotion_id,customer_id,revision),
  FOREIGN KEY(promotion_id,customer_id) REFERENCES canonical_customer_registry(promotion_id,customer_id)
);
-- Effective identity per customer: latest identity edit, else the base row.
CREATE VIEW IF NOT EXISTS canonical_customer_effective_identity AS
SELECT b.promotion_id,b.customer_id,
  COALESCE((SELECT k.name FROM canonical_customer_contacts k
    WHERE k.promotion_id=b.promotion_id AND k.customer_id=b.customer_id
    ORDER BY k.revision DESC LIMIT 1),b.name) AS name,
  CASE WHEN i.operation_id IS NULL THEN b.document ELSE i.document END AS document,
  CASE WHEN i.operation_id IS NULL THEN b.address ELSE i.address END AS address
FROM (
  SELECT promotion_id,customer_id,name,document,address FROM customers
  UNION ALL SELECT promotion_id,customer_id,name,document,address FROM canonical_live_customers
) b
LEFT JOIN canonical_customer_identities i
  ON i.promotion_id=b.promotion_id AND i.customer_id=b.customer_id
  AND i.revision=(SELECT MAX(x.revision) FROM canonical_customer_identities x
    WHERE x.promotion_id=b.promotion_id AND x.customer_id=b.customer_id);
-- Must ride on the contact revision of the same operation (authorized there).
CREATE TRIGGER IF NOT EXISTS customer_identity_contact_insert
BEFORE INSERT ON canonical_customer_identities
WHEN NOT EXISTS(SELECT 1 FROM canonical_customer_contacts c
  WHERE c.operation_id=NEW.operation_id AND c.promotion_id=NEW.promotion_id
    AND c.customer_id=NEW.customer_id AND c.revision=NEW.revision AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'stale_contact'); END;
-- One DNI/RUC per customer (effective documents, the edited customer excluded).
CREATE TRIGGER IF NOT EXISTS customer_identity_document_unique
BEFORE INSERT ON canonical_customer_identities
WHEN NEW.document IS NOT NULL AND EXISTS(
  SELECT 1 FROM canonical_customer_effective_identity v
  WHERE v.promotion_id=NEW.promotion_id AND v.customer_id<>NEW.customer_id
    AND lower(trim(COALESCE(v.document,'')))=NEW.document)
BEGIN SELECT RAISE(ABORT,'customer_document_conflict'); END;
CREATE TRIGGER IF NOT EXISTS customer_identity_no_update
BEFORE UPDATE ON canonical_customer_identities
BEGIN SELECT RAISE(ABORT,'immutable_customer_identity'); END;
CREATE TRIGGER IF NOT EXISTS customer_identity_no_delete
BEFORE DELETE ON canonical_customer_identities
BEGIN SELECT RAISE(ABORT,'immutable_customer_identity'); END;
-- A new live customer cannot take a DNI/RUC assigned through an identity edit.
CREATE TRIGGER IF NOT EXISTS canonical_live_customers_identity_document
BEFORE INSERT ON canonical_live_customers
WHEN NEW.document IS NOT NULL AND trim(NEW.document)<>'' AND EXISTS(
  SELECT 1 FROM canonical_customer_effective_identity v
  WHERE v.promotion_id=NEW.promotion_id AND v.customer_id<>NEW.customer_id
    AND lower(trim(COALESCE(v.document,'')))=lower(trim(NEW.document)))
BEGIN SELECT RAISE(ABORT,'invalid_live_customer'); END;
