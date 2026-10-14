import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('tools/cloudflare-pos-web/wrangler.jsonc', 'utf8');
const launcher = readFileSync('tools/cloudflare-pos-web/public/index.html', 'utf8');
const activation = readFileSync('tools/cloudflare-pos-web/public/activate.js', 'utf8');
const workflow = readFileSync('.github/workflows/v1.3-pos-web-deploy.yml', 'utf8');
const router = readFileSync('tools/cloudflare-pos-web/src/worker.js', 'utf8');
const appIndex = readFileSync('POS/index.html', 'utf8');
const hostedGuard = readFileSync('POS/js/sync/hosted-canonical-guard.js', 'utf8');
const serviceWorker = readFileSync('POS/sw.js', 'utf8');
const parsedConfig = JSON.parse(config);

test('hosted POS uses explicit Worker routing with a stable workers.dev name', () => {
  assert.equal(parsedConfig.name, 'nuevo-amanecer-pos-web');
  assert.equal(parsedConfig.main, './src/worker.js');
  assert.equal(parsedConfig.assets.directory, './_site');
  assert.equal(parsedConfig.assets.binding, 'ASSETS');
  assert.deepEqual(parsedConfig.assets.run_worker_first, [
    '/', '/app', '/app/', '/health', '/auth/*', '/read/*',
    '/commands/*', '/imports/*', '/sync/operations*', '/settings'
  ]);
  assert.equal(parsedConfig.assets.html_handling, 'none');
  assert.deepEqual(parsedConfig.services, [
    { binding: 'CANON_BACKEND', service: 'nuevo-amanecer-pos-prod' }
  ]);
  assert.equal(parsedConfig.workers_dev, true);
});

test('launcher requires browser activation and never embeds the activation secret', () => {
  assert.match(launcher, /Clave de activación/);
  assert.match(activation, /x-activation-secret/);
  assert.match(activation, /NA_HOSTED_CONFIG/);
  assert.doesNotMatch(activation, /nuevo-amanecer-pos-prod\.nuevo-amanecer-pos\.workers\.dev/);
  assert.match(activation, /na_canonical_binding/);
  assert.match(activation, /na_cloud_sync_credentials/);
  assert.doesNotMatch(launcher + activation, /POS_ACTIVATION_SECRET|sk-[A-Za-z0-9_-]{20,}/);
});

test('launcher stores the current canonical authority only after authenticated probes', () => {
  const sessionProbe = activation.indexOf("'/auth/session'");
  const statusProbe = activation.indexOf("'/read/canonical/status'");
  const save = activation.indexOf('saveSession(');
  assert.ok(sessionProbe >= 0 && statusProbe > sessionProbe);
  assert.ok(save >= 0);
  assert.match(activation, /body\.mode !== 'ACTIVE'/);
  assert.match(activation, /body\.authority !== 'canonical'/);
});

