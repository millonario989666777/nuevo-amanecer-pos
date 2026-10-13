const CACHE_PREFIX = 'nuevo-amanecer-pos-shell-';
const CACHE_NAME = `${CACHE_PREFIX}__BUILD_HASH__`;
const VENDOR_CACHE_NAME = 'nuevo-amanecer-pos-vendor-tesseract-6.0.1';
const MANUAL_UPDATE_MARKER_CACHE = 'nuevo-amanecer-pos-manual-update-v1';
// OCR de compras y catálogo de referencia: no se precargan (no sirven para vender). Se guardan en una
// caché de la misma generación la primera vez que se usan, así nunca se mezclan con otro build.
const LAZY_CACHE_PREFIX = 'nuevo-amanecer-pos-lazy-';
const LAZY_CACHE_NAME = LAZY_CACHE_PREFIX + CACHE_NAME.slice(CACHE_PREFIX.length);
const PRECACHE_URLS = [
  './index.html',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/responsive.css',
  './css/print.css',
  './css/motion/motion.css',
  './css/motion/transitions.css',
  './css/motion/modals.css',
  './css/motion/notifications.css',
  './css/client-credit-accounts-v2.css',
  './css/canon-desktop-dashboard.css',
  './css/canon-mobile-home.css',
  './css/mobile-inventory.css',
  './js/inventory/mobile-inventory.js',
  './css/experience-v2/tokens.css',
  './css/experience-v2/layout.css',
  './css/experience-v2/responsive.css',
  './css/experience-v2/components/buttons.css',
  './css/experience-v2/components/cards.css',
  './css/experience-v2/components/tables.css',
  './css/experience-v2/components/forms.css',
  './css/experience-v2/components/modals.css',
  './css/experience-v2/components/navigation.css',
  './css/experience-v2/pages/menu.css',
  './css/experience-v2/pages/pos.css',
  './css/canon-pos-reference-ui.css',
  './css/canon-phone-sale.css',
  './css/experience-v2/pages/inventario.css',
  './css/experience-v2/pages/clientes.css',
  './css/experience-v2/pages/caja.css',
  './css/experience-v2/pages/ventas.css',
  './css/canon-pending-sales.css',
  './css/canon-ventas-tabs.css',
  './css/canon-ux-fixes.css',
  './css/config-e2.css',
  './css/config-v9.css',
  './css/experience-v2/pages/gastos.css',
  './css/experience-v2/pages/configuracion.css',
  './css/experience-v2/animations/motion.css',
  './css/experience-v2/animations/transitions.css',
  './css/experience-v2/animations/menu.css',
  './css/experience-v2/animations/pos.css',
  './css/experience-v2/animations/modals.css',
  './css/experience-v2/animations/notifications.css',
  './js/core/utils.js',
  './js/core/lima-time.js',
  './js/sync/outbox.js',
  './js/sync/hosted-canonical-guard.js',
  './js/adapters/canonical-ui-adapter.js',
  './js/sync/canonical-client.js',
  './js/sync/canonical-sale-intent.js',
  './js/sync/canonical-sale-outbox.js',
  './js/sync/canonical-sale-projection.js',
  './js/sync/canonical-sale-integration.js',
  './js/sync/canonical-sale-view.js',
  './js/sync/canonical-credit-payment-bridge.js',
  './js/sync/canonical-payment-annul-bridge.js',
  './js/sync/canonical-product-bridge.js',
  './js/sync/canonical-customer-bridge.js',
  './js/sync/canonical-customer-credit-policy-bridge.js',
  './js/sync/canonical-inventory-bridge.js',
  './js/sync/canonical-cash-bridge.js',
  './js/sync/canonical-expense-bridge.js',
  './js/sync/canonical-cash-history.js',
  './js/sync/canonical-status-banner.js',
  './js/legacy-inline/inline-01.js',
  './js/modules/ticket/legacy.js',
  './js/modules/ticket/share-receipt.js',
  './js/modules/ticket/share-receipt-ui.js',
  './css/receipt-share.css',
  './js/legacy-inline/inline-02.js',
  './js/modules/ticket/overrides.js',
  './js/legacy-inline/inline-03.js',
  './js/core/state.js',
  './js/legacy-inline/inline-04.js',
  './js/legacy-inline/inline-05.js',
  './js/legacy-inline/inline-06.js',
  './js/legacy-inline/inline-07.js',
  './js/modules/ticket/zones.js',
  './js/legacy-inline/inline-08.js',
  './js/legacy-inline/inline-09.js',
  './js/legacy-inline/inline-10.js',
  './js/legacy-inline/inline-11.js',
  './js/legacy-inline/inline-12.js',
  './js/products/image-batch.js',
  './js/legacy-inline/inline-13.js',
  './js/modules/ticket/secure-print.js',
  './js/legacy-inline/inline-14.js',
  './js/legacy-inline/inline-15.js',
  './js/legacy-inline/inline-16.js',
  './js/legacy-inline/inline-17.js',
  './js/legacy-inline/inline-18.js',
  './js/navigation/menu-navigation.js',
  './js/motion/core.js',
  './js/motion/page-transitions.js',
  './js/motion/scroll-motion.js',
  './js/motion/lab-parity-bridge.js',
  './js/motion/modal-motion.js',
  './js/motion/feedback-motion.js',
  './js/motion/cart-motion.js',
  './js/modules/client-credit-accounts-v2.js',
  './js/compat/legacy-globals.js',
  './js/app.js',
  './js/canon-pos-reference-ui.js',
  './js/canon-phone-sale.js',
  './js/canon-desktop-dashboard.js',
  './js/config/config-e2.js',
  './js/config/config-g.js',
  './js/config/pos-reviews-client.js',
  './js/config/pos-annul-client.js',
  './js/modules/discount-sheet.js','./js/config/pos-sale-note-client.js','./js/config/pos-purchases-client.js','./js/config/config-v9.js',
  './js/config/pos-roles-client.js',
  './js/core/lazy-assets.js'
];
const LAZY_URLS = [
  './js/catalog/reference-catalog-data.js',
  './js/catalog/reference-catalog.js',
  './js/ocr/ocr-extract.js',
  './js/ocr/ocr-document-extract.js',
  './js/ocr/ocr-parse.js',
  './js/ocr/ocr-reference-matcher.js',
  './js/ocr/ocr-purchase-engine.js',
  './js/ocr/ocr-purchase-review.js',
  './js/ocr/ocr-purchase-apply.js',
  './js/ocr/ocr-purchase-integration.js'
];
const VENDOR_URLS = [
  './js/ocr/vendor/tesseract-6.0.1/tesseract.min.js',
  './js/ocr/vendor/tesseract-6.0.1/worker.min.js',
  './js/ocr/vendor/tesseract-6.0.1/tesseract-core-simd-lstm.wasm.js',
  './js/ocr/vendor/tesseract-6.0.1/lang/spa.traineddata.gz',
  './js/ocr/vendor/pdfjs-6.4.299/pdf.worker.min.mjs',
  './js/ocr/vendor/pdfjs-6.4.299/pdf.min.mjs',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/FoxitDingbats.pfb',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/LICENSE_LIBERATION',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/LICENSE_FOXIT',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/FoxitSerifBold.pfb',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/FoxitSymbol.pfb',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/FoxitSerif.pfb',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/FoxitFixedBold.pfb',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/LiberationSans-Italic.ttf',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/LiberationSans-Regular.ttf',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/FoxitFixedItalic.pfb',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/LiberationSans-Bold.ttf',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/FoxitFixed.pfb',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/FoxitSerifBoldItalic.pfb',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/FoxitFixedBoldItalic.pfb',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/FoxitSerifItalic.pfb',
  './js/ocr/vendor/pdfjs-6.4.299/standard_fonts/LiberationSans-BoldItalic.ttf',
  './js/ocr/vendor/mammoth-1.13.0/mammoth.browser.min.js'
];
const PRECACHE_URLS_ABSOLUTE = new Set(PRECACHE_URLS.map((url) => new URL(url, self.registration.scope).href));
const VENDOR_URLS_ABSOLUTE = new Set(VENDOR_URLS.map((url) => new URL(url, self.registration.scope).href));
const LAZY_URLS_ABSOLUTE = new Set(LAZY_URLS.map((url) => new URL(url, self.registration.scope).href));
const START_URL = new URL('./index.html', self.registration.scope).href;
const START_PATH = new URL(START_URL).pathname;

