-- Etapa 2 (G): roles por aparato (dueño/empleado) y PIN del dueño validado solo por el servidor.
-- Aditiva: solo tablas nuevas. Un aparato sin fila en pos_device_roles es del dueño, así el
-- teléfono actual del dueño sigue funcionando igual. El PIN se guarda solo como hash PBKDF2 con sal.
CREATE TABLE IF NOT EXISTS pos_device_roles (
  device_id  TEXT PRIMARY KEY NOT NULL CHECK (length(device_id) BETWEEN 1 AND 160),
  pos_role   TEXT NOT NULL CHECK (pos_role IN ('owner', 'empleado')),
  label      TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 60),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pos_owner_pin (
  id           INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  salt_hex     TEXT NOT NULL CHECK (length(salt_hex) = 32 AND salt_hex NOT GLOB '*[^0-9a-f]*'),
  hash_hex     TEXT NOT NULL CHECK (length(hash_hex) = 64 AND hash_hex NOT GLOB '*[^0-9a-f]*'),
  iterations   INTEGER NOT NULL CHECK (iterations >= 10000),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until TEXT,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pos_pairing_codes (
  code_hash  TEXT PRIMARY KEY NOT NULL CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  pos_role   TEXT NOT NULL CHECK (pos_role IN ('empleado')),
  label      TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 60),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  used_by    TEXT
);
CREATE TABLE IF NOT EXISTS pos_owner_approvals (
  approval_id  TEXT PRIMARY KEY NOT NULL CHECK (length(approval_id) BETWEEN 1 AND 80),
  device_id    TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 60),
  operation_id TEXT CHECK (operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 200),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);
CREATE TABLE IF NOT EXISTS pos_settings (
  key        TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 60),
  value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 8000),
  revision   INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
