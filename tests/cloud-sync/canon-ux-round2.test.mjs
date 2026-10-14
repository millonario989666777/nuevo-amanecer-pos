import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPosSandbox, json } from '../product-fixes/fix05/lib/sandbox.mjs';

const read = rel => readFileSync(new URL('../../POS/' + rel, import.meta.url), 'utf8');

test('E: una línea VARIOS no repite su nombre junto a la insignia VARIOS', () => {
  const sb = createPosSandbox();
  assert.equal(sb.run(`_naSaleItemTitle({ventaLibre:true,name:'VARIOS'})`), '');
  assert.equal(sb.run(`_naSaleItemTitle({ventaLibre:true,name:'varios '})`), '');
  assert.equal(sb.run(`_naSaleItemTitle({ventaLibre:true,name:'Pan suelto'})`), 'Pan suelto');
  assert.equal(sb.run(`_naSaleItemTitle({name:'Arroz'})`), 'Arroz');
  assert.equal(sb.run(`_naSaleItemTitle({})`), 'Producto');
});

test('F: Inicio dice "transacciones" (no "transacciónes")', () => {
  const sources = read('js/legacy-inline/inline-02.js') + read('index.html');
  assert.doesNotMatch(sources, /transacción\$\{[^}]*'es'\}/);
  const sb = createPosSandbox();
  for (const n of [1, 2]) assert.equal(sb.run(`(validas=>\`\${validas.length===1?'transacción':'transacciones'}\`)(Array(${n}))`), n === 1 ? 'transacción' : 'transacciones');
});

test('6: Caja no muestra "Cajero:" vacío cuando CANON no guarda el cajero', () => {
  const sb = createPosSandbox();
  sb.run(`cajEstado=Object.assign({},cajEstado,{cajero:'',cajeroNombre:''})`);
  assert.equal(sb.run('_naSecCashCashierText()'), 'sin registrar');
  sb.run(`cajEstado.cajero='Ana'`);
  assert.equal(sb.run('_naSecCashCashierText()'), 'Ana');
  assert.doesNotMatch(read('js/legacy-inline/inline-11.js'), /Cajero: \$\{cajEstado\.cajero\|\|''\}/);
});

test('B: una venta a crédito se distingue de un ingreso de caja', () => {
  const sb = createPosSandbox();
  assert.equal(sb.run(`_naSecCashCreditPart({tipo:'ing',metodo:'credito',monto:2,credito:2})`), 2);
  assert.equal(sb.run(`_naSecCashCreditPart({tipo:'ing',metodo:'credito',monto:2})`), 2);
  assert.equal(sb.run(`_naSecCashCreditPart({tipo:'ing',metodo:'efectivo',monto:2,credito:0})`), 0);
  assert.equal(sb.run(`_naSecCashCreditPart({tipo:'cob',metodo:'efectivo',monto:2})`), 0);
  const html = sb.run(`(()=>{const parent=document.createElement('div');_naSecCashMovement(parent,{tipo:'ing',metodo:'credito',monto:2,credito:2,desc:'Venta V-092',cat:'Venta'});
    const row=parent.children[0];const flat=n=>[n.className||'',n.textContent||'',...(n.children||[]).map(flat)].join('|');return flat(row);})()`);
  assert.match(html, /mov-item ing credito/);
  assert.match(html, /📝/);
  assert.match(html, /a crédito \(no entra a caja\)/);
  assert.doesNotMatch(html, /\+S\//);
  const cash = sb.run(`(()=>{const parent=document.createElement('div');_naSecCashMovement(parent,{tipo:'ing',metodo:'efectivo',monto:3,desc:'Venta',cat:'Venta'});const flat=n=>[n.className||'',n.textContent||'',...(n.children||[]).map(flat)].join('|');return flat(parent.children[0]);})()`);
  assert.match(cash, /mov-amt pos/);
  assert.match(cash, /\+S\/ ?3\.00/);
});

test('I: los cobros de Caja muestran el cliente y el historial muestra fecha/hora/método', () => {
  const ctx = vm.createContext({ console });
  ctx.globalThis = ctx;
  new vm.Script(read('js/adapters/canonical-ui-adapter.js')).runInContext(ctx);
  const snap = ctx.NuevoAmanecerCanonicalUIAdapter.snapshot({
    authority: 'canonical', customers: [{ customer_id: 'C1', name: 'Luis Ramos' }],
    credits: [{ credit_id: 'op1:credit', customer_id: 'C1', original_amount_cents: 200, current_balance_cents: 100, provenance: 'LIVE' }],
    payments: [{ payment_id: 'p1', credit_id: 'op1:credit', amount_cents: 100, payment_date: '2026-10-11', payment_timestamp: '2026-10-11T22:25:00.000Z', payment_date_known: 1, method: 'yape' }],
    financialEvents: [{ event_id: 'p1', operation_id: 'p1', event_type: 'PAYMENT', credit_id: 'op1:credit', credit_delta_cents: -100, cash_delta_cents: 0, payment_method: 'yape', created_at: '2026-10-11T22:25:00.000Z' }],
    cashSessions: [], sales: [], saleItems: [], cashMovements: [], products: [], expenses: []
  });
  const cob = snap.cashMovements.find(m => m.tipo === 'cob');
  assert.equal(cob.clienteNombre, 'Luis Ramos');
  assert.match(cob.desc, /Luis Ramos/);
  const v2 = read('js/modules/client-credit-accounts-v2.js');
  assert.match(v2, /function labPaymentDetailRows/);
  assert.match(v2, /labPaymentMethodLabel\(pay\)/);
  assert.match(v2, /labPaymentLocalTime\(pay\)/);
});

test('9: la búsqueda de clientes dibuja la lista sin la animación diferida', () => {
  const v2 = read('js/modules/client-credit-accounts-v2.js');
  assert.match(v2, /document\.activeElement\.id === 'cliSearch'/);
  assert.match(v2, /naClientReducedMotion\(\) \|\| searching\)/);
});