function isExcluded(request, url) {
  return request.method !== 'GET'
    || url.origin !== self.location.origin
    || url.pathname === '/health'
    || url.pathname.startsWith('/sync/')
    || url.pathname.startsWith('/read/')
    || request.headers.has('authorization')
    || request.headers.has('x-sync-token')
    || request.headers.has('x-read-token')
    || (request.mode === 'navigate'
      ? url.pathname !== START_PATH
      : !PRECACHE_URLS_ABSOLUTE.has(url.href) && !VENDOR_URLS_ABSOLUTE.has(url.href) && !LAZY_URLS_ABSOLUTE.has(url.href));
}

// Un deploy cambia pocos archivos: cada recurso que ya está en una generación anterior se revalida con
// su ETag (304 = mismo contenido) y se copia; solo se descarga lo que cambió. Sin ETag o ante cualquier
// duda se descarga completo como antes (cache: 'reload'). La generación se escribe solo cuando TODOS
// los recursos llegaron (todo o nada, como addAll); si alguno falla la versión actual sigue intacta.
async function previousShellCaches() {
  const names = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);
  return Promise.all(names.reverse().map((name) => caches.open(name)));
}

async function stagedShellEntry(previousCaches, url) {
  let previous = null;
  for (const cache of previousCaches) {
    const cached = await cache.match(url).catch(() => null);
    if (cached && cached.ok && cached.headers.get('etag')) { previous = cached; break; }
  }
  if (previous) {
    try {
      const revalidated = await fetch(new Request(url, { cache: 'no-store', headers: { 'If-None-Match': previous.headers.get('etag') } }));
      if (revalidated.status === 304) return [url, previous];
      if (revalidated.ok) return [url, revalidated];
    } catch (_) {}
  }
  const response = await fetch(new Request(url, { cache: 'reload' }));
  if (!response.ok) throw new TypeError('PRECACHE_FAILED');
  return [url, response];
}

