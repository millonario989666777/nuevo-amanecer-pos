import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../POS/js/legacy-inline/inline-02.js', import.meta.url), 'utf8');
const fnBody = (name) => { const i = src.indexOf(`async function ${name}(`); assert.ok(i >= 0, name); const j = src.indexOf('\nasync function ', i + 10); return src.slice(i, j < 0 ? undefined : j); };

test('cambiar de cajero con caja abierta no cambia quién abrió la caja ni ventas/abonos guardados o en cola', () => {
  for (const name of ['cashierSelectActive', 'cashierToggleFromConfig']) {
    const body = fnBody(name);
    assert.doesNotMatch(body, /cajEstado\.(cajeroId|cajeroNombre|cajero)\s*=/, `${name} no toca cajEstado`);
    assert.doesNotMatch(body, /ventas\s*(\[|\.)[^;]*cajero[^;]*=/, `${name} no reescribe ventas`);
    assert.doesNotMatch(body, /(outbox|intents?|abonos|creditPayments)[^;]*cajero[^;]*=/i, `${name} no reescribe cola ni abonos`);
    assert.match(body, /cfgCajero/, `${name} sincroniza #cfgCajero para que Guardar no lo revierta`);
  }
  // Solo completa cajEstado si está vacío (no pisa a quien abrió).
  assert.match(src, /if\(!cajEstado\.cajeroId\)cajEstado\.cajeroId=/);
  assert.match(src, /if\(!cajEstado\.cajeroNombre\)cajEstado\.cajeroNombre=/);
});

test('Desactivar no se pierde: la lista conserva los mismos objetos', () => {
  assert.match(src, /Object\.assign\(raw,item,\{id\}\)/);
});
