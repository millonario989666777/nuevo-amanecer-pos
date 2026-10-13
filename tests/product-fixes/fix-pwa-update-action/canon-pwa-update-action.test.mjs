import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync('POS/index.html', 'utf8');
const css = readFileSync('POS/css/components.css', 'utf8');
const sw = readFileSync('POS/sw.js', 'utf8');

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.ok(start >= 0, 'missing start: ' + startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(end > start, 'missing end: ' + endNeedle);
  return source.slice(start, end);
}

test('CANON renders a visible real update action', () => {
  assert.match(index, /id="pwaUpdatePrompt"/);
  assert.match(index, /id="pwaUpdateStatus"/);
  assert.match(index, /id="pwaUpdateAction"[^>]*>Actualizar ahora<\/button>/);
  assert.match(css, /\.pwa-update-prompt\{/);
  assert.match(css, /\.pwa-update-action\{/);
  assert.match(css, /@media\(max-width:430px\)/);
});

test('page updater checks, waits, activates and reloads once', () => {
  const block = between(index, '// CANON-PWA-UPDATE-001', '</script>');
  assert.match(block, /registration\.update\(\)/);
  assert.match(block, /registration\.waiting/);
  assert.match(block, /registration\.installing/);
  assert.match(block, /statechange/);
  assert.match(block, /NA_ACTIVATE_UPDATE/);
  assert.match(block, /controllerchange/);
  assert.match(block, /reloadingForWorkerUpdate/);
  assert.match(block, /Reintentar/);
  assert.doesNotThrow(() => new Function(block));
});

test('new versions always activate (never stuck waiting); the page reloads only when no sale is in progress', () => {
  const install = between(sw, "self.addEventListener('install'", "self.addEventListener('activate'");
  const message = between(sw, "self.addEventListener('message'", "self.addEventListener('fetch'");
  assert.match(install, /stageShell\(cache\)\)\s*\.then\(\(\) => self\.skipWaiting\(\)\)/);
  assert.match(sw, /self\.clients\.claim\(\)/);
  assert.match(index, /afterSaleFinishes\(function \(\) \{\s*\/\/[^\n]*\n\s*if \(quietNeeded\(\)\)/);
  assert.match(message, /NA_ENABLE_MANUAL_UPDATES/);
  assert.match(message, /caches\.open\(MANUAL_UPDATE_MARKER_CACHE\)/);
  assert.match(message, /NA_ACTIVATE_UPDATE/);
  assert.match(message, /self\.skipWaiting\(\)/);
  assert.match(index, /NA_ENABLE_MANUAL_UPDATES/);
  assert.doesNotThrow(() => new Function(sw));
});

test('heavy OCR vendor assets no longer block each shell update', () => {
  const precache = between(sw, 'const PRECACHE_URLS = [', 'const VENDOR_URLS = [');
  const vendor = between(sw, 'const VENDOR_URLS = [', 'const PRECACHE_URLS_ABSOLUTE');
  for (const asset of [
    'tesseract.min.js',
    'worker.min.js',
    'tesseract-core-simd-lstm.wasm.js',
    'spa.traineddata.gz'
  ]) {
    assert.doesNotMatch(precache, new RegExp(asset.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));
    assert.match(vendor, new RegExp(asset.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));
  }
  assert.match(sw, /VENDOR_CACHE_NAME/);
  assert.match(sw, /VENDOR_URLS_ABSOLUTE\.has\(request\.url\)/);
  assert.match(sw, /cache\.put\(request, response\.clone\(\)\)/);
});

test('updater stays outside LAB and business authority', () => {
  assert.doesNotMatch(index + css + sw, /laboratorio\//i);
  assert.doesNotMatch(sw, /\/commands\/|payment\.create|sale\.create|credit-account\.create/i);
});
