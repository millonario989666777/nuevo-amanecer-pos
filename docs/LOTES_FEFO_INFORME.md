# Informe local — Lotes, vencimiento FEFO y productos a vencer

Fecha: 2026-10-14. Implementador: CANON / pos-canon-implementer.
Directorio: `/workspace/wt-lotes`. Rama: `feat/lotes-vencimiento-fefo-v2`.
HEAD inicial/final: `ef32c1b465994e11c900566187f98df28c2431e2`.

Implementación local entregada, con gates de entorno/visual pendientes. No se hicieron commits, push, checkout, stash, reset, deploy, cambios de secrets, instalaciones ni migraciones remotas. No se escribieron archivos de producto en `laboratorio/**`. Migraciones anteriores y tests existentes permanecen intactos.

## Archivos y finalidad

| Archivos | Cambio / motivo |
| --- | --- |
| `POS/js/inventory/stock-lots.js` | Motor puro compartido: validación de recibos, cantidades físicas, FEFO, día comercial Lima y reporte. |
| `POS/js/inventory/stock-lots-ui.js`, `POS/css/stock-lots.css` | Lotes opcionales en ingresos; reporte 30/60/90/vencidos; contador por producto; confirmación explícita; DOM/textContent, modal con foco/Escape y controles >=44px. |
| `POS/index.html`, `POS/sw.js` | Carga del motor/UI y precache de los tres assets para el shell offline. |
| `POS/js/config/pos-purchases-client.js` | Lote/vencimiento por línea; varios lotes usando varias líneas del mismo producto; fingerprint e historial/terminación conservan lotes. |
| `POS/js/sync/canonical-inventory-bridge.js` | Pasa lotes por inventory.adjust/compra OCR; valida/advierte; no pierde metadatos en fallback por línea. |
| `POS/js/sync/canonical-client.js` | Payloads canónicos, misma identidad/journal, confirmación durable, fracciones físicas de productos con lotes, reserva pendiente y proyección de stock+lotes+revisión a partir del receipt. |
| `POS/js/sync/canonical-sale-intent.js` | Conserva consentimiento por línea sin cambiar versión ni IDs; no mezcla líneas con consentimiento diferente. |
| `POS/js/sync/canonical-sale-integration.js` | Verifica lotes proyectados y exige confirmación antes de guardar una venta que necesite vencidos. |
| `POS/js/sync/canonical-sale-outbox.js` | Mensajes claros para rechazos de vencidos/coherencia, conservando revisión durable y la cola existente. |
| `POS/js/sync/canonical-sale-projection.js`, `POS/js/sync/canonical-sale-view.js` | Reservan lotes pendientes y receipts; evitan doble consumo mientras se completa ACK/refresco. |
| `POS/js/adapters/canonical-ui-adapter.js` | Lleva lotes canónicos al catálogo de UI y respaldos. |
| `POS/js/legacy-inline/inline-03.js` | Backup/restore JSON admite lotes con límites, IDs únicos, fechas/cantidades válidas y suma <= stock; datos antiguos no inventan lotes. |
| `tools/cloudflare-lab/src/stock-lots.js` | Lectura agrupada, SQL parametrizado de ingresos/consumos/devolución y receipt de asignación real. |
| `tools/cloudflare-lab/src/a6-inventory.js` | Lotes y stock en el mismo batch CAS de inventory.adjust; replay/hash/autoridad existentes. Retorno a lotes solo desde el orquestador interno de anulación. |
| `tools/cloudflare-lab/src/a6-commerce.js` | FEFO en venta normal y rápida Turso, con asignaciones durables y rollback financiero completo; lectura agrupada evita una subrequest por producto. |
| `tools/cloudflare-lab/src/a6-canonical.js` | Lotes anidados en la misma lectura/réplica de productos y bajo la revisión canónica actual. |
| `tools/cloudflare-lab/src/pos-purchases.js` | Recibo de compra conserva lotes y exige contenido idéntico al reintentar; assertion de cabecera evita mezcla de lotes entre solicitudes concurrentes. |
| `tools/cloudflare-lab/src/pos-sale-annul.js` | Devuelve a los mismos lotes originalmente consumidos mediante el inventory.adjust idempotente actual. |
| `infra/database/migrations/0030_canonical_stock_lots.sql` | Única migración nueva; solo CREATE TABLE/INDEX IF NOT EXISTS. |
| `tests/cloud-sync/stock-lots-core.test.mjs`, `stock-lots-backend.test.mjs`, `stock-lots-ui-backup.test.mjs` | 25 casos nuevos; incluidos por el glob existente de CANON Critical CI. |
| `README.md`, `docs/LOTES_FEFO.md`, `docs/superpowers/plans/2026-10-14-lotes-fefo.md` | Contrato, decisiones, plan y comandos locales reproducibles. |
| `docs/LOTES_FEFO_INFORME.md`, `evidence/lotes-local/**` | Informe, logs completos, diff revisado, guard local y copia recuperable del código inicial. |

