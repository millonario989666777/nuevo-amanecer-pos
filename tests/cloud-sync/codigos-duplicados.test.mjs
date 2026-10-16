import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PERMISSIONS as serverPolicy } from '../../tools/cloudflare-lab/src/pos-permissions.js';

const source = readFileSync(new URL('../../POS/js/inventory/codigos-duplicados.js', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../../POS/js/config/pos-permissions.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const product = (id, extra = {}) => ({ id, name: `Paracetamol ${id} 500 mg, caja de 100 tabletas`,
  sku: `SKU-${id}`, barcode: '', codigosAlternativos: [], codigoAlternativo: '',
  descripcion: 'Tabletas para venta por unidad', cat: 'farmacia', marca: 'Genérico',
  unidad: 'unidad', unidadCompra: 'caja', factorCompra: 100, icon: '💊', imagen: null,
  precio: 0.5, costo: 0.2, stock: 120, stockMin: 20, venc: '2028-09-30',
  precioCaja: 45, unidCaja: 100, incluyeIGV: true, tipoImpuesto: 'gravado',
  impuestoComplementario: '', controlInventario: true, activo: true, ...extra });
const sale = (id, date, items, extra = {}) => ({ id, fecha: date, hora: '10:00', hora24: '10:00:00',
  total: 1, metodo: 'efectivo', estado: 'completada', anulada: false, clienteId: null,
  items: items.map(id => ({ id, name: `Producto ${id}`, qty: 2, cantidad: 2, precio: 0.5, costo: 0.2, unitsPerQty: 1 })), ...extra });
function api(extra = {}) {
  const context = vm.createContext(extra);
  vm.runInContext(source, context);
  return { api: context.NA_CODIGOS_DUPLICADOS, context };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('tres productos activos producen exactamente los tres pares de un código', () => {
  const { api: a } = api();
  const rows = plain(a.listPairs([product(1, { sku: ' 00775001 ' }),
    product(2, { barcode: '00775001' }), product(3, { codigosAlternativos: ['00775001'] })]));
  assert.deepEqual(rows.map(row => [row.code, row.products.map(p => p.id)]),
    [['00775001', [1, 2]], ['00775001', [1, 3]], ['00775001', [2, 3]]]);
});

test('usa los cuatro campos de codes(), ignora números/vacíos y conserva ceros y mayúsculas', () => {
  const { api: a } = api();
  const catalog = [product(1, { sku: ' 00012 ', barcode: 'AbC', codigosAlternativos: [' 077 ', ' ', 77], codigoAlternativo: ' OLD ' }),
    product(2, { sku: 'OLD', barcode: '077', codigosAlternativos: ['00012', 'AbC'] }),
    product(3, { sku: '12', barcode: 'abc', codigosAlternativos: '00012', codigoAlternativo: 77 })];
  const rows = plain(a.listPairs(catalog));
  assert.deepEqual(rows.map(row => row.code), ['00012', 'AbC', '077', 'OLD']);
  assert.ok(rows.every(row => row.products.map(p => p.id).join(',') === '1,2'));
});

test('repetir un código dentro del producto o su identidad no crea pares consigo mismo', () => {
  const { api: a } = api();
  const first = product(1, { sku: ' 123 ', barcode: '123', codigosAlternativos: ['123', '123'], codigoAlternativo: '123' });
  assert.equal(a.listPairs([first]).length, 0);
  assert.equal(a.listPairs([first, { ...first, id: '1' }]).length, 0);
  const rows = a.listPairs([first, { ...first, id: '1' }, product(2, { barcode: '123' })]);
  assert.equal(rows.length, 1);
  assert.deepEqual(plain(rows[0].products.map(p => p.id)), [1, 2]);
});

test('excluye activo:false y tombstones; incluye activos sin stock o sin reposición', () => {
  const { api: a } = api();
  const catalog = [product(1, { sku: '123', stock: 0 }), product(2, { barcode: '123', activo: false }),
    product(3, { barcode: '123', eliminado: true }), product(4, { barcode: '123', deleted: true }),
    product(5, { barcode: '123', deleted_at: '2026-10-12T00:00:00Z' }),
    product(6, { barcode: '123', activo: undefined, stock: -2, reactivadoAt: '2025-01-01T00:00:00Z' })];
  const rows = plain(a.listPairs(catalog));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].products.map(p => [p.id, p.stock]), [[1, 0], [6, -2]]);
  assert.equal(a.listPairs([null, undefined, product(2, { activo: false })]).length, 0);
});

test('última venta coincide solo por ID local o product_id y excluye anuladas/venta libre', () => {
  const { api: a } = api();
  const catalog = [product(1, { product_id: 'CANON-A', barcode: '123' }), product(2, { barcode: '123' })];
  const sales = [sale('new', '2026-10-15', ['CANON-A'], { anulada: true }),
    sale('state', '2026-10-14', ['CANON-A'], { estado: 'anulada' }),
    sale('old', '2026-10-10', ['CANON-A']),
    sale('valid', '2026-10-12', [], { items: [{ id: 'line-id', product_id: 'CANON-A', qty: 1 }] }),
    sale('name-only', '2026-10-15', [], { items: [{ name: catalog[1].name, sku: catalog[1].sku }] }),
    sale('free', '2026-10-15', [2], { items: [{ id: 2, ventaLibre: true }] })];
  assert.deepEqual(plain(a.listPairs(catalog, sales)[0].products.map(p => p.lastSaleDate)), ['2026-10-12', null]);
  const local = a.listPairs([product(1, { barcode: '123' }), product(2, { barcode: '123' })], [sale('numeric-string', '2026-10-13', ['2'])]);
  assert.equal(local[0].products[1].lastSaleDate, '2026-10-13');
});

test('calendario Lima para instantes, timestamps sin zona y fallback a fecha válida', () => {
  const { api: a } = api();
  const catalog = [product(1, { barcode: '123' }), product(2, { barcode: '123' })];
  for (const [timestamp, fecha, expected] of [
    ['2026-10-14T04:30:00Z', '2026-10-14', '2026-10-13'],
    ['2026-10-14T00:30:00+02:00', '', '2026-10-13'],
    ['2026-10-14T00:30:00-05:00', '', '2026-10-14'],
    ['2026-10-14T23:30:00', '', '2026-10-14'],
    ['2026-10-14 00:10', '', '2026-10-14'],
    ['inválida', '2026-10-12', '2026-10-12'],
    ['', '2026-02-30', null], ['', '', null]
  ]) {
    assert.equal(a.listPairs(catalog, [sale('date', fecha, [1], { timestamp })])[0].products[0].lastSaleDate, expected, timestamp || fecha);
  }
});

test('consulta pura con entradas congeladas; salida no modifica catálogo ni ventas pendientes', () => {
  const { api: a } = api();
  const catalog = freeze([product(1, { barcode: '123' }), product(2, { barcode: '123' })]);
  const sales = freeze([sale('pending-synthetic', '2026-10-13', [1], { pending: true, confirmed: false, operation_id: 'synthetic-pending' })]);
  const before = JSON.stringify({ catalog, sales });
  const rows = a.listPairs(catalog, sales);
  rows[0].products[0].name = 'Salida independiente';
  rows[0].products[0].stock = 99;
  assert.equal(JSON.stringify({ catalog, sales }), before);
  assert.equal(a.listPairs(null, null).length, 0);
});

test('política compartida cliente/servidor default-deny ya limita la pantalla al owner', () => {
  const context = {};
  vm.runInNewContext(policy, context);
  for (const role of ['owner', 'empleado', 'unknown', undefined]) {
    assert.equal(context.NA_PERMISSIONS.canAccessScreen(role, 'pageCodigosDuplicados'), role === 'owner');
  }
  assert.deepEqual(plain(context.NA_PERMISSIONS.routeRoles('/no-listed-duplicate-codes', 'POST')), ['owner']);
  for (const role of ['owner', 'empleado', 'unknown', undefined]) {
    assert.equal(serverPolicy.canAccessScreen(role, 'pageCodigosDuplicados'), role === 'owner');
    assert.equal(serverPolicy.routeRoles('/auth/unlisted-duplicate-codes', 'GET').includes(role), role === 'owner');
  }
});

// DOM mínimo para probar contratos de eventos/permisos sin lanzar navegador.
function domHarness({ role = 'owner', confirmed = true, lateMenu = false } = {}) {
  class Node {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.hidden = false; this.textContent = ''; this.classes = new Set(); }
    get classList() { return { contains: value => this.classes.has(value), add: value => this.classes.add(value),
      remove: (...values) => values.forEach(value => this.classes.delete(value)),
      toggle: (value, on) => on ? this.classes.add(value) : this.classes.delete(value) }; }
    set className(value) { this.classes = new Set(value.split(' ')); }
    append(...nodes) { for (const node of nodes) { if (node.tag === '#fragment') this.append(...node.children); else { node.parent = this; this.children.push(node); } } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, callback) { this.events[name] = callback; }
    focus() { document.activeElement = this; }
    querySelectorAll(selector) {
      const key = selector.match(/^\[data-(.*)\]$/)?.[1]?.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.children.flatMap(node => [ ...((key && key in node.dataset) || node.tag === selector ? [node] : []), ...node.querySelectorAll(selector) ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const page = new Node(), heading = new Node('h1'), list = new Node(), status = new Node(), intro = new Node(), back = new Node('button'), refresh = new Node('button'), menu = new Node();
  const inventory = new Node();
  page.className = 'page';
  list.dataset.cdList = ''; status.dataset.cdStatus = ''; intro.dataset.cdOwner = '';
  back.dataset.cdBack = ''; refresh.dataset.cdRefresh = ''; refresh.dataset.cdOwner = '';
  page.append(heading, list, status, intro, back, refresh);
  const summary = new Node('summary');
  let available = !lateMenu;
  const observers = [], events = {}, opened = [], edits = [], navigated = [];
  const document = { readyState: 'complete', activeElement: null, documentElement: new Node('html'), body: new Node('body'), createElement: tag => new Node(tag), createDocumentFragment: () => new Node('#fragment'),
    querySelectorAll: () => [page, inventory],
    getElementById: id => id === 'pageCodigosDuplicados' ? page : id === 'pageInventario' ? inventory : null,
    querySelector: selector => selector === '#pageInventario .inv-secondary-menu' && available ? menu : selector === '#pageInventario .inv-secondary > summary' ? summary : null };
  const context = { document, productos: [product(1, { barcode: '123' }), product(2, { barcode: '123' })], ventas: [],
    NA_ROLES: { role, isOwner: () => confirmed && context.NA_ROLES.role === 'owner' },
    // Navegación estándar de la app: se registra y activa la página (el guardado de estado de UI es normal).
    NA_MENU_NAVIGATION: { navigate(id) { navigated.push(id); [page, inventory].forEach(n => n.classList.remove('active')); (id === 'pageCodigosDuplicados' ? page : inventory).classList.add('active'); return true; } },
    goPage() { throw Error('usar NA_MENU_NAVIGATION'); },
    editProd: id => edits.push(id),
    addEventListener: (event, callback) => { events[event] = callback; }, setTimeout: callback => callback(),
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe(target) { this.target = target; this.connected = true; } disconnect() { this.connected = false; } },
    localStorage: { setItem() { throw Error('No debe persistir'); } }, saveAllData() { throw Error('No debe guardar'); },
    fetch() { throw Error('No debe llamar API'); } };
  const { api: a } = api(context);
  return { a, context, page, inventory, heading, list, status, intro, back, refresh, menu, summary, observers, events, opened, edits,
    createMenu() { available = true; observers.filter(o => o.connected && o.target === document.body).forEach(o => o.callback()); } };
}

test('espera a Más opciones y navega con la navegación estándar sin tocar catálogo ni ventas', () => {
  const h = domHarness({ lateMenu: true });
  assert.equal(h.menu.children.length, 0);
  h.createMenu();
  h.events['na:role'](); h.events['na:role']();
  assert.equal(h.menu.children.length, 1);
  assert.equal(h.menu.children[0].textContent, 'Códigos duplicados');
  assert.equal(h.observers.find(o => o.target === h.context.document.body).connected, false);
  const before = JSON.stringify({ products: h.context.productos, sales: h.context.ventas });
  h.menu.children[0].events.click();
  assert.equal(h.page.classList.contains('active'), true);
  assert.match(h.status.textContent, /1 par/);
  assert.equal(h.list.children.length, 1);
  assert.equal(h.a.openProduct('1'), true);
  assert.deepEqual(h.edits, [1], 'ID conserva el tipo que exige editProd');
  assert.equal(h.a.openProduct('missing'), false);
  h.back.events.click();
  assert.equal(h.inventory.classList.contains('active'), true);
  assert.equal(h.page.classList.contains('active'), false);
  assert.equal(JSON.stringify({ products: h.context.productos, sales: h.context.ventas }), before);
});

test('empleado, rol desconocido o owner sin confirmar no tienen entrada ni acceso programático', () => {
  for (const options of [{ role: 'empleado' }, { role: 'unknown' }, { role: 'owner', confirmed: false }]) {
    const h = domHarness(options);
    assert.equal(h.menu.children.length, 0);
    Object.defineProperty(h.context, 'productos', { get() { throw Error('No leer catálogo sin permiso'); } });
    Object.defineProperty(h.context, 'ventas', { get() { throw Error('No leer ventas sin permiso'); } });
    assert.equal(h.a.open(), false);
    assert.equal(h.a.openProduct(1), false);
    assert.equal(h.status.textContent, 'Sin permiso');
    assert.equal(h.list.children.length, 0);
    assert.deepEqual(h.opened, []); assert.deepEqual(h.edits, []);
  }
});

test('render usa texto para los valores del catálogo y sin ventas; la ficha es opcional', () => {
  const h = domHarness();
  const name = '<img src=x onerror=alert(1)> Producto de prueba';
  h.context.productos[0].name = name;
  h.context.productos[0].sku = ' <script>código</script> ';
  h.context.productos[1].codigoAlternativo = '<script>código</script>';
  delete h.context.editProd;
  h.a.render();
  const pair = h.list.children.find(node => node.children[0].textContent === 'Código: <script>código</script>');
  assert.ok(pair);
  assert.equal(pair.children[0].textContent, 'Código: <script>código</script>');
  const section = pair.children[1].children[0];
  assert.equal(section.children[0].textContent, name);
  assert.equal(section.children[1].children[1].children[1].textContent, 'sin ventas');
  assert.equal(section.children.length, 2, 'sin botón si no existe editor');
  assert.equal(h.a.openProduct(1), false);
});

test('revocación borra filas y entrada; actualiza la consulta al activar o refrescar', () => {
  const h = domHarness();
  h.a.open();
  h.context.productos[1].activo = false;
  assert.equal(h.a.openProduct(2), false, 'no abre producto desactivado tras render');
  h.refresh.events.click();
  assert.equal(h.status.textContent, 'Sin códigos duplicados');
  h.context.productos[1].activo = true;
  h.page.classes.add('active');
  h.observers.find(o => o.target === h.page).callback();
  assert.equal(h.list.children.length, 1);
  h.events['na:canonical-updated']();
  h.context.ventas = [sale('receipt', '2026-10-12', [1], { source: 'CANONICAL_RECEIPT' })];
  h.events['na:canonical-sale-projection']();
  assert.equal(h.list.children[0].children[1].children[0].children[1].children[1].children[1].textContent, '12/10/2026');
  h.context.NA_ROLES.role = 'empleado'; h.events['na:role']();
  assert.equal(h.menu.children.length, 0);
  assert.equal(h.list.children.length, 0);
  assert.equal(h.intro.hidden, true);
  assert.equal(h.status.textContent, 'Sin permiso');
});

test('resuelve productoId local y product_id CANON sin confundir el ID de la línea', () => {
  const { api: a } = api();
  const catalog = [product(1, { product_id: 'CANON-A', barcode: '123' }), product(2, { barcode: '123' })];
  for (const item of [{ id: 1 }, { id: 2, productoId: '1' }, { id: 2, product_id: 'CANON-A' }]) {
    const rows = a.listPairs(catalog, [sale('synthetic', '2026-10-12', [], { items: [item] })]);
    assert.deepEqual(plain(rows[0].products.map(p => p.lastSaleDate)), ['2026-10-12', null]);
  }
  const rows = a.listPairs(catalog, [sale('unresolved', '2026-10-15', [], { items: [{ id: 2, product_id: 'unknown' }] })]);
  assert.deepEqual(plain(rows[0].products.map(p => p.lastSaleDate)), [null, null]);
});

test('pendientes, no confirmadas y revisión nunca sustituyen una última venta confirmada', () => {
  const { api: a } = api();
  const catalog = freeze([product(1, { barcode: '123' }), product(2, { barcode: '123' })]);
  for (const extra of [{ pending: true }, { confirmed: false }, { pendingSync: true },
    { status: 'PENDING_SYNC' }, { estado: ' pendiente ' }, { source: 'CANONICAL_OUTBOX' },
    { naReview: true }, { canonicalReview: true }, { status: 'ANULADA' }]) {
    const sales = freeze([sale('confirmed', '2026-10-10', [1]), sale('pending', '2026-10-15', [1, 2], extra)]);
    const before = JSON.stringify(sales);
    assert.deepEqual(plain(a.listPairs(catalog, sales)[0].products.map(p => p.lastSaleDate)), ['2026-10-10', null]);
    assert.equal(JSON.stringify(sales), before);
  }
  const receipt = sale('receipt', '2026-10-12', [2], { source: 'CANONICAL_RECEIPT', canonicalReceiptProjection: true });
  assert.equal(a.listPairs(catalog, [receipt])[0].products[1].lastSaleDate, '2026-10-12');
});

test('fecha con zona no normaliza días/horas inválidos; acepta created_at y años bisiestos', () => {
  const { api: a } = api();
  const catalog = [product(1, { barcode: '123' }), product(2, { barcode: '123' })];
  for (const timestamp of ['2026-02-30T10:00:00Z', '2026-02-29T00:00:00-05:00',
    '2026-10-12T24:00:00Z', '2026-10-12T10:60:00Z', '2026-13-01T00:00:00Z']) {
    assert.equal(a.listPairs(catalog, [sale('invalid', '', [1], { timestamp })])[0].products[0].lastSaleDate, null);
    assert.equal(a.listPairs(catalog, [sale('fallback', '2026-10-10', [1], { timestamp })])[0].products[0].lastSaleDate, '2026-10-10');
  }
  assert.equal(a.listPairs(catalog, [sale('leap', '', [1], { timestamp: '2024-02-29T04:30:00Z' })])[0].products[0].lastSaleDate, '2024-02-28');
  assert.equal(a.listPairs(catalog, [sale('created', '', [1], { created_at: '2026-10-14T04:30:00Z' })])[0].products[0].lastSaleDate, '2026-10-13');
});

test('apertura y refresco conservan un foco útil para teclado, incluso al desaparecer el par', () => {
  const h = domHarness();
  h.a.open();
  assert.equal(h.context.document.activeElement, h.heading);
  assert.equal(h.heading.attributes.tabindex, '-1');
  const oldButton = h.list.querySelector('[data-cd-product]');
  oldButton.focus();
  h.a.render();
  const replacement = h.context.document.activeElement;
  assert.notEqual(replacement, oldButton);
  assert.equal(replacement, h.list.querySelector('[data-cd-product]'));
  h.context.productos[1].activo = false;
  h.a.render();
  assert.equal(h.context.document.activeElement, h.refresh);
  h.back.events.click();
  assert.equal(h.context.document.activeElement, h.summary); // «Más opciones»: el botón está dentro de <details> cerrado
});

test('sigue el binding léxico de productos y ventas, igual que el runtime real', () => {
  const catalog = [product(1, { barcode: '123' }), product(2, { barcode: '123' })];
  const h = domHarness();
  const liveContext = vm.createContext(h.context);
  vm.runInContext(`let productos=${JSON.stringify(catalog)}; let ventas=${JSON.stringify([sale('synthetic', '2026-10-12', [1])])};`, liveContext);
  h.context.productos = []; h.context.ventas = [];
  vm.runInContext(source, liveContext);
  liveContext.NA_CODIGOS_DUPLICADOS.render();
  assert.equal(h.list.children.length, 1);
  assert.equal(h.list.children[0].children[1].children[0].children[1].children[1].children[1].textContent, '12/10/2026');
});

test('los códigos coinciden con el plan real de image-batch, con ceros y mayúsculas intactos', () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../../POS/js/products/image-batch.js', import.meta.url), 'utf8'), context);
  const { api: a } = api();
  const catalog = [product(1, { sku: ' 00012 ', barcode: 'AbC', codigosAlternativos: ['077'], codigoAlternativo: 'OLD' }),
    product(2, { sku: 'OLD', barcode: '077', codigosAlternativos: ['00012', 'AbC'] }),
    product(3, { sku: '12', barcode: 'abc' })];
  const pairs = a.listPairs(catalog);
  const entries = ['00012', 'AbC', '077', 'OLD', '12', 'abc'].map(code => ({ codes: [code], image: 'data:image/png;base64,iVBORw0KGgo=' }));
  const rows = context.NuevoAmanecerImageBatch.plan(entries, catalog, []);
  for (const row of rows) {
    assert.equal(row.status === 'ambiguous', pairs.some(pair => pair.code === row.entry.codes[0]));
  }
});

test('identidad CANON sin id local muestra datos pero no ofrece un botón inoperante', () => {
  const h = domHarness();
  delete h.context.productos[0].id;
  h.context.productos[0].product_id = 'CANON-ONLY';
  h.a.render();
  assert.equal(h.list.querySelectorAll('[data-cd-product]').length, 1);
  assert.equal(h.a.openProduct('CANON-ONLY'), false);
});

test('editProd real y su wrapper abren el formulario sin guardar y restauran la imagen', () => {
  // Ejecutar el cuerpo real y el wrapper F12; solo las utilidades DOM se
  // sustituyen. No sustituir editProd ni su restauración de la imagen.
  const read = file => readFileSync(new URL('../../POS/js/legacy-inline/' + file, import.meta.url), 'utf8');
  const base = read('inline-01.js').match(/^function editProd\(id\).*$/m)[0];
  const wrapper = read('inline-08.js').match(/^editProd=function\(id,\.\.\.args\).*$/m)[0];
  const h = domHarness();
  const fields = new Map();
  h.context.document.getElementById = id => {
    if (id === 'pageCodigosDuplicados') return h.page;
    if (!fields.has(id)) fields.set(id, h.context.document.createElement('div'));
    return fields.get(id);
  };
  Object.assign(h.context, { invEditId: null, imagenProducto: null, _naProductAltCodes: () => [],
    renderAltBarcodeFields() {}, toggleProductCodeFields() {}, renderCategorySelects() {},
    toggleNewCategoryField() {}, setProductInventoryControl() {}, calcMargen() {},
    _naEffectiveExpiry: p => p.venc, _naProductFormState() {}, _naF12SetMode() {},
    _naF12InferMode: () => 'image', _naF12RenderVisual() {} });
  const image = 'data:image/png;base64,synthetic';
  h.context.productos[0].imagen = image;
  const before = JSON.stringify({ products: h.context.productos, sales: h.context.ventas });
  const context = vm.createContext(h.context);
  vm.runInContext(base + '\nconst _naF12BaseEditProd=editProd;\n' + wrapper, context);
  assert.equal(h.a.openProduct(1), true);
  assert.equal(fields.get('pNombre').value, h.context.productos[0].name);
  assert.equal(fields.get('mProd').classList.contains('open'), true);
  assert.equal(h.context.imagenProducto, image);
  assert.equal(JSON.stringify({ products: h.context.productos, sales: h.context.ventas }), before);
  h.context.renderCategorySelects = () => { throw Error('synthetic DOM failure'); };
  assert.throws(() => h.a.openProduct(1), /synthetic DOM failure/);
  assert.equal(h.context.productos[0].imagen, image, 'finally también restaura si falla la apertura');
});
