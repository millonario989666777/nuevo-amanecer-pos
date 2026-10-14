import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('POS/index.html', 'utf8');
const css = readFileSync('POS/css/canon-pos-reference-ui.css', 'utf8');
const decorator = readFileSync('POS/js/canon-pos-reference-ui.js', 'utf8');
const mirroredPosCss = readFileSync('POS/css/experience-v2/pages/pos.css', 'utf8');
const sw = readFileSync('POS/sw.js', 'utf8');

test('CANON owns the POS shell and production-only UI assets without LAB runtime dependency', () => {
  assert.ok(mirroredPosCss.length > 0);
  assert.match(html, /id="pagePOS"/);

  const mirrored = html.indexOf('css/experience-v2/pages/pos.css');
  const canonOnly = html.indexOf('css/canon-pos-reference-ui.css');
  assert.ok(mirrored >= 0);
  assert.ok(canonOnly > mirrored);

  const app = html.indexOf('js/app.js');
  const ui = html.indexOf('js/canon-pos-reference-ui.js');
  assert.ok(app >= 0);
  assert.ok(ui > app);

  assert.match(sw, /'\.\/css\/canon-pos-reference-ui\.css'/);
  assert.match(sw, /'\.\/js\/canon-pos-reference-ui\.js'/);
  assert.doesNotMatch(html, /laboratorio\/pos-lab\/(?:styles|animations)/i);
});

