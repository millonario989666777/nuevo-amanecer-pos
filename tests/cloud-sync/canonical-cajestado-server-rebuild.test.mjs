// Etapa 1.4 (auditoría 2026-10-12): el estado de caja del equipo se reconstruye
// con las cajas del servidor, sin F5. Caso real: el teléfono seguía con la caja
// vieja 023f621a mientras la abierta era a007968b.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const SCRIPTS = [['adapter', read('POS/js/adapters/canonical-ui-adapter.js')],
  ...['canonical-sale-intent', 'canonical-sale-outbox'].map((n) => [n, read('POS/js/sync/' + n + '.js')])];
const MIGS = ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql'];
const INLINE03 = read('POS/js/legacy-inline/inline-03.js');
const REBUILD = INLINE03.match(/function _naRebuildCanonicalCashState\(\)\{[\s\S]*?\n\}/)[0];

// Ejecuta la función real de inline-03 sobre el estado del equipo y devuelve cajEstado.
function uiCash(d, stale) {
  const fn = new Function('window', 'NuevoAmanecerCanonical', 'let cajEstado=arguments[2];' + REBUILD + ';_naRebuildCanonicalCashState();return cajEstado;');
  return fn(d.context, d.api, stale);
}
const settle = () => new Promise((r) => setTimeout(r, 150));

test('el handler de actualización CANON siempre reconstruye la caja, también cuando reutiliza la vista', () => {
  assert.match(INLINE03, /if\(!reuse\)\{_naApplyCanonicalLegacyView\(canonical\);[^\n]*\}\n\s*else _naRebuildCanonicalCashState\(\);/);
});

test('(a)+(c) otro equipo cierra y abre caja; al reconectar el teléfono muestra la caja nueva sin F5', async (t) => {
  const f = await activeCanon(t, { migrations: MIGS });
  const a = await device(f, { token: 'r-a', deviceId: 'r-a', scripts: SCRIPTS });
  await a.api.openCash({ session_id: '023f621a-old', opening_cents: 1000 }); await a.api.refresh();
  const stale = uiCash(a, null);
  assert.equal(stale.sessionId, '023f621a-old'); assert.equal(stale.abierta, true);
  a.context.NuevoAmanecerCanonicalSaleOutbox.start();
  const b = await device(f, { token: 'r-b', deviceId: 'r-b', scripts: SCRIPTS });
  await b.api.refresh();
  await b.api.closeCash({ counted_cents: 1000 }); await b.api.refresh();
  await b.api.openCash({ session_id: 'a007968b-new', opening_cents: 500 });
  assert.equal(a.api.sourceState().validation, 'current', 'la réplica de A figura vigente: antes no se releía al reconectar');
  a.context.dispatchEvent({ type: 'online' }); await settle();
  const now = uiCash(a, stale);
  assert.equal(now.sessionId, 'a007968b-new'); assert.equal(now.abierta, true); assert.equal(now.fondo, 5);
  a.context.navigator.onLine = false;
});

test('(b) el cierre se aceptó pero la respuesta se perdió: al reconectar la caja figura cerrada', async (t) => {
  const f = await activeCanon(t, { migrations: MIGS });
  let lose = false;
  const a = await device(f, { token: 'l-a', deviceId: 'l-a', scripts: SCRIPTS,
    onFetch: async (url, _o, real) => { if (lose && url.endsWith('/commands/cash.close')) { await real(); throw new TypeError('Failed to fetch'); } return null; } });
  await a.api.openCash({ session_id: 'S-lost', opening_cents: 1000 }); await a.api.refresh();
  a.context.NuevoAmanecerCanonicalSaleOutbox.start();
  lose = true;
  await assert.rejects(a.api.closeCash({ counted_cents: 1000 }));
  lose = false;
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n, 1, 'el servidor sí cerró');
  a.context.dispatchEvent({ type: 'online' }); await settle();
  const now = uiCash(a, null);
  assert.equal(now.sessionId, 'S-lost'); assert.equal(now.abierta, false); assert.equal(now.cerrada, true);
  a.context.navigator.onLine = false;
});