El Worker de producción reutiliza el backend versionado bajo `tools/cloudflare-lab`; no necesita una copia del motor bajo `tools/cloudflare-prod`.

## Diseño FEFO y vencidos

Cada ingreso crea IDs de lote derivados de `<operation_id>:lot:<índice>`, con código, vencimiento y cantidad física. Distintos ingresos con igual código siguen siendo recibos distintos. Stock sin lote = stock total canónico menos suma de lotes.

Orden: lotes vigentes por fecha de vencimiento, instante de ingreso e ID; después remanente sin lote. Vencimiento inclusivo: un lote se permite durante su fecha de vencimiento y está vencido cuando su fecha es anterior al día comercial Lima de la venta (`created_at`, UTC-5).

Si lo vigente y sin lote no alcanza, se bloquea la venta. Solo la aceptación explícita del diálogo para esa venta guarda `allow_expired_lots:true`; permite completar con vencidos al final, también ordenados FEFO. Cancelar conserva el carrito y no crea venta. No se recuerda autorización para otras ventas ni se añade automáticamente en un retry. El Worker valida también a clientes antiguos que omitan el consentimiento.

Anulación: lee asignaciones originales, devuelve esas cantidades a esos IDs y recupera también el remanente sin lote. No recalcula FEFO ni borra ventas. Las compras completas y anulaciones mantienen la orquestación recuperable existente; **cada movimiento de stock y sus lotes es atómico**, no se afirma atomicidad nueva de toda la anulación/caja entre múltiples comandos.

El reporte usa hoy en Lima y ventanas acumulativas inclusivas 0..30, 0..60, 0..90; vencidos usa días <0. Excluye saldos cero. El badge cuenta productos distintos con lotes vencidos o a vencer en 30 días. El remanente sin lote no recibe una fecha inventada.

## Offline, persistencia y compatibilidad

Sin rutas ni outbox paralelos. Venta viaja por `sale.create`, ingresos/salidas por `inventory.adjust`; compra mantiene IDs `<compra>:<línea>`. Misma estrategia de revisiones CAS, hash, autorización y recibos. La intención offline guarda fecha/consentimiento antes de enviar y conserva su operation_id en recarga/retry. El Worker calcula la asignación y la graba en el batch de venta/stock/caja. ACK perdido devuelve el consumo durable sin volver a descontar.

La proyección reserva lotes entre ventas pendientes. Una salida manual de un producto con lotes y ventas pendientes de ese producto se bloquea hasta confirmarlas, incluidas fracciones; evita consumir físicamente el lote vigente ya reservado por una venta cobrada offline. El receipt actualiza cantidades/revisión y el reporte comparte la vista completa durante ACK/refresco.

