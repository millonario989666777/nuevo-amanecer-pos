import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decimalToCents, mapStagingRow, a6PolicyHash, A6_POLICY_HASH_INPUT } from '../../tools/cloudflare-lab/src/a6-mapping.js';
import { sha256Hex, stableStringify } from '../../tools/cloudflare-lab/src/a5-import-core.js';
import { a6Fixture, assertedFinancialRows, deferred, intercept, READ_ROUTES, READER, response, SALE, syntheticRows, syncOperation, TABLES, trafficIsZero, WRITER } from './a6-fixture.mjs';

async function frozen(t, options) {
  const f = await a6Fixture(t, options);
  await response(await f.freeze(), 201);
  assert.equal(f.control().mode, 'FROZEN');
  return f;
}

async function published(t, options) {
  const f = await frozen(t, options);
  const result = await response(await f.promote(), 201);
  assert.equal(result.status, 'COMMITTED');
  assert.equal(f.control().active_promotion_id, f.request.promotion_id);
  return { f, result };
}

function stagedRow(type, payload, key = payload.id ?? 'key') {
  return (async () => {
    const json = stableStringify(payload);
    return { import_id: 'mapping-run', entity_type: type, source_key: key, source_name: 'mapping.json', source_row: 1,
      payload_json: json, payload_hash: await sha256Hex(json), validation_status: 'VALID' };
  })();
}

function insertRow(f, table, row) {
  const keys = Object.keys(row);
  return f.exec(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(key => row[key] ?? null));
}

async function emptyCandidate(t) {
  const f = await frozen(t);
  f.failBatchAt(0);
  await response(await f.promote('prepare'), 409);
  f.failBatchAt(null);
  assert.equal(f.sql('SELECT status FROM canonical_promotions').status, 'PREPARED');
  const mapped = {};
  for (const type of TABLES) mapped[type] = (await mapStagingRow(f.sql('SELECT * FROM import_staging WHERE entity_type=? ORDER BY source_key LIMIT 1', type), f.request.promotion_id)).row;
  return { f, mapped };
}

test('SQL real: PK/FK generación/fuente, centavos seguros, hashes, JSON y flags rechazan inserts inválidos', async (t) => {
  const { f, mapped } = await emptyCandidate(t);
  const attacks = [
    ['products', { product_id: null }, /NOT NULL/],
    ['products', { promotion_id: 'missing' }, /candidate_sealed/],
    ['products', { source_key: 'missing-source' }, /FOREIGN KEY/],
    ['products', { source_entity_type: 'customers' }, /CHECK/],
    ['products', { source_payload_hash: 'g'.repeat(64) }, /CHECK/],
    ['products', { source_payload_hash: 'a'.repeat(63) }, /CHECK/],
    ['products', { source_payload_json: '{' }, /CHECK/],
    ['products', { includes_igv: 2 }, /CHECK/],
    ['products', { tracks_inventory: -1 }, /CHECK/],
    ['products', { cost_cents: 0.5 }, /invalid_product/],
    ['products', { price_cents: Number.MAX_SAFE_INTEGER + 1 }, /invalid_product/],
    ['products', { opening_stock_quantity: Infinity, current_stock_quantity: Infinity }, /CHECK/],
    ['products', { current_stock_quantity: 999 }, /invalid_product/],
    ['products', { alternate_codes_json: '{}' }, /invalid_product/],
    ['credits', { customer_id: 'missing-customer' }, /FOREIGN KEY/],
    ['credit_payments', { credit_id: 'missing-credit' }, /FOREIGN KEY/],
    ['credit_payments', { amount_cents: 0 }, /CHECK/],
    ['credit_payments', { amount_cents: 0.5 }, /invalid_payment/],
    ['credit_payments', { source_payment_id: '-' }, /invalid_payment/],
    ['credit_payments', { payment_date_known: 2 }, /CHECK/],
  ];
  for (const [table, delta, error] of attacks) assert.throws(() => insertRow(f, table, { ...mapped[table], ...delta }), error, `${table}: ${JSON.stringify(delta)}`);
  assert.deepEqual(f.counts(), { products: 0, customers: 0, credits: 0, credit_payments: 0 });
  assert.equal(f.sql('SELECT candidate_revision FROM canonical_promotions').candidate_revision, 0);
  insertRow(f, 'customers', mapped.customers);
  insertRow(f, 'credits', mapped.credits);
  insertRow(f, 'credit_payments', mapped.credit_payments);
  assert.equal(f.sql('SELECT candidate_revision FROM canonical_promotions').candidate_revision, 3);
  assert.throws(() => insertRow(f, 'credit_payments', mapped.credit_payments), /UNIQUE/);
  assert.deepEqual(f.all('PRAGMA foreign_key_check'), []);
});

test('reconciliación rechaza hash sintácticamente válido pero falso y proyección tipada alterada', async (t) => {
  for (const delta of [{ source_payload_hash: 'a'.repeat(64) }, { price_cents: 999 }, { source_payload_json: '{"substituted":true}' }]) await t.test(Object.keys(delta)[0], async (t) => {
    const { f, mapped } = await emptyCandidate(t);
    insertRow(f, 'products', { ...mapped.products, ...delta });
    const result = await response(await f.promote(), 409);
    assert.equal(result.error, 'canonical_reconciliation_failed');
    assert.equal(f.control().active_promotion_id, null);
    assert.equal(f.sql('SELECT status FROM canonical_promotions').status, 'PREPARED');
    trafficIsZero(f);
  });
});

test('carrera SQL: venta/sync validada antes de freeze no escribe después del fence', async (t) => {
  for (const target of ['sale', 'sync']) await t.test(target, async (t) => {
    const f = await a6Fixture(t);
    const reached = deferred(), release = deferred();
    let fired = false;
    const restore = intercept(f, async ({ when, method, entries, sql }) => {
      const match = target === 'sale' ? method === 'batch' && entries.some(e => e.sql.includes('INSERT INTO sales ')) : method === 'run' && sql.includes('INSERT INTO sync_operations');
      if (!fired && when === 'before' && match) { fired = true; reached.resolve(); await release.promise; }
    });
    const request = target === 'sale' ? f.post('/commands/sale.create', SALE) : f.post('/sync/operations', await syncOperation());
    await reached.promise;
    try { await response(await f.freeze(), 201); } finally { release.resolve(); }
    const result = await response(await request, 409);
    assert.equal(result.error, 'authority_frozen');
    restore();
    trafficIsZero(f);
  });
});

test('competidores simultáneos para mismo baseline no pueden reclamar dos aperturas', async (t) => {
  const f = await frozen(t);
  const both = deferred(); let arrived = 0;
  const restore = intercept(f, async ({ when, method, sql }) => {
    if (when === 'before' && method === 'run' && sql.startsWith('INSERT INTO canonical_promotions(')) {
      if (++arrived === 2) both.resolve();
      await both.promise;
    }
  });
  const results = await Promise.all([f.promote(), f.promote('publish', { operation_id: 'other-intent', promotion_id: 'other-generation' })]);
  restore();
  assert.equal(arrived, 2);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_promotions').n, 1);
  assert.equal(f.control().mode, 'CANONICAL_READ_ONLY');
  trafficIsZero(f);
});

test('carreras control/staging/auth revalidan claim, prepare y publish dentro de SQL', async (t) => {
  for (const phase of ['claim', 'prepare', 'publish']) for (const change of ['control', 'rotate', 'revoke']) await t.test(`${phase}/${change}`, async (t) => {
    const f = await frozen(t);
    if (phase === 'publish') await response(await f.promote('prepare'), 200);
    let fired = false;
    const restore = intercept(f, async ({ when, method, kind, sql }) => {
      const match = phase === 'claim' ? method === 'run' && sql.startsWith('INSERT INTO canonical_promotions(') : method === 'batch' && kind === phase;
      if (!fired && when === 'before' && match) {
        fired = true;
        if (change === 'control') f.bumpControl();
        if (change === 'rotate') f.rotate();
        if (change === 'revoke') f.revoke();
      }
    });
    await response(await f.promote(), 409);
    restore();
    assert.ok(fired);
    assert.equal(f.control().active_promotion_id, null);
    assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_promotions WHERE status='COMMITTED'").n, 0);
    trafficIsZero(f);
  });
});

