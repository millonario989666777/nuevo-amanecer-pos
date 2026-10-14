import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness(products = []) {
  const calls = { enqueued: [], confirmations: [], notices: [] };
  const context = vm.createContext({
    console: { error() {} }, Date, crypto,
    document: {
      readyState: 'loading', addEventListener() {},
      getElementById: () => null, querySelector: () => null,
    },
    addEventListener() {},
    confirm: message => { calls.confirmations.push(message); return false; },
    NuevoAmanecerCanonical: { enabled: () => true, snapshot: () => ({ sales: [], products }) },
    NuevoAmanecerCanonicalSaleOutbox: {
      enqueue: async intent => { calls.enqueued.push(intent); return intent; },
    },
    cart: [{ id: 'P', qty: 1, precio: 2 }],
    productos: [{ id: 'P', name: 'Producto', stock: 2 }], ventas: [], clientes: [],
    posPayM: 'efectivo', posProc: false,
    isModuleLocked: () => false,
    _naSessionOpen: () => true,
    _naPaymentState: () => ({ valid: true }),
    toast: message => calls.notices.push(message),
  });
  context.window = context;
  for (const path of [
    'inventory/stock-lots.js', 'inventory/stock-lots-ui.js',
    'sync/canonical-sale-intent.js', 'sync/canonical-sale-projection.js',
    'sync/canonical-sale-integration.js',
  ]) vm.runInContext(readFileSync('POS/js/' + path, 'utf8'), context, { filename: path });
  return { context, calls };
}

const product = { product_id: 'P', name: 'Producto', tracks_inventory: 1, current_stock_quantity: 2 };
const expiredProduct = { ...product, lots: [{
  lot_id: 'expired', lot_code: 'Vencido', expiry_date: '2000-01-01',
  received_at: '1999-12-01T13:00:00.000Z', quantity: 2,
}] };

async function assertCaptured(h) {
  const result = await h.context.confirmarVenta();
  assert.equal(result?.status, 'PENDING_SYNC');
  assert.equal(h.calls.enqueued.length, 1);
  assert.equal(h.context.cart.length, 0);
  assert.equal(h.calls.confirmations.length, 0);
  assert.equal(h.calls.enqueued[0].items[0].allow_expired_lots, undefined);
  assert.ok(h.calls.notices.every(message => !message.includes('No se pudo validar los lotes')));
}

test('canonical mock sin outbox.snapshot no bloquea una venta sin lotes', async () => {
  for (const products of [[], [product]]) {
    const h = harness(products);
    assert.equal(h.context.NuevoAmanecerCanonicalSaleOutbox.snapshot, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(h.context.NA_STOCK_LOTS_UI.currentProducts())), products);
    await assertCaptured(h);
  }
});

test('lotes conocidos sólo vencidos se bloquean por defecto antes del enqueue', async () => {
  const h = harness([expiredProduct]);
  await h.context.confirmarVenta();
  assert.equal(h.calls.confirmations.length, 0);
  assert.match(h.calls.notices[0], /Venta bloqueada/);
  assert.equal(h.calls.enqueued.length, 0);
  assert.equal(h.context.cart.length, 1);
  assert.match(h.calls.notices.at(-1), /Venta bloqueada/);
});

test('currentProducts cae al snapshot base si view/projector faltan o lanzan', async () => {
  for (const rebuild of [undefined, 'unavailable', () => { throw Error('VIEW_UNAVAILABLE'); }]) {
    for (const project of [undefined, 'unavailable', () => { throw Error('PROJECTION_UNAVAILABLE'); }]) {
      const h = harness([product]);
      h.context.NuevoAmanecerCanonicalSaleOutbox.snapshot = () => ({ intents: [] });
      h.context.NuevoAmanecerCanonicalSaleView = { rebuild };
      h.context.NuevoAmanecerCanonicalSaleProjection = { project };
      assert.equal(h.context.NA_STOCK_LOTS_UI.currentProducts()[0], product);
      await assertCaptured(h);
    }
  }
});

test('fallback de proyección conserva la confirmación de lotes vencidos conocidos', async () => {
  const h = harness([expiredProduct]);
  h.context.NuevoAmanecerCanonicalSaleView = { rebuild() { throw Error('VIEW_UNAVAILABLE'); } };
  await h.context.confirmarVenta();
  assert.equal(h.calls.confirmations.length, 0);
  assert.equal(h.calls.enqueued.length, 0);
  assert.equal(h.context.cart.length, 1);
});

test('errores ajenos a confirmación FEFO no bloquean venta ni prevalidación de salida', async () => {
  for (const candidate of [{ ...product, lots_json: 'invalid' }, { ...expiredProduct, current_stock_quantity: undefined }]) {
    const h = harness([candidate]);
    assert.equal(h.context.NA_STOCK_LOTS_UI.confirmConsumption(candidate, 1), false);
    await assertCaptured(h);
  }
  const h = harness([expiredProduct]);
  assert.equal(h.context.NA_STOCK_LOTS_UI.confirmConsumption(expiredProduct, 1), null);
  assert.equal(h.calls.confirmations.length, 0);
});

test('fallo inesperado de prevalidación no bloquea la captura canónica', async () => {
  for (const method of ['currentProducts', 'confirmConsumption']) {
    const h = harness([product]);
    h.context.NA_STOCK_LOTS_UI = {
      currentProducts: () => [product], confirmConsumption: () => false,
      [method]() { throw Error('UI_UNAVAILABLE'); },
    };
    await assertCaptured(h);
  }
});

test('SALIDA manual sólo cancela ante vencidos conocidos sin consentimiento; otros errores llegan al servidor',async()=>{
  for(const candidate of [product,expiredProduct,{...expiredProduct,current_stock_quantity:undefined}]){
    const h=harness([candidate]),adjustments=[];
    h.context.invMovId='P';h.context.invMovT='salida';
    h.context.document.getElementById=id=>id==='mMovCant'?{value:'1'}:null;
    h.context.NuevoAmanecerCanonical.refresh=async()=>{};
    h.context.NuevoAmanecerCanonical.adjustInventory=async input=>{adjustments.push(input);return{operation_id:'manual',movement_type:'SALIDA',stock_after:1};};
    vm.runInContext(readFileSync('POS/js/sync/canonical-inventory-bridge.js','utf8'),h.context);
    const result=await h.context.NuevoAmanecerCanonicalInventoryBridge.save();
    assert.equal(result,candidate!==expiredProduct);assert.equal(adjustments.length,candidate===expiredProduct?0:1);
    assert.equal(h.calls.confirmations.length,0);
  }
  const h=harness([product]),adjustments=[];
  h.context.invMovId='P';h.context.invMovT='salida';
  h.context.document.getElementById=id=>id==='mMovCant'?{value:'1'}:null;
  h.context.NuevoAmanecerCanonical.refresh=async()=>{};
  h.context.NuevoAmanecerCanonical.adjustInventory=async input=>{adjustments.push(input);return{movement_type:'SALIDA',stock_after:1};};
  h.context.NA_STOCK_LOTS_UI={confirmConsumption(){throw Error('UI_UNAVAILABLE');}};
  vm.runInContext(readFileSync('POS/js/sync/canonical-inventory-bridge.js','utf8'),h.context);
  assert.equal(await h.context.NuevoAmanecerCanonicalInventoryBridge.save(),true);assert.equal(adjustments.length,1);
});