Productos/datos sin lotes conservan el camino existente. El backend sin 0030 acepta comandos antiguos; solicitudes que requieren lotes rechazan con schema_not_ready. Backup JSON incluye lotes del catálogo y el restore los valida. Restore comercial CANON no habilita persistencia legacy: recuperación autoritativa sigue siendo SQL/backend; el export completo SQL incluye las tablas nuevas y asignaciones. Compras/anulaciones completas siguen necesitando internet según su comportamiento actual.

## Comandos y resultados exactos

Para todos los comandos amplios se establecieron `TMPDIR`, `TMP` y `TEMP` en `$PWD/evidence/lotes-local/tmp`. El guard `evidence/lotes-local/local-test-guard.cjs` bloquea commits/fetch y herramientas prohibidas incluso dentro de tests existentes, y bloquea fetch externo; los dobles de transporte locales de tests se conservan. No modifica assertions ni expectativas.

```sh
NODE_OPTIONS="--require=$PWD/evidence/lotes-local/local-test-guard.cjs" node --test tests/product-fixes/fix*/*.test.mjs tests/product-fixes/canonical-ui-contract.test.mjs tests/product-fixes/canon-ticket-unified-editor.test.mjs tests/backup-complete.test.mjs tests/backup-restore.test.mjs tests/repo-map.test.mjs tests/security-secret-separation.test.mjs tests/cloud-sync/*.test.mjs
```

Exit 1; Node v20.19.2: **141 archivos, 78 PASS, 63 FAIL**, 0 skipped/cancelled/todo. 60 fallan al importar `node:sqlite`; 2 por dependencias ausentes (`esbuild`, `exceljs`); 1 (`neutral-migrations-contract`) por `spawnSync git EPERM`. Log: `evidence/lotes-local/node-full-final.log`. Son limitaciones preexistentes de entorno, comprobadas leyendo los imports/código de HEAD, no regresiones del parche. Se requiere Node22 como en CI.

```sh
bun test --preload ./evidence/lotes-local/local-test-guard.cjs tests/product-fixes/fix*/*.test.mjs tests/product-fixes/canonical-ui-contract.test.mjs tests/product-fixes/canon-ticket-unified-editor.test.mjs tests/backup-complete.test.mjs tests/backup-restore.test.mjs tests/repo-map.test.mjs tests/security-secret-separation.test.mjs tests/cloud-sync/*.test.mjs
```

Exit 1; Bun v1.4.2: **1143 PASS, 2 SKIP, 10 FAIL, 2 errores**, 1155 tests / 141 archivos, 57.60s. Log: `evidence/lotes-local/bun-full-final.log`. Los dos imports faltantes cuentan en fallos/errores. Los otros ocho fallos son `workflow refresh preserves ancestry needed to validate approved feature commit`, en `canon-migration-0023`, `canon-migration-0024`, `canon-migration-0025`, `canon-migration-0026`, `canon-migration-0027`, `canon-migration-0028`, `canon-migrations-0021-0022` y `canon-receipts-activation`: intentan commits/fetch de Git, prohibidos por el owner. Dos skips ya declarados en `canon-migration-0029` por workflow ausente. Sin regresiones de assertions detectadas; ningún test existente debilitado.

```sh
bun test tests/cloud-sync/stock-lots-core.test.mjs tests/cloud-sync/stock-lots-backend.test.mjs tests/cloud-sync/stock-lots-ui-backup.test.mjs
```

Exit 0: **25 PASS, 0 FAIL**, 3 archivos, 1.67s. Log `evidence/lotes-local/new-tests-final.log`. Incluye FEFO/empates/decimales/vencidos/sin lote, reporte, compras concurrentes, anulación, schema completo 0001..0030, reaplicación aditiva, CAS/rollback, sesión fast Turso, offline/reload/ACK, rechazo durable, reserva pendiente y backup/restore.

```sh
bun test tests/cloud-sync/stock-lots-core.test.mjs tests/cloud-sync/stock-lots-backend.test.mjs tests/cloud-sync/stock-lots-ui-backup.test.mjs tests/cloud-sync/pos-purchases.test.mjs tests/cloud-sync/bot6-purchase-finish.test.mjs
```

