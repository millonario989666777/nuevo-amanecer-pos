-- Etapa 2 (G, punto 4): anular una venta CANON en el servidor, solo con internet.
-- Aditiva: una tabla nueva. No cambia ventas, cajas, créditos ni stock existentes.
-- Una fila por venta (sale_id es la llave), así el stock vuelve una sola vez.
-- operation_id único: reintentar la misma anulación nunca repite efectos.
-- La devolución de efectivo es un ajuste de caja y el stock vuelve con entradas de inventario,
--   ambos con su propio operation_id derivado (operation_id + ':cash' y ':inv:N').
CREATE TABLE IF NOT EXISTS pos_sale_annulments (
  sale_id        TEXT PRIMARY KEY NOT NULL CHECK (length(sale_id) BETWEEN 1 AND 160),
  operation_id   TEXT NOT NULL UNIQUE CHECK (length(operation_id) BETWEEN 1 AND 120),
  promotion_id   TEXT NOT NULL,
  reason         TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  status         TEXT NOT NULL DEFAULT 'en_curso' CHECK (status IN ('en_curso', 'anulada')),
  cash_cents     INTEGER NOT NULL DEFAULT 0 CHECK (cash_cents >= 0),
  digital_cents  INTEGER NOT NULL DEFAULT 0 CHECK (digital_cents >= 0),
  result_json    TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND length(result_json) <= 8000)),
  principal_id   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  completed_at   TEXT
);
