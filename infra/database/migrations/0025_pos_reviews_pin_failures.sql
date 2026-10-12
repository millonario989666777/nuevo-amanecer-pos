-- Etapa 2 (G, auditoría): bloqueo del PIN por aparato y revisiones del dueño.
-- Aditiva: solo tablas nuevas. No cambia ventas, cajas ni créditos.
-- pos_pin_failures: fallos del PIN del dueño por aparato (5 fallos = 15 min) y tope global
--   (20 fallos en 15 min entre todos los aparatos).
-- pos_review_flags: lo que el dueño debe revisar. Nunca edita la venta ni la caja:
--   'discount' = venta de un aparato empleado por debajo del precio del catálogo,
--   'cash_close_diff' = cierre de caja de un empleado con diferencia.
CREATE TABLE IF NOT EXISTS pos_pin_failures (
  device_id     TEXT PRIMARY KEY NOT NULL CHECK (length(device_id) BETWEEN 1 AND 160),
  failed_count  INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  window_start  TEXT NOT NULL,
  locked_until  TEXT
);
CREATE TABLE IF NOT EXISTS pos_review_flags (
  flag_id        TEXT PRIMARY KEY NOT NULL CHECK (length(flag_id) BETWEEN 1 AND 200),
  kind           TEXT NOT NULL CHECK (kind IN ('discount', 'cash_close_diff')),
  ref_id         TEXT NOT NULL CHECK (length(ref_id) BETWEEN 1 AND 160),
  device_id      TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 160),
  amount_cents   INTEGER NOT NULL,
  detail_json    TEXT NOT NULL CHECK (json_valid(detail_json) AND length(detail_json) <= 4000),
  status         TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'aprobado', 'rechazado')),
  shortage_cents INTEGER NOT NULL DEFAULT 0 CHECK (shortage_cents >= 0),
  note           TEXT CHECK (note IS NULL OR length(note) <= 200),
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  resolved_by    TEXT
);
