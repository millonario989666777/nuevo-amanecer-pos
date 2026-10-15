# Mapa de arquitectura (verificado contra el código)

## Carpetas principales
| Ruta | Contenido |
|---|---|
| `POS/` | App web (vanilla JS, sin bundler). Entrada `POS/index.html`, service worker `POS/sw.js`. |
| `POS/js/legacy-inline/inline-01.js … inline-18.js` | Lógica histórica extraída del HTML: venta (`posRender`), inventario, clientes (`cliRender`), caja (`cajRender`, `abrirCaja`, `cerrarCaja`), ventas (`ventasRender`), respaldo/snapshot. Se sobreescriben funciones por capas: el orden de los `<script>` en `index.html` importa. |
| `POS/js/core/` | Utilidades (`utils.js`, `state.js`, `lima-time.js`, `theme-state.js`, `lazy-assets.js`). |
| `POS/js/navigation/menu-navigation.js` | Navegación segura en móvil, drawer del teléfono (filas filtradas por rol, logo, línea de versión). |
| `POS/js/config/` | Permisos (`pos-permissions.js`), roles (`pos-roles-client.js`), Configuración (`config-v9.js`, `config-v9-boot.js`, `config-e2.js`, `config-g.js`), versión publicada (`build-info.js`), clientes de anulación, DNI, compras, notas y revisiones. |
| `POS/js/modules/` | `caja-movimientos-historial.js` (historial de caja), `proximamente.js` (registro solo-owner), `client-credit-accounts-v2.js`, `discount-sheet.js`, `ticket/`. |
| `POS/js/inventory/` | `stock-lots.js` y `stock-lots-ui.js` (lotes/FEFO), `mobile-inventory.js`. |
| `POS/js/products/` | Fotos de productos (`image-sync.js`, `image-batch.js`). |
| `POS/js/sync/` | Cliente CANON y puentes: `canonical-client.js` (lecturas/comandos), `canonical-sale-intent.js`, `canonical-sale-outbox.js`, `canonical-sale-integration.js`, `canonical-cash-bridge.js`, `canonical-expense-bridge.js`, `canonical-inventory-bridge.js`, `canonical-product-bridge.js`, `canonical-customer-bridge.js`, `canonical-credit-payment-bridge.js`, `outbox.js`, `hosted-canonical-guard.js`, `read-only.js`. |
| `POS/js/canon-phone-sale.js`, `canon-pos-reference-ui.js`, `canon-desktop-dashboard.js` | Venta en teléfono, UI de referencia de venta, Inicio de escritorio (**layouts protegidos**). |
| `tools/cloudflare-lab/` | **Worker backend usado también en producción** (no borrar por su nombre). `src/worker.js` (router), `src/a6-*.js` (comandos/lecturas canónicas), `src/pos-roles.js`, `src/pos-permissions.js`, `src/stock-lots.js`, `src/cash-session-cashier.js`, `src/turso-d1-adapter.js` (Turso con interfaz tipo D1). Tests en `tools/cloudflare-lab/test/`. |
| `tools/cloudflare-prod/` | Configs wrangler de producción (`wrangler.turso-prod.jsonc`). |
| `tools/cloudflare-pos-web/` | Worker estático público que sirve el POS en `/app/` y hace proxy de la API al backend (`src/worker.js`, `public/`). |
| `infra/database/migrations/` | Migraciones SQL numeradas (`00NN_*.sql`), solo aditivas. |
| `ops/` | Archivos JSON de disparo de workflows (deploy/migraciones). |
| `tests/` | Unit (`**/*.test.mjs`, p. ej. `tests/cloud-sync/`, `tests/product-fixes/`) y e2e (`tests/e2e/*.spec.ts`). |
| `laboratorio/` | POS-LAB retirado: solo histórico, no escribir. |

## Capas de CSS
Orden de carga en `POS/index.html`: `base.css` → `layout.css` → `components.css` → `responsive.css` → hojas CANON (`canon-*.css`, `config-*.css`, `inventario-redesign.css`, `mobile-drawer.css`, `proximamente.css`, …) → `theme-dark.css` → correcciones finales (`inventory-form-polish.css`). Para cambios nuevos prefiere una hoja CANON específica y acotada por id de página.
- `POS/css/experience-v2/pages/*.css` son **copias de laboratorio: no editar**. Se verifican con `node tools/pos-experience/promote-lab-visuals.mjs --check`.

## Backend y datos
- Cloudflare Worker (`tools/cloudflare-lab/src/worker.js`) + base de datos **Turso** (vía `turso-d1-adapter.js`).
- Autorización: `authorizeSession` resuelve el rol y aplica `NA_PERMISSIONS.routeRoles` (rutas no listadas = solo owner).

## Flujo de sync
1. La venta se arma como *intent* local y entra al **outbox** (`canonical-sale-outbox.js`, `outbox.js`); nunca se edita una venta/abono pendiente.
2. `canonical-client.js` envía comandos `/commands/*` con `operation_id` idempotente (reintentos devuelven *replay*).
3. Las lecturas `/read/canonical/*` (o el snapshot) rehidratan la réplica local bajo una revisión financiera (`financial_revision`) consistente.

## Deploy (solo vía ops JSON + PR mergeado a `feature/v1.3-mobile-cloud`)
- **Backend primero** cuando cambie código del Worker: `ops/v1.3-turso-prod-worker-hotfix-trigger.json` → workflow `.github/workflows/v1.3-turso-prod-worker-hotfix.yml` (incrementar `attempt`, `target_commit`, `rollback_ref`).
- **Web:** `ops/v1.3-pos-web-deploy-trigger.json` → `.github/workflows/v1.3-pos-web-deploy.yml` (incrementar `retry_attempt`, `approved_base`, `requested_at_utc`, rollback en `retry_reason`). Reemplaza `__BUILD_HASH__`/`__BUILD_DATE__` en `sw.js`, `index.html` y `js/config/build-info.js`.
- Migraciones remotas: workflows `canon-migration-00NN.yml` con su `ops/canon-migration-00NN.json`, solo con aprobación del owner y respaldo.

## Workflows que NUNCA se ejecutan/disparan sin orden explícita del owner
- `.github/workflows/production-release.yml`
- `.github/workflows/v1.3-prod-cutover.yml`
- `.github/workflows/v1.3-prod-browser-cors-hotfix.yml`
- `.github/workflows/canon-whatsapp-receipts-activation.yml`
- `.github/workflows/v1.3-live-migration-0018.yml`
- `.github/workflows/v1.3-turso-prod-cutover.yml` y `.github/workflows/v1.3-turso-prod-direct-cutover.yml`
(No modificar sus `ops/*-trigger.json`.)
