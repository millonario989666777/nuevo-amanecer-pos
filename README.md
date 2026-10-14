# POS Nuevo Amanecer

## Estado actual

**Producción estable:** `v1.2-production`.

**Línea activa del repositorio:** V1.3 en integración/remediación sobre `feature/v1.3-mobile-cloud`.

V1.3 todavía no equivale a un cutover de producción. Los gates locales, migraciones versionadas, LAB, backups y código dormido no autorizan por sí solos un deploy remoto ni el modo comercial `ACTIVE`.

Fuentes rápidas:

- Estado V1.3 actual: [docs/V1.3_STATUS.md](docs/V1.3_STATUS.md)
- Mapa corto del repositorio: [REPO_MAP.yaml](REPO_MAP.yaml)
- Reglas de trabajo y zonas: [AGENTS.md](AGENTS.md)
- Reglas funcionales del producto: [AGENTS_Nuevo_Amanecer.md](AGENTS_Nuevo_Amanecer.md)
- Roles OpenCode: [.opencode/ROLE_MAP.md](.opencode/ROLE_MAP.md)
- Flujo de ramas y preview: [docs/BRANCH_PREVIEW_WORKFLOW.md](docs/BRANCH_PREVIEW_WORKFLOW.md)
- Retiro controlado de POS-LAB: [docs/LAB_RETIREMENT.md](docs/LAB_RETIREMENT.md)

## Zonas

| Zona | Rol |
| --- | --- |
| `POS/` | CANON del producto |
| `laboratorio/pos-lab/` | histórico/read-only; POS-LAB retirado del flujo activo |
| `tools/cloudflare-lab/` | backend/harnesses con nombre histórico; no borrar por el retiro de POS-LAB |
| `tools/cloudflare-backup/` | backup/recovery |
| `tests/` | regresiones de producto, cloud-sync, infraestructura y seguridad |
| `.opencode/` | agentes y comandos |
| `.agents/skills/` | skills canónicas |
| `evidence/` | evidencia histórica/de tareas; no asumir que describe el HEAD actual |

`MANIFEST.yaml` y `orchestrator/` pertenecen al modo SHADOW legacy. No son gates automáticos para trabajo normal de CANON salvo invocación explícita.

## Ejecutar el POS estable local

En Windows con Node.js:

```powershell
INICIAR_POS.cmd
```

El iniciador abre:

```text
http://127.0.0.1:8788/POS/index.html
```

Inicio manual:

```powershell
node tools/pos-local/server.mjs
```

Las pruebas que usan SQLite (`node:sqlite`, p. ej. `tests/cloud-sync/*.test.mjs`) requieren Node >= 22.23: con 22.11 dan un falso 500 «column index out of range».

Prueba focal del servidor local:

```powershell
node --test tests/release-local-server.test.mjs
```

No cambiar el origen de una caja existente sin exportar y comprobar antes el respaldo completo. El repositorio no debe contener datos comerciales reales ni valores de credenciales.

Pruebas focalizadas de abonos CANON (Worker/SQLite local con datos sintéticos):

```powershell
node --test tests/cloud-sync/canonical-credit-payment-e2e.test.mjs tests/cloud-sync/canonical-credit-payment-bridge.test.mjs tests/cloud-sync/client-renderer-collision.test.mjs
```

## Desarrollo por ramas y preview

POS-LAB permanente está retirado. Todo cambio nuevo nace desde el HEAD CANON vigente en una rama aislada, pasa Draft PR + CI + revisión independiente y, cuando corresponde, un preview temporal del mismo SHA.

No existe promoción LAB -> CANON para trabajo nuevo. Los artefactos históricos bajo `laboratorio/pos-lab/` se conservan únicamente como referencia hasta su limpieza documental controlada.

El directorio `tools/cloudflare-lab/` mantiene un nombre histórico pero contiene piezas de backend/harnesses usadas por CANON; no debe borrarse ni renombrarse como parte del retiro de POS-LAB.

## V1.3 y documentación histórica

Los documentos `V1.3_A2...` a `V1.3_A6...`, los informes de remediación, snapshots y evidence registran gates concretos. Son evidencia útil, pero pueden contener SHAs, conteos o estados válidos únicamente para aquel momento.

Antes de actuar sobre ellos, consulta [docs/V1.3_STATUS.md](docs/V1.3_STATUS.md) y el HEAD real de GitHub.

La migración/reconciliación A5 continúa documentada en [docs/V1.3_A5_MIGRATION_RECONCILIATION.md](docs/V1.3_A5_MIGRATION_RECONCILIATION.md). Sus fuentes privadas se colocan en `tools/cloudflare-lab/private/a5-inputs/`, ignoradas por Git. A5 no despliega ni promueve datos comerciales por sí sola.

## Regresión de ventas CANON/Turso

```sh
node --test tests/cloud-sync/canonical-sale-turso-root.test.mjs
```

Contrato, causas reproducidas y recuperación selectiva del outbox de prueba:
[docs/CANON_TURSO_SALE_ROOT.md](docs/CANON_TURSO_SALE_ROOT.md).
