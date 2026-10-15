# Pruebas

- Node 22 (en este entorno: `export PATH=/workspace/tools/node22/bin:$PATH`).
- **Unit:** `node --test` desde la raíz (descubre `**/*.test.mjs`). Hay fallos preexistentes en la base: compara contra la base (lista de `not ok`) y exige **cero fallos nuevos**. Focalizado: `node --test tests/cloud-sync/<archivo>.test.mjs`.
- **E2E (Playwright, Chromium):** `playwright.config.ts` usa el puerto fijo 4173; **no lo uses** (puede estar ocupado por otro agente). Crea una copia local no commiteada con otro puerto, p. ej.:
  `sed 's/const PORT = 4173;/const PORT = Number(process.env.PWPORT||4291);/' playwright.config.ts > pw-local.config.ts`
  y ejecuta `PWPORT=4291 npx playwright test -c pw-local.config.ts --reporter=line`.
  Specs en `tests/e2e/`.
- **La suite sobrescribe** `POS/index.html`, `POS/css/base.css`, `POS/css/components.css`, `POS/css/layout.css` y `evidence/**`. Después de correrla:
  `git checkout -- POS/index.html POS/css/base.css POS/css/components.css POS/css/layout.css evidence && git clean -fd evidence`
  Nunca commitear esas versiones. ⚠️ Si tienes cambios intencionales sin commitear en esos archivos, commitéalos **antes** de correr la suite o los perderás al restaurar.
- **Flaky conocido:** `tests/product-fixes/fix02/fix02-cash-history.test.mjs` T6 (`cashClosures[1].id: identificador duplicado`) falla ~1/6 corridas: `abrirCaja` usa `sessionId: Date.now()` y dos aperturas en el mismo milisegundo colisionan. Reintentar antes de diagnosticar.
- Lint: ESLint disponible en `/workspace/tools/qa/node_modules/.bin/eslint` (entorno local).
- CI: `.github/workflows/canon-critical-ci.yml` y `.github/workflows/e2e-smoke-ci.yml`.
