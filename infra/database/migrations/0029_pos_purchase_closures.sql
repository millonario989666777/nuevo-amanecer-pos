-- Bot 6 ítem 9: cerrar como parcial una compra atascada (una línea ya no se puede aplicar).
-- Aditiva: una tabla nueva. Solo el dueño (PIN maestro + motivo). Las líneas ya aplicadas se conservan,
-- las que faltan quedan como no aplicadas. Nunca toca stock, kardex, cajas ni ventas.
CREATE TABLE IF NOT EXISTS pos_purchase_closures (
  purchase_id     TEXT PRIMARY KEY NOT NULL REFERENCES pos_purchases(purchase_id),
  reason          TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  applied_lines   TEXT NOT NULL,
  missing_lines   TEXT NOT NULL,
  approval_id     TEXT,
  principal_id    TEXT NOT NULL,
  closed_at       TEXT NOT NULL
);
