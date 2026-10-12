// Etapa 1.5 (auditoría 2026-10-12): franja superior única. Ámbar = reintentando,
// rojo = rechazado/bloqueado o caja de otro día; número + «Ver»; al reconectar
// reintenta con el MISMO operation_id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const SCRIPTS = [['adapter', read('POS/js/adapters/canonical-ui-adapter.js')],
  ...['canonical-sale-intent', 'canonical-sale-outbox', 'canonical-status-banner'].map((n) => [n, read('POS/js/sync/' + n + '.js')])];
const MIGS = ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql'];

test('index y service worker cargan la franja', () => {
  assert.match(read('POS/index.html'), /<script src="js\/sync\/canonical-status-banner\.js"><\/script>/);
  assert.match(read('POS/sw.js'), /'\.\/js\/sync\/canonical-status-banner\.js'/);
});

test('sin pendientes no se muestra nada', async (t) => {
  const f = await activeCanon(t, { migrations: MIGS });
  const d = await device(f, { token: 'b0', deviceId: 'b0', scripts: SCRIPTS, globals: { obtenerHoy: () => new Date().toISOString().slice(0, 10) } });
  assert.equal(d.context.NuevoAmanecerStatusBanner.view(d.context.NuevoAmanecerStatusBanner.compute()), null);
});

test('503 en un ajuste: franja ámbar «1 pendiente · reintentando»; al reconectar se aplica UNA vez con el mismo operation_id y la franja desaparece', async (t) => {
  const f = await activeCanon(t, { migrations: MIGS });
  let fail = true;
  const d = await device(f, { token: 'b1', deviceId: 'b1', scripts: SCRIPTS,
    onFetch: async (url) => (fail && url.endsWith('/commands/inventory.adjust') ? Response.json({ error: 'service_unavailable' }, { status: 503 }) : null) });
  const p = d.api.snapshot().products.find((x) => Number(x.tracks_inventory) === 1);
  const before = f.sql('SELECT current_stock_quantity q FROM products WHERE product_id=?', p.product_id).q;
  await assert.rejects(d.api.adjustInventory({ product_id: p.product_id, movement_type: 'ENTRADA', quantity: 1, reason: 'Prueba banner' }));
  const op = d.api.pendingSnapshot().payload.operation_id;
  const banner = d.context.NuevoAmanecerStatusBanner;
  const v = banner.view(banner.compute());
  assert.equal(v.tone, 'amber'); assert.equal(v.count, 1); assert.match(v.text, /1 pendiente\(s\) · reintentando/);
  fail = false;
  await banner.retryOnReconnect();
  assert.equal(f.sql('SELECT current_stock_quantity q FROM products WHERE product_id=?', p.product_id).q, before + 1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_manual_inventory_movements WHERE operation_id=?', op).n, 1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_manual_inventory_movements').n, 1);
  assert.equal(d.api.pendingSnapshot(), null);
  assert.equal(banner.view(banner.compute()), null);
});

test('rechazo definitivo (409): franja roja y NO se reintenta sola', async (t) => {
  const f = await activeCanon(t, { migrations: MIGS });
  const d = await device(f, { token: 'b2', deviceId: 'b2', scripts: SCRIPTS,
    onFetch: async (url) => (url.endsWith('/commands/inventory.adjust') ? Response.json({ error: 'stale_stock' }, { status: 409 }) : null) });
  const p = d.api.snapshot().products.find((x) => Number(x.tracks_inventory) === 1);
  await assert.rejects(d.api.adjustInventory({ product_id: p.product_id, movement_type: 'ENTRADA', quantity: 1, reason: 'Prueba banner' }));
  const banner = d.context.NuevoAmanecerStatusBanner;
  const v = banner.view(banner.compute());
  assert.equal(v.tone, 'red'); assert.match(v.text, /1 rechazada\(s\) o bloqueada\(s\)/);
  const posts = () => d.fetchLog.filter((x) => x.url.endsWith('/commands/inventory.adjust')).length;
  const n = posts(); await banner.retryOnReconnect(); assert.equal(posts(), n, 'sin reenvío automático de un rechazo');
});

test('caja abierta de otro día: franja roja con el aviso dentro', async (t) => {
  const f = await activeCanon(t, { migrations: MIGS });
  const d = await device(f, { token: 'b3', deviceId: 'b3', scripts: SCRIPTS, globals: { obtenerHoy: () => '2099-01-01' } });
  await d.api.openCash({ session_id: 'S-old', opening_cents: 0 }); await d.api.refresh();
  const banner = d.context.NuevoAmanecerStatusBanner;
  const v = banner.view(banner.compute());
  assert.equal(v.tone, 'red'); assert.match(v.text, /La caja abierta es del \d{4}-\d{2}-\d{2}: ciérrala y abre la de hoy/);
});
