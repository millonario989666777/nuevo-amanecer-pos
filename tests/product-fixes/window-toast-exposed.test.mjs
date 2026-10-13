import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('toast global: the legacy const toast is also window.toast (modules call root.toast)', () => {
  const line = read('POS/js/legacy-inline/inline-01.js').split('\n').find((l) => l.startsWith('const toast=(msg'));
  assert.ok(line, 'toast definition present');
  const el = { textContent: '', className: '', classList: { add() {}, remove() {} } };
  const window = {};
  const ctx = { window, document: { getElementById: () => el }, setTimeout: () => 0, clearTimeout() {} };
  vm.runInNewContext(line, ctx);
  assert.equal(typeof window.toast, 'function');
  window.toast('Configuración es solo para el dueño.', 'error');
  assert.equal(el.textContent, 'Configuración es solo para el dueño.');
  for (const f of ['pos-roles-client.js', 'config-g.js', 'config-v9.js', 'pos-annul-client.js', 'pos-purchases-client.js', 'pos-reviews-client.js']) {
    assert.match(read(`POS/js/config/${f}`), /root\.toast\(/, `${f} uses root.toast`);
  }
});

test('empty or hidden toast never shows as an empty pill', () => {
  const css = read('POS/css/na-line-icons.css');
  assert.match(css, /\.toast:not\(\.show\)\{visibility:hidden\}/);
  assert.match(css, /\.toast:empty\{display:none!important\}/);
  assert.match(read('POS/index.html'), /href="css\/na-line-icons\.css"/);
  assert.match(read('POS/sw.js'), /'\.\/css\/na-line-icons\.css'/);
  assert.match(read('POS/sw.js'), /'\.\/js\/ui\/na-line-icons\.js'/);
});