test('freeze CAS rechaza revisión staging cambiada después de validar el run', async (t) => {
  const f = await a6Fixture(t);
  let fired = false;
  intercept(f, async ({ when, method, kind }) => {
    if (!fired && when === 'before' && method === 'batch' && kind === 'freeze') {
      fired = true;
      f.exec('UPDATE import_runs SET revision=revision+1 WHERE import_id=?', f.request.import_id);
    }
  });
  await response(await f.freeze(), 409);
  assert.ok(fired);
  assert.equal(f.control().mode, 'LEGACY');
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_command_receipts').n, 0);
});

test('candidate revision cambia después de reconciliar: publish CAS no sella digest viejo', async (t) => {
  const f = await frozen(t);
  await response(await f.promote('prepare'), 200);
  let fired = false;
  intercept(f, async ({ when, method, kind }) => {
    if (!fired && when === 'before' && method === 'batch' && kind === 'publish') {
      fired = true;
      // Model a writer winning the candidate revision after reconciliation.
      f.exec('UPDATE canonical_promotions SET candidate_revision=candidate_revision+1 WHERE promotion_id=?', f.request.promotion_id);
    }
  });
  await response(await f.promote(), 409);
  assert.ok(fired);
  const p = f.sql('SELECT * FROM canonical_promotions');
  assert.equal(p.sealed_revision, null);
  assert.equal(p.canonical_digest, null);
  assert.equal(f.control().active_promotion_id, null);
});

test('rollback revalida first_live/control/auth dentro del batch y conserva recibo COMMITTED', async (t) => {
  for (const change of ['marker', 'control', 'rotate', 'revoke']) await t.test(change, async (t) => {
    const { f, result } = await published(t);
    let fired = false;
    intercept(f, async ({ when, method, kind }) => {
      if (!fired && when === 'before' && method === 'batch' && kind === 'rollback') {
        fired = true;
        if (change === 'marker') f.bumpControl(",first_live_operation_id='durable-live-marker'");
        if (change === 'control') f.bumpControl();
        if (change === 'rotate') f.rotate();
        if (change === 'revoke') f.revoke();
      }
    });
    await response(await f.rollback(), 409);
    assert.ok(fired);
    assert.equal(f.control().active_promotion_id, f.request.promotion_id);
    const p = f.sql('SELECT status,result_json FROM canonical_promotions');
    assert.equal(p.status, 'COMMITTED');
    assert.deepEqual(JSON.parse(p.result_json), result);
    assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_command_receipts WHERE command='rollback'").n, 0);
  });
});

test('hash/id alterado después de COMMITTED falla sin efectos, fase no cambia identidad', async (t) => {
  const { f, result } = await published(t);
  const before = f.control();
  for (const delta of [{ expected_control_revision: 999 }, { operation_id: 'different' }, { promotion_id: 'different' }, { expected_staging_revision: 999 }, { policy_hash: '0'.repeat(64) }]) {
    await response(await f.promote('publish', delta), 409);
    assert.deepEqual(f.control(), before);
  }
  assert.deepEqual(await response(await f.promote('prepare'), 200), result);
});

test('nulls opcionales ausentes nunca se convierten en defaults comerciales', async (t) => {
  const rows = syntheticRows();
  rows[0].payload = { id: rows[0].source_key, name: 'Minimal' };
  const { f } = await published(t, { rows });
  const p = f.sql("SELECT * FROM products WHERE product_id='00000'");
  for (const key of ['sku','barcode','cost_cents','price_cents','box_price_cents','purchase_factor','units_per_box','opening_stock_quantity','current_stock_quantity','stock_min_quantity','includes_igv','tracks_inventory','expiry_date']) assert.equal(p[key], null, key);
  assert.equal(p.alternate_codes_json, null, 'absent optional codes must remain NULL, not an invented empty list');
});

test('documento de cliente no es alias obligatorio de su ID comercial', async (t) => {
  const rows = syntheticRows();
  rows.find(r => r.entity_type === 'customers').payload.Documento = '00123456';
  const { f } = await published(t, { rows });
  const customer = f.sql('SELECT customer_id,document FROM customers');
  assert.equal(customer.customer_id, '000C');
  assert.equal(customer.document, '00123456');
});

test('FK cliente/crédito/pago no resuelve padre en otra generación con mismo ID', async (t) => {
  const { f } = await published(t, { runs: 2 });
  await f.selectRun(1);
  await response(await f.freeze('freeze-fk-generation-two'), 201);
  f.failBatchAt(0);
  await response(await f.promote('prepare'), 409);
  f.failBatchAt(null);
  const mapped = {};
  for (const table of TABLES) mapped[table] = (await mapStagingRow(f.sql('SELECT * FROM import_staging WHERE import_id=? AND entity_type=? ORDER BY source_key LIMIT 1', f.request.import_id, table), f.request.promotion_id)).row;
  assert.throws(() => insertRow(f, 'credits', mapped.credits), /FOREIGN KEY/);
  assert.throws(() => insertRow(f, 'credit_payments', mapped.credit_payments), /FOREIGN KEY/);
  insertRow(f, 'customers', mapped.customers);
  insertRow(f, 'credits', mapped.credits);
  insertRow(f, 'credit_payments', mapped.credit_payments);
  assert.deepEqual(f.all('PRAGMA foreign_key_check'), []);
  assert.equal(f.control().active_promotion_id, 'a6-promotion-1');
});

test('cada frontera de lote 25+8: antes/durante/después conserva prefijo durable invisible y retry sin duplicados', async (t) => {
  for (const batch of [1, 2]) for (const point of ['before', 'during', 'after']) await t.test(`batch-${batch}/${point}`, async (t) => {
    const f = await frozen(t);
    let seen = 0, fired = false;
    const restore = intercept(f, async ({ when, method, kind, statements }) => {
      if (method !== 'batch' || kind !== 'prepare') return;
      if (when === 'before') seen++;
      if (seen !== batch || fired) return;
      if (point === 'during' && when === 'before') {
        fired = true;
        // Last statement fails AFTER all row INSERTs/revision triggers: real rollback.
        const guard = statements.at(-1);
        guard._run = () => { throw new Error('injected end-of-batch failure'); };
      } else if (point === when) { fired = true; throw new Error('injected batch boundary'); }
    });
    await response(await f.promote('prepare'), 409);
    restore();
    assert.ok(fired);
    const expectedRows = point === 'after' ? batch === 1 ? 25 : 33 : batch === 1 ? 0 : 25;
    assert.equal(Object.values(f.counts()).reduce((sum, n) => sum + n, 0), expectedRows);
    assert.equal(f.sql('SELECT candidate_revision FROM canonical_promotions').candidate_revision, expectedRows);
    assert.equal(f.control().active_promotion_id, null);
    for (const route of READ_ROUTES) await response(await f.read(route), 409);
    trafficIsZero(f);
    await response(await f.promote(), 201);
    assert.equal(f.sql('SELECT candidate_revision FROM canonical_promotions').candidate_revision, 33);
    assert.deepEqual(f.counts(), { products: 28, customers: 1, credits: 1, credit_payments: 3 });
  });
});

test('todos los puntos SQL publish revierten puntero/COMMITTED/digest/recibo como una decisión', async (t) => {
  for (let index = 0; index < 6; index++) await t.test(`statement-${index}`, async (t) => {
    const f = await frozen(t);
    await response(await f.promote('prepare'), 200);
    const before = f.control();
    f.failBatchAt(index);
    await response(await f.promote(), 409);
    f.failBatchAt(null);
    assert.deepEqual(f.control(), before);
    const p = f.sql('SELECT status,sealed_revision,canonical_digest,result_json FROM canonical_promotions');
    assert.deepEqual({ ...p }, { status: 'PREPARED', sealed_revision: null, canonical_digest: null, result_json: null });
    trafficIsZero(f);
    await response(await f.promote(), 201);
  });
});

