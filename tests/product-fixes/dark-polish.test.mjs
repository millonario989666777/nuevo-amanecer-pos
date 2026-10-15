import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('POS/css/dark-polish.css', 'utf8');
const index = readFileSync('POS/index.html', 'utf8');
const sw = readFileSync('POS/sw.js', 'utf8');
const theme = readFileSync('POS/css/theme-dark.css', 'utf8');
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), declarations: Object.fromEntries(
    body.split(';').filter(s => s.trim()).map(s => s.trim().split(/\s*:\s*/))
  ) }));

function declaration(selector, property) {
  const rule = rules.find(r => r.selector.split(',').map(s => s.trim()).includes(selector));
  assert.ok(rule, `Missing rule: ${selector}`);
  assert.ok(rule.declarations[property], `Missing ${property}: ${selector}`);
  return rule.declarations[property];
}

function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/i);
  const channels = hex.slice(1).match(/../g).map(c => {
    const value = parseInt(c, 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return channels.reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
}

export function contrast(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

test('dark polish is the final stylesheet and is precached', () => {
  const links = [...index.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)];
  assert.match(links.at(-1)[0], /href="css\/dark-polish.css"/);
  assert.match(sw, /'\.\/css\/dark-polish\.css'/);
});

test('all colors are dark scoped; only authorized typography/version exceptions exist', () => {
  assert.ok(rules.length >= 7);
  for (const rule of rules) {
    const selectors = rule.selector.split(',').map(s => s.trim());
    for (const [property, value] of Object.entries(rule.declarations)) {
      if (selectors.every(s => s.startsWith('body.dark '))) {
        assert.ok(['color', 'background-color', 'border-color'].includes(property), property);
      } else {
        assert.deepEqual(selectors, ['#naMobileDrawerVersion']);
        assert.ok(['white-space', 'overflow', 'text-overflow', 'font-size'].includes(property));
      }
    }
  }
  assert.doesNotMatch(css, /@media/, 'sin cambios de tipografía en Venta: la base clara debe quedar idéntica');
  assert.equal(declaration('#naMobileDrawerVersion', 'overflow'), 'visible');
  assert.equal(declaration('#naMobileDrawerVersion', 'text-overflow'), 'clip');
  assert.match(readFileSync('POS/js/navigation/menu-navigation.js', 'utf8'), /info\.hash\.slice\(0, 7\)/);
});

test('WCAG contrast helper matches reference black/white and identical colors', () => {
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.equal(contrast('#1e293b', '#1e293b'), 1);
});

test('changed text passes AA and pending dots pass non-text contrast', () => {
  const surface = theme.match(/--na-dk-surface:(#[\da-f]{6})/i)[1];
  const surface2 = theme.match(/--na-dk-surface-2:(#[\da-f]{6})/i)[1];
  for (const [selector, bg] of [
    ['body.dark #pageMenu #menuActivityTitle', surface],
    ['body.dark #pageMenu #menuPendingTitle', surface],
    ['body.dark #posPhoneCatalog #posPhoneCatalogTitle', surface2],
    ['body.dark #pagePOS .cart-head-clear', declaration('body.dark #pagePOS .cart-head-clear', 'background-color')],
  ]) {
    const ratio = contrast(declaration(selector, 'color'), bg);
    assert.ok(ratio >= 4.5, `${selector}: ${ratio.toFixed(2)}:1`);
    console.log(`${selector}: ${ratio.toFixed(2)}:1, AA PASS`);
  }
  for (const tone of ['amber', 'red', 'teal']) {
    const selector = `body.dark #pageMenu .menu-pending-mark.${tone}`;
    const ratio = contrast(declaration(selector, 'background-color'), surface);
    assert.ok(ratio >= 3, `${selector}: ${ratio.toFixed(2)}:1`);
    console.log(`${selector}: ${ratio.toFixed(2)}:1, non-text PASS`);
  }
});
