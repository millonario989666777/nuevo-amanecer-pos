-- Etapa 2 (ítem 11): registro de compras con proveedor y costo.
-- Aditiva: dos tablas nuevas. El stock entra con inventory.adjust ENTRADA por línea
--   (operation_id '<compra>:<línea>', el mismo que ya usa la app), así reintentar nunca duplica stock.
-- Nunca cambia ventas, cajas ni créditos. El costo queda registrado; no edita el costo del producto.
CREATE TABLE IF NOT EXISTS pos_purchases (
  purchase_id      TEXT PRIMARY KEY NOT NULL CHECK (length(purchase_id) BETWEEN 1 AND 120),
  promotion_id     TEXT NOT NULL,
  supplier         TEXT CHECK (supplier IS NULL OR length(supplier) BETWEEN 1 AND 120),
  document_ref     TEXT CHECK (document_ref IS NULL OR length(document_ref) BETWEEN 1 AND 80),
  total_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cost_cents >= 0),
  line_count       INTEGER NOT NULL CHECK (line_count BETWEEN 1 AND 200),
  status           TEXT NOT NULL DEFAULT 'en_curso' CHECK (status IN ('en_curso', 'aplicada')),
  principal_id     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  completed_at     TEXT
);
CREATE TABLE IF NOT EXISTS pos_purchase_lines (
  purchase_id     TEXT NOT NULL REFERENCES pos_purchases(purchase_id),
  line_number     INTEGER NOT NULL CHECK (line_number BETWEEN 0 AND 10000),
  product_id      TEXT NOT NULL CHECK (length(product_id) BETWEEN 1 AND 160),
  quantity        REAL NOT NULL CHECK (quantity > 0),
  unit_cost_cents INTEGER CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  PRIMARY KEY (purchase_id, line_number)
);
