// Historial de cierres de caja (CANON, solo lectura): real Worker -> SQLite ->
// canonical-client snapshot -> resumen por sesión + render en la pestaña Caja.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { activeCanon, device, storage } from './canon-browser-harness.mjs';

const source = readFileSync('POS/js/sync/canonical-cash-history.js', 'utf8');
const scripts = [['canonical-cash-history.js', source]];
const CREDIT = 'CR:001';

async function history(t) {
  const f = await activeCanon(t, { migrations: ['0021_canonical_payment_references.sql'] });
  const tab = await device(f, { token: 'owner-token', deviceId: 'owner', scripts });
  await tab.api.openCash({ session_id: 'S-1', opening_cents: 1000 });
  await tab.api.refresh();
  tab.context.NuevoAmanecerCashHistory.rememberCashier('S-1', { id: 'CAJ-1', nombre: 'Dalila' });
  await tab.api.createPayment({ credit_id: CREDIT, amount_cents: 200, payment_method: 'efectivo', session_id: 'S-1' });
  await tab.api.refresh();
  await tab.api.createPayment({ credit_id: CREDIT, amount_cents: 150, payment_method: 'yape', reference: 'YAPE-HIST-1' });
  await tab.api.refresh();
  await tab.api.closeCash({ session_id: 'S-1', counted_cents: 1150 });
  await tab.api.refresh();
  // Opened at 20:33 Lima on 2026-10-11 (01:33Z next day): the card must say 11/10/2026.
  // Test-only backdating (immutability triggers dropped and restored).
  for (const [table, set] of [['cash_sessions', "opened_at='2026-10-12T01:33:00.000Z'"], ['financial_events', "created_at='2026-10-12T01:40:00.000Z'"], ['cash_closures', "closed_at='2026-10-12T03:05:00.000Z'"]]) {
    const trigger = table + '_no_update';
    f.database.exec('DROP TRIGGER ' + trigger);
    f.database.exec('UPDATE canonical_' + table + ' SET ' + set);
    f.database.exec(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON canonical_${table} BEGIN SELECT RAISE(ABORT,'immutable_financial_history'); END;`);
  }
  await tab.api.openCash({ session_id: 'S-2', opening_cents: 500 });
  await tab.api.refresh();
  return { f, tab };
}

test('summary per closed session: Lima date/times, fondo, esperado, contado, diferencia, cobros, cajero', async (t) => {
  const { f, tab } = await history(t);
  const H = tab.context.NuevoAmanecerCashHistory;
  const rows = H.summarize(tab.api.snapshot(), H.cashierMap());
  assert.equal(JSON.stringify(rows.map((r) => [r.sessionId, r.status])), JSON.stringify([['S-2', 'OPEN'], ['S-1', 'CLOSED']]));
  const s1 = rows.find((r) => r.sessionId === 'S-1');
  assert.equal(s1.fecha, '2026-10-11', 'Lima business day, not the UTC day');
  assert.equal(s1.fechaLabel, '11/10/2026');
  assert.equal(s1.apertura, '20:33');
  assert.equal(s1.cierre, '22:05');
  assert.equal(s1.fondo, 1000);
  assert.equal(s1.esperado, 1200);
  assert.equal(s1.contado, 1150);
  assert.equal(s1.diferencia, -50);
  assert.equal(s1.cobros, 350, 'cash (session_id) + Yape (inside the session window)');
  assert.equal(s1.cobrosCount, 2);
  assert.equal(s1.cobrosEfectivo, 200);
  assert.equal(s1.cobrosDigital, 150);
  assert.equal(s1.cajero, 'Dalila');
  // Read-only: the history never writes or calls the Worker.
  const before = tab.fetchLog.length;
  H.summarize(tab.api.snapshot(), H.cashierMap());
  assert.equal(tab.fetchLog.length, before);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n, 1);
});

test('sales are attributed by the canonical cash_movements session_id', () => {
  const ctx = vm.createContext({ localStorage: storage() });
  ctx.globalThis = ctx;
  vm.runInContext(source, ctx);
  const rows = ctx.NuevoAmanecerCashHistory.summarize({
    cashSessions: [
      { session_id: 'A', status: 'CLOSED', opening_cents: 0, expected_cents: 700, counted_cents: 700, difference_cents: 0, opened_at: '2026-10-10T13:00:00Z', closed_at: '2026-10-10T23:00:00Z' },
      { session_id: 'B', status: 'CLOSED', opening_cents: 0, expected_cents: 0, counted_cents: 0, difference_cents: 0, opened_at: '2026-10-11T13:00:00Z', closed_at: '2026-10-11T23:00:00Z' },
    ],
    cashMovements: [
      { sale_id: 'V1', session_id: 'A', amount_cents: 500, cash_cents: 500, digital_cents: 0, credit_cents: 0 },
      { sale_id: 'V2', session_id: 'A', amount_cents: 900, cash_cents: 200, digital_cents: 300, credit_cents: 400 },
      { sale_id: 'V3', session_id: null, amount_cents: 999, cash_cents: 999 },
    ],
    financialEvents: [], expenses: [{ session_id: 'B', amount_cents: 120 }],
  }, {});
  const a = rows.find((r) => r.sessionId === 'A'), b = rows.find((r) => r.sessionId === 'B');
  assert.equal(a.ventas, 1400); assert.equal(a.ventasCount, 2); assert.equal(a.ventasCredito, 400);
  assert.equal(b.ventas, 0); assert.equal(b.gastos, 120);
  assert.equal(a.cajero, '', 'unknown cashier stays empty (UI: "No registrado")');
});

function fakeDom() {
  function node(tag) {
    const attrs = new Map(), listeners = {};
    return {
      tag, children: [], className: '', textContent: '', hidden: false, style: {}, type: '',
      setAttribute(k, v) { attrs.set(k, String(v)); }, getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      append(...n) { this.children.push(...n); }, replaceChildren() { this.children = []; },
      addEventListener(n, fn) { listeners[n] = fn; }, click() { listeners.click && listeners.click(); },
      querySelector(sel) { const m = /^\[([\w-]+)\]$/.exec(sel); return m ? this.children.find((c) => c.getAttribute && c.getAttribute(m[1]) !== null) || null : null; },
    };
  }
  const content = node('div'), bar = node('div');
  const all = (n) => [n.textContent, ...n.children.flatMap(all)].filter(Boolean);
  return { node, content, bar, all, document: {
    createElement: node,
    getElementById: (id) => (id === 'cajContent' ? content : null),
    querySelector: (sel) => (sel === '#pageCaja .tabs-wrap' ? bar : null),
  } };
}

test('Caja gets a read-only "Historial" tab that lists closed sessions only (CANON)', async (t) => {
  const { tab } = await history(t);
  const dom = fakeDom();
  const calls = [];
  const ctx = vm.createContext({ document: dom.document, localStorage: tab.localStorage, NuevoAmanecerCanonical: { enabled: () => true, snapshot: () => tab.api.snapshot() }, cajRender() { calls.push('base'); }, updateDashboard() {}, cajSetTab(btn, name) { calls.push(['tab', name]); vm.runInContext(`cajTab=${JSON.stringify(name)}`, ctx); ctx.cajRender(); } });
  ctx.globalThis = ctx;
  vm.runInContext("let cajTab='resumen';", ctx);
  vm.runInContext(source, ctx);
  const button = dom.bar.children.find((c) => c.getAttribute('data-na-cash-history-tab'));
  assert.ok(button, 'tab injected');
  assert.equal(button.textContent, '🗂️ Historial');
  ctx.cajRender();
  assert.deepEqual(calls, ['base'], 'other tabs keep the original renderer');
  button.click();
  const texts = dom.all(dom.content);
  assert.ok(texts.includes('Historial de cierres · 1 cierre'), texts.join('|'));
  assert.ok(texts.includes('📅 11/10/2026 · 20:33 → 22:05'));
  for (const [label, value] of [['Cajero', 'Dalila'], ['Fondo inicial', 'S/ 10.00'], ['Cobros (2)', 'S/ 3.50'], ['Efectivo esperado', 'S/ 12.00'], ['Efectivo contado', 'S/ 11.50'], ['Diferencia', '-S/ 0.50 (faltante)']]) {
    const i = texts.indexOf(label);
    assert.ok(i >= 0 && texts[i + 1] === value, `${label} -> ${value}: ${texts.slice(i, i + 2)}`);
  }
  assert.ok(!texts.some((x) => /S-2/.test(x)), 'open session not listed');
  // Rendering is DOM-text only (no innerHTML) and calls no command.
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(source));
  assert.ok(!/create(Payment|Compensation|Adjustment)|openCash|closeCash|refresh\(/.test(source));
});

test('outside CANON no tab is added and cajRender is untouched', () => {
  const dom = fakeDom();
  const calls = [];
  const ctx = vm.createContext({ document: dom.document, NuevoAmanecerCanonical: { enabled: () => false }, cajRender() { calls.push('base'); } });
  ctx.globalThis = ctx;
  vm.runInContext("let cajTab='historial';", ctx);
  vm.runInContext(source, ctx);
  assert.equal(dom.bar.children.length, 0);
  ctx.cajRender();
  assert.deepEqual(calls, ['base']);
});

test('index.html loads the history after the cash bridge; sw.js precaches it; opening records the cashier', () => {
  const index = readFileSync('POS/index.html', 'utf8');
  const sw = readFileSync('POS/sw.js', 'utf8');
  const bridge = readFileSync('POS/js/sync/canonical-cash-bridge.js', 'utf8');
  assert.ok(index.indexOf('js/sync/canonical-cash-history.js') > index.indexOf('js/sync/canonical-cash-bridge.js'));
  assert.ok(sw.includes("'./js/sync/canonical-cash-history.js'"));
  assert.match(bridge, /NuevoAmanecerCashHistory\?\.rememberCashier\(id, cashier\)/);
});
