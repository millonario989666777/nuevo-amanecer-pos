---
name: add-permission
description: "Agregar o cambiar un permiso de rol (owner/empleado) en cliente y servidor con denegación por defecto y pruebas."
---

# Add permission

1. Única fuente: `POS/js/config/pos-permissions.js` (`SCREENS`, `ACTIONS`, `SYNC_ENTITIES`, `API_ROUTES`). El Worker la importa por `tools/cloudflare-lab/src/pos-permissions.js`. No dupliques listas en otros archivos.
2. **Default-deny:** lo que no esté listado es solo owner; roles desconocidos o sin confirmar no tienen permisos. Nunca asumas `owner` por defecto.
3. Rutas nuevas: agrega `{ path, methods, roles, action? }`. Para datos sensibles del negocio (gastos, reportes) usa `roles: owner`. Revisa también el snapshot (`tools/cloudflare-lab/src/a6-canonical.js`) para no filtrar datos por otra ruta.
4. Servidor: verifica el rol **antes** de cualquier replay/idempotencia o lectura de estado (ver `createCanonicalExpense` en `tools/cloudflare-lab/src/a6-expenses.js`).
5. Cliente: UI oculta lo no permitido (`pos-roles-client.js`, `menu-navigation.js` `canShowDrawerPage`) y tolera 403 sin romper el sync.
6. Pruebas obligatorias: `tests/cloud-sync/pos-permissions-table.test.mjs` (tabla), `tests/cloud-sync/pos-permissions-server.test.mjs` (empleado recibe 403), e2e `tests/e2e/canon-role-permissions.spec.ts` si cambia la UI.
7. Si cambia el Worker, el deploy es backend primero (ver `docs/codex/ARCHITECTURE.md`).
