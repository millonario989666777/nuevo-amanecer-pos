import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync('POS/js/inventory/historial-compras.js', 'utf8');

test('guarda estática: no usa settings, escrituras, fetch ni persistencia; consulta con GET explícito', () => {
  for (const forbidden of ['/settings', 'POST', 'fetch(', 'localStorage', 'sessionStorage', 'saveAppState']) {
    assert.equal(source.includes(forbidden), false, `el módulo no debe contener ${forbidden}`);
  }
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.match(source, /\bapi\(\s*READ_PATH\s*,\s*undefined\s*,\s*'GET'\s*\)/);
});

function load(globals = {}) {
  const ctx = vm.createContext(globals);
  vm.runInContext(source, ctx);
  return ctx.NA_HISTORIAL_COMPRAS;
}
const h = load();
const plain = value => JSON.parse(JSON.stringify(value));
const products = [
  { id: 101, name: 'Paracetamol 500 mg', sku: 'FAR-101', barcode: '7750000000101', alternateCodes: ['MED-101'], costo: 99, stock: 60 },
  { id: 202, nombre: 'Azúcar rubia 1 kg', codigo: 'AB-202', barcode: '7750000000202', stock: 20 },
  { id: 303, name: 'Alcohol 70°', sku: 'FAR-303', stock: 0 }
];
const purchases = [
  { purchase_id: 'PUR-test-old', created_at: '2026-10-10T18:00:00Z', supplier: 'Distribuidora de prueba', status: 'aplicada', total_cost_cents: 6800, lines: [
    { purchase_id: 'PUR-test-old', line_number: 1, product_id: '101', quantity: 20, unit_cost_cents: 100 },
    { purchase_id: 'PUR-test-old', line_number: 2, product_id: '202', quantity: 12, unit_cost_cents: 400 }
  ] },
  { purchase_id: 'PUR-test-new', created_at: '2026-10-14T02:00:00Z', supplier: 'Proveedor de prueba', status: 'aplicada', lines: [
    { purchase_id: 'PUR-test-new', line_number: 1, product_id: '101', quantity: 40, unit_cost_cents: 150 }
  ] }
];
const movement = (overrides = {}) => ({ movement_id: 'IM-test', operation_id: 'OCR-test:0', product_id: '101', movement_type: 'ENTRADA', quantity: 10, created_at: '2026-10-12T08:00:00-05:00', reason: 'Compra OCR OCR-test, línea 0: +10', ...overrides });
function freezeDeep(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}

test('buscador por nombre sin tildes, SKU, barras, código alterno e identidad; no muta catálogo', () => {
  const before = JSON.stringify(products);
  for (const query of ['PARACETAMOL 500', 'far-101', '7750000000101', 'med-101', '101']) assert.deepEqual(plain(h.searchProducts(products, query)).map(p => p.id), [101]);
  assert.equal(h.searchProducts(products, 'azucar rubia')[0].id, 202);
  assert.equal(h.searchProducts(products, 'ab-202')[0].id, 202);
  assert.equal(h.searchProducts(products, 'inexistente').length, 0);
  assert.equal(JSON.stringify(products), before);
});

test('ordena reciente primero, total por producto y promedio ponderado (no promedio simple)', () => {
  const history = h.buildHistory(freezeDeep(structuredClone(purchases)), [], '101');
  assert.deepEqual(plain(history.rows).map(r => r.id), ['PUR-test-new:1', 'PUR-test-old:1']);
  assert.deepEqual(plain(history.rows).map(r => r.totalCents), [6000, 2000]);
  assert.equal(history.summary.totalQuantity, 60);
  assert.equal(history.summary.totalCostCents, 8000, 'no usa el total del documento que contiene otros productos');
  assert.equal(history.summary.weightedUnitCostCents, 8000 / 60);
  assert.equal(h.money(history.summary.weightedUnitCostCents), 'S/ 1.33');
  assert.equal(h.limaLabel(history.summary.lastPurchase.timestamp), '13/10/2026 21:00');
});

