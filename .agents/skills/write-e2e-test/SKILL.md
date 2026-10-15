---
name: write-e2e-test
description: "Escribir y correr pruebas Playwright e2e del POS en un puerto libre, sin backend real ni datos de producción."
---

# Write e2e test

1. Specs en `tests/e2e/<tema>.spec.ts`; imita `tests/e2e/proximamente.spec.ts` o `tests/e2e/mobile-drawer.spec.ts`.
2. Aísla la red: `page.route('**/*', ...)` deja pasar solo `127.0.0.1` y simula el backend con hosts ficticios (p. ej. `permissions.test`) y tokens sintéticos. Nunca apuntes a producción ni uses datos reales de clientes.
3. Roles: simula `na_cloud_sync_credentials` + `na_pos_role_v1` en `localStorage` y responde `/auth/me`; sin credenciales el POS está en modo local (owner).
4. Cubre 390, 768 y 1366 px con `page.setViewportSize`; comprueba visibilidad, que nada tape los toques (`elementFromPoint`) y que el layout de Venta/Inicio no cambie.
5. Ejecuta en un puerto libre, nunca 4173 (ver `docs/codex/TESTING.md`), y restaura después los archivos que la suite sobrescribe.
