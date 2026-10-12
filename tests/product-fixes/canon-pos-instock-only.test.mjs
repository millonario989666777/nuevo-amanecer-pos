import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('POS/js/legacy-inline/inline-14.js', 'utf8');
const task = JSON.parse(readFileSync('tasks/CANON-POS-INSTOCK-ONLY-001.json', 'utf8'));

function extractVisiblePredicate() {
  const start = source.indexOf('function _naSecProductVisibleInPos');
  const end = source.indexOf('\nfunction _naSecProductCard', start);
  assert.ok(start >= 0, 'CANON stock visibility predicate must exist');
  assert.ok(end > start, 'CANON stock visibility predicate must be bounded');
  return source.slice(start, end);
}

test('CANON POS shows positive controlled stock and hides zero/negative controlled stock', () => {
  const sandbox = {
    _naTracksStock(product) {
      return product.tracksStock !== false;
    },
    _naNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    }
  };

  vm.runInNewContext(extractVisiblePredicate(), sandbox);

  assert.equal(sandbox._naSecProductVisibleInPos({ stock: 5, tracksStock: true }), true);
  assert.equal(sandbox._naSecProductVisibleInPos({ stock: 0, tracksStock: true }), false);
  assert.equal(sandbox._naSecProductVisibleInPos({ stock: -2, tracksStock: true }), false);
  assert.equal(sandbox._naSecProductVisibleInPos({ stock: 0, tracksStock: false }), true);
});

test('CANON posRender filters visibility without mutating inventory state', () => {
  assert.match(source, /rows=productos\.filter\(product=>_naSecProductVisibleInPos\(product\)&&/);
  assert.doesNotMatch(source, /productos\s*=\s*productos\.filter\(_naSecProductVisibleInPos\)/);
  assert.doesNotMatch(source, /product\.stock\s*[-+*/]?=(?!=)/, 'no assignment to product.stock (comparisons like === are fine)');
});

test('promotion contract is CANON-scoped and rollbackable', () => {
  assert.equal(task.environment, 'CANON');
  assert.ok(task.allowed_files.includes('POS/js/legacy-inline/inline-14.js'));
  assert.ok(task.forbidden_files.includes('laboratorio/**'));
  assert.match(task.rollback, /Revertir el PR/);
});