async function stageShell(cache) {
  const requests = [...PRECACHE_URLS_ABSOLUTE];
  const previousCaches = await previousShellCaches().catch(() => []);
  if (!previousCaches.length) {
    return cache.addAll(requests.map((url) => new Request(url, { cache: 'reload' })));
  }
  const entries = await Promise.all(requests.map((url) => stagedShellEntry(previousCaches, url)));
  await Promise.all(entries.map(([url, response]) => cache.put(url, response)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => stageShell(cache))
      .then(() => caches.has(MANUAL_UPDATE_MARKER_CACHE))
      .then((manualModeEnabled) => manualModeEnabled ? undefined : self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) || (name.startsWith(LAZY_CACHE_PREFIX) && name !== LAZY_CACHE_NAME))
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});


self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'NA_ENABLE_MANUAL_UPDATES') {
    event.waitUntil(caches.open(MANUAL_UPDATE_MARKER_CACHE).then(() => undefined));
    return;
  }

  if (event.data.type === 'NA_ACTIVATE_UPDATE') {
    event.waitUntil(Promise.resolve(self.skipWaiting()));
    return;
  }

  if (event.data.type !== 'NA_BUILD_DIAGNOSTIC') return;

  const payload = {
    type: 'NA_BUILD_DIAGNOSTIC',
    buildHash: '__BUILD_HASH__',
    cacheName: CACHE_NAME,
    scope: self.registration.scope
  };

  if (event.ports && event.ports[0]) {
    event.ports[0].postMessage(payload);
    return;
  }

  if (event.source && typeof event.source.postMessage === 'function') {
    event.source.postMessage(payload);
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (isExcluded(request, url)) return;

  if (VENDOR_URLS_ABSOLUTE.has(request.url)) {
    event.respondWith(
      caches.open(VENDOR_CACHE_NAME)
        .then((cache) => cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
          });
        }))
    );
    return;
  }

  if (LAZY_URLS_ABSOLUTE.has(request.url)) {
    event.respondWith(
      caches.open(LAZY_CACHE_NAME)
        .then((cache) => cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(new Request(request, { cache: 'no-store' })).then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
          });
        }))
    );
    return;
  }

  // Serve the installed generation first. Recover missing shell files online
  // without writing newer responses into that generation.
  // A new worker remains waiting until the owner presses "Actualizar ahora".
  const key = request.mode === 'navigate' ? START_URL : request.url;
  event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(key)).then((cached) =>
    cached || fetch(new Request(request, { cache: 'no-store' })).catch(() => new Response('No se pudo recuperar la interfaz. Compruebe la conexion y vuelva a intentar.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    }))
  ));
});
