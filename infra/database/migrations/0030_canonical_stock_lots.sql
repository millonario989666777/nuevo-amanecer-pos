-- Lotes opcionales. Stock total/revisión permanecen en products/live_products.
-- Sin lote = stock total menos SUM(quantity). Un ingreso tiene identidad por operación/índice.
CREATE TABLE IF NOT EXISTS canonical_stock_lots (
  promotion_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  lot_id TEXT NOT NULL CHECK (length(lot_id) BETWEEN 1 AND 240),
  lot_code TEXT NOT NULL CHECK (length(lot_code) BETWEEN 1 AND 120),
  expiry_date TEXT NOT NULL CHECK (length(expiry_date)=10),
  quantity REAL NOT NULL DEFAULT 0 CHECK (quantity>=0),
  received_at TEXT NOT NULL,
  receipt_operation_id TEXT NOT NULL,
  PRIMARY KEY (promotion_id,product_id,lot_id)
);
CREATE INDEX IF NOT EXISTS canonical_stock_lots_fefo
  ON canonical_stock_lots(promotion_id,product_id,expiry_date,received_at,lot_id);
-- Asignación durable: '' representa el remanente sin lote.
CREATE TABLE IF NOT EXISTS canonical_stock_lot_effects (
  promotion_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity!=0),
  sale_id TEXT,
  created_at TEXT NOT NULL,
  expired_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (expired_confirmed IN (0,1)),
  PRIMARY KEY (operation_id,product_id,lot_id)
);
CREATE INDEX IF NOT EXISTS canonical_stock_lot_effects_sale
  ON canonical_stock_lot_effects(promotion_id,sale_id,product_id);
-- Contenido de lote del recibo de compra; conserva 0028/0029 intactas y reaplicación segura.
CREATE TABLE IF NOT EXISTS pos_purchase_line_lots (
  purchase_id TEXT NOT NULL REFERENCES pos_purchases(purchase_id),
  line_number INTEGER NOT NULL,
  lots_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (purchase_id,line_number),
  FOREIGN KEY (purchase_id,line_number) REFERENCES pos_purchase_lines(purchase_id,line_number)
);