test('deployment assembles canonical POS under app and verifies the public URL', () => {
  assert.match(workflow, /cp -a POS\/\. tools\/cloudflare-pos-web\/_site\/app\//);
  assert.match(workflow, /nuevo-amanecer-pos-web\.nuevo-amanecer-pos\.workers\.dev/);
  assert.match(workflow, /npx wrangler deploy --config \.\.\/cloudflare-pos-web\/wrangler\.jsonc/);
  assert.match(workflow, /HOSTED_POS_WEB_PASS/);
  assert.match(workflow, /Local server required: NO/);
});

test('deploy workflow does not expose the production activation secret', () => {
  assert.doesNotMatch(workflow, /POS_ACTIVATION_SECRET/);
  assert.doesNotMatch(workflow, /x-activation-secret/);
});

test('hosted POS router maps root and app entrypoints to exact HTML assets', () => {
  assert.match(router, /url\.pathname === '\/'/);
  assert.match(router, /assetUrl\.pathname = '\/index\.html'/);
  assert.match(router, /url\.pathname === '\/app'/);
  assert.match(router, /url\.pathname === '\/app\/'/);
  assert.match(router, /assetUrl\.pathname = '\/app\/index\.html'/);
  assert.match(router, /env\.ASSETS\.fetch/);
});

test('public verification is pipe-safe for the large POS HTML document', () => {
  assert.match(workflow, /ROOT_CODE=.*pos-root\.html/);
  assert.match(workflow, /APP_CODE=.*pos-app\.html/);
  assert.match(workflow, /grep -Fq 'Nuevo Amanecer POS' \/tmp\/pos-root\.html/);
  assert.match(workflow, /grep -Fq 'Nuevo Amanecer — ERP &amp; POS' \/tmp\/pos-app\.html/);
  assert.doesNotMatch(workflow, /printf '%s' "\$APP" \| grep -q/);
});


test('hosted app refuses silent local mode and loads the guard before canonical client', () => {
  const guardIndex = appIndex.indexOf('js/sync/hosted-canonical-guard.js');
  const canonicalIndex = appIndex.indexOf('js/sync/canonical-client.js');
  assert.ok(guardIndex >= 0 && canonicalIndex > guardIndex);
  assert.match(hostedGuard, /NA_HOSTED_CONFIG/);
  assert.match(hostedGuard, /HOSTED_SUFFIX/);
  assert.match(hostedGuard, /na_canonical_binding/);
  assert.match(hostedGuard, /na_cloud_sync_credentials/);
  assert.match(hostedGuard, /location\.replace/);
  assert.match(serviceWorker, /hosted-canonical-guard\.js/);
});

test('hosted deploy replaces the service-worker build hash and verifies it remotely', () => {
  assert.match(workflow, /sed -i "s\/__BUILD_HASH__\/\$GITHUB_SHA\/g"/);
  assert.match(workflow, /Service Worker build hash placeholder was not replaced/);
  assert.match(workflow, /grep -Fq "\$GITHUB_SHA" \/tmp\/pos-sw\.js/);
  assert.match(workflow, /hosted-canonical-guard\.js/);
});


test('hosted PWA precaches the complete CANON Motion runtime as one shell generation', () => {
  for (const asset of [
    './css/motion/motion.css',
    './css/motion/transitions.css',
    './css/motion/modals.css',
    './css/motion/notifications.css',
    './js/motion/core.js',
    './js/motion/page-transitions.js',
    './js/motion/scroll-motion.js',
    './js/motion/modal-motion.js',
    './js/motion/feedback-motion.js',
    './js/motion/cart-motion.js'
  ]) assert.match(serviceWorker, new RegExp(asset.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));
});

test('hosted PWA stages a complete build and applies it through the explicit updater', () => {
  assert.match(serviceWorker, /CRITICAL_SHELL\.has\(url\)\) throw error/);
  assert.match(serviceWorker, /await cache\.put\(url, response\)/);
  assert.match(serviceWorker, /MANUAL_UPDATE_MARKER_CACHE/);
  assert.match(serviceWorker, /\.then\(\(\) => self\.skipWaiting\(\)\)/);
  assert.match(serviceWorker, /NA_ENABLE_MANUAL_UPDATES/);
  assert.match(serviceWorker, /NA_ACTIVATE_UPDATE/);
  assert.match(serviceWorker, /self\.clients\.claim\(\)/);
  assert.match(appIndex, /Actualizar ahora/);
  assert.match(appIndex, /NA_ACTIVATE_UPDATE/);
  assert.match(appIndex, /updateViaCache:\s*'none'/);
});


