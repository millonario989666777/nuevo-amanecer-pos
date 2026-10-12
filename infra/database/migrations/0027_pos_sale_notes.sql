-- Etapa 2 (ítem 10): nota opcional de una venta CANON.
-- Aditiva: una tabla nueva. Nunca cambia montos, ventas, cajas, créditos ni stock.
-- Una fila por venta; volver a enviar la misma nota es idempotente.
CREATE TABLE IF NOT EXISTS pos_sale_notes (
  sale_id      TEXT PRIMARY KEY NOT NULL CHECK (length(sale_id) BETWEEN 1 AND 160),
  note         TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 300),
  principal_id TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
