---
name: add-migration
description: "Crear una migración de base de datos CANON/Turso: solo aditiva, con respaldo y aprobación del owner."
---

# Add migration

1. **Requiere aprobación explícita del owner** para aplicarse en remoto, y respaldo previo verificado.
2. Archivo nuevo `infra/database/migrations/00NN_descripcion.sql` con el siguiente número libre. Solo aditiva: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` con default seguro, índices nuevos. Prohibido `DROP`, renombrar, reescribir o borrar datos, y tocar ventas/abonos pendientes.
3. El código del Worker debe funcionar con y sin la migración (comprobar el esquema, como `cash-session-cashier.js`).
4. Pruebas: test de migración en `tests/cloud-sync/canon-migration-00NN.test.mjs` (aplica sobre SQLite en memoria, idempotente, sin pérdida de datos) siguiendo los existentes.
5. Activación remota: workflow `canon-migration-00NN.yml` + `ops/canon-migration-00NN.json`, siguiendo el último par existente, solo tras aprobación. Nunca uses los workflows prohibidos de `docs/codex/ARCHITECTURE.md`.