test('freeze/rollback perdidos después de commit retornan recibos inmutables y mismo epoch en retry', async (t) => {
  for (const command of ['freeze', 'rollback']) await t.test(command, async (t) => {
    const f = command === 'freeze' ? await a6Fixture(t) : (await published(t)).f;
    const path = `/commands/canonical.${command}`;
    const body = { operation_id: `${command}-lost`, expected_control_revision: f.control().revision, ...(command === 'rollback' ? { promotion_id: f.request.promotion_id } : {}) };
    let fired = false;
    const restore = intercept(f, async ({ when, method, kind }) => {
      if (!fired && when === 'after' && method === 'batch' && kind === command) { fired = true; throw new Error('lost receipt ACK'); }
    });
    const first = await response(await f.post(path, body), 200);
    restore();
    assert.ok(fired);
    const control = f.control();
    assert.deepEqual(await response(await f.post(path, body), 200), first);
    assert.deepEqual(f.control(), control);
    await response(await f.post(path, { ...body, expected_control_revision: 999 }), 409);
    assert.deepEqual(f.control(), control);
    assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_command_receipts WHERE operation_id=?', body.operation_id).n, 1);
  });
});

test('biyección/hash/digest/totales independientes y export lossless de las cuatro entidades', async (t) => {
  const { f, result } = await published(t);
  const provenance = ['promotion_id','source_import_id','source_entity_type','source_name','source_row','source_key','source_payload_json','source_payload_hash','mapping_version'];
  const digestRows = [];
  for (const table of TABLES) {
    const columns = f.all(`PRAGMA table_info(${table})`).map(c => c.name).filter(c => !provenance.includes(c));
    const primary = { products: 'product_id', customers: 'customer_id', credits: 'credit_id', credit_payments: 'payment_id' }[table];
    const rows = f.all(`SELECT * FROM ${table} WHERE promotion_id=? ORDER BY ${primary}`, f.request.promotion_id);
    const entityRows = [];
    const exported = []; let cursor = null;
    do {
      const page = await response(await f.export(f.request.promotion_id, table, `&limit=1${cursor ? `&cursor=${cursor}` : ''}`), 200);
      exported.push(...page.items); cursor = page.next_cursor;
    } while (cursor);
    assert.equal(exported.length, rows.length);
    assert.equal(new Set(exported.map(r => JSON.stringify([r.source_name,r.source_row,r.source_key]))).size, rows.length);
    for (const row of rows) {
      const original = f.sql('SELECT * FROM import_staging WHERE import_id=? AND entity_type=? AND source_name=? AND source_row=? AND source_key=?', row.source_import_id, row.source_entity_type, row.source_name, row.source_row, row.source_key);
      assert.equal(row.source_payload_json, original.payload_json);
      assert.equal(row.source_payload_hash, await sha256Hex(original.payload_json));
      const exportedRow = exported.find(r => r.source_name === row.source_name && r.source_row === row.source_row && r.source_key === row.source_key);
      assert.equal(exportedRow.source_payload_json, original.payload_json);
      const digest = { entity_type: table, row: Object.fromEntries([...columns,'source_name','source_row','source_key','source_payload_hash'].map(k => [k, row[k] ?? null])) };
      entityRows.push(digest); digestRows.push(digest);
    }
    assert.equal(result.entity_digests[table], await sha256Hex(stableStringify(entityRows)));
  }
  assert.equal(result.canonical_digest, await sha256Hex(stableStringify(digestRows)));
  assert.deepEqual(result.amounts, { credit_amount_cents: 1000, credit_paid_cents: 300, credit_balance_cents: 700, payment_amount_cents: 300 });
  const credit = f.sql('SELECT * FROM credits');
  assert.equal(credit.sale_id, null);
  assert.equal(credit.original_amount_cents - credit.import_paid_cents, credit.opening_balance_cents);
  assert.equal(credit.current_balance_cents, credit.opening_balance_cents);
  assert.equal(f.sql('SELECT SUM(amount_cents) n FROM credit_payments').n, credit.import_paid_cents);
  trafficIsZero(f);
});

test('Date objects serializan ISO; objetos {}, inválidos y aliases contradictorios bloquean promoción API', async (t) => {
  for (const [label, change] of [
    ['lost-Date', p => { p.Fecha = {}; }],
    ['invalid-date', p => { p.fecha = '2026-02-30'; }],
    ['contradictory-date', p => { p.Fecha = '2026-03-02'; }],
    ['contradictory-time', p => { p['Fecha y hora'] = '2026-03-01T11:00:00Z'; }],
    ['contradictory-amount', p => { p.Monto = '999.00'; }],
  ]) await t.test(label, async (t) => {
    const rows = syntheticRows();
    change(rows.find(r => r.payload.id === 'PAY:2').payload);
    const f = await frozen(t, { rows });
    const rejected = await response(await f.promote(), 409);
    assert.equal(rejected.error, 'mapping_rejected');
    assert.equal(f.control().active_promotion_id, null);
    trafficIsZero(f);
  });
  const rows = syntheticRows();
  rows.find(r => r.payload.id === 'PAY:2').payload.Fecha = new Date('2026-03-01T03:04:05.000Z');
  const { f } = await published(t, { rows });
  const json = f.sql("SELECT source_payload_json FROM credit_payments WHERE source_payment_id='PAY:2'").source_payload_json;
  assert.equal(JSON.parse(json).Fecha, '2026-03-01T03:04:05.000Z');
});

test('seguridad lecturas: READ_TOKEN o sesión writer activa, cursor/limit inválido y CORS', async (t) => {
  const { f } = await published(t);
  for (const route of READ_ROUTES) {
    await response(await f.read(route, '', {}), 401);
    await response(await f.read(route, '', WRITER), 200);
    const options = await f.fetch(`http://localhost/read/canonical/${route}`, { method: 'OPTIONS' });
    assert.equal(options.status, 204);
    assert.match(options.headers.get('access-control-allow-headers'), /x-read-token/i);
  }
  // Canonical collection pages accept up to 250 rows (admin/export pages stay at 100).
  for (const query of ['?limit=0','?limit=251','?limit=1.1','?limit=NaN','?cursor=!!!','?cursor=e30']) await response(await f.read('products', query), 400);
  await response(await f.read('products', '?limit=250'), 200);
  f.revoke();
  await response(await f.read('products'), 200);
  await response(await f.export(f.request.promotion_id, 'products'), 403);
  assert.equal((await f.fetch('http://localhost/read/canonical/products', { method: 'POST', headers: READER })).status, 405);
});

test('Gate local falla cerrado salvo enabled + localhost + database/manifest exactos y policy hash estable', async (t) => {
  const f = await a6Fixture(t);
  assert.equal(await a6PolicyHash(), await sha256Hex(A6_POLICY_HASH_INPUT));
  const valid = f.env.A6_OPERATIONAL_MANIFEST;
  for (const [url, mutation, status, error] of [
    ['http://worker.test/read/canonical/status', () => {}, 404, 'not_found'],
    ['http://localhost/read/canonical/status', () => { f.env.A6_LOCAL_GATE = 'disabled'; }, 404, 'not_found'],
    ['http://localhost/read/canonical/status', () => { f.env.A6_LOCAL_GATE = 'enabled'; f.env.A6_LOCAL_DATABASE_ID = 'wrong'; }, 503, 'a6_manifest_invalid'],
    ['http://localhost/read/canonical/status', () => { f.env.A6_LOCAL_DATABASE_ID = 'a6-synthetic-memory-database'; f.env.A6_OPERATIONAL_MANIFEST = '{}'; }, 503, 'a6_manifest_invalid'],
  ]) {
    f.env.A6_OPERATIONAL_MANIFEST = valid;
    mutation();
    const body = await response(await f.fetch(url, { headers: READER }), status);
    assert.equal(body.error, error);
  }
});

