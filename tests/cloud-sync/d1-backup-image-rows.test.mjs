import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stripInternalImageRows } from '../../tools/cloudflare-backup/src/backup-core.js';

globalThis.crypto ??= webcrypto;

const SQL = [
  'CREATE TABLE pos_settings(key TEXT PRIMARY KEY, value_json TEXT);',
  `INSERT INTO "pos_settings" ("key","value_json") VALUES('normal','{}');`,
  `INSERT INTO "pos_settings" ("key","value_json") VALUES('internal:dni:x','{}');`,
  `INSERT INTO "pos_settings" ("key","value_json") VALUES('internal:img:m:abc','{"p":"1"}');`,
  `INSERT INTO pos_settings VALUES('internal:img:c:abc:etag:0','"AAAA"');`,
  `INSERT INTO "pos_settings" ("key","value_json") VALUES('internal:imgrate:abc','{}');`,
  `INSERT INTO "products" ("product_id","name") VALUES('p1','internal:img:m:not-a-setting');`,
].join('\n');

test('stripInternalImageRows elimina solo filas internal:img de pos_settings', () => {
  const out = stripInternalImageRows(SQL);
  assert.ok(!/VALUES\('internal:img/.test(out), 'sin miniaturas ni contadores');
  for (const keep of ["'normal'", "'internal:dni:x'", 'CREATE TABLE pos_settings', "VALUES('p1','internal:img:m:not-a-setting')"]) assert.ok(out.includes(keep), keep);
  assert.equal(out.split('\n').length, 4);
});

const require = createRequire(new URL('../../tools/cloudflare-lab/package.json', import.meta.url));
const { build } = require('esbuild');
const bundled = await build({ entryPoints: [fileURLToPath(new URL('../../tools/cloudflare-backup/src/workflow.js', import.meta.url))],
  bundle: true, format: 'esm', write: false, plugins: [{ name: 'workflow-base-only', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'base', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class WorkflowEntrypoint { constructor(ctx, env) { this.env = env; } }' }));
  } }] });
const { D1BackupWorkflow } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('el Workflow de respaldo D1 guarda en R2 el SQL sin filas internal:img', async t => {
  const objects = new Map();
  const env = { ACCOUNT_ID: 'a'.repeat(32), DATABASE_ID: 'cf2c83d3-f187-472e-967b-0ad24be969eb', D1_REST_API_TOKEN: 'test-secret',
    BACKUP_BUCKET: {
      async put(key, bytes, options) { objects.set(key, { bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, options }); },
      async get(key) { const v = objects.get(key); return v && { size: v.bytes.byteLength, customMetadata: v.options.customMetadata, arrayBuffer: async () => v.bytes.buffer.slice(v.bytes.byteOffset, v.bytes.byteOffset + v.bytes.byteLength) }; },
    } };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://download.example/export') return new Response(SQL);
    const body = JSON.parse(options.body);
    return Response.json({ success: true, result: body.current_bookmark ? { at_bookmark: 'b', status: 'complete', result: { signed_url: 'https://download.example/export' } } : { at_bookmark: 'b' } });
  });
  const step = { async do(name, options, callback) { return (callback ?? options)(); } };
  const result = await new D1BackupWorkflow({}, env).run({ timestamp: new Date('2026-09-21T08:00:00Z') }, step);
  assert.equal(result.status, 'PASS');
  const sql = new TextDecoder().decode(objects.get(result.sql_key).bytes);
  assert.ok(!/VALUES\('internal:img/.test(sql));
  assert.ok(sql.includes("'normal'"));
  assert.equal(result.size_bytes, new TextEncoder().encode(stripInternalImageRows(SQL)).byteLength);
});