test('Lima alrededor de medianoche y timestamps sin zona, independiente del dispositivo', () => {
  for (const [raw, expected] of [
    ['2026-10-14T04:59:00Z', '13/10/2026 23:59'],
    ['2026-10-14T05:00:00Z', '14/10/2026 00:00'],
    ['2026-10-14T23:30:00', '14/10/2026 23:30'],
    ['2026-10-14 00:10', '14/10/2026 00:10'],
    ['2026-10-14', '14/10/2026 00:00'],
    ['2026-10-14T10:00:00+09:00', '13/10/2026 20:00']
  ]) assert.equal(h.limaLabel(raw), expected);
  assert.equal(h.timestamp('basura'), null);
  assert.equal(h.limaLabel(null), 'Fecha no registrada');
});

test('deduplica la compra del ledger por operation_id/product_id y conserva líneas de distintos lotes', () => {
  const p = structuredClone(purchases);
  p[1].lines.push({ purchase_id: 'PUR-test-new', line_number: 2, product_id: '101', quantity: 10, unit_cost_cents: 200, lots: [{ lot_code: 'TEST-2', quantity: 10 }] });
  const moves = [movement({ operation_id: 'PUR-test-new:1', quantity: 40 }), movement({ operation_id: 'PUR-test-new:2' })];
  const history = h.buildHistory(p.concat(p), moves.concat(moves), 101);
  assert.equal(history.rows.length, 3);
  assert.equal(history.summary.totalQuantity, 70);
  assert.equal(history.summary.totalCostCents, 10000);
});

test('compra en curso/parcial: solo líneas confirmadas por ledger; pendientes no son compras aplicadas', () => {
  const p = [{ purchase_id: 'PUR-partial', created_at: '2026-10-14', status: 'cerrada_parcial', lines: [
    { purchase_id: 'PUR-partial', line_number: 1, product_id: '101', quantity: 12, unit_cost_cents: 200 },
    { purchase_id: 'PUR-partial', line_number: 2, product_id: '101', quantity: 30, unit_cost_cents: 500 }
  ] }];
  const moves = [movement({ operation_id: 'PUR-partial:1', quantity: 12 })];
  const history = h.buildHistory(p, moves, '101');
  assert.equal(history.rows.length, 1);
  assert.equal(history.summary.totalQuantity, 12);
  assert.equal(history.summary.totalCostCents, 2400);
  assert.equal(history.excludedLines, 1);
  assert.equal(h.buildHistory(p, [], '101').rows.length, 0);
  p[0].status = 'en_curso';
  assert.equal(h.buildHistory(p, moves, '101').rows.length, 1);
  const wrongProduct = movement({ operation_id: 'PUR-partial:2', product_id: '202' });
  assert.equal(h.buildHistory(p, [wrongProduct], '101').rows.length, 0);
});

test('OCR antiguo/entrada de compra se incluye sin inventar costo actual; excluye altas, ventas, devoluciones y ajustes', () => {
  const moves = [movement(), movement(),
    { id: 'local-OCR', productId: 101, type: 'ENTRADA', delta: 5, source: 'OCR_PURCHASE', referenceId: 'OCR-local:0', timestamp: '2026-10-11T08:00:00Z' },
    { id: 'manual-purchase', productId: 101, type: 'ENTRADA', delta: 6, reason: 'Compra a proveedor: +6', fecha: '2026-10-09', hora24: '10:00' },
    movement({ operation_id: 'adjust:0', reason: 'Corrección por conteo' }),
    movement({ operation_id: 'return:0', reason: 'Devolución de cliente' }),
    movement({ operation_id: 'sale:0', movement_type: 'SALE' }),
    movement({ operation_id: 'reversal:0', movement_type: 'SALE_REVERSAL' }),
    movement({ operation_id: 'create:0', movement_type: 'ALTA' }),
    movement({ operation_id: 'out:0', movement_type: 'SALIDA' })
  ];
  const history = h.buildHistory(purchases, moves, '101');
  assert.equal(history.rows.length, 5);
  assert.equal(history.summary.totalQuantity, 81);
  assert.equal(history.summary.missingCostQuantity, 21);
  assert.equal(history.summary.weightedUnitCostCents, 8000 / 60);
  assert.equal(history.rows.find(r => r.id === 'OCR-test:0').unitCostCents, null);
  assert.equal(h.money(null), 'Sin costo registrado');
});