test('freeze gana por CAS SQL o rechaza carrera legacy; después cerca sale, sync e import sin efectos parciales', async (t) => {
  const f = await a6Fixture(t);
  let raced = false;
  const restore = intercept(f, async ({ when, method, kind }) => {
    if (!raced && when === 'before' && method === 'batch' && kind === 'freeze') {
      raced = true;
      f.insert({ operation_id: 'race-before-freeze', device_id: 'a6-writer', device_sequence: 1, entity_type: 'sale', entity_id: 'sale-race', payload: {}, created_at: '2026-01-01', received_at: '2026-01-01' });
    }
  });
  assert.equal((await f.freeze('freeze-raced')).status, 409);
  assert.equal(f.control().mode, 'LEGACY');
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_command_receipts').n, 0);
  restore();
  f.exec('DELETE FROM sync_operations WHERE operation_id=?', 'race-before-freeze');
  await response(await f.freeze('freeze-winner'), 201);
  assert.equal((await f.post('/commands/sale.create', SALE)).status, 409);
  assert.equal((await f.post('/sync/operations', await syncOperation())).status, 409);
  assert.equal((await f.post('/commands/import.stage', { action: 'start', import_id: 'stale-import' })).status, 409);
  trafficIsZero(f);
});

test('PREPARED completo permanece invisible; publish sella promoción y puntero atómicamente', async (t) => {
  const f = await frozen(t);
  const prepared = await response(await f.promote('prepare'), 200);
  assert.equal(prepared.status, 'PREPARED');
  assert.equal(prepared.remaining, 0);
  assert.deepEqual(f.counts(), { products: 28, customers: 1, credits: 1, credit_payments: 3 });
  assert.equal(f.control().active_promotion_id, null);
  assert.equal((await f.read('products')).status, 409);
  const committed = await response(await f.promote('publish'), 201);
  assert.equal(committed.status, 'COMMITTED');
  assert.equal(f.sql('SELECT status FROM canonical_promotions WHERE promotion_id=?', f.request.promotion_id).status, 'COMMITTED');
  assert.equal(f.control().active_promotion_id, f.request.promotion_id);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_assertions').n, 0);
  assert.equal((await f.post('/commands/sale.create', SALE)).status, 409, 'writer legacy after new commit');
  assert.equal((await f.post('/sync/operations', await syncOperation())).status, 409, 'legacy journal after new commit');
  trafficIsZero(f);
});

test('retry simultáneo mismo operation/hash produce una sola generación; hash distinto y competidor no abren otra', async (t) => {
  const f = await frozen(t);
  const both = deferred();
  let arrived = 0;
  const restore = intercept(f, async ({ when, method, sql }) => {
    if (when === 'before' && method === 'run' && sql.startsWith('INSERT INTO canonical_promotions(')) {
      if (++arrived === 2) both.resolve();
      await both.promise;
    }
  });
  const [one, two] = await Promise.all([f.promote(), f.promote()]);
  restore();
  assert.equal(arrived, 2, 'both requests reached the claim race');
  const bodies = await Promise.all([one.json(), two.json()]);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_promotions').n, 1);
  assert.deepEqual(f.counts(), { products: 28, customers: 1, credits: 1, credit_payments: 3 });
  assert.equal((await f.promote('publish', { expected_source_hash: 'f'.repeat(64) })).status, 409);
  assert.equal((await f.promote('publish', { operation_id: 'competitor-op', promotion_id: 'competitor-promotion' })).status, 409);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_promotions').n, 1);
  assert.deepEqual(await response(await f.promote(), 200), bodies.find(x => x.status === 'COMMITTED'));
  assert.deepEqual([one.status, two.status].sort(), [200, 201], JSON.stringify(bodies));
  assert.equal(new Set(bodies.map(x => x.canonical_digest)).size, 1);
});

test('CAS de writer detecta rotación y revocación entre autorización y lote; retry con credencial vigente reanuda', async (t) => {
  for (const action of ['rotate', 'revoke']) await t.test(action, async (t) => {
    const f = await frozen(t);
    let injected = false;
    const restore = intercept(f, async ({ when, method, kind }) => {
      if (!injected && when === 'before' && method === 'batch' && kind === 'prepare') {
        injected = true;
        if (action === 'rotate') f.rotate(); else f.revoke();
      }
    });
    assert.equal((await f.promote('prepare')).status, 409);
    assert.deepEqual(f.counts(), { products: 0, customers: 0, credits: 0, credit_payments: 0 });
    restore();
    if (action === 'rotate') {
      assert.equal((await f.promote('prepare')).status, 401);
      const current = { ...WRITER, 'x-sync-token': 'rotated-secret' };
      const resumed = await response(await f.post('/commands/import.promote', { ...f.request, phase: 'prepare' }, current), 200);
      assert.equal(resumed.remaining, 0);
    } else {
      assert.equal((await f.promote('prepare')).status, 403);
    }
  });
});

test('fallos antes/durante/después del batch PREPARE no publican parcial y retry converge', async (t) => {
  for (const point of ['before', 'during', 'after']) await t.test(point, async (t) => {
    const f = await frozen(t);
    let fired = false;
    let restore = () => {};
    if (point === 'during') f.failBatchAt(2);
    else restore = intercept(f, async ({ when, method, kind }) => {
      if (!fired && when === point && method === 'batch' && kind === 'prepare') { fired = true; throw new Error(`injected-${point}`); }
    });
    assert.equal((await f.promote('prepare')).status, 409);
    assert.equal(f.control().active_promotion_id, null);
    assert.equal((await f.read('products')).status, 409);
    if (point !== 'after') assert.deepEqual(f.counts(), { products: 0, customers: 0, credits: 0, credit_payments: 0 });
    else assert.ok(Object.values(f.counts()).reduce((a, b) => a + b, 0) > 0, 'durable batch survives lost ACK');
    restore(); f.failBatchAt(null);
    const retry = await response(await f.promote('publish'), 201);
    assert.equal(retry.status, 'COMMITTED');
    assert.deepEqual(f.counts(), { products: 28, customers: 1, credits: 1, credit_payments: 3 });
  });
});

test('fallos de validación y antes/durante/después de PUBLISH dejan autoridad vieja o commit nuevo completo', async (t) => {
  for (const point of ['validation', 'before', 'during', 'after']) await t.test(point, async (t) => {
    const f = await frozen(t);
    await response(await f.promote('prepare'), 200);
    let fired = false;
    let restore = () => {};
    if (point === 'during') f.failBatchAt(3);
    else restore = intercept(f, async ({ when, method, kind, sql }) => {
      const validation = point === 'validation' && when === 'before' && method === 'all' && sql?.startsWith('SELECT * FROM import_staging');
      const publish = point !== 'validation' && !fired && when === point && method === 'batch' && kind === 'publish';
      if (validation || publish) { fired = true; throw new Error(`injected-${point}`); }
    });
    const failed = await f.promote('publish');
    assert.equal(failed.status, point === 'validation' ? 500 : point === 'after' ? 200 : 409);
    if (point === 'after') {
      assert.equal(f.control().active_promotion_id, f.request.promotion_id);
      assert.equal(f.sql('SELECT status FROM canonical_promotions WHERE promotion_id=?', f.request.promotion_id).status, 'COMMITTED');
    } else {
      assert.equal(f.control().active_promotion_id, null);
      assert.equal(f.sql('SELECT status FROM canonical_promotions WHERE promotion_id=?', f.request.promotion_id).status, 'PREPARED');
    }
    restore(); f.failBatchAt(null);
    const retry = await response(await f.promote('publish'), point === 'after' ? 200 : 201);
    assert.equal(retry.status, 'COMMITTED');
    assert.equal((await f.read('status')).status, 200);
  });
});

test('lost ACK después de commit recupera exactamente el recibo durable sin reaplicar', async (t) => {
  const f = await frozen(t);
  let fired = false;
  const restore = intercept(f, async ({ when, method, kind }) => {
    if (!fired && when === 'after' && method === 'batch' && kind === 'publish') { fired = true; throw new Error('lost-ack'); }
  });
  const recoveredAtBoundary = await response(await f.promote(), 200);
  assert.equal(recoveredAtBoundary.status, 'COMMITTED');
  const durable = f.sql('SELECT result_json,candidate_revision,sealed_revision FROM canonical_promotions WHERE promotion_id=?', f.request.promotion_id);
  assert.ok(durable.result_json);
  assert.equal(durable.candidate_revision, durable.sealed_revision);
  restore();
  const replay = await response(await f.promote(), 200);
  assert.deepEqual(replay, JSON.parse(durable.result_json));
  assert.deepEqual(f.counts(), { products: 28, customers: 1, credits: 1, credit_payments: 3 });
});

