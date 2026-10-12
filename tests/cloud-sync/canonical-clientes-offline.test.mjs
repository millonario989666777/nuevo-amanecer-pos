// Etapa 1.6 (auditoría 2026-10-12, Bot 3 P1-1): al perder la conexión, Clientes no
// se vacía si ya hay una réplica CANON aplicada (remote/revalidated/cache).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../POS/js/legacy-inline/inline-03.js', import.meta.url), 'utf8');
const handler = src.slice(src.indexOf("window.addEventListener('offline'"), src.indexOf("window.addEventListener('na:canonical-updated'"));

function run(source, applied) {
  const listeners = {}, badge = { hidden: true, textContent: '' };
  const ctx = {
    _naCanonicalTransportConnected: true, _naCanonicalLoadError: null, _naCanonicalViewApplied: applied, rendered: 0,
    window: { addEventListener: (n, fn) => { listeners[n] = fn; } },
    NuevoAmanecerCanonical: { enabled: () => true, sourceState: () => ({ source, validation: 'current' }) },
    document: { getElementById: (id) => (id === 'cliAuthorityBadge' ? badge : null) },
    _naSetHeaderConnectionState() {}, _naSchedulePageRender() { ctx.rendered++; }, _naActivePageId: () => 'pageClientes',
  };
  const keys = Object.keys(ctx);
  new Function(...keys, handler + ';return ()=>({err:_naCanonicalLoadError});')(...keys.map((k) => ctx[k]));
  listeners.offline();
  return { badge, ctx };
}

for (const source of ['remote', 'revalidated', 'cache']) {
  test(`offline con réplica ${source} ya aplicada: no marca error (la lista sigue visible)`, () => {
    const { badge } = run(source, true);
    assert.equal(badge.textContent, 'Sin conexión · datos guardados');
    assert.doesNotMatch(handler, /state\.source==='cache'\)\{if\(badge\)/, 'ya no depende solo de la caché');
  });
}
test('offline sin datos aplicados: sigue mostrando el error', () => {
  assert.match(handler, /else\{_naCanonicalLoadError=new Error\('AUTHORITY_UNAVAILABLE'\)/);
  const { badge } = run('none', false);
  assert.notEqual(badge.textContent, 'Sin conexión · datos guardados');
});
