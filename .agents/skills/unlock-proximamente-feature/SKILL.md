---
name: unlock-proximamente-feature
description: "Desbloquear una función del registro Próximamente (solo owner): enabled + page + rutas de servidor."
---

# Unlock Próximamente feature

1. Registro: `FEATURES` en `POS/js/modules/proximamente.js`. Una función queda desbloqueada solo con `enabled: true` **y** `page: 'pageX'` existente; `isEnabled`/`isUnlocked` devuelven false sin `page`.
2. Crea primero la pantalla real (skill `add-screen`) y sus permisos (skill `add-permission`): pantalla y rutas solo owner salvo orden distinta del owner.
3. Rutas de servidor nuevas: agrégalas a `API_ROUTES` en `POS/js/config/pos-permissions.js` e impleméntalas en `tools/cloudflare-lab/src/` con pruebas; si necesitan tablas, skill `add-migration`.
4. La vista previa bloqueada nunca guarda datos; no la conviertas en formulario funcional.
5. Pruebas: `tests/cloud-sync/proximamente-registry.test.mjs` y `tests/e2e/proximamente.spec.ts` (owner entra, empleado recibe «Sin permiso»).
