# Visual regression

The separate Chromium suite in `tests/visual/visual.spec.ts` covers Inicio and
Venta at 1366×768, 768×1024 and 390×844, in light and dark mode (32 screenshots):

- Inicio on load, plus the open navigation drawer at 390 px.
- Venta with an empty catalog, three cart items, a typed product search, and
  the Cobrar dialog open. The suite never confirms or pays a sale.
- On phones the empty/search scenarios open the product catalog dialog, since
  the normal sale screen hides the catalog.

It uses synthetic localStorage products, empty sales and local owner mode.
All requests outside `http://127.0.0.1:4183` are blocked, including CDN fonts;
system fallback fonts are intentional. Service workers are blocked. The clock
is installed before navigation and Date is fixed at
`2026-10-15T10:00:00-05:00`, with Lima timezone, es-PE locale and reduced motion.
Each screenshot waits for network idle and `document.fonts.ready`.

Volatile chrome is masked: `#fechaHoy`, `#menuDesktopDate`, `#cajFechaLbl`,
`.na-mobile-activity-time`, `#naMobileDrawerVersion`, `#localStatus`,
`#saveStatus`, `#naStatusBanner`, and `#gToast` (including Guardado notices).
These selectors cover date/time text, build date, connection/sync and save
feedback. There is no separate live clock widget on these screens.

## Run locally

```sh
npm ci --no-audit --no-fund
npx playwright install chromium
npm run test:visual
npm run test:visual:update
```

Port 4183 must be free. `playwright.config.ts` remains scoped to `tests/e2e`;
visual tests run only through `playwright.visual.config.ts`.
Baselines live in `tests/visual/__screenshots__/visual.spec.ts/`, with names
such as `inicio-390-dark.png` and `venta-cobrar-1366-light.png`.

## Baselines and CI

Intentional UI changes must update the baselines in the **same PR**. Never
raise the tolerance (`maxDiffPixelRatio: 0.001`) to accommodate a change.
Generate and review baselines inside the same image CI uses:

```sh
docker run --rm --ipc=host -v "$PWD:/work" -w /work \
  mcr.microsoft.com/playwright:v1.47.2-jammy \
  bash -lc 'npm ci --no-audit --no-fund && npm run test:visual:update && npm run test:visual'
```

Alternatively, download the `visual-results` CI artifact and review the
container-generated screenshots. On the first run with missing baselines,
Playwright fails comparison but writes the new reference files into the
screenshots directory. Copy those into the baseline paths, commit them in
the same PR, and rerun CI. For an existing-baseline mismatch, the artifact's
`test-results` contains actual/expected/diff images; review the actual image
before copying it to the corresponding baseline path. Never use a diff image
as a baseline.

The workflow compares without `--update-snapshots` and always uploads
`tests/visual/__screenshots__` and `test-results` as `visual-results`.
Local host-generated baselines are not the CI reference: OS fonts and browser
libraries can differ. This infrastructure change intentionally ships without
PNGs; bootstrap them from the pinned CI container in the baseline PR.
