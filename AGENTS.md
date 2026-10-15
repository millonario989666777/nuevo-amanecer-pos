# AGENTS.md — Modos de trabajo del proyecto Nuevo Amanecer

## Estado operativo del propietario

**CANON_DEFAULT = true**
**POS_LAB_RETIRED = true**
**BRANCH_PREVIEW_REQUIRED = true**

CANON es la única fuente funcional del producto. El antiguo POS-LAB deja de ser una zona de desarrollo activa.

Toda tarea normal del POS debe ejecutarse así:

1. partir del HEAD vigente de `feature/v1.3-mobile-cloud`;
2. crear una rama aislada `feature/*`, `fix/*`, `perf/*` o `arch/*`;
3. modificar únicamente el alcance autorizado;
4. ejecutar pruebas focalizadas y regresiones;
5. abrir Draft PR;
6. exigir CANON Critical CI + E2E Smoke CI cuando apliquen;
7. revisión independiente Reviewer/Forensic;
8. preview temporal del mismo SHA cuando la validación visual o de navegador sea necesaria;
9. completar merge/deploy cuando estén incluidos en la autorización vigente del owner;
10. borrar la rama después del merge.

No existe promoción LAB -> CANON para trabajo nuevo.

## Regla principal

La solicitud explícita actual del propietario es la máxima autoridad para tareas normales de desarrollo del producto.

Cuando el propietario diga «impleméntalo», «aplícalo a CANON» o autorice continuar una implementación, esa autorización cubre publicar la rama/PR, integrar y desplegar el cambio solicitado y aplicar las migraciones aditivas indispensables para activarlo. No se vuelve a pedir permiso para esos pasos dentro del mismo alcance. Se conservan pruebas, revisión independiente, respaldo previo a migraciones remotas y verificación posterior. Una petición de debatir, revisar o preparar un borrador no autoriza producción. Acciones destructivas, force-push, cambios de secrets o ampliaciones del alcance requieren autorización explícita específica. Las restricciones de la plataforma no pueden desactivarse desde este repositorio.

## Zonas y agentes

- **CANON** → `pos-canon-implementer`: producto `POS/**` y código CANON versionado dentro del alcance autorizado. Deploy remoto únicamente dentro de la autorización vigente descrita arriba.
- **PREVIEW DE RAMA** → no es otra copia del producto: sirve exactamente el SHA del Draft PR/candidato.
- **POS-LAB histórico** → retirado. `laboratorio/pos-lab/**` no es destino de nuevas escrituras ni fuente de promoción.
- **SHADOW legacy** → `pos-implementer`: solo infraestructura/evidence shadow; `PRODUCT_WRITE = DENIED`.
- **PLANNER** → `pos-planner`: READ-ONLY.
- **REVIEWER** → `pos-reviewer`: READ-ONLY independiente.
- **TESTER** → `pos-tester`: TEST-ONLY; no cambia expectativas para fabricar PASS.

La referencia corta es `.opencode/ROLE_MAP.md`.

## Seguridad Git

Antes y después de cambios:

- confirmar rama y HEAD;
- `git status --short`;
- pruebas focalizadas;
- regresiones relevantes;
- `git diff --check`;
- revisar diff completo.

Prohibido sin autorización vigente que cubra la acción:

- merge a CANON fuera del alcance aprobado;
- deploy de producción fuera del alcance aprobado;
- force-push;
- cambios de secrets;
- migraciones remotas fuera del alcance aprobado;
- borrar datos;
- ocultar o saltar tests fallidos.

## Gates de rama

Un candidato solo puede solicitar merge cuando:

- el diff corresponde al alcance;
- CANON Critical CI está verde cuando aplica;
- E2E Smoke CI está verde cuando aplica;
- Reviewer no tiene P0/P1 abiertos;
- Forensic confirma integridad de datos/rutas sensibles;
- el preview, si se exige, ejecuta el mismo SHA revisado.

Un fallo de CI se clasifica primero como **REGRESIÓN REAL** o **TEST OBSOLETO**. No se debilitan assertions sin reemplazarlas por invariantes equivalentes o más fuertes.

## Retiro de POS-LAB

El POS-LAB activo queda retirado.

- no crear ramas `lab/*`;
- no ejecutar `/lab-preflight` ni `/lab-validate`;
- no publicar GitHub Pages LAB;
- no ejecutar deploy/refresh remoto LAB;
- no usar `laboratorio/pos-lab/**` como fuente de verdad;
- `POS/**` nunca depende en runtime de `laboratorio/**`.

Los contratos/evidence históricos pueden conservarse como auditoría hasta una limpieza posterior explícita.

**Importante:** `tools/cloudflare-lab/**` NO se borra por nombre. Parte de ese árbol contiene hoy el Worker/backend y harnesses usados también por CANON/producción. Su renombre o partición requiere una migración separada con pruebas.

Documentos vigentes:

- `docs/BRANCH_PREVIEW_WORKFLOW.md`
- `docs/LAB_RETIREMENT.md`
- `REPO_MAP.yaml`
- `docs/V1.3_STATUS.md`
- `AGENTS_Nuevo_Amanecer.md`

Los documentos LAB anteriores pasan a ser evidencia histórica y no habilitan un flujo LAB nuevo.

## Shadow mode legacy

El shadow mode sigue disponible únicamente cuando una tarea lo invoque explícitamente.

En shadow mode:

- `PRODUCT_WRITE = DENIED`;
- solo puede escribir infraestructura/evidence según su contrato;
- no gobierna automáticamente tareas normales del POS.

## Contexto para Codex (resumen; detalle en `docs/codex/`)

- Negocio, reglas de farmacia/caja/roles y reglas de diseño: `docs/codex/BUSINESS_CONTEXT.md`
- Mapa de arquitectura (módulos, CSS, backend, sync, migraciones, deploy, workflows prohibidos): `docs/codex/ARCHITECTURE.md`
- Pruebas (Node 22, unit, e2e en puerto libre, archivos que la suite sobrescribe): `docs/codex/TESTING.md`
- Skills del repo para tareas recurrentes: `.agents/skills/` (add-screen, add-permission, add-migration, unlock-proximamente-feature, write-e2e-test, pre-publish-verification)

Reglas duras (no negociables):

1. **Nunca** cambiar el layout de la pantalla Venta ni de la página Inicio (sus funciones internas sí pueden mejorar).
2. Toda pantalla debe funcionar en 1366, 768 y 390 px; diseñar primero para teléfono.
3. Permisos: tabla única `POS/js/config/pos-permissions.js`, denegación por defecto en servidor; todo cambio de permiso lleva prueba cliente + servidor.
4. Migraciones de BD/CANON: solo aditivas, con respaldo previo y aprobación del owner.
5. Nunca alterar ventas ni abonos pendientes (outbox/sin confirmar).
6. No editar `POS/css/experience-v2/pages/*.css` (copias de laboratorio).
7. No commitear `POS/index.html`, `POS/css/base.css`, `POS/css/components.css`, `POS/css/layout.css` ni `evidence/**` sobrescritos por la suite de pruebas (restaurar con `git checkout`); los cambios intencionales a esos archivos se hacen y commitean antes de correr la suite.
8. Nunca escribir secretos, tokens, datos de clientes ni identificadores sensibles de producción en código, docs, logs o prompts.