test('5: el botón de actualizar no se habilita mientras se descarga y el primer clic no se pierde', () => {
  const index = read('index.html');
  const start = index.indexOf('CANON-PWA-UPDATE-001'), block = index.slice(start, index.indexOf('</script>', start));
  assert.match(block, /markVersionPending\('Descargando la versión nueva…', true\)/);
  // Pasivo (true): si el vendedor eligió "Más tarde" no se vuelve a abrir solo; el botón sigue deshabilitado.
  assert.match(block, /'Descargando…', false, true\)/);
  assert.match(block, /120000/);
  assert.match(block, /pwaUpdateQueued = true/);
  assert.match(block, /if \(pwaUpdateQueued\) \{ pwaUpdateQueued = false; runPwaUpdate\(\); \}/);
  assert.doesNotThrow(() => new Function(block.replace(/^[^\n]*\n/, '')));
});

test('CSS CANON de la ronda 2 está enlazado y precacheado', () => {
  const index = read('index.html'), sw = read('sw.js'), css = read('css/canon-ux-fixes.css');
  assert.match(index, /href="css\/canon-ux-fixes\.css"/);
  assert.match(sw, /'\.\/css\/canon-ux-fixes\.css'/);
  assert.match(css, /\.modal-overlay:not\(\.open\)\{visibility:hidden/);
  assert.match(css, /#securityLockScreen:not\(\.open\)\{visibility:hidden\}/);
  // P2-C (móvil): los cerrar llegan a 44 px.
  assert.match(css, /\.btn-close-m\{min-width:44px;min-height:44px/);
  assert.match(css, /\.mov-amt\.credito/);
  assert.match(read('js/legacy-inline/inline-11.js'), /'Cobros en efectivo'/);
});

test('10: el menú lateral cerrado es inert', () => {
  const nav = read('js/navigation/menu-navigation.js');
  assert.match(nav, /drawer\.inert = true;/);
  assert.match(nav, /drawer\.inert = false;/);
});

test('Caja: muestra quién abrió la sesión CANON (registro local) y conserva el fallback', () => {
  const sb = createPosSandbox();
  sb.run(`cajEstado=Object.assign({},cajEstado,{cajero:'',cajeroNombre:'',sessionId:'s-1'})`);
  sb.run(`globalThis.NuevoAmanecerCashHistory={cashierMap:()=>({'s-1':{id:'c1',nombre:'Mery'}})}`);
  assert.equal(sb.run('_naSecCashCashierText()'), 'Mery');
  sb.run(`cajEstado.sessionId='s-viejo'`);
  assert.equal(sb.run('_naSecCashCashierText()'), 'sin registrar');
});

test('Caja: un "@" suelto al final de la etiqueta del movimiento no se muestra', () => {
  const src = read('js/legacy-inline/inline-11.js');
  assert.match(src, /String\(movement\.desc\|\|'Movimiento'\)\.replace\(\/\\s\*@\+\\s\*\$\/,''\)/);
});
