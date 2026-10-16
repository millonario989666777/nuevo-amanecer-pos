-- PROTOTIPO DEL ASISTENTE (rama feature/asistente-aislado). ESCRITA Y NO APLICADA EN NINGÚN LADO.
-- Antes de aplicarla: copia de respaldo en R2 y visto bueno del jefe (ver docs/asistente/PLAN.md).
-- Aditiva: solo una tabla nueva de bitácora. El nivel del asistente por aparato vive en pos_settings
-- (clave internal:asst:lvl:<hash>), que ya existe; sin esta tabla el permiso funciona igual, solo no se anota.
CREATE TABLE IF NOT EXISTS pos_assistant_access_log (
  event_id   TEXT PRIMARY KEY NOT NULL CHECK (length(event_id) BETWEEN 1 AND 64),
  device_id  TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 160),
  level      TEXT NOT NULL CHECK (level IN ('off', 'consultas', 'consultas_documentos')),
  changed_by TEXT NOT NULL CHECK (length(changed_by) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pos_assistant_access_log_device ON pos_assistant_access_log(device_id, created_at);
