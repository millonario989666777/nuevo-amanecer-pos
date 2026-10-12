// Write-path budget for the credits/payments fixes (P1-1, P1-2). Production runs
// DB_PROVIDER=turso: every pipeline is ONE external subrequest (Workers Free: 50).
// The real Worker entry + real Turso adapter run against a fake /v3/pipeline backed
// by SQLite (with BEGIN/COMMIT/ROLLBACK batch semantics). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import workerEntry from '../../tools/cloudflare-lab/src/worker-entry.js';
import { activeCanon, device } from './canon-browser-harness.mjs';

const FREE_TIER = 50;
const LIVE = ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql',
  '0017_canonical_live_customers.sql', '0018_canonical_customer_credit_policy.sql'];
const ALL = [...LIVE, '0019_canonical_debt_reconciliation.sql', '0020_canonical_customer_contacts.sql', '0021_canonical_payment_references.sql'];

function encodeValue(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'bigint') return { type: 'integer', value: String(value) };
  if (typeof value === 'number') return Number.isInteger(value) ? { type: 'integer', value: String(value) } : { type: 'float', value };
  if (typeof value === 'string') return { type: 'text', value };
  if (value instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  throw new TypeError('unsupported value ' + typeof value);
}
function decodeArg(arg) {
  if (arg.type === 'null') return null;
  if (arg.type === 'integer') { const n = BigInt(arg.value); return Number.isSafeInteger(Number(n)) ? Number(n) : n; }
  if (arg.type === 'float') return Number(arg.value);
  if (arg.type === 'text') return arg.value;
  if (arg.type === 'blob') return Buffer.from(arg.base64, 'base64');
  throw new TypeError('unsupported arg ' + arg.type);
}
function fakeTurso(database) {
  const calls = [];
  const run = (stmt) => {
    const statement = database.prepare(stmt.sql);
    const args = (stmt.args || []).map(decodeArg);
    if (!stmt.want_rows || !statement.columns().length) {
      const info = statement.run(...args);
      return { cols: [], rows: [], affected_row_count: Number(info.changes), last_insert_rowid: null };
    }
    const cols = statement.columns().map((column) => ({ name: column.name }));
    const rows = statement.all(...args).map((row) => cols.map((column) => encodeValue(row[column.name])));
    return { cols, rows, affected_row_count: 0, last_insert_rowid: null };
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const results = body.requests.map((request) => {
      if (request.type === 'close') return { type: 'ok', response: { type: 'close' } };
      if (request.type === 'execute') {
        try { return { type: 'ok', response: { type: 'execute', result: run(request.stmt) } }; }
        catch (error) { return { type: 'error', error: { message: String(error.message) } }; }
      }
      if (request.type === 'batch') {
        const steps = request.batch.steps, stepResults = [], stepErrors = [];
        const holds = (cond) => !cond ? true : cond.type === 'ok' ? !!stepResults[cond.step] : cond.type === 'not' ? !holds(cond.cond) : false;
        steps.forEach((step, index) => {
          stepResults[index] = null; stepErrors[index] = null;
          if (!holds(step.condition)) return;
          try { stepResults[index] = run(step.stmt); } catch (error) { stepErrors[index] = { message: String(error.message) }; }
        });
        return { type: 'ok', response: { type: 'batch', result: { step_results: stepResults, step_errors: stepErrors } } };
      }
      return { type: 'error', error: { message: 'unsupported ' + request.type } };
    });
    return new Response(JSON.stringify({ baton: null, results }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

// Commands from the real browser client are answered by the production entry on Turso.
async function tursoShop(t, migrations) {
  const f = await activeCanon(t, { migrations });
  const turso = fakeTurso(f.database);
  const env = { ...f.env, RUNTIME_ENVIRONMENT: 'production', CANONICAL_RUNTIME_ENABLED: 'enabled', DB_PROVIDER: 'turso',
    TURSO_DATABASE_URL: 'https://budget.turso.test', TURSO_AUTH_TOKEN: 'budget-turso-token' };
  const log = [];
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a', async onFetch(url, rest) {
    const path = new URL(url).pathname;
    if (!path.startsWith('/commands/')) return null;
    const original = globalThis.fetch, before = turso.calls.length;
    globalThis.fetch = turso.fetchImpl;
    try {
      const res = await workerEntry.fetch(new Request('https://prod.example' + path, rest), env, {});
      log.push({ path, status: res.status, calls: turso.calls.length - before });
      return res;
    } finally { globalThis.fetch = original; }
  } });
  const pid = 'BUD-' + randomUUID().slice(0, 6);
  await tab.api.createProduct({ product_id: pid, name: 'Prod budget', sku: pid + 's', barcode: pid + 'b', alternate_codes: [], category: 't', brand: 'T', description: null, icon: '📦', image: null, unit: 'unidad', purchase_unit: 'unidad', purchase_factor: 1, cost_cents: 100, price_cents: 1000, box_price_cents: null, units_per_box: null, initial_stock_quantity: 100, stock_min_quantity: 0, expiry_date: null, includes_igv: true, tax_type: 'gravado', complementary_tax: '', tracks_inventory: true });
  const last = (route) => log.filter((x) => x.path === '/commands/' + route).at(-1);
  const sell = async () => { await tab.api.refresh(); await tab.api.createSale({ items: [{ product_id: pid, quantity: 1 }], payment_method: 'credito', customer_id: '000C', credit_due: '2099-12-31' }).catch(() => null); return last('sale.create'); };
  return { f, tab, log, last, sell };
}

test('P1-2 budget: the MANUAL credit-line check adds no Turso subrequest to a credit sale', async (t) => {
  const before = await tursoShop(t, LIVE.slice(0, 4)); // pre-0018: no policy table
  const baseline = await before.sell();
  assert.equal(baseline.status, 201);

  const after = await tursoShop(t, ALL);
  await after.tab.api.refresh();
  await after.tab.api.setCustomerCreditPolicy({ customer_id: '000C', mode: 'MANUAL', manual_limit_cents: 1000000, reason: 'Presupuesto de prueba', administrator_id: 'a', administrator_name: 'Admin' });
  const manual = await after.sell();
  assert.equal(manual.status, 201);
  assert.ok(manual.calls <= baseline.calls, `credit sale with MANUAL line: ${manual.calls} calls vs ${baseline.calls} before the fix`);
  assert.ok(manual.calls < FREE_TIER);

  await after.tab.api.refresh();
  await after.tab.api.setCustomerCreditPolicy({ customer_id: '000C', mode: 'MANUAL', manual_limit_cents: 1, reason: 'Presupuesto de prueba', administrator_id: 'a', administrator_name: 'Admin' });
  const rejected = await after.sell();
  assert.equal(rejected.status, 409);
  assert.ok(rejected.calls <= baseline.calls, `rejected credit sale: ${rejected.calls} calls`);
  t.diagnostic(`credit sale Turso calls: before=${baseline.calls} manual=${manual.calls} rejected=${rejected.calls}`);
});

test('P1-1 budget: the voucher guard costs at most 2 extra subrequests per digital payment (single and batch)', async (t) => {
  const without = await tursoShop(t, ALL.slice(0, -1));
  await without.tab.api.refresh();
  await without.tab.api.createPayment({ credit_id: 'CR:001', amount_cents: 100, payment_method: 'yape', reference: 'BUD-OP-1' });
  const legacy = without.last('payment.create');
  assert.equal(legacy.status, 201);

  const withRefs = await tursoShop(t, ALL);
  await withRefs.tab.api.refresh();
  await withRefs.tab.api.createPayment({ credit_id: 'CR:001', amount_cents: 100, payment_method: 'yape', reference: 'BUD-OP-1' });
  const guarded = withRefs.last('payment.create');
  assert.equal(guarded.status, 201);
  assert.ok(guarded.calls <= legacy.calls + 2, `payment with voucher: ${guarded.calls} vs ${legacy.calls}`);
  assert.ok(guarded.calls < FREE_TIER);

  await withRefs.tab.api.refresh();
  await withRefs.tab.api.createPayment({ credit_id: 'CR:001', amount_cents: 100, payment_method: 'yape', reference: 'bud-op-1' }).catch(() => null);
  const duplicate = withRefs.last('payment.create');
  assert.equal(duplicate.status, 409);
  assert.ok(duplicate.calls <= legacy.calls + 2);
  assert.equal(await withRefs.tab.api.discardRejectedPayment(), true);

  await withRefs.tab.api.refresh();
  await withRefs.tab.api.createPaymentBatch([{ credit_id: 'CR:001', amount_cents: 100, payment_method: 'yape', reference: 'BUD-LOTE-1' }]);
  const batch = withRefs.last('payment.batch');
  assert.equal(batch.status, 201);
  assert.ok(batch.calls < FREE_TIER);
  t.diagnostic(`payment Turso calls: legacy=${legacy.calls} guarded=${guarded.calls} duplicate=${duplicate.calls} batch=${batch.calls}`);
});
