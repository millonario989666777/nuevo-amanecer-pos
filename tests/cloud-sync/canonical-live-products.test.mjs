import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';

const bridge = readFileSync('POS/js/sync/canonical-product-bridge.js','utf8');
const client = readFileSync('POS/js/sync/canonical-client.js','utf8');
const inline02 = readFileSync('POS/js/legacy-inline/inline-02.js','utf8');
const inline07 = readFileSync('POS/js/legacy-inline/inline-07.js','utf8');
const index = readFileSync('POS/index.html','utf8');
const sw = readFileSync('POS/sw.js','utf8');
const migration = readFileSync('infra/database/migrations/0014_canonical_live_products.sql','utf8');
const scripts = [['canonical-product-bridge.js', bridge]];

function fillProduct(tab, overrides={}) {
  const values={
    pNombre:'Producto LIVE E2E',
    pDescripcion:'Producto creado por prueba',
    pSku:'LIVE-E2E-001',
    pBarcode:'775000000001',
    pMarca:'Prueba',
    pCosto:'2.50',
    pPrecio:'5.00',
    pVenc:'',
    pPrecioCaja:'',
    pUnidCaja:'',
    pFactorCompra:'1',
    pCat:'abarrotes',
    pIcon:'📦',
    pUnidad:'unidad',
    pUnidadCompra:'unidad',
    pTipoImpuesto:'gravado',
    pImpuestoComplementario:'',
    pStock:'8',
    pStockMin:'2',
    ...overrides,
  };
  for (const [id,value] of Object.entries(values)) tab.el(id).value=value;
  tab.el('pControlInventario').checked=true;
  tab.el('pIncluyeIGV').checked=true;
}

async function productTab(f, options={}) {
  const deviceOptions={
    token: options.token || 'device-a-token',
    localStorage: options.localStorage,
    scripts,
    globals:{
      invEditId:null,
      imagenProducto:null,
      appConfig:{margenActive:true},
      readAltBarcodes(){return options.altCodes || ['ALT-LIVE-001'];},
      ...(options.globals || {}),
    },
    onFetch:options.onFetch,
  };
  if (Object.prototype.hasOwnProperty.call(options,'deviceId')) deviceOptions.deviceId=options.deviceId;
  else if (!options.localStorage) deviceOptions.deviceId='device-a';
  return device(f,deviceOptions);
}

test('product.create persists in D1, survives F5, is visible to another device and is sellable', async (t) => {
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql']});
  const tab=await productTab(f);
  fillProduct(tab);

  assert.equal(await tab.context.NuevoAmanecerCanonicalProductBridge.save(),true);

  const row=f.sql("SELECT * FROM canonical_live_products WHERE sku='LIVE-E2E-001'");
  assert.equal(row.name,'Producto LIVE E2E');
  assert.equal(row.price_cents,500);
  assert.equal(row.cost_cents,250);
  assert.equal(row.opening_stock_quantity,8);
  assert.equal(row.current_stock_quantity,8);
  assert.equal(row.stock_revision,0);
  assert.equal(row.tracks_inventory,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_product_operations').n,1);
  assert.deepEqual(tab.context.__closed,['mProd']);

  const created=tab.api.snapshot().products.find((p)=>p.product_id===row.product_id);
  assert.ok(created);
  assert.equal(created.provenance,'LIVE');
  assert.equal(created.current_stock_quantity,8);

  const reloaded=await productTab(f,{localStorage:tab.localStorage});
  assert.ok(reloaded.api.snapshot().products.some((p)=>p.product_id===row.product_id));

  const other=await productTab(f,{token:'device-b-token',deviceId:'device-b'});
  const seen=other.api.snapshot().products.find((p)=>p.product_id===row.product_id);
  assert.ok(seen);
  assert.equal(seen.stock_revision,0);

  const receipt=await other.api.createSale({
    items:[{product_id:row.product_id,quantity:2}],
    payment_method:'transferencia',
    reference:'LIVE-PRODUCT-SALE-1',
  });
  assert.equal(receipt.status,'created');
  await other.api.refresh();

  const after=f.sql('SELECT current_stock_quantity,stock_revision FROM canonical_live_products WHERE product_id=?',row.product_id);
  assert.equal(after.current_stock_quantity,6);
  assert.equal(after.stock_revision,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_inventory_effects WHERE product_id=?',row.product_id).n,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM inventory_movements WHERE product_id=?',row.product_id).n,1);
  assert.equal(other.api.snapshot().products.find((p)=>p.product_id===row.product_id).current_stock_quantity,6);
});