test('dos runs staged antes del freeze admiten mismos IDs en generaciones distintas sin FK cruzada ni overwrite', async (t) => {
  const f = await a6Fixture(t, { runs: 2 });
  assert.equal(f.sql("SELECT COUNT(*) n FROM import_runs WHERE status='PASS'").n, 2);
  await response(await f.freeze('freeze-generation-one'), 201);
  await response(await f.promote(), 201);
  const cursor = (await response(await f.read('products', '?limit=1'), 200)).next_cursor;
  const previousRows = f.all('SELECT * FROM products WHERE promotion_id=? ORDER BY product_id', f.request.promotion_id);
  await f.selectRun(1);
  await response(await f.freeze('freeze-generation-two'), 201);
  await response(await f.promote('prepare'), 200);
  assert.equal(f.control().active_promotion_id, 'a6-promotion-1');
  assert.equal((await f.read('products')).status, 409, 'freeze must not expose the candidate');
  const second = await response(await f.promote(), 201);
  assert.equal(second.promotion_id, 'a6-promotion-2');
  for (const table of TABLES) {
    assert.equal(f.sql(`SELECT COUNT(*) n FROM ${table}`).n, f.manifest.expected[table] * 2);
    assert.equal(f.sql(`SELECT COUNT(DISTINCT promotion_id) n FROM ${table}`).n, 2);
  }
  const cross = f.sql(`SELECT COUNT(*) n FROM credits c LEFT JOIN customers u ON u.promotion_id=c.promotion_id AND u.customer_id=c.customer_id WHERE u.customer_id IS NULL`).n;
  assert.equal(cross, 0);
  assert.equal(f.control().active_promotion_id, 'a6-promotion-2');
  assert.equal((await response(await f.read('products', `?cursor=${cursor}`), 400)).error, 'stale_cursor');
  const beforeRollback = f.counts('a6-promotion-2');
  await response(await f.rollback({ operation_id: 'rollback-generation-two' }), 201);
  assert.equal(f.control().active_promotion_id, 'a6-promotion-1');
  assert.equal(f.control().mode, 'CANONICAL_READ_ONLY');
  assert.deepEqual(f.all('SELECT * FROM products WHERE promotion_id=? ORDER BY product_id', 'a6-promotion-1'), previousRows);
  assert.deepEqual(f.counts('a6-promotion-2'), beforeRollback);
  assert.deepEqual(await response(await f.promote(), 200), second, 'abandoned publication retains COMMITTED receipt');
  assert.equal(f.control().active_promotion_id, 'a6-promotion-1', 'receipt replay must not republish');
});

test('rollback pretráfico conserva filas y recibos; first_live y efectos impiden rollback simple', async (t) => {
  const { f, result } = await published(t);
  const rolled = await response(await f.rollback(), 201);
  assert.equal(rolled.active_promotion_id, null);
  assert.equal(f.sql('SELECT status FROM canonical_promotions WHERE promotion_id=?', f.request.promotion_id).status, 'ABANDONED');
  assert.deepEqual(JSON.parse(f.sql('SELECT result_json FROM canonical_promotions WHERE promotion_id=?', f.request.promotion_id).result_json), result);
  assert.ok(f.sql("SELECT result_json FROM canonical_command_receipts WHERE command='rollback'").result_json);
  assert.deepEqual(f.counts(), { products: 28, customers: 1, credits: 1, credit_payments: 3 });

  const live = await published(t);
  live.f.bumpControl(",first_live_operation_id='first-live-op'");
  const revision = live.f.control().revision;
  assert.equal((await live.f.rollback({ operation_id: 'rollback-after-live' })).status, 409);
  assert.equal(live.f.control().active_promotion_id, live.f.request.promotion_id);
  assert.equal(live.f.control().revision, revision);
  assert.ok(live.f.sql('SELECT result_json FROM canonical_promotions WHERE promotion_id=?', live.f.request.promotion_id).result_json);
});

test('mapeo preserva centavos exactos, ceros, negativos/decimales, flags, nulls y DATE/TIMESTAMP/UNKNOWN', async (t) => {
  const { f } = await published(t);
  const product = f.sql("SELECT * FROM products WHERE promotion_id=? AND product_id='00000'", f.request.promotion_id);
  assert.deepEqual({ product_id: product.product_id, sku: product.sku, barcode: product.barcode, alternate: JSON.parse(product.alternate_codes_json), cost: product.cost_cents,
    price: product.price_cents, stock: product.opening_stock_quantity, factor: product.purchase_factor, igv: product.includes_igv, tracks: product.tracks_inventory, image: product.image },
  { product_id: '00000', sku: '000', barcode: '0000', alternate: ['0007','0007','0010'], cost: 29, price: 1234, stock: -2.75, factor: 2.5, igv: 1, tracks: 0, image: null });
  assert.equal(f.sql("SELECT opening_stock_quantity FROM products WHERE product_id='00001' AND promotion_id=?", f.request.promotion_id).opening_stock_quantity, 0);
  assert.equal(decimalToCents('90071992547409.91'), 9007199254740991);
  assert.throws(() => decimalToCents('0.001'), /invalid_amount/);
  assert.throws(() => decimalToCents('90071992547409.92'), /invalid_amount/);
  const dates = f.all('SELECT source_payment_id,payment_date,payment_timestamp,payment_date_known,date_precision FROM credit_payments WHERE promotion_id=? ORDER BY source_payment_id', f.request.promotion_id);
  assert.deepEqual(dates.map(x => [x.source_payment_id, x.payment_date, x.payment_timestamp, x.payment_date_known, x.date_precision]), [
    ['PAY:0', null, null, 0, 'UNKNOWN'], ['PAY:1', '2026-02-28', null, 1, 'DATE'], ['PAY:2', '2026-03-01', '2026-02-28T22:04:05.000-05:00', 1, 'TIMESTAMP'],
  ]);
});

test('gate field-level rechaza Date perdido como {}, fecha inválida y aliases contradictorios', async () => {
  const cases = [
    ['credit_payments', { id: 'p', credito_id: 'c', monto_cents: 100, fecha: '2026-01-01', fecha_conocida: true, Fecha: {} }, /invalid_payment_date/],
    ['credit_payments', { id: 'p', credito_id: 'c', monto_cents: 100, fecha: '2026-02-30', fecha_conocida: true }, /invalid_(normalized_)?payment_date/],
    ['credit_payments', { id: 'p', credito_id: 'c', monto_cents: 100, fecha: null, fecha_conocida: false, Fecha: '2026-01-01' }, /contradictory_payment_date/],
    ['credits', { id: 'c', cliente_id: 'u', monto_cents: 100, Monto: '2.00', pagado_cents: 0, saldo_cents: 100 }, /contradictory_original_amount/],
    ['products', { id: 'different', name: 'x' }, /contradictory_product_id/],
  ];
  for (const [type, payload, error] of cases) await assert.rejects(mapStagingRow(await stagedRow(type, payload, type === 'products' ? 'source-id' : payload.id), 'p'), error);
});

