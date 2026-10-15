import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';

const app = readFileSync('POS/index.html', 'utf8');
const { stdout: original } = await promisify(execFile)('git', ['show', '514de90ad663d9003bccdefd9a70c58a925f1aad:POS/index.html'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
const launcher = readFileSync('tools/cloudflare-pos-web/public/index.html', 'utf8');
const guard = readFileSync('POS/js/sync/hosted-canonical-guard.js', 'utf8');
const early = ['/runtime-config.js', 'js/sync/hosted-canonical-guard.js'];
const scripts = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const sources = html => scripts(html).map(m => /\bsrc="([^"]+)"/.exec(m[1])?.[1]).filter(Boolean);
const withoutFallbacks = html => html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
const sheets = html => [...withoutFallbacks(html).matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map(m => /href="([^"]+)"/.exec(m[0])[1]);

test('runtime config then guard are the first synchronous head scripts, before assets', () => {
  const head = /<head>([\s\S]*?)<\/head>/.exec(app)[1];
  assert.deepEqual(sources(head).slice(0, 2), early);
  for (const tag of scripts(head).slice(0, 2)) assert.doesNotMatch(tag[1], /\b(?:async|defer|type)\b/);
  assert.ok(head.indexOf(early[1]) < head.indexOf('<link'));
  for (const src of early) assert.equal(sources(app).filter(value => value === src).length, 1);
});

const fast = m => /na_cloud_sync_credentials/.test(m[0]) && !/\bsrc=/.test(m[1]);
test('all other external and inline scripts preserve their original order and attributes', () => {
  const remaining = html => scripts(html).filter(m => !fast(m) && !early.includes(/\bsrc="([^"]+)"/.exec(m[1])?.[1])).map(m => m[0]);
  assert.deepEqual(remaining(app), remaining(original));
});

test('fast launcher redirect is the first script, hosted /app/ only, and only when no saved credentials (subset of the guard)', () => {
  const all = scripts(app);
  assert.ok(fast(all[0]), 'inline fast check runs before any external script');
  const code = all[0][0];
  assert.match(code, /nuevo-amanecer-pos\\\.workers\\\.dev\$/);
  assert.match(code, /\^\\\/app\(\\\/\|\$\)/);
  assert.match(code, /typeof c\.token!=='string'\|\|!c\.token\)l\.replace\(l\.origin\+'\/'\)/);
  assert.match(code, /catch\(_\)\{\}/);
  const guard = readFileSync(new URL('../../POS/js/sync/hosted-canonical-guard.js', import.meta.url), 'utf8');
  assert.match(guard, /validCredentials\(credentials\)/);
  assert.match(guard, /root\.location\.replace\(root\.location\.origin \+ '\/'\)/);
});

test('deferred styles have an adjacent blocking noscript fallback and preserve cascade order', () => {
  // dark-polish.css (bloqueante, mínima) se añade al final a propósito; el resto mantiene el orden original.
  assert.deepEqual(sheets(app).filter(h => h !== 'css/dark-polish.css'), sheets(original));
  assert.equal(sheets(app).at(-1), 'css/dark-polish.css');
  for (const match of app.matchAll(/<link\b[^>]*media="print"[^>]*onload="this.media='all'"[^>]*>/g)) {
    const href = /href="([^"]+)"/.exec(match[0])[1];
    const fallback = /^\s*<noscript>(<link\b[^>]*>)<\/noscript>/.exec(app.slice(match.index + match[0].length));
    assert.ok(fallback, href);
    assert.ok(fallback[1].includes(`href="${href}"`));
    assert.doesNotMatch(fallback[1], /\b(?:media|onload)=/);
  }
  for (const href of ['base.css', 'layout.css', 'components.css', 'config-e2.css', 'config-v9.css']) {
    assert.ok(app.includes(`<link rel="stylesheet" href="css/${href}">`), href);
  }
});

test('launcher reserves card and status space at desktop and phone widths', () => {
  assert.match(launcher, /\.card\{min-height:440px;/);
  assert.match(launcher, /\.status\{min-height:56px;/);
  assert.match(launcher, /@media\(max-width:520px\)\{\.card\{min-height:520px;/);
  assert.match(launcher, /id="openPos"[^>]*href="\/app\/"/);
});

test('guard runs without body, redirects unbound hosted browsers, and ignores localhost without config', () => {
  const redirects = [];
  const root = {
    location: { hostname: 'production.nuevo-amanecer-pos.workers.dev', pathname: '/app/', origin: 'https://production.nuevo-amanecer-pos.workers.dev', replace: url => redirects.push(url) },
    document: { documentElement: { dataset: {} } },
    localStorage: { getItem: () => null },
    NA_HOSTED_CONFIG: { environment: 'production', hostedHost: 'production.nuevo-amanecer-pos.workers.dev', apiOrigin: 'https://api.example.test' },
  };
  vm.runInNewContext(guard, { window: root, URL });
  assert.equal(root.document.documentElement.dataset.naHostedCanon, 'activation-required');
  assert.deepEqual(redirects, [root.location.origin + '/']);
  vm.runInNewContext(guard, { window: { location: { hostname: 'localhost' } }, URL });
  root.localStorage.getItem = key => JSON.stringify(key === 'na_canonical_binding'
    ? { endpoint: root.NA_HOSTED_CONFIG.apiOrigin, promotion_id: 'fixture', authority_epoch: 0, revision: 0 }
    : { endpoint: root.NA_HOSTED_CONFIG.apiOrigin, token: 'test-only' });
  vm.runInNewContext(guard, { window: root, URL });
  assert.equal(root.document.documentElement.dataset.naHostedCanon, 'bound');
  assert.equal(redirects.length, 1);
});
