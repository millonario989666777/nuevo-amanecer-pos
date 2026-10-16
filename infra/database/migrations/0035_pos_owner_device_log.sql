-- PROTOTIPO DEL ASISTENTE (rama feature/asistente-aislado). ESCRITA Y NO APLICADA EN NINGÚN LADO.
-- Bitácora del registro del aparato del dueño (rutas /auth/assistant/owner-device/*, detrás de ASSISTANT_OWNER_BOOTSTRAP=1).
-- Antes de aplicarla: copia de respaldo en R2 y visto bueno del jefe (ver docs/asistente/PLAN.md). Aditiva: una tabla nueva.
CREATE TABLE IF NOT EXISTS pos_owner_device_log (
  event_id        TEXT PRIMARY KEY NOT NULL CHECK (length(event_id) BETWEEN 1 AND 64),
  event           TEXT NOT NULL CHECK (event IN ('register_first', 'request', 'approve', 'reject', 'revoke')),
  device_id       TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 160),
  actor_device_id TEXT NOT NULL CHECK (length(actor_device_id) BETWEEN 1 AND 160),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pos_owner_device_log_device ON pos_owner_device_log(device_id, created_at);