Exit 0: **37 PASS, 0 FAIL**, 5 archivos, 2.29s; `purchase-race-green.log`. Antes de la corrección, el test con barrera de compras mostró `purchase_line_failed` en lugar de rechazar contenido ajeno antes de efectos (`purchase-race-red.log`).

```sh
bun test tests/cloud-sync/stock-lots-backend.test.mjs tests/cloud-sync/stock-lots-core.test.mjs tests/cloud-sync/stock-lots-ui-backup.test.mjs tests/cloud-sync/canonical-sale-turso-root.test.mjs tests/cloud-sync/canonical-targeted-refresh.test.mjs tests/cloud-sync/canonical-sale-view.test.mjs tests/cloud-sync/canonical-inventory-adjust.test.mjs tests/cloud-sync/pos-sale-annul.test.mjs tests/cloud-sync/pos-purchases.test.mjs
```

Exit 0: **86 PASS, 0 FAIL**, 9 archivos, 9.43s; `focused.log` (corrida anterior al último refuerzo de carrera; regresión completa posterior cubre el estado final).

`node --test tests/cloud-sync/stock-lots-core.test.mjs`: rojo inicial por motor ausente; verde tras implementación. `node --test tests/cloud-sync/stock-lots-backend.test.mjs`: bloqueo inicial por node:sqlite ausente. Se verificaron las nuevas pruebas con Bun; logs RED→GREEN conservados.

`TMPDIR="$PWD/evidence/lotes-local/tmp" node evidence/lotes-local/browser-check.cjs` y alternativa con `bun`: exit 1 antes de ejecutar escenarios; Chromium SIGTRAP / `setsockopt: Operation not permitted`. El script define 320/360/390/430/768/1024/1366/1920, filtros, ingreso, confirmación y controles, pero **ninguno de esos anchos queda declarado PASS**. Logs `browser.log`, `browser-bun.log`.

`git diff --check`: exit 0, sin errores. Diff completo revisado y guardado en `tracked-diff.patch`; archivos nuevos revisados también. Rama y HEAD sin cambios. Copia inicial `baseline.tar`, SHA256 `8fcbccbe6825c8d412bc83ccddda001dfd8296338692ae79e8a753c2aae91465`.

`node --test tests/repo-map.test.mjs tests/security-secret-separation.test.mjs`: exit 0, 2 archivos PASS / 0 FAIL; `repo-security-final.log` tras escribir el informe.

## Revisión independiente y pendientes

Reviewer/Forensic independiente READ-ONLY: sin P0/P1 abiertos identificados tras correcciones. Verificó 26/26 del contrato Turso original y 22/22 casos de lotes durante revisión; última comprobación acotada de fast/carrera/reporte: 3 PASS, 0 FAIL, 13 filtrados. Cerró la observación del reporte entre replay y refresh. No sustituyó validación visual.

Pendientes: ejecutar Node22 con dependencias ya disponibles, CANON Critical/E2E y preview del SHA candidato cuando se autorice el flujo con red; validación real de los ocho anchos y Android offline. No se puede declarar release completo ni preview visual aprobado en este entorno. La lectura de productos agrega una consulta agrupada para lotes por página; medir CPU/tamaño con catálogo real y muchos lotes antes de release. El schema cache frío puede consultar sqlite_master una vez; no se elimina esa detección de compatibilidad para optimizar.

Stock offline de otro dispositivo sigue siendo optimista bajo el contrato canónico actual: un cambio concurrente puede mandar una venta cobrada a revisión; no se introduce reserva global/multiwriter. Fecha offline usa el reloj de captura como ya ocurría; no se inventa una nueva autoridad horaria.

Se conserva el límite anterior de `sale.annul`: las ventas a crédito no se anulan por ese comando. La devolución exacta de lotes aplica a las anulaciones soportadas actualmente; esta feature no cambia la política de reversión de crédito/caja.
