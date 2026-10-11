import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { a6Fixture, response } from './a6-fixture.mjs';
import workerEntry from '../../tools/cloudflare-lab/src/worker-entry.js';
import { canonicalRead } from '../../tools/cloudflare-lab/src/a6-canonical.js';
import { createTursoD1Adapter } from '../../tools/cloudflare-lab/src/turso-d1-adapter.js';

// Production runs DB_PROVIDER=turso: every statement is ONE external HTTP
// fetch, and Workers Free allows 50 external subrequests per invocation.
// These tests drive the real Worker entry through the real Turso adapter
// against a fake Turso /v3/pipeline backed by SQLite, and count HTTP calls.
const BUDGET = 25;
const PROMOTION = 'a6-promotion-1';
const SESSION_TOKEN = 'budget-session-token';
const AUTH = { authorization: 'Bearer ' + SESSION_TOKEN };
const ROUTES = ['status', 'products', 'customers', 'credits', 'credit-payments', 'credit-accounts', 'cash-sessions',
  'financial-events', 'expenses', 'sales', 'sale-items', 'inventory-movements', 'cash-movements', 'snapshot'];
const LATER_MIGRATIONS = ['0007_lab_workspace', '0008_canonical_commerce', '0009_canonical_financial', '0011_canonical_session_runtime',
  '0012_credit_accounts_v2', '0013_canonical_expenses', '0014_canonical_live_products', '0015_canonical_inventory_adjust',
  '0016_canonical_generic_sale_lines', '0017_canonical_live_customers', '0018_canonical_customer_credit_policy',
  '0019_canonical_debt_reconciliation', '0020_canonical_customer_contacts'];
// Distinct row counts per table so any mis-mapped count/ledger term changes the body.
const SEED = {
  canonical_sale_context: 3, sale_items: 4, cash_movements: 5, inventory_movements: 6, canonical_inventory_effects: 2,
  canonical_live_inventory_effects: 3, canonical_financial_operations: 7, canonical_financial_events: 8, live_credits: 2,
  canonical_expenses: 3, canonical_expense_operations: 4, canonical_product_operations: 5, canonical_live_products: 2,
  canonical_inventory_operations: 6, canonical_manual_inventory_movements: 4, canonical_customer_operations: 7,
  canonical_customer_registry: 2, canonical_live_customers: 3, canonical_customer_credit_policy_operations: 9,
  canonical_customer_credit_policies: 2, canonical_reconciliation_credits: 11, canonical_credit_baseline_adjustments: 13,
  canonical_customer_contacts: 17,
};

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

// Fake Turso Hrana-over-HTTP endpoint. Records every request; rejects batches
// (the read path must never open a transaction or take a write lock).
function fakeTurso(database) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const results = body.requests.map((request) => {
      if (request.type === 'close') return { type: 'ok', response: { type: 'close' } };
      if (request.type !== 'execute') return { type: 'error', error: { message: 'read path must not batch: ' + request.type } };
      try {
        const statement = database.prepare(request.stmt.sql);
        const args = (request.stmt.args || []).map(decodeArg);
        if (!request.stmt.want_rows) {
          const info = statement.run(...args);
          return { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: Number(info.changes), last_insert_rowid: null } } };
        }
        const cols = statement.columns().map((column) => ({ name: column.name }));
        const rows = statement.all(...args).map((row) => cols.map((column) => encodeValue(row[column.name])));
        return { type: 'ok', response: { type: 'execute', result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } };
      } catch (error) {
        return { type: 'error', error: { message: String(error.message) } };
      }
    });
    return new Response(JSON.stringify({ baton: null, results }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl, statements: () => calls.flatMap((call) => call.requests.filter((r) => r.type === 'execute').map((r) => r.stmt.sql)) };
}

function fillValue(column, table, index, promotion) {
  const name = column.name;
  if (name === 'promotion_id') return promotion;
  if (name === 'sale_id') return `S${index}`;
  if (name === 'movement_id') return `M${index}`;
  if (name === 'line_number') return 1;
  if (name.endsWith('_json')) return '{}';
  const type = String(column.type).toUpperCase();
  if (type.includes('INT')) return index + 1;
  if (type.includes('REAL')) return -(index + 1);
  return `${table}:${name}:${index}`;
}