test('costo cero es válido; sin costo no se convierte a cero; entradas inválidas no afectan el resumen', () => {
  const p = [{ purchase_id: 'PUR-validation', status: 'aplicada', created_at: 'fecha inválida', lines: [
    { purchase_id: 'PUR-validation', line_number: 1, product_id: '101', quantity: 10, unit_cost_cents: 0 },
    { purchase_id: 'PUR-validation', line_number: 2, product_id: '101', quantity: 5, unit_cost_cents: null },
    { purchase_id: 'PUR-validation', line_number: 3, product_id: '101', quantity: -1, unit_cost_cents: 100 },
    { purchase_id: 'PUR-validation', line_number: 4, product_id: '101', quantity: 'mal', unit_cost_cents: 100 },
    { purchase_id: 'PUR-validation', line_number: 5, product_id: '101', quantity: 0, unit_cost_cents: 100 },
    { purchase_id: 'PUR-validation', line_number: 6, product_id: '101', quantity: 3, unit_cost_cents: -100 },
    { purchase_id: 'PUR-validation', line_number: 7, product_id: '101', quantity: 2, unit_cost_cents: 1.5 }
  ] }];
  const history = h.buildHistory(p, [], '101');
  assert.equal(history.summary.totalQuantity, 20);
  assert.equal(history.summary.costedQuantity, 10);
  assert.equal(history.summary.weightedUnitCostCents, 0);
  assert.equal(history.summary.lastPurchase, null);
  assert.equal(h.money(0), 'S/ 0.00');
  assert.equal(h.buildHistory([], [], '303').rows.length, 0);
});

test('solo-owner, default-deny, únicamente GET; rechaza respuesta tardía si pierde permisos', async () => {
  const calls = [];
  let owner = true;
  const globals = { NA_ROLES: { isOwner: () => owner, api: async (...args) => { calls.push(args); return { purchases }; } }, NA_PERMISSIONS: { canAccessScreen: (role, page) => role === 'owner' && page === 'pageHistorialCompras' } };
  const api = load(globals);
  assert.deepEqual(plain(await api.readPurchases()), { purchases, ready: true });
  assert.deepEqual(calls, [['/auth/purchases', undefined, 'GET']]);
  owner = false;
  await assert.rejects(api.readPurchases(), /Sin permiso/);
  assert.equal(calls.length, 1);
  assert.equal(load().ownerAllowed(), false);
  assert.equal(load({ NA_ROLES: globals.NA_ROLES }).ownerAllowed(), false);
  owner = true;
  globals.NA_ROLES.api = async () => { owner = false; return { purchases }; };
  await assert.rejects(api.readPurchases(), /Sin permiso/);
  owner = true;
  globals.NA_ROLES.api = async () => ({ purchases: [] });
  assert.deepEqual(plain(await api.readPurchases()), { purchases: [], ready: true });
  globals.NA_ROLES.api = async () => ({ purchases: [], ready: false });
  assert.deepEqual(plain(await api.readPurchases()), { purchases: [], ready: false });
  globals.NA_ROLES.api = async () => ({});
  await assert.rejects(api.readPurchases(), /Respuesta de compras no válida/);
});

