# Respaldos de migraciones CANON (0031, 0032 y siguientes): cómo restaurar

Cada workflow `canon-migration-00NN.yml` toma, **antes** de aplicar la migración, un respaldo lógico completo de Turso (esquema + todas las tablas, en una sola transacción de lectura). Lo cifra en el runner y lo sube a R2 (`nuevo-amanecer-prod-v2-backups`, clave `canon-migration-00NN/<fecha>-<commit>.json`). La clave R2 exacta y el sha256 quedan en el resumen del run.

## Cifrado (estado actual)
- AES-256-GCM. La clave se deriva con `sha256('nuevo-amanecer-contact-backup-v1\0' + TURSO_PROD_AUTH_TOKEN)` y se usa el AAD `nuevo-amanecer-contact-backup-v1` (ver `encryptBackup` en `tools/cloudflare-prod/scripts/turso-customer-contacts-maintenance.mjs`).
- El archivo es un JSON con `iv`, `tag` y `data` en base64.
- **Riesgo conocido:** la clave sale del token de producción de Turso. Si ese token se rota, los respaldos anteriores solo se pueden descifrar con el token viejo. Antes de rotarlo, descifra los respaldos que quieras conservar y vuelve a cifrarlos.
- Una clave de respaldo dedicada (secreto nuevo, p. ej. `MIGRATION_BACKUP_KEY_SECRET`) eliminaría ese acoplamiento, pero exige crear un secreto en producción, así que **queda pendiente de que el dueño lo decida**.

## Restaurar (solo con autorización del dueño)
1. Descarga el objeto: `npx wrangler r2 object get "nuevo-amanecer-prod-v2-backups/<clave>" --remote --file=backup.enc.json` y comprueba que su sha256 coincide con el del run.
2. Descifra en una máquina de confianza, con el token disponible solo como variable de entorno (nunca lo pegues en archivos ni en logs):
   ```js
   import {readFileSync,writeFileSync} from 'node:fs';import {createHash,createDecipheriv} from 'node:crypto';
   const e=JSON.parse(readFileSync('backup.enc.json','utf8'));
   const key=createHash('sha256').update('nuevo-amanecer-contact-backup-v1\0'+process.env.TURSO_PROD_AUTH_TOKEN).digest();
   const d=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));d.setAAD(Buffer.from('nuevo-amanecer-contact-backup-v1'));d.setAuthTag(Buffer.from(e.tag,'base64'));
   writeFileSync('backup.json',Buffer.concat([d.update(Buffer.from(e.data,'base64')),d.final()]),{mode:0o600});
   ```
3. `backup.json` contiene `schema` (sentencias `sql` de `sqlite_master`) y `tables` (filas por tabla).
   - Restaura primero en una base Turso **nueva o de staging**: crea el esquema y luego inserta las filas tabla por tabla. Los triggers del libro inmutable van **después** de los datos.
   - Verifica conteos y `financial_revision`, y solo entonces cambia el worker a esa base.
4. Las migraciones son aditivas. Para deshacer solo 0032 no hace falta restaurar: basta volver el worker a un commit anterior. La tabla nueva queda sin uso.
5. Borra `backup.json` y `backup.enc.json` al terminar: contienen datos de clientes.