function seed(f, tables = SEED) {
  for (const [table, count] of Object.entries(tables)) {
    const columns = f.all(`PRAGMA table_info(${table})`);
    if (!columns.length) continue;
    const insert = (index, promotion) => {
      const values = columns.map((column) => {
        if (table === 'canonical_financial_events' && column.name === 'credit_id') return index % 3 === 0 ? null : `CR:${index}`;
        if (column.name === 'promotion_id' || column.notnull || column.pk) return fillValue(column, table, index, promotion);
        return null;
      });
      f.database.prepare(`INSERT INTO ${table} (${columns.map((c) => c.name).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
    };
    for (let i = 0; i < count; i++) insert(i, PROMOTION);
    // A foreign-promotion row proves every count keeps its promotion filter.
    if (columns.some((c) => c.name === 'promotion_id')) insert(1000, 'other-promotion');
  }
}

async function activeFixture(t, { mode = 'ACTIVE', migrations = LATER_MIGRATIONS, drop = [], seeded = true } = {}) {
  const f = await a6Fixture(t);
  await response(await f.freeze(), 201);
  await response(await f.promote(), 201);
  for (const name of migrations) f.database.exec(readFileSync(new URL(`../../infra/database/migrations/${name}.sql`, import.meta.url), 'utf8'));
  for (const trigger of f.all("SELECT name FROM sqlite_master WHERE type='trigger'")) f.database.exec(`DROP TRIGGER "${trigger.name}"`);
  f.database.exec('PRAGMA foreign_keys=OFF');
  f.database.exec('PRAGMA ignore_check_constraints=ON');
  if (mode === 'ACTIVE') f.exec("UPDATE canonical_control SET mode='ACTIVE',revision=revision+1,authority_epoch=authority_epoch+1,minimum_client_contract='a6-gate-c-v1' WHERE id=1");
  if (seeded) seed(f);
  for (const table of drop) f.database.exec(`DROP TABLE ${table}`);
  f.addDevice('budget-writer', 'writer', 'active', SESSION_TOKEN);
  return f;
}

// Runs the production entry (worker-entry.js + DB_PROVIDER=turso) with the
// fake Turso endpoint and returns HTTP status, exact body text and call count.
async function tursoWorker(f) {
  const turso = fakeTurso(f.database);
  const env = { RUNTIME_ENVIRONMENT: 'production', CANONICAL_RUNTIME_ENABLED: 'enabled', DB_PROVIDER: 'turso',
    TURSO_DATABASE_URL: 'https://budget.turso.test', TURSO_AUTH_TOKEN: 'budget-turso-token', READ_TOKEN: 'fixture-read-token' };
  const original = globalThis.fetch;
  return {
    turso,
    async read(route) {
      const before = turso.calls.length;
      globalThis.fetch = turso.fetchImpl;
      try {
        const res = await workerEntry.fetch(new Request(`https://prod.example/read/canonical/${route}`, { headers: AUTH }), env, {});
        return { status: res.status, text: await res.text(), calls: turso.calls.length - before, sql: turso.statements().slice(before) };
      } finally {
        globalThis.fetch = original;
      }
    },
  };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// Direct handler call: legacy (verbatim pre-fix statement-per-check path) vs
// read plan, same database, same json helper, exact body text compared.
async function direct(f, route, legacy) {
  const turso = fakeTurso(f.database);
  const db = createTursoD1Adapter({ TURSO_DATABASE_URL: 'https://budget.turso.test', TURSO_AUTH_TOKEN: 't' }, { fetchImpl: turso.fetchImpl });
  try {
    const res = await canonicalRead(new URL(`https://prod.example/read/canonical/${route}`), db, json, legacy ? { legacy: true } : {});
    return { status: res.status, text: await res.text(), calls: turso.calls.length };
  } catch (error) {
    return { status: 'throw', text: String(error.message), calls: turso.calls.length };
  }
}

async function assertParity(f, routes = ROUTES) {
  const report = {};
  for (const route of routes) {
    const legacy = await direct(f, route, true);
    const planned = await direct(f, route, false);
    assert.equal(planned.status, legacy.status, `${route}: status`);
    assert.equal(planned.text, legacy.text, `${route}: body must be byte-identical`);
    report[route] = { status: legacy.status, legacy: legacy.calls, planned: planned.calls };
  }
  return report;
}

test('ACTIVE /read/canonical/status with every migration through 0020 stays within the subrequest budget', async (t) => {
  const f = await activeFixture(t);
  const w = await tursoWorker(f);
  const status = await w.read('status');
  assert.equal(status.status, 200, status.text);
  const body = JSON.parse(status.text);
  assert.equal(body.mode, 'ACTIVE');
  assert.equal(body.authority, 'canonical');
  // Contacts (0020) ledger must still be part of financial_revision.
  assert.ok(body.financial_revision >= SEED.canonical_customer_contacts, JSON.stringify(body));
  assert.ok(status.calls <= BUDGET, `status used ${status.calls} Turso HTTP calls (budget ${BUDGET})`);
  // Read-only: every statement is a SELECT; nothing opens a transaction or writes.
  for (const sql of status.sql) assert.match(sql.trim(), /^SELECT\b/i, sql.slice(0, 80));
  assert.ok(w.turso.calls.every((call) => call.requests.every((r) => r.type === 'execute' || r.type === 'close')), 'no batch / BEGIN');
  // The legacy path is what production ran: prove it exceeded Workers Free's 50.
  const legacy = await direct(f, 'status', true);
  assert.ok(legacy.calls > 50, `legacy status used ${legacy.calls} calls`);
});

test('every canonical refresh route and the status gate used before commands stay within the budget', async (t) => {
  const f = await activeFixture(t);
  const w = await tursoWorker(f);
  for (const route of ROUTES.filter((r) => r !== 'snapshot')) {
    const result = await w.read(route + (route === 'status' ? '' : '?limit=100'));
    assert.equal(result.status, 200, `${route}: ${result.text}`);
    assert.ok(result.calls <= BUDGET, `${route} used ${result.calls} Turso HTTP calls (budget ${BUDGET})`);
    for (const sql of result.sql) assert.match(sql.trim(), /^SELECT\b/i, `${route}: ${sql.slice(0, 80)}`);
  }
});

test('parity: ACTIVE with all migrations returns byte-identical bodies on every route', async (t) => {
  const f = await activeFixture(t);
  const report = await assertParity(f);
  assert.equal(report.status.status, 200);
  for (const [route, r] of Object.entries(report)) assert.ok(r.planned <= r.legacy, `${route}: ${JSON.stringify(r)}`);
  // Exact counts: guards against a parity oracle that is itself broken.
  const body = JSON.parse((await direct(f, 'status', false)).text);
  assert.equal(body.counts.live_products, SEED.canonical_live_products);
  assert.equal(body.counts.live_customers, SEED.canonical_live_customers);
  assert.equal(body.counts.live_credits, SEED.live_credits);
  assert.equal(body.counts.reconciliation_credits, SEED.canonical_reconciliation_credits);
  assert.equal(body.counts.sales, SEED.canonical_sale_context);
  assert.equal(body.counts.inventory_movements, SEED.canonical_inventory_effects + SEED.canonical_live_inventory_effects + SEED.canonical_manual_inventory_movements);
  assert.equal(body.counts.expenses, SEED.canonical_expense_operations);
  const ledger = SEED.canonical_sale_context + SEED.canonical_financial_operations + SEED.canonical_expense_operations +
    SEED.canonical_product_operations + SEED.canonical_inventory_operations + SEED.canonical_customer_operations +
    SEED.canonical_customer_credit_policy_operations + SEED.canonical_reconciliation_credits +
    SEED.canonical_credit_baseline_adjustments + SEED.canonical_customer_contacts;
  assert.equal(body.financial_revision, ledger);
});

test('parity: ACTIVE without the 0020 contacts table', async (t) => {
  const f = await activeFixture(t, { drop: ['canonical_customer_contacts'] });
  const report = await assertParity(f);
  assert.equal(report.status.status, 200);
  const body = JSON.parse((await direct(f, 'status', false)).text);
  assert.equal(body.financial_revision, SEED.canonical_sale_context + SEED.canonical_financial_operations + SEED.canonical_expense_operations +
    SEED.canonical_product_operations + SEED.canonical_inventory_operations + SEED.canonical_customer_operations +
    SEED.canonical_customer_credit_policy_operations + SEED.canonical_reconciliation_credits + SEED.canonical_credit_baseline_adjustments);
});

test('parity: ACTIVE with partial optional schemas (one table of each multi-table guard missing)', async (t) => {
  const f = await activeFixture(t, { drop: ['canonical_live_inventory_effects', 'canonical_customer_registry',
    'canonical_customer_credit_policies', 'canonical_credit_baseline_adjustments', 'canonical_manual_inventory_movements', 'canonical_expenses'] });
  const report = await assertParity(f, ['status', 'products', 'customers', 'credits', 'expenses', 'inventory-movements']);
  assert.equal(report.status.status, 200);
});

test('parity: no control row -> 409 canonical_not_published', async (t) => {
  const f = await activeFixture(t);
  f.exec('DELETE FROM canonical_control');
  const report = await assertParity(f);
  for (const [route, r] of Object.entries(report)) assert.equal(r.status, 409, route);
  const w = await tursoWorker(f);
  const status = await w.read('status');
  assert.equal(status.status, 409);
  assert.deepEqual(JSON.parse(status.text), { error: 'canonical_not_published' });
});

test('parity: CANONICAL_READ_ONLY (published, not ACTIVE)', async (t) => {
  const f = await activeFixture(t, { mode: 'CANONICAL_READ_ONLY' });
  const report = await assertParity(f);
  assert.equal(report.status.status, 200);
  assert.equal(report['cash-sessions'].status, 409);
});

test('parity: pre-commerce schema without authority tables falls back to the exact legacy path', async (t) => {
  const f = await activeFixture(t, { mode: 'CANONICAL_READ_ONLY', migrations: [], seeded: false });
  const report = await assertParity(f, ['status', 'products', 'customers', 'credits', 'credit-payments']);
  assert.equal(report.status.status, 200);
  // Fallback costs exactly one extra schema probe, never more.
  for (const [route, r] of Object.entries(report)) assert.equal(r.planned, r.legacy + 1, route);
});

test('parity: a missing unguarded table still fails closed on both paths', async (t) => {
  const f = await activeFixture(t, { drop: ['live_credits'] });
  const legacy = await direct(f, 'status', true);
  const planned = await direct(f, 'status', false);
  assert.equal(legacy.status, 'throw');
  assert.equal(planned.status, 'throw');
  const w = await tursoWorker(f);
  const viaWorker = await w.read('status');
  assert.equal(viaWorker.status, 500);
  assert.deepEqual(JSON.parse(viaWorker.text), { error: 'internal_error' });
});

test('schema probe is per request: an additive migration is visible on the next request', async (t) => {
  const f = await activeFixture(t, { drop: ['canonical_customer_contacts'] });
  const w = await tursoWorker(f);
  const first = JSON.parse((await w.read('status')).text);
  f.database.exec(readFileSync(new URL('../../infra/database/migrations/0020_canonical_customer_contacts.sql', import.meta.url), 'utf8'));
  for (const trigger of f.all("SELECT name FROM sqlite_master WHERE type='trigger'")) f.database.exec(`DROP TRIGGER "${trigger.name}"`);
  seed(f, { canonical_customer_contacts: 2 });
  const second = JSON.parse((await w.read('status')).text);
  assert.equal(second.financial_revision, first.financial_revision + 2);
});