test('constraints SQL exigen FK/hash/JSON/flags y candidatos/recibos son inmutables', async (t) => {
  const { f } = await published(t);
  assert.equal(f.database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  for (const table of TABLES) {
    assert.throws(() => f.exec(`UPDATE ${table} SET source_payload_hash=? WHERE promotion_id=?`, 'a'.repeat(64), f.request.promotion_id), /immutable_canonical_candidate/);
    assert.throws(() => f.exec(`DELETE FROM ${table} WHERE promotion_id=?`, f.request.promotion_id), /immutable_canonical_candidate/);
    const existing = f.sql(`SELECT * FROM ${table} WHERE promotion_id=? LIMIT 1`, f.request.promotion_id);
    assert.throws(() => insertRow(f, table, existing), /candidate_sealed/);
  }
  assert.throws(() => f.exec('DELETE FROM canonical_promotions WHERE promotion_id=?', f.request.promotion_id), /immutable_promotion/);
  assert.throws(() => f.exec("UPDATE canonical_promotions SET request_hash=? WHERE promotion_id=?", 'a'.repeat(64), f.request.promotion_id), /immutable_promotion/);
  assert.throws(() => f.exec("UPDATE canonical_command_receipts SET result_json='{}'"), /immutable_receipt/);
  assert.throws(() => f.exec('DELETE FROM canonical_command_receipts'), /immutable_receipt/);
  assert.throws(() => f.exec("UPDATE canonical_control SET mode='ACTIVE',revision=revision+1,authority_epoch=authority_epoch+1 WHERE id=1"), /gate_p_control/);
  f.exec("UPDATE canonical_control SET first_live_operation_id='x',revision=revision+1,authority_epoch=authority_epoch+1 WHERE id=1");
  assert.throws(() => f.exec("UPDATE canonical_control SET first_live_operation_id=NULL,revision=revision+1,authority_epoch=authority_epoch+1 WHERE id=1"), /immutable_first_live/);
});

test('todas las rutas leen autoridad activa con paginación completa, cursores stale y cero secretos/raw JSON públicos', async (t) => {
  const { f } = await published(t);
  for (const route of READ_ROUTES) {
    let cursor = null, items = [], pages = 0;
    do {
      const query = `?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await f.read(route, query);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const text = await r.text();
      assert.equal(r.status, 200, `${route}: ${text}`);
      assert.doesNotMatch(text, /fixture-read-token|a6-writer-secret|credential_hash|source_payload_json|synthetic-source-secret/);
      const body = JSON.parse(text);
      assert.equal(body.authority, 'canonical');
      assert.equal(body.promotion_id, f.request.promotion_id);
      assert.equal(body.read_only, true);
      if (route !== 'status') { items.push(...body.items); cursor = body.next_cursor; } else cursor = null;
      pages++;
    } while (cursor);
    assert.ok(pages >= 1);
    if (route === 'products') assert.equal(items.length, 28);
    if (route === 'customers') assert.equal(items.length, 1);
    if (route === 'credits') assert.equal(items.length, 1);
    if (route === 'credit-payments') assert.equal(items.length, 3);
    if (['sales','sale-items','inventory-movements','cash-movements'].includes(route)) assert.equal(items.length, 0);
  }
  const first = await response(await f.read('products', '?limit=1'), 200);
  f.bumpControl();
  const stale = await response(await f.read('products', `?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`), 400);
  assert.equal(stale.error, 'stale_cursor');
});

test('lector detecta cambio de autoridad durante consulta y no devuelve página mezclada', async (t) => {
  const { f } = await published(t);
  let controls = 0;
  const restore = intercept(f, async ({ when, method, sql }) => {
    if (when === 'after' && method === 'first' && sql?.startsWith('SELECT mode,active_promotion_id')) {
      controls++;
      if (controls === 1) f.bumpControl();
    }
  });
  const body = await response(await f.read('products', '?limit=3'), 409);
  assert.equal(body.error, 'authority_changed');
  restore();
});

test('export admin pagina procedencia lossless incluso tras rollback; público y read_only no acceden', async (t) => {
  const { f } = await published(t);
  const original = f.sql("SELECT payload_json,payload_hash FROM import_staging WHERE entity_type='products' AND source_key='00000'");
  let cursor = '', found;
  do {
    const page = await response(await f.export(f.request.promotion_id, 'products', `&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), 200);
    found ||= page.items.find(x => x.source_key === '00000');
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(found.source_payload_json, original.payload_json);
  assert.equal(found.source_payload_hash, original.payload_hash);
  assert.equal((await f.export(f.request.promotion_id, 'products', '', {})).status, 401);
  assert.equal((await f.export(f.request.promotion_id, 'products', '', { 'x-device-id': 'a6-reader', 'x-sync-token': 'a6-reader-secret' })).status, 403);
  await response(await f.rollback(), 201);
  const after = await response(await f.export(f.request.promotion_id, 'products', '&limit=100'), 200);
  assert.equal(after.status, 'ABANDONED');
  assert.equal(after.items.find(x => x.source_key === '00000').source_payload_json, original.payload_json);
});

test('migración 0006 es acumulativa sobre 0001..0005 y restricciones quedan activas', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (let i = 1; i <= 6; i++) {
      const match = i === 1 ? '0001_sync_operations.sql' : i === 2 ? '0002_read_only_indexes.sql' : i === 3 ? '0003_device_auth.sql'
        : i === 4 ? '0004_sale_create.sql' : i === 5 ? '0005_import_staging.sql' : '0006_canonical_promotion.sql';
      db.exec(readFileSync(new URL(`../../infra/database/migrations/${match}`, import.meta.url), 'utf8'));
    }
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('canonical_promotions','canonical_control','products','customers','credits','credit_payments')").get().n, 6);
    assert.throws(() => db.prepare("INSERT INTO canonical_control(id,mode,revision,authority_epoch,minimum_client_contract) VALUES(2,'LEGACY',0,0,'x')").run(), /CHECK constraint failed/);
  } finally { db.close(); }
});

test('migración 0006 es reaplicable sin destruir generaciones ni control', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const name of ['0001_sync_operations.sql','0002_read_only_indexes.sql','0003_device_auth.sql','0004_sale_create.sql','0005_import_staging.sql','0006_canonical_promotion.sql']) {
      db.exec(readFileSync(new URL(`../../infra/database/migrations/${name}`, import.meta.url), 'utf8'));
    }
    const migration = readFileSync(new URL('../../infra/database/migrations/0006_canonical_promotion.sql', import.meta.url), 'utf8');
    assert.doesNotThrow(() => db.exec(migration));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM canonical_control').get().n, 1);
  } finally { db.close(); }
});

// Gap regressions: assertions are contractual, not an expected-failure baseline.
function generationSnapshot(f, id) {
  const key = { products: 'product_id', customers: 'customer_id', credits: 'credit_id', credit_payments: 'payment_id' };
  return Object.fromEntries(TABLES.map(table => [table, f.all(`SELECT * FROM ${table} WHERE promotion_id=? ORDER BY ${key[table]}`, id)]));
}

async function failedPreparedAfterReadOnly(t, runs = 2) {
  const { f } = await published(t, { runs });
  const previous = f.request.promotion_id;
  const previousRows = generationSnapshot(f, previous);
  await f.selectRun(1);
  await response(await f.freeze('freeze-failed-candidate'), 201);
  let batches = 0;
  const restore = intercept(f, async ({ method, kind, when }) => {
    if (method === 'batch' && kind === 'prepare' && when === 'before' && ++batches === 2) throw new Error('synthetic candidate interrupted after durable prefix');
  });
  try { await response(await f.promote(), 409); } finally { restore(); }
  assert.equal(batches, 2, 'fault reached the second prepare batch');
  const candidate = f.sql('SELECT * FROM canonical_promotions WHERE promotion_id=?', f.request.promotion_id);
  assert.equal(candidate.status, 'PREPARED');
  assert.equal(candidate.candidate_revision, 25);
  assert.equal(candidate.result_json, null);
  assert.equal(f.control().mode, 'FROZEN');
  assert.equal(f.control().active_promotion_id, previous);
  assert.equal(f.control().first_live_operation_id, null);
  return { f, previous, previousRows, candidate, candidateRows: generationSnapshot(f, candidate.promotion_id) };
}