test('launcher exposes a shell-only recovery path that preserves activation storage', () => {
  assert.match(launcher, /activate\.js\?build=__BUILD_HASH__/);
  assert.match(activation, /refresh-shell/);
  assert.match(activation, /navigator\.serviceWorker\.getRegistrations\(\)/);
  assert.match(activation, /registration\.scope\.startsWith\(window\.location\.origin \+ '\/app\/'\)/);
  assert.match(activation, /registration\.unregister\(\)/);
  assert.doesNotMatch(activation, /caches\.delete\(name\)/);
  assert.match(activation, /window\.location\.replace\('\/app\/\?shell_refresh='/);
  const refreshStart = activation.indexOf('async function refreshShellOnly()');
  const refreshEnd = activation.indexOf('function setStatus', refreshStart);
  const refreshBlock = activation.slice(refreshStart, refreshEnd);
  assert.doesNotMatch(refreshBlock, /localStorage\.(?:clear|removeItem)/);
  assert.doesNotMatch(refreshBlock, /sessionStorage\.(?:clear|removeItem)/);
  assert.doesNotMatch(refreshBlock, /BINDING_KEY|CREDENTIALS_KEY/);
});

test('launcher and app load no-store runtime configuration before hosted logic', () => {
  assert.match(launcher, /<script src="\/runtime-config\.js"><\/script>[\s\S]*activate\.js/);
  assert.match(appIndex, /<script src="\/runtime-config\.js"><\/script>[\s\S]*hosted-canonical-guard\.js/);
  assert.match(router, /url\.pathname === '\/runtime-config\.js'/);
  assert.match(router, /HOSTED_ENVIRONMENT/);
  assert.match(router, /CANON_API_ORIGIN/);
});

test('network shell responses are no-store so recovery cannot reuse stale HTTP assets', () => {
  assert.match(router, /Cache-Control', 'no-store, max-age=0, must-revalidate'/);
  assert.match(router, /url\.pathname\.startsWith\('\/app\/'\)/);
  assert.match(router, /url\.pathname === '\/activate\.js'/);
});

test('deploy versions the launcher activation script with the exact hosted build hash', () => {
  assert.match(workflow, /_site\/index\.html/);
  assert.match(workflow, /sed -i "s\/__BUILD_HASH__\/\$GITHUB_SHA\/g" tools\/cloudflare-pos-web\/_site\/index\.html/);
  assert.match(workflow, /grep -Fq "\$GITHUB_SHA" tools\/cloudflare-pos-web\/_site\/index\.html/);
});


test('canonical API proxy routes invoke the Worker before static assets', () => {
  for (const route of ['/health','/auth/*','/read/*','/commands/*','/imports/*','/sync/operations*','/settings']) {
    assert.ok(parsedConfig.assets.run_worker_first.includes(route), route + ' must run Worker first');
  }
});

test('same-origin proxy reaches CANON through a Cloudflare service binding', () => {
  assert.match(router, /env\.CANON_BACKEND/);
  assert.match(router, /service\.fetch\(request\)/);
  assert.doesNotMatch(router, /new Request\(target\.toString/);
  assert.doesNotMatch(router, /await fetch\(proxied\)/);
});

test('hosted browser talks to CANON through the same-origin Worker proxy', () => {
  assert.match(router, /function isCanonicalApiPath\(pathname\)/);
  assert.match(router, /pathname\.startsWith\('\/auth\/'\)/);
  assert.match(router, /pathname\.startsWith\('\/read\/'\)/);
  assert.match(router, /pathname\.startsWith\('\/commands\/'\)/);
  assert.match(router, /pathname === '\/settings'/);
  assert.match(router, /return proxyCanonical\(request, env\)/);
  assert.match(router, /apiOrigin: hostedOrigin/);
  assert.match(router, /CANON_API_ORIGIN/);
  assert.match(workflow, /POS_WEB_URL\/health/);
  assert.match(workflow, /pos-health\.json/);
  assert.match(workflow, /'"ok":true'/);
});

test('launcher source does not render a literal newline escape after runtime config', () => {
  assert.doesNotMatch(launcher, /<\/script>\\n\s*<script/);
});


test('hosted proxy forwards the original browser request through the service binding', () => {
  const start = router.indexOf('async function proxyCanonical');
  const end = router.indexOf('function runtimeConfig', start);
  const block = router.slice(start, end);
  assert.match(block, /service\.fetch\(request\)/);
  assert.doesNotMatch(block, /new Request\(/);
  assert.doesNotMatch(block, /headers\.delete\('host'\)/);
});
