import test from 'node:test';
import assert from 'node:assert/strict';
import { productImagesRoute } from '../../tools/cloudflare-lab/src/pos-product-images.js';

// DB falsa mínima: registra cada DELETE para probar que la limpieza de huérfanos es conservadora.
function fakeDb({ list = {}, lookup = {}, listError = null }) {
  const deletes = [];
  const metas = ['ghost-1', 'ghost-2'].map(p => ({ value_json: JSON.stringify({ p, c: ['c-' + p], e: 'e'.repeat(16), n: 1, u: 'now' }) }));
  const db = {
    deletes,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async all() {
          if (/LIKE 'internal:img:m:%'/.test(sql)) return { results: metas };
          const table = /FROM (\w+)$/.exec(sql)?.[1];
          if (listError?.[table]) throw new Error(listError[table]);
          if (!(table in list)) throw new Error('no such table: ' + table);
          return { results: list[table].map(product_id => ({ product_id })) };
        },
        async first() {
          const m = /FROM (products|canonical_live_products) WHERE product_id/.exec(sql);
          if (m) { if (!(m[1] in lookup)) throw new Error('no such table: ' + m[1]); return lookup[m[1]].includes(args[0]) ? { product_id: args[0] } : null; }
          if (/SELECT key FROM pos_settings/.test(sql)) return { key: args[0] };
          return null;
        },
        async run() { if (/^DELETE/.test(sql)) deletes.push(args[0]); return {}; },
      };
      return stmt;
    },
  };
  return db;
}
const json = (body, status = 200) => ({ status, body });
// POST con cuerpo vacío: dispara la limpieza y luego se rechaza (unexpected_field) sin borrar nada propio.
const del = db => productImagesRoute(new Request('http://x/auth/product-images', { method: 'POST', body: '{}' }), new URL('http://x/auth/product-images'), {}, { posRole: 'owner', principalId: 'o' }, json, db);
const imageDeletes = db => db.deletes.filter(k => /^internal:img:m:/.test(String(k)));

test('catálogo vacío (ambas lecturas sin filas): no se borra ninguna foto', async () => {
  const db = fakeDb({ list: { products: [], canonical_live_products: [] }, lookup: { products: [], canonical_live_products: [] } });
  await del(db);
  assert.deepEqual(imageDeletes(db), [], 'ninguna foto borrada con catálogo vacío');
});
test('ambas tablas ausentes: no se borra ninguna foto', async () => {
  const db = fakeDb({});
  await del(db);
  assert.deepEqual(imageDeletes(db), []);
});
test('una lectura del catálogo falla: limpieza omitida aunque la otra devuelva filas', async () => {
  const db = fakeDb({ list: { products: ['p1'] }, lookup: { products: ['p1'], canonical_live_products: [] } });
  await del(db);
  assert.deepEqual(imageDeletes(db), [], 'no such table en canonical_live_products omite la limpieza');
  const db2 = fakeDb({ list: { products: ['p1'], canonical_live_products: [] }, listError: { canonical_live_products: 'D1_ERROR: network' }, lookup: { products: ['p1'], canonical_live_products: [] } });
  await assert.rejects(del(db2));
  assert.deepEqual(imageDeletes(db2), []);
});
test('solo se borra la foto cuyo product_id la consulta individual confirma inexistente', async () => {
  // La lista no incluye ghost-1, pero la consulta individual sí lo encuentra: no se borra.
  const db = fakeDb({ list: { products: ['p1'], canonical_live_products: [] }, lookup: { products: ['p1', 'ghost-1'], canonical_live_products: [] } });
  await del(db);
  const deleted = imageDeletes(db);
  assert.equal(deleted.length, 1, 'solo ghost-2 se borra');
});