test('gap/PREPARED rollback FROZEN restaura puntero previo read-only y conserva prefijo ABANDONED', async (t) => {
  const { f, previous, previousRows, candidate, candidateRows } = await failedPreparedAfterReadOnly(t);
  const before = f.control();
  const request = { operation_id: 'abandon-failed-prepared', promotion_id: candidate.promotion_id, expected_control_revision: before.revision };
  const result = await response(await f.post('/commands/canonical.rollback', request), 201);
  assert.equal(result.status, 'ROLLED_BACK');
  assert.equal(result.write_permission_restored, false);
  assert.equal(f.control().mode, 'CANONICAL_READ_ONLY');
  assert.equal(f.control().active_promotion_id, previous);
  assert.equal(f.control().revision, before.revision + 1);
  assert.equal(f.control().authority_epoch, before.authority_epoch + 1);
  const abandoned = f.sql('SELECT * FROM canonical_promotions WHERE promotion_id=?', candidate.promotion_id);
  assert.equal(abandoned.status, 'ABANDONED');
  assert.equal(abandoned.result_json, null, 'never manufacture a COMMITTED receipt');
  assert.equal(abandoned.candidate_revision, 25);
  assert.deepEqual(generationSnapshot(f, candidate.promotion_id), candidateRows);
  assert.deepEqual(generationSnapshot(f, previous), previousRows);
  assert.equal((await response(await f.read('status'), 200)).promotion_id, previous);
  const exported = await response(await f.export(candidate.promotion_id, 'products', '&limit=100'), 200);
  assert.equal(exported.status, 'ABANDONED');
  assert.equal(exported.items.length, 25);
  assert.deepEqual(await response(await f.post('/commands/canonical.rollback', request), 200), result);
  await response(await f.promote(), 409);
  assert.equal(f.control().active_promotion_id, previous);
  trafficIsZero(f);
});

for (const attack of ['stale-request', 'control-race', 'first-live-before', 'first-live-race']) {
  test(`gap/PREPARED rollback refuse ${attack} sans mutation`, async (t) => {
    const { f, candidate, candidateRows } = await failedPreparedAfterReadOnly(t);
    if (attack === 'first-live-before') f.bumpControl(",first_live_operation_id='synthetic-live-marker'");
    const request = { operation_id: `prepared-${attack}`, promotion_id: candidate.promotion_id,
      expected_control_revision: f.control().revision - (attack === 'stale-request' ? 1 : 0) };
    let fired = false, expectedControl = f.control();
    const restore = intercept(f, async ({ when, method, kind }) => {
      if (!fired && attack.endsWith('race') && when === 'before' && method === 'batch' && kind === 'rollback') {
        fired = true;
        f.bumpControl(attack === 'first-live-race' ? ",first_live_operation_id='synthetic-raced-live'" : '');
        expectedControl = f.control();
      }
    });
    try { await response(await f.post('/commands/canonical.rollback', request), 409); } finally { restore(); }
    if (attack.endsWith('race')) assert.ok(fired, 'rollback must reach SQL CAS, not fail due to unsupported PREPARED');
    assert.deepEqual(f.control(), expectedControl);
    assert.equal(f.sql('SELECT status FROM canonical_promotions WHERE promotion_id=?', candidate.promotion_id).status, 'PREPARED');
    assert.deepEqual(generationSnapshot(f, candidate.promotion_id), candidateRows);
    assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_command_receipts WHERE operation_id=?', request.operation_id).n, 0);
  });
}

test('gap/PREPARED obsoleto no puede deshacer un freeze posterior aunque use revision actual', async (t) => {
  const { f, candidate, candidateRows } = await failedPreparedAfterReadOnly(t, 3);
  const oldRequest = { ...f.request }, oldManifest = f.env.A6_OPERATIONAL_MANIFEST;
  // A different staged run wins in this freeze. No trigger is disabled and no
  // control snapshot is restored to manufacture the newer freeze.
  await f.selectRun(2);
  f.request.expected_control_revision = f.control().revision;
  await response(await f.promote(), 201);
  await response(await f.freeze('new-freeze-after-competing-publish'), 201);
  const before = f.control(), newRows = generationSnapshot(f, f.request.promotion_id);
  f.env.A6_OPERATIONAL_MANIFEST = oldManifest;
  f.request = oldRequest;
  await response(await f.rollback({ operation_id: 'obsolete-candidate-rollback', expected_control_revision: before.revision }), 409);
  assert.deepEqual(f.control(), before);
  assert.deepEqual(generationSnapshot(f, before.active_promotion_id), newRows);
  assert.deepEqual(generationSnapshot(f, candidate.promotion_id), candidateRows);
  assert.equal(f.sql('SELECT status FROM canonical_promotions WHERE promotion_id=?', candidate.promotion_id).status, 'PREPARED');
});

test('gap/operational manifest JSON y hash quedan durables e inmutables desde PREPARED hasta rollback', async (t) => {
  const f = await frozen(t);
  const expected = structuredClone(f.manifest);
  await response(await f.promote('prepare'), 200);
  // Column names are the durable contract under test, not test-side shadow data.
  const read = () => f.sql('SELECT * FROM canonical_promotions WHERE promotion_id=?', f.request.promotion_id);
  const prepared = read();
  assert.equal(typeof prepared.operational_manifest_json, 'string', 'persist the operational manifest, not only the A5 manifest hash');
  assert.deepEqual(JSON.parse(prepared.operational_manifest_json), expected);
  assert.equal(prepared.operational_manifest_hash, await sha256Hex(stableStringify(expected)));
  await response(await f.promote(), 201);
  await response(await f.rollback(), 201);
  const after = read();
  assert.equal(after.operational_manifest_json, prepared.operational_manifest_json);
  assert.equal(after.operational_manifest_hash, prepared.operational_manifest_hash);
  assert.throws(() => f.exec('UPDATE canonical_promotions SET operational_manifest_json=? WHERE promotion_id=?', '{}', f.request.promotion_id), /immutable|CHECK/i);
  assert.throws(() => f.exec('UPDATE canonical_promotions SET operational_manifest_hash=? WHERE promotion_id=?', 'a'.repeat(64), f.request.promotion_id), /immutable|CHECK/i);
});

for (const phase of ['PREPARED', 'COMMITTED']) for (const field of ['worker_hash', 'client_hash', 'backup_hash', 'operator', 'expected']) {
  test(`gap/operational manifest changed ${field} conflicts with same ${phase} promotion`, async (t) => {
    const f = await frozen(t);
    await response(await f.promote(phase === 'PREPARED' ? 'prepare' : 'publish'), phase === 'PREPARED' ? 200 : 201);
    const before = f.control(), rows = generationSnapshot(f, f.request.promotion_id);
    const promotion = f.sql('SELECT * FROM canonical_promotions WHERE promotion_id=?', f.request.promotion_id);
    const original = f.env.A6_OPERATIONAL_MANIFEST, changed = JSON.parse(original);
    if (field === 'operator') changed.operator = 'different-approved-operator';
    else if (field === 'expected') changed.expected.credit_balance_cents++;
    else changed[field] = await sha256Hex(`different-${field}`);
    f.env.A6_OPERATIONAL_MANIFEST = JSON.stringify(changed);
    const rejected = await f.promote();
    const body = await rejected.json();
    assert.equal(rejected.status, 409, JSON.stringify(body));
    assert.match(body.error, /manifest.*mismatch|promotion_conflict|manifest.*conflict/, 'reject identity change, not a coincidental aggregate mismatch');
    assert.deepEqual(f.control(), before);
    assert.deepEqual(generationSnapshot(f, f.request.promotion_id), rows);
    assert.deepEqual(f.sql('SELECT * FROM canonical_promotions WHERE promotion_id=?', f.request.promotion_id), promotion);
    f.env.A6_OPERATIONAL_MANIFEST = original;
    await response(await f.promote(), phase === 'PREPARED' ? 201 : 200);
  });
}

test('gap/customer/payment assertions valid positive control respects supplied sequence not date/source order', async (t) => {
  const { f } = await published(t, { rows: assertedFinancialRows() });
  assert.deepEqual(f.all("SELECT source_payment_id,source_sequence,source_cumulative_paid_cents,source_balance_after_cents FROM credit_payments WHERE credit_id='CR:001' ORDER BY source_sequence")
    .map(p => [p.source_payment_id,p.source_sequence,p.source_cumulative_paid_cents,p.source_balance_after_cents]), [
    ['PAY:1',1,100,900], ['PAY:2',2,200,800], ['PAY:0',3,300,700],
  ]);
  const customer = f.sql('SELECT * FROM customers');
  assert.equal(customer.source_documents_total, 2);
  assert.equal(customer.source_documents_pending, 1);
  assert.equal(customer.source_documents_paid, 1);
  assert.equal(customer.source_payment_count, 4);
  assert.equal(customer.source_pending_original_cents, 1000);
  assert.equal(customer.source_pending_paid_cents, 300);
  trafficIsZero(f);
});

