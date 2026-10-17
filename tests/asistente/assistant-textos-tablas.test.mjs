// Textos más simples (Bot 2) y la burbuja que no tapa la última fila de las tablas en tableta/PC (Bot 4 sobre 78dbc841).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { NO_STOCK_TEXT } from '../../tools/cloudflare-lab/src/pos-assistant.js';
import { runAssistantQuery } from '../../tools/cloudflare-lab/src/pos-assistant-queries.js';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const UI = read('POS/js/modules/asistente/asistente-ui.js'), CORE = read('POS/js/modules/asistente/asistente-core.js');
const SRV = read('tools/cloudflare-lab/src/pos-assistant.js'), Q = read('tools/cloudflare-lab/src/pos-assistant-queries.js');

test('Bot 2: sin «fila(s)», «producto(s)» ni parecidos en ningún texto del asistente', () => {
  for (const [name, src] of [['ui', UI], ['core', CORE], ['servidor', SRV], ['consultas', Q]]) {
    const hits = src.match(/[a-záéíóúñ]{3,}\((?:s|es)\)(?=[\s'.,:)])/g) || []; // palabras en textos; las funciones f(s) se excluyen abajo
    assert.deepEqual(hits.filter((h) => !/^(norm|esc|test|url|string|tring)\(s\)$/i.test(h)), [], name);
  }
});

test('Bot 2: singular y plural bien escritos en las consultas', async () => {
  const P = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, nombre: 'Prod ' + i, controla: true, stock: 0, min: 2, precio: 1, costo: 0, ...extra }));
  const one = await runAssistantQuery({ products: async () => P(1) }, { tipo: 'bajo_stock' });
  const two = await runAssistantQuery({ products: async () => P(2) }, { tipo: 'bajo_stock' });
  assert.match(one.texto, /^Hay 1 producto en o bajo el mínimo\./); assert.match(two.texto, /^Hay 2 productos en o bajo el mínimo\./);
  const s1 = await runAssistantQuery({ products: async () => P(1) }, { tipo: 'sin_costo' }), s2 = await runAssistantQuery({ products: async () => P(3) }, { tipo: 'sin_costo' });
  assert.match(s1.texto, /^1 producto no tiene costo\./); assert.match(s2.texto, /^3 productos no tienen costo\./);
});

test('Bot 2: aviso de compra grande en una sola frase corta; sin control de stock en palabras simples', () => {
  const t = NO_STOCK_TEXT('Recarga');
  assert.equal(t, '«Recarga» no lleva control de stock, así que no preparo compras ni ajustes de ese producto.');
  assert.ok(!/inventario|controla/.test(t));
  const om = SRV.slice(SRV.indexOf('const overLimitMessage'), SRV.indexOf('// Productos que NO controlan'));
  for (const s of om.match(/'[^']*'/g)) assert.ok(s.length <= 70, 'trozo corto: ' + s);
  assert.ok(!/Fuera del límite/.test(om));
  assert.match(UI, /'1 fila pasa el límite: corrígela en la factura o quítala\.'/);
  assert.match(UI, /' filas pasan el límite: corrígelas en la factura o quítalas\.'/);
  assert.match(CORE, /'Ese producto no lleva control de stock\.'/);
});

test('Bot 2: lista de precios sin la etiqueta «Cliente:»', () => {
  assert.match(UI, /\(p\.cliente && CUSTOMER_DOCS\.indexOf\(p\.tipo\) >= 0 \? ' · Cliente: ' \+ p\.cliente : ''\)/); assert.match(UI, /var CUSTOMER_DOCS = \['estado_cuenta'\];/);
});

test('Bot 4: la burbuja también mira la última celda visible de las tablas (TOTAL de Valorización, «—» de Ventas/stock) y toma la más baja', () => {
  const lc = UI.slice(UI.indexOf('  function lastCell(pg, br) {'), UI.indexOf('  // Lo más bajo entre'));
  assert.match(lc, /pg\.querySelectorAll\('table'\)/); assert.match(lc, /k < LAST_N/, 'solo las últimas tablas');
  assert.match(lc, /seen < 2/, 'solo las 2 últimas filas visibles de cada tabla');
  assert.match(lc, /x0 = br\.left - 8, x1 = br\.right \+ 8/, 'en la franja horizontal de la burbuja');
  assert.match(lc, /pinned\(cell, pg\)/, 'sin celdas fijas'); assert.match(lc, /visibility === 'hidden'/);
  assert.match(UI, /function lastRow\(pg, br\) \{ var a = lastTappable\(pg, br\), b = lastCell\(pg, br\); return !a \? b : !b \? a : \(b\.r\.bottom > a\.r\.bottom \? b : a\); \}/);
  const pp = UI.slice(UI.indexOf('  function padPage(bottom) {'), UI.indexOf('  function padPage(bottom) {') + 900);
  assert.match(pp, /var last = lastRow\(pg, br\);/);
});

test('Bot 4: la etiqueta de demostración dice solo «Modo demostración»', () => {
  assert.match(UI, /m\.textContent = 'Modo demostración';/); assert.ok(!/sin clave de DeepSeek/.test(UI));
});
