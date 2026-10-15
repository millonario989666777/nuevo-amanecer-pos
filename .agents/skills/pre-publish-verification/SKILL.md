---
name: pre-publish-verification
description: "Checklist obligatorio antes de push/merge/deploy de cambios del POS."
---

# Pre-publish verification

- [ ] Rama aislada desde el HEAD vigente de `feature/v1.3-mobile-cloud`; `git status --short` limpio salvo el alcance.
- [ ] Diff revisado completo; `git diff --check`; sin secretos, tokens, datos de clientes ni identificadores sensibles.
- [ ] Layout de Venta (`#pagePOS`) e Inicio (`#pageMenu`) sin cambios; sin ediciones en `POS/css/experience-v2/pages/*.css`.
- [ ] Permisos nuevos con default-deny y pruebas cliente + servidor.
- [ ] Migraciones: solo aditivas, con aprobación del owner y respaldo.
- [ ] Unit `node --test` (Node 22): cero fallos nuevos frente a la base (fix02 T6 es flaky conocido).
- [ ] E2E Playwright en puerto libre: todo verde; revisado a 390/768/1366.
- [ ] `node tools/pos-experience/promote-lab-visuals.mjs --check` pasa.
- [ ] Restaurados `POS/index.html`, `POS/css/base.css`, `POS/css/components.css`, `POS/css/layout.css`, `evidence/**` sobrescritos por la suite; no commiteados.
- [ ] CI (`canon-critical-ci.yml`, `e2e-smoke-ci.yml`) verde en el PR.
- [ ] Deploy (si está autorizado): backend primero si cambia el Worker, luego web; anotar rollback ref; nunca los workflows prohibidos.