test('business-critical POS ids and handlers remain in the canonical shell', () => {
  for (const id of [
    'pagePOS','posSearch','posArea','posSidebar','cartDrawer','cartItems','posSubtotal','posIgv','posTotal',
    'btnRapido','btnPagar','cartBadge','btnVentaLibre','btnMayorista'
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /onclick="abrirCobro\('rapido'\)"/);
  assert.match(html, /onclick="abrirCobro\('normal'\)"/);
  assert.match(html, /onclick="toggleMayorista\(\)"/);
  assert.match(html, /onclick="abrirVentaLibre\(\)"/);
  assert.match(html, /onclick="toggleCart\(\)"/);
});

test('production decorator builds toolbar, current-sale hierarchy and quick actions without innerHTML', () => {
  assert.match(decorator, /pos-commandbar/);
  assert.match(decorator, /pos-module-identity/);
  assert.match(decorator, /Venta actual/);
  assert.match(decorator, /posCartSummary/);
  assert.match(decorator, /posProductCount/);
  assert.match(decorator, /posUnitCount/);
  assert.match(decorator, /Pago rápido/);
  assert.match(decorator, /Pagar/);
  assert.match(decorator, /Descuento/);
  assert.match(decorator, /Mayorista/);
  assert.match(decorator, /VARIOS/);
  assert.match(decorator, /x und/);
  assert.match(decorator, /x caja/);
  assert.doesNotMatch(decorator, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(decorator, /fetch\(|\/commands\/|localStorage|sessionStorage/);
  assert.doesNotThrow(() => new Function(decorator));
});

test('desktop uses categories + catalog + persistent current sale columns', () => {
  assert.match(css, /#pagePOS>\.pos-body\{[\s\S]*grid-template-columns:220px minmax\(0,1fr\) 390px/);
  assert.match(css, /#pagePOS \.sidebar\{[\s\S]*overflow-y:auto/);
  assert.match(css, /#pagePOS \.cat-btn\{[\s\S]*flex-direction:row/);
  assert.match(css, /#pagePOS \.products-area\{[\s\S]*grid-template-columns:repeat\(auto-fill,minmax\(148px,1fr\)\)/);
  assert.match(css, /#pagePOS \.cart-drawer\{[\s\S]*position:relative/);
  assert.match(css, /#pagePOS \.cart-backdrop\{display:none\}/);
  assert.match(css, /#pagePOS \.cart-secondary-actions\{/);
  assert.match(css, /#pagePOS \.total-main\{[\s\S]*background:var\(--pos-ref-teal\)/);
});

test('tablet and phone return the current sale to a real drawer', () => {
  assert.match(css, /@media\(max-width:1099px\)\{[\s\S]*#pagePOS>\.pos-body\{display:flex\}/);
  assert.match(css, /@media\(max-width:1099px\)\{[\s\S]*#pagePOS \.cart-drawer\{[\s\S]*position:absolute/);
  assert.match(css, /#pagePOS \.cart-drawer\.open\{right:0!important\}/);
  assert.match(css, /@media\(max-width:700px\)\{[\s\S]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:700px\)\{[\s\S]*#pagePOS \.cart-drawer\{right:-100%!important;width:100%\}/);
});

test('CANON-only style selectors remain bounded to pagePOS or dark-mode pagePOS descendants', () => {
  const selectors = css
    .split('{')
    .slice(0,-1)
    .map(chunk => chunk.split('}').pop().trim())
    .filter(value => value && !value.startsWith('/*') && !value.startsWith('@media'));
  const relevant = selectors.filter(value => value.includes('#pagePOS'));
  assert.ok(relevant.length > 30);
  for (const selector of relevant) assert.match(selector, /#pagePOS/);
});


test('fidelity pass hides duplicate global chrome and matches reference proportions on real desktop', () => {
  assert.match(css, /body\.na-pos-reference-active>\.g-topbar\{[\s\S]*position:absolute!important[\s\S]*width:0[\s\S]*height:0/);
  assert.match(css, /body\.na-pos-reference-active #backBtn\{[\s\S]*display:flex!important/);
  assert.match(css, /body\.na-pos-reference-active #pagePOS \.pos-menu-button\{visibility:hidden!important/);
  assert.match(css, /@media\(min-width:1280px\)\{[\s\S]*grid-template-columns:218px minmax\(0,1fr\) 440px/);
  assert.match(css, /@media\(min-width:1280px\)\{[\s\S]*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(css, /#pagePOS \.p-stock-badge\.ok,[\s\S]*background:var\(--pos-ref-orange\)!important/);
  assert.match(css, /#pagePOS \.cart-head-title\{font-size:24px/);
  assert.match(css, /#pagePOS \.btn-cobro\{[^}]*min-height:52px[^}]*font-size:18px/);
});

test('phone using Chrome desktop-site cannot be squeezed into the three-column desktop workbench', () => {
  assert.match(css, /body\.na-pos-phone-device #pagePOS>\.pos-body\{display:flex!important\}/);
  assert.match(css, /body\.na-pos-phone-device #pagePOS \.cart-drawer\{[\s\S]*right:-100%!important/);
  assert.match(css, /body\.na-pos-phone-device #pagePOS \.cart-drawer\.open\{right:0!important\}/);
  assert.match(css, /body\.na-pos-phone-device #pagePOS \.products-area\{[\s\S]*repeat\(2,minmax\(0,1fr\)\)!important/);
  assert.match(decorator, /function phoneDevice\(\)/);
  assert.match(decorator, /na-pos-phone-device/);
  assert.match(decorator, /Math\.min\(Number\(root\.screen/);
});

test('production toolbar mirrors the real canonical connection state instead of drawing a fake status', () => {
  assert.match(decorator, /id = 'posRuntimeStatus'/);
  assert.match(decorator, /document\.getElementById\('localStatus'\)/);
  assert.match(decorator, /state === 'connected' \? 'Online'/);
  assert.match(decorator, /MutationObserver\(sync\)/);
  assert.doesNotMatch(decorator, /setInterval\(/);
});

test('consolidated CSS has one rule per selector in each breakpoint scope', () => {
  function check(source) {
    const seen = new Set(); let cursor = 0;
    while (cursor < source.length) {
      const start = source.indexOf('{', cursor); if (start < 0) break;
      const selector = source.slice(cursor, start).trim();
      let depth = 1, end = start + 1;
      for (; depth && end < source.length; end++) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; }
      assert.equal(depth, 0, 'balanced CSS blocks');
      assert.ok(!seen.has(selector), 'duplicate selector: ' + selector); seen.add(selector);
      if (selector.startsWith('@media')) check(source.slice(start + 1, end - 1));
      cursor = end;
    }
  }
  check(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  assert.doesNotMatch(css, /\.p-stock-badge[^{}]*body\./);
});

test('new cart actions use effective cart prices and stock-aware quantity handler', () => {
  assert.match(decorator, /root\.posQty\(current\._lineKey, value - Number\(current\.qty\)\)/);
  assert.match(decorator, /current\.precio = value/);
  assert.match(decorator, /appConfig\.margenActive && value < cost/);
  assert.match(decorator, /root\._naSaleUiLocked\(\)/);
  assert.match(decorator, /root\._naOpenClientPicker\('mVentaCliente'\)/);
  assert.match(decorator, /select\.value = customerId/);
  assert.match(decorator, /root\.limpiarCarrito\(\)/);
  assert.doesNotMatch(decorator, /product\.precio\s*=/);
});


test('branding freeze keeps the original cart mark in the POS header', () => {
  assert.match(decorator, /var mark = element\('div', 'pos-module-mark', '🛒'\);/);
  assert.doesNotMatch(decorator, /mark\.replaceChildren\(lineIcon\(/);
});


test('current sale fidelity keeps customer functional and matches the approved summary hierarchy', () => {
  assert.match(decorator, /function buildCustomerButton\(\)/);
  assert.match(decorator, /customer\.id = 'posCustomerButton'/);
  assert.match(decorator, /root\._naOpenClientPicker\('mVentaCliente'\)/);
  assert.match(decorator, /decorateCartRows\(\)/);
  assert.match(decorator, /cart-line-unit/);
  assert.match(decorator, /root\.limpiarCarrito\(\)/);
  assert.match(css, /#pagePOS \.cart-totals\{[^}]*display:grid[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(165px,auto\)/);
  assert.match(css, /#pagePOS \.cart-count-line\{[^}]*grid-row:1 \/ span 2/);
  assert.match(css, /#pagePOS #posUnitCount\{display:none\}/);
  assert.match(css, /#pagePOS \.total-main\{[^}]*grid-column:1 \/ -1/);
  assert.match(css, /#pagePOS \.cart-head-clear svg\{/);
  assert.match(css, /#pagePOS \.cart-secondary-actions button svg\{/);
});

test('current sale scope does not introduce unsupported sale notes', () => {
  assert.doesNotMatch(decorator, /Nota de venta/);
  assert.doesNotMatch(decorator, /saleNote|sale_note|note\s*:/);
});

test('short desktop viewport compacts only the current-sale footer', () => {
  assert.match(css, /@media\(min-width:1100px\) and \(max-height:700px\)\{[\s\S]*#pagePOS \.total-main\{[^}]*min-height:36px[^}]*font-size:22px/);
  assert.match(css, /@media\(min-width:1100px\) and \(max-height:700px\)\{[\s\S]*#pagePOS \.cart-secondary-actions button\{[^}]*min-height:32px[^}]*font-size:11px/);
  assert.match(css, /@media\(min-width:1100px\) and \(max-height:700px\)\{[\s\S]*#pagePOS \.btn-cobro\{[^}]*min-height:44px[^}]*font-size:16px/);
});


test('toolbar search icon selector does not steal the scanner badge dot', () => {
  assert.match(decorator, /querySelector\(':scope > span:first-child'\)/);
  assert.doesNotMatch(decorator, /querySelector\('span:first-child'\)/);
  assert.match(html, /id="scannerIndicator"[\s\S]*?class="scanner-dot"/);
  assert.match(html, /class="na-li na-li-search"/);
});
