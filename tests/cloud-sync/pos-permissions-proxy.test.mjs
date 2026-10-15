import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PERMISSIONS as p } from '../../tools/cloudflare-lab/src/pos-permissions.js';
import worker from '../../tools/cloudflare-pos-web/src/worker.js';
const config = JSON.parse(readFileSync(new URL('../../tools/cloudflare-pos-web/wrangler.jsonc', import.meta.url), 'utf8'));
const patterns = config.assets.run_worker_first;

test('all permission routes are proxied by assets and the web Worker', async () => {
  assert.deepEqual(p.PROXY_PREFIXES, patterns.filter(x => !['/', '/app', '/app/'].includes(x)));
  for (const path of new Set([...p.ROLE_PATHS, ...p.PRODUCT_IMAGE_PATHS, ...p.API_ROUTES.map(r => r.path)])) {
    assert.ok(patterns.some(pattern => pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path), path);
    let called = false;
    const response = await worker.fetch(new Request('https://pos.test' + path), {
      CANON_API_ORIGIN: 'https://backend.test',
      CANON_BACKEND: { fetch(request) { called = new URL(request.url).pathname === path; return new Response('proxied'); } },
      ASSETS: { fetch() { throw new Error('API incorrectly sent to assets: ' + path); } },
    });
    assert.equal(called, true, path);
    assert.equal(await response.text(), 'proxied');
  }
});