const customerAssertionAttacks = [
  ['image-vs-document-zero-difference', 'customers', 'Saldo imágenes', '6.00'],
  ['document-balance', 'customers', 'Saldo documentos', '8.00'],
  ['documents-total', 'customers', 'Docs. totales', 3],
  ['documents-pending', 'customers', 'Docs. pendientes', 2],
  ['documents-paid', 'customers', 'Docs. pagados', 0],
  ['payment-count', 'customers', 'N.º abonos', 5],
  ['pending-original', 'customers', 'Crédito original pendiente', '15.00'],
  ['pending-paid', 'customers', 'Abonado en créditos pendientes', '8.00'],
  ['pending-progress', 'customers', '% avance pendiente', 0.8],
  ['historical-credit', 'customers', 'Crédito histórico', '14.00'],
  ['historical-paid', 'customers', 'Pagado histórico', '7.00'],
  ['credit-customer-image', 'credits', 'Saldo imágenes cliente', '6.00'],
  ['credit-customer-document', 'credits', 'Saldo documentos cliente', '6.00'],
  ['credit-customer-difference', 'credits', 'Diferencia cliente', '1.00'],
  ['credit-payment-count', 'credits', 'N.º abonos', 2],
  ['credit-progress', 'credits', '% avance', 0.2],
];

async function assertFinancialRejection(t, rows) {
  const f = await frozen(t, { rows });
  // Establish the actual attack precondition: A5 passed with unchanged exact
  // global amounts. Every rejection must therefore be field/relationship-level.
  assert.deepEqual(f.manifests[0].report.amounts, { credit_amount_cents: 1500, credit_paid_cents: 800, credit_balance_cents: 700, payment_amount_cents: 800, sales_total_cents: 0 });
  const before = f.control();
  const r = await f.promote(), body = await r.json();
  assert.equal(r.status, 409, JSON.stringify(body));
  assert.match(body.error, /canonical_reconciliation_failed|mapping_rejected|promotion_prepare_conflict/);
  assert.deepEqual(f.control(), before);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_promotions WHERE status='COMMITTED'").n, 0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM import_staging').n, rows.length);
  trafficIsZero(f);
}

for (const [label, type, field, value] of customerAssertionAttacks) {
  test(`gap/customer assertion ${label} rejects despite valid global totals`, async (t) => {
    const rows = assertedFinancialRows();
    rows.find(r => r.entity_type === type).payload[field] = value;
    await assertFinancialRejection(t, rows);
  });
}

const paymentAssertionAttacks = [
  ['sequence-zero', 'Pago N.º (secuencia)', 0],
  ['sequence-negative', 'Pago N.º (secuencia)', -1],
  ['sequence-fraction', 'Pago N.º (secuencia)', 1.5],
  ['sequence-duplicate-within-credit', 'Pago N.º (secuencia)', 1],
  ['cumulative-paid', 'Pagado acumulado', '1.00'],
  ['balance-after', 'Saldo después del pago', '9.00'],
  ['cumulative-progress', 'Avance acumulado', 0.1],
  ['original-credit', 'Crédito original', '11.00'],
  ['current-credit-balance', 'Saldo actual documento', '8.00'],
  ['customer-document', 'Documento cliente', 'other-customer'],
  ['customer-name', 'Cliente', 'Different customer'],
];
for (const [label, field, value] of paymentAssertionAttacks) {
  test(`gap/payment assertion ${label} rejects despite valid global totals`, async (t) => {
    const rows = assertedFinancialRows();
    rows.find(r => r.payload.id === 'PAY:2').payload[field] = value;
    await assertFinancialRejection(t, rows);
  });
}

test('gap/payment sequence supplied is unique per credit, not global; absent stays NULL', async (t) => {
  const rows = assertedFinancialRows();
  // Both credits legitimately have sequence 1; missing sequence is not a zero.
  const p = rows.find(r => r.payload.id === 'PAY:PAID').payload;
  delete p['Pago N.º (secuencia)'];
  delete p['Pagado acumulado']; delete p['Saldo después del pago']; delete p['Avance acumulado'];
  const { f } = await published(t, { rows });
  assert.equal(f.sql("SELECT source_sequence FROM credit_payments WHERE source_payment_id='PAY:PAID'").source_sequence, null);
  assert.equal(f.sql("SELECT source_sequence FROM credit_payments WHERE source_payment_id='PAY:1'").source_sequence, 1);
});

for (const declared of ['unsafe-exact-total', 'safe-but-false-total']) {
  test(`gap/safe sums overflow ${declared} rejected with individually safe cents`, async (t) => {
    const half = 4503599627370496;
    const rows = [{ entity_type: 'customers', source_name: 'overflow.json', source_row: 1, source_key: 'overflow-customer', payload: { id: 'overflow-customer', nombre: 'Synthetic overflow' } }];
    for (let i = 1; i <= 2; i++) {
      rows.push({ entity_type: 'credits', source_name: 'overflow.json', source_row: i + 1, source_key: `overflow-credit-${i}`,
        payload: { id: `overflow-credit-${i}`, cliente_id: 'overflow-customer', monto_cents: half, pagado_cents: half, saldo_cents: 0 } });
      rows.push({ entity_type: 'credit_payments', source_name: 'overflow.json', source_row: i + 3, source_key: `overflow-payment-${i}`,
        payload: { id: `overflow-payment-${i}`, credito_id: `overflow-credit-${i}`, monto_cents: half, fecha: null, fecha_conocida: false } });
    }
    assert.ok(Number.isSafeInteger(half));
    assert.ok(BigInt(half) * 2n > BigInt(Number.MAX_SAFE_INTEGER));
    const f = await a6Fixture(t, { rows });
    assert.equal(f.manifests[0].report.verdict, 'PASS', 'synthetic A5 run really exists');
    if (declared === 'unsafe-exact-total') {
      await response(await f.freeze(), 503);
      await response(await f.promote(), 503);
      assert.equal(f.control().mode, 'LEGACY');
    } else {
      // Attack a manifest that lies within the numeric range: canonical must
      // recompute, not accept the caller's safe-looking replacement totals.
      for (const key of ['credit_amount_cents','credit_paid_cents','payment_amount_cents']) f.manifest.expected[key] = Number.MAX_SAFE_INTEGER;
      f.env.A6_OPERATIONAL_MANIFEST = JSON.stringify(f.manifest);
      await response(await f.freeze(), 201);
      const r = await response(await f.promote(), 409);
      assert.match(r.error, /reconciliation|overflow|unsafe/);
      assert.equal(f.control().mode, 'FROZEN');
    }
    assert.equal(f.control().active_promotion_id, null);
    assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_promotions WHERE status='COMMITTED'").n, 0);
    trafficIsZero(f);
  });
}

for (const wrong of ['promotion', 'entity']) {
  test(`gap/admin cursor bound to ${wrong}, rejects cross-scope reuse`, async (t) => {
    const { f } = await published(t, { runs: 2 });
    const firstPromotion = f.request.promotion_id;
    const first = await response(await f.export(firstPromotion, 'products', '&limit=1'), 200);
    assert.ok(first.next_cursor);
    const same = await response(await f.export(firstPromotion, 'products', `&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`), 200);
    assert.notEqual(same.items[0].source_key, first.items[0].source_key);
    let target = firstPromotion, entity = 'customers';
    if (wrong === 'promotion') {
      await f.selectRun(1);
      await response(await f.freeze('freeze-cursor-generation-two'), 201);
      await response(await f.promote(), 201);
      target = f.request.promotion_id; entity = 'products';
    }
    const r = await f.export(target, entity, `&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`);
    const body = await r.json();
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(body.error, /cursor/);
    assert.equal(body.items, undefined, 'no partial export for wrong scope');
  });
}