test('todos los datos de entrada, ventas y abonos/outbox permanecen idénticos y congelados', () => {
  const data = freezeDeep({ products: structuredClone(products), purchases: structuredClone(purchases), movements: [movement()], sales: [{ id: 'TEST-sale-pending', state: 'PENDING' }], payments: [{ id: 'TEST-payment-pending', state: 'PENDING' }] });
  const before = JSON.stringify(data);
  h.searchProducts(data.products, '101');
  for (const id of ['101', '202', '303']) h.buildHistory(data.purchases, data.movements, id);
  assert.equal(JSON.stringify(data), before);
  assert.doesNotMatch(source, /\b(?:setItem|removeItem|saveAllData|saveAppState|submit|adjustInventory|prepareCommand|commandContext)\s*\(/);
});

test('CSS neutraliza nowrap global y usa selector de página en claro/oscuro', () => {
  const css = readFileSync('POS/css/historial-compras.css', 'utf8');
  assert.match(css, /white-space: normal !important/);
  assert.match(css, /body\.dark #pageHistorialCompras/);
  assert.match(css, /minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /#page(?:POS|Menu)\b/);
});

test('promedio ponderado no redondea los pesos de cantidades fraccionarias', () => {
  const history = h.buildHistory([{ purchase_id: 'PUR-fraction', status: 'aplicada', lines: [
    { line_number: 0, product_id: '101', quantity: 0.5, unit_cost_cents: 101 },
    { line_number: 1, product_id: '101', quantity: 1.5, unit_cost_cents: 201 }
  ] }], [], '101');
  assert.equal(history.summary.totalQuantity, 2);
  assert.equal(history.summary.totalCostCents, 353, 'los totales monetarios sí se redondean a céntimos');
  assert.equal(history.summary.weightedUnitCostCents, 176, '(0.5 × 101 + 1.5 × 201) / 2');
});

test('costos vacíos/objetos no son costo cero; línea sin número no se inventa como línea cero', () => {
  const history = h.buildHistory([{ purchase_id: 'PUR-empty-costs', status: 'aplicada', lines: [
    ...['', '   ', undefined, null, false, [], {}].map((value, line_number) => ({ line_number, product_id: '101', quantity: 10, unit_cost_cents: value })),
    { line_number: 7, product_id: '101', quantity: 5, unit_cost_cents: 0 },
    ...[null, '', false, [], {}].map(line_number => ({ line_number, product_id: '101', quantity: 100, unit_cost_cents: 200 }))
  ] }], [], '101');
  assert.equal(history.rows.length, 8);
  assert.equal(history.summary.totalQuantity, 75);
  assert.equal(history.summary.missingCostQuantity, 70);
  assert.equal(history.summary.costedQuantity, 5);
  assert.equal(history.summary.weightedUnitCostCents, 0);
});

// DOM mínimo para probar carga, selección y ciclo de permisos sin navegador ni HTML externo.
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.attributes = {}; this._text = ''; this.hidden = false; this.value = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(' '); }
  set innerHTML(_) { throw new Error('El render debe usar texto seguro'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, callback) { this.events[key] = callback; }
}
function uiHarness({ role = 'owner', cloud = true, reader = async () => ({ purchases }), moves = [movement()] } = {}) {
  const elements = Object.fromEntries(['content', 'denied', 'search', 'products', 'status', 'result', 'retry'].map(name => [name, new Element()]));
  const events = {}, reads = [], violations = [];
  let active = false, update;
  const deny = action => { violations.push(action); throw new Error(action); };
  const data = freezeDeep({ products: structuredClone(products), purchases: structuredClone(purchases), inventoryMovements: structuredClone(moves), sales: [{ id: 'TEST-sale-pending' }], payments: [{ id: 'TEST-payment-pending' }] });
  const page = { classList: { contains: name => name === 'active' && active }, querySelector: selector => elements[selector.slice(9, -1)] };
  const ctx = vm.createContext({
    document: { readyState: 'complete', getElementById: id => id === 'pageHistorialCompras' ? page : null, createElement: tag => new Element(tag) },
    MutationObserver: function (callback) { update = callback; this.observe = () => {}; },
    addEventListener: (name, callback) => { events[name] = callback; },
    NA_ROLES: { isOwner: () => role === 'owner', api: async (...args) => { reads.push(args); return reader(); } },
    NA_PERMISSIONS: { canAccessScreen: (r, id) => r === 'owner' && id === 'pageHistorialCompras' },
    NuevoAmanecerCanonical: { enabled: () => cloud, snapshot: () => data, refresh: () => deny('refresh'), adjustInventory: () => deny('adjustInventory'), prepareCommand: () => deny('prepareCommand') },
    localStorage: new Proxy({}, { get: (_, key) => deny('localStorage.' + String(key)) }),
    sessionStorage: new Proxy({}, { get: (_, key) => deny('sessionStorage.' + String(key)) }),
    fetch: () => deny('fetch directo'), saveAllData: () => deny('saveAllData'), saveAppState: () => deny('saveAppState'),
    data
  });
  vm.runInContext('let productos = data.products; let inventoryMovements = data.inventoryMovements; let ventas = data.sales; let abonosPendientes = data.payments;', ctx);
  vm.runInContext(source, ctx);
  return {
    ctx, elements, events, reads, violations,
    activate(value) { active = value; update(); },
    role(value) { role = value; events['na:role'](); },
    select(query = 'FAR-101') { elements.search.value = query; elements.search.events.input(); elements.products.children.find(node => node.tag === 'button').events.click(); },
    snapshot: () => vm.runInContext('JSON.stringify({productos, inventoryMovements, ventas, abonosPendientes, data})', ctx)
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('UI cloud y local: consultas/selección sin acceso a storage, comandos ni cambios en datos congelados', async () => {
  for (const cloud of [true, false]) {
    const ui = uiHarness({ cloud });
    const before = ui.snapshot();
    assert.equal(ui.reads.length, 0, 'no consulta una página oculta');
    ui.activate(true); await settle(); ui.select();
    assert.match(ui.elements.result.textContent, /Sin costo registrado/);
    assert.match(ui.elements.result.textContent, cloud ? /S\/ 1\.33/ : /10 · unidad física/);
    if (cloud) assert.match(ui.elements.result.textContent, /13\/10\/2026 21:00/);
    ui.events['na:canonical-updated'](); ui.select('AB-202');
    if (!cloud) assert.match(ui.elements.result.textContent, /Sin compras registradas/);
    ui.activate(false); ui.activate(true); await settle(); ui.select('FAR-303');
    assert.match(ui.elements.result.textContent, /Sin compras registradas/);
    assert.equal(ui.snapshot(), before);
    assert.deepEqual(ui.violations, []);
    assert.deepEqual(ui.reads, cloud ? [['/auth/purchases', undefined, 'GET'], ['/auth/purchases', undefined, 'GET']] : []);
  }
});

test('UI deniega empleado, rol desconocido y no confirmado antes de leer fuentes o servidor', async () => {
  for (const role of ['empleado', 'unknown', 'unconfirmed']) {
    const ui = uiHarness({ role });
    ui.ctx.NuevoAmanecerCanonical.snapshot = () => { throw new Error('No debe leer datos del owner'); };
    ui.activate(true); await settle();
    assert.equal(ui.elements.denied.hidden, false);
    assert.equal(ui.elements.content.hidden, true);
    assert.equal(ui.elements.products.textContent, '');
    assert.deepEqual(ui.reads, []);
    assert.deepEqual(ui.violations, []);
  }
});

test('UI distingue lista vacía, ready:false y error de red; reintento solo lee', async () => {
  for (const first of [{ purchases: [] }, { purchases: [], ready: false }, new Error('offline')]) {
    let response = first;
    const ui = uiHarness({ moves: [], reader: async () => { if (response instanceof Error) throw response; return response; } });
    ui.activate(true); await settle(); ui.select();
    if (first.ready === undefined && !(first instanceof Error)) {
      assert.match(ui.elements.result.textContent, /Sin compras registradas/);
      assert.equal(ui.elements.retry.hidden, true);
    } else {
      assert.equal(ui.elements.result.textContent, '');
      assert.match(ui.elements.status.textContent, first instanceof Error ? /No se pudo cargar/ : /todavía no está disponible/);
      assert.equal(ui.elements.retry.hidden, false);
      response = { purchases };
      await ui.elements.retry.events.click();
      assert.match(ui.elements.result.textContent, /S\/ 1\.33/);
    }
    assert.deepEqual(ui.violations, []);
    assert.ok(ui.reads.every(args => args[0] === '/auth/purchases' && args[1] === undefined && args[2] === 'GET'));
  }
});

test('respuesta tardía se descarta al salir o perder permisos; borra resultados y selección del owner', async () => {
  for (const loseRole of [true, false]) {
    let release;
    const ui = uiHarness({ reader: () => new Promise(resolve => { release = resolve; }) });
    ui.activate(true); ui.select();
    if (loseRole) ui.role('empleado'); else ui.activate(false);
    release({ purchases }); await settle();
    assert.equal(ui.elements.products.textContent, '');
    assert.equal(ui.elements.result.textContent, '');
    assert.equal(ui.elements.status.textContent, '');
    if (loseRole) assert.equal(ui.elements.search.value, '');
    assert.deepEqual(ui.violations, []);
  }
});

test('tras un fallo de lectura solo el botón Reintentar vuelve a consultar (sin reintentos por eventos)', () => {
  assert.match(source, /!loaded && !pending && !failed\)\) load\(\)/);
  assert.match(source, /retry\.addEventListener\('click', load\)/);
  assert.match(source, /purchases = \[\]; failed = true;/);
});

test('ownerAllowed depende solo de NA_ROLES.isOwner(), sin canAccessScreen', () => {
  let screenCalls = 0;
  const permissions = { canAccessScreen: () => { screenCalls++; return false; } };
  assert.equal(load({ NA_ROLES: { isOwner: () => true } }).ownerAllowed(), true);
  assert.equal(load({ NA_ROLES: { isOwner: () => true }, NA_PERMISSIONS: permissions }).ownerAllowed(), true);
  assert.equal(load({ NA_ROLES: { isOwner: () => false }, NA_PERMISSIONS: permissions }).ownerAllowed(), false);
  assert.equal(load({}).ownerAllowed(), false);
  assert.equal(screenCalls, 0);
  assert.doesNotMatch(source, /canAccessScreen/);
});

test('aviso de límite: desde 300 compras se indica «Mostrando las últimas 300 compras»', () => {
  const api = load();
  assert.equal(api.PURCHASE_LIMIT, 300);
  const list = n => Array.from({ length: n }, (_, i) => ({ purchase_id: 'PUR-' + i, lines: [] }));
  // Sin flag (worker anterior): cuenta solo las no incompletas.
  assert.equal(api.limitReached(list(299)), false);
  assert.equal(api.limitReached(list(300)), true);
  assert.equal(api.limitReached(list(305)), true);
  assert.equal(api.limitReached(null), false);
  assert.match(source, /'Mostrando las últimas ' \+ PURCHASE_LIMIT \+ ' compras'/);
});

test('limitReached: el flag truncated del servidor manda; sin él, 300 filas o más prueban corte', () => {
  const api = load();
  const list = (n, status = 'aplicada') => Array.from({ length: n }, (_, i) => ({ purchase_id: status + '-' + i, status, lines: [] }));
  // 299 aplicadas + 5 en_curso = 304 filas: sin corte el servidor devuelve todo (≤ 300), así que 304 prueba corte.
  const mixed = list(299).concat(list(5, 'en_curso'));
  assert.equal(api.limitReached(mixed), true);
  // Bloque de 300 con 7 en_curso dentro (antes se descontaban y el aviso no salía).
  assert.equal(api.limitReached(list(293).concat(list(7, 'en_curso'))), true);
  assert.equal(api.limitReached(list(292).concat(list(7, 'en_curso'))), false);
  assert.equal(api.limitReached(list(300).concat(list(3, 'en_curso'))), true);
  // cerrada_parcial viene dentro de las 300 recientes: sí cuenta.
  assert.equal(api.limitReached(list(299).concat(list(1, 'cerrada_parcial'))), true);
  // Con flag, se usa tal cual aunque el conteo diga otra cosa.
  assert.equal(api.limitReached(list(300), false), false);
  assert.equal(api.limitReached(list(10), true), true);
  assert.equal(api.limitReached(mixed, true), true);
});

test('readPurchases propaga truncated solo si es booleano', async () => {
  const make = body => load({ NA_ROLES: { isOwner: () => true, api: async () => body } });
  assert.equal((await make({ purchases: [], truncated: true }).readPurchases()).truncated, true);
  assert.equal((await make({ purchases: [], truncated: false }).readPurchases()).truncated, false);
  assert.equal((await make({ purchases: [] }).readPurchases()).truncated, undefined);
  assert.equal((await make({ purchases: [], truncated: 'yes' }).readPurchases()).truncated, undefined);
});

// Arma la respuesta igual que GET /auth/purchases: bloque de las 300 más recientes de cualquier estado
// (con LIMIT 301 en el worker 45, que además informa truncated) + las en_curso más antiguas aparte.
function serverResponse(db, withFlag) {
  const sorted = db.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const recent = sorted.slice(0, 300), seen = new Set(recent.map(r => r.purchase_id));
  const open = sorted.filter(r => r.status === 'en_curso' && !seen.has(r.purchase_id));
  const purchases = open.concat(recent).map(r => ({ ...r, lines: [] }));
  return withFlag ? { purchases, truncated: sorted.length > 300 } : { purchases };
}
function makeDb({ applied, openRecent = 0, openOld = 0 }) {
  const at = i => new Date(Date.UTC(2026, 9, 15) - i * 3600e3).toISOString();
  const db = [];
  for (let i = 0; i < openRecent; i++) db.push({ purchase_id: 'new-open-' + i, status: 'en_curso', created_at: at(i) });
  for (let i = 0; i < applied; i++) db.push({ purchase_id: 'ap-' + i, status: 'aplicada', created_at: at(openRecent + i) });
  for (let i = 0; i < openOld; i++) db.push({ purchase_id: 'old-open-' + i, status: 'en_curso', created_at: at(openRecent + applied + i) });
  return db;
}

test('limitInfo: aviso correcto con y sin en_curso, con y sin truncated (respuesta armada como el worker)', () => {
  const api = load();
  const cases = [
    // [descripción, db, ¿hubo corte?, en_curso fuera del bloque de 300]
    ['10 aplicadas', { applied: 10 }, false, 0],
    ['300 justas', { applied: 300 }, false, 0],
    ['301 aplicadas', { applied: 301 }, true, 0],
    ['295 aplicadas + 5 en_curso recientes (300 en total)', { applied: 295, openRecent: 5 }, false, 0],
    ['296 aplicadas + 5 en_curso recientes (corte con en_curso en el bloque)', { applied: 296, openRecent: 5 }, true, 0],
    ['320 aplicadas + 6 en_curso recientes', { applied: 320, openRecent: 6 }, true, 0],
    ['320 aplicadas + 4 en_curso antiguas', { applied: 320, openOld: 4 }, true, 4],
    ['310 aplicadas + 3 recientes + 1 antigua', { applied: 310, openRecent: 3, openOld: 1 }, true, 1],
    ['290 aplicadas + 10 en_curso antiguas (300 en total, sin corte)', { applied: 290, openOld: 10 }, false, 0],
    ['290 aplicadas + 12 en_curso antiguas (2 quedan fuera)', { applied: 290, openOld: 12 }, true, 2]
  ];
  for (const [name, spec, cut, older] of cases) {
    const db = makeDb(spec);
    for (const withFlag of [true, false]) {
      const res = serverResponse(db, withFlag);
      const info = api.limitInfo(res.purchases, res.truncated);
      // El worker anterior no distingue «exactamente 300» de «hubo corte»: con 300 filas avisa (conservador).
      const expectCut = withFlag ? cut : res.purchases.length >= 300;
      assert.equal(info.reached, expectCut, name + (withFlag ? ' (con truncated)' : ' (sin truncated)'));
      if (cut) {
        assert.equal(info.reached, true, name);
        assert.equal(info.olderOpen, older, name);
        assert.equal(info.label, 'Mostrando las últimas 300 compras' + (older ? ' y ' + older + (older === 1 ? ' incompleta más antigua' : ' incompletas más antiguas') : ''), name);
      } else if (!info.reached) assert.equal(info.label, '', name);
    }
  }
});

test('limitInfo: entradas raras no rompen el aviso', () => {
  const api = load();
  assert.deepEqual({ ...api.limitInfo(null) }, { reached: false, olderOpen: 0, label: '' });
  assert.deepEqual({ ...api.limitInfo(undefined, true) }, { reached: true, olderOpen: 0, label: 'Mostrando las últimas 300 compras' });
  assert.equal(api.limitInfo([null, undefined], false).reached, false);
  // truncated:false manda aunque lleguen 300 filas.
  assert.equal(api.limitInfo(serverResponse(makeDb({ applied: 300 }), false).purchases, false).reached, false);
});