test('product.create rejects duplicate catalog codes across IMPORT and LIVE and remains atomic', async (t) => {
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql']});
  const imported=f.sql("SELECT sku,barcode FROM products WHERE (sku IS NOT NULL AND trim(sku)<>'') OR (barcode IS NOT NULL AND trim(barcode)<>'') LIMIT 1");
  const tab=await productTab(f,{altCodes:[]});
  fillProduct(tab,{pSku:imported.sku || 'UNUSED-LIVE',pBarcode:imported.sku ? '775000000099' : imported.barcode});

  assert.equal(await tab.context.NuevoAmanecerCanonicalProductBridge.save(),false);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_products').n,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_product_operations').n,0);
  assert.ok(tab.toasts.some(([m])=>/rechazó|product_code_conflict|No se registró|ya pertenece a «/.test(m)));

  assert.equal(tab.api.pendingSnapshot(),null,'a definitive 409 must not poison the next product create');
  fillProduct(tab,{pSku:'LIVE-UNIQUE-1',pBarcode:'775000000098'});
  assert.equal(await tab.context.NuevoAmanecerCanonicalProductBridge.save(),true);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_products').n,1);

  const third=await productTab(f,{token:'device-c-token',deviceId:'device-c',altCodes:[]});
  fillProduct(third,{pSku:'live-unique-1',pBarcode:'775000000097'});
  assert.equal(await third.context.NuevoAmanecerCanonicalProductBridge.save(),false);
  assert.equal(third.api.pendingSnapshot(),null);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_products').n,1);
});

test('lost ACK retries the same product operation and never creates a duplicate', async (t) => {
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql']});
  let drop=true;
  const tab=await productTab(f,{
    async onFetch(url,options,forward){
      if(url.endsWith('/commands/product.create')&&drop){drop=false;await forward();throw new TypeError('lost ack after commit');}
      return null;
    }
  });
  fillProduct(tab,{pSku:'LIVE-ACK-1',pBarcode:'775000000096'});

  assert.equal(await tab.context.NuevoAmanecerCanonicalProductBridge.save(),false);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_products').n,1);
  const pending=tab.api.pendingSnapshot();
  assert.equal(pending.command,'product.create');
  const operation=pending.payload.operation_id;

  fillProduct(tab,{pNombre:'DO NOT CREATE SECOND',pSku:'OTHER-SKU',pBarcode:'775000000095'});
  assert.equal(await tab.context.NuevoAmanecerCanonicalProductBridge.save(),true);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_products').n,1);
  assert.equal(f.sql('SELECT operation_id FROM canonical_product_operations').operation_id,operation);
  assert.equal(tab.api.pendingSnapshot(),null);
  assert.equal(tab.api.receiptSnapshot().status,'already_processed');
});

test('committed product with refresh failure is reported CONFIRMED and must not be retried as a new product', async (t) => {
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql']});
  let failReads=false;
  const tab=await productTab(f,{
    async onFetch(url){
      if(url.endsWith('/commands/product.create')){failReads=true;return null;}
      if(failReads&&url.includes('/read/canonical/')) return new Response(JSON.stringify({error:'boom'}),{status:503});
      return null;
    }
  });
  fillProduct(tab,{pSku:'LIVE-REFRESH-1',pBarcode:'775000000094'});
  assert.equal(await tab.context.NuevoAmanecerCanonicalProductBridge.save(),true);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_products').n,1);
  assert.ok(tab.toasts.some(([m])=>/CONFIRMADO/.test(m)&&/NO vuelvas a guardarlo/.test(m)));
  assert.equal(tab.toasts.some(([m])=>/No se registró el producto/.test(m)),false);
});

test('double tap emits exactly one product.create request', async (t) => {
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql']});
  const tab=await productTab(f);
  fillProduct(tab,{pSku:'LIVE-TAP-1',pBarcode:'775000000093'});
  const api=tab.context.NuevoAmanecerCanonicalProductBridge;
  const [first,second]=await Promise.all([api.save(),api.save()]);
  assert.deepEqual([first,second],[true,false]);
  assert.equal(tab.fetchLog.filter((x)=>x.url.endsWith('/commands/product.create')).length,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_products').n,1);
});

test('bridge is create-only in CANON and never falls back to legacy persistence', async (t) => {
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql']});
  const tab=await productTab(f,{globals:{invEditId:'existing-product'}});
  fillProduct(tab);
  assert.equal(await tab.context.NuevoAmanecerCanonicalProductBridge.save(),false);
  assert.equal(tab.fetchLog.filter((x)=>x.url.endsWith('/commands/product.create')).length,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_products').n,0);
  assert.doesNotMatch(bridge,/saveAllData\s*\(|productos\s*\.push|inventoryMovements\s*\.push/);
});

test('shell/winner/client/migration expose only the canonical product-create path',()=>{
  assert.match(client,/['"]product\.create['"]/);
  assert.match(client,/function createProduct\(input\)/);
  assert.match(client,/createProduct:\s*createProduct/);
  assert.match(inline02,/abrirModalProd=function\(\)\{if\(isModuleLocked\('productos',\{canonicalProductUi:true\}\)\)/);
  assert.match(inline07,/NuevoAmanecerCanonicalProductBridge/);
  assert.match(inline07,/bridge\.save\(\)/);
  assert.match(inline07,/_naF10BaseGuardarProd\.apply\(this,args\)/);
  assert.match(index,/js\/sync\/canonical-product-bridge\.js/);
  assert.match(sw,/\.\/js\/sync\/canonical-product-bridge\.js/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS canonical_live_products/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS canonical_product_operations/);
  assert.match(migration,/canonical_live_inventory_effects/);
  assert.doesNotMatch(migration,/DROP TRIGGER IF EXISTS products_candidate_insert/);
});
