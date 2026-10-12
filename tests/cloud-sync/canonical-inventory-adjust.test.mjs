import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';

const bridge=readFileSync('POS/js/sync/canonical-inventory-bridge.js','utf8');
const client=readFileSync('POS/js/sync/canonical-client.js','utf8');
const adapter=readFileSync('POS/js/adapters/canonical-ui-adapter.js','utf8');
const inline16=readFileSync('POS/js/legacy-inline/inline-16.js','utf8');
const index=readFileSync('POS/index.html','utf8');
const sw=readFileSync('POS/sw.js','utf8');
const migration=readFileSync('infra/database/migrations/0015_canonical_inventory_adjust.sql','utf8');
const scripts=[['canonical-inventory-bridge.js',bridge]];

async function inventoryTab(f,options={}){
  const {productId,type='entrada',token='device-a-token',localStorage,onFetch,locked=false}=options;
  const globals={
    invMovId:productId,
    invMovT:type,
    securityIsLocked(){return locked;},
    storage:{getItem(){return null;}},
    LOCK_KEYS:{master:'na_master_lock',readOnly:'na_readonly',modules:{productos:'na_lock_productos'}},
    invRender(){},posRender(){},updateDashboard(){}
  };
  const opts={token,localStorage,scripts,globals,onFetch};
  if(Object.prototype.hasOwnProperty.call(options,'deviceId'))opts.deviceId=options.deviceId;
  else if(!localStorage)opts.deviceId='device-a';
  return device(f,opts);
}

function trackedImport(f,min=0){
  return f.sql(`SELECT product_id,current_stock_quantity,stock_revision FROM products
    WHERE tracks_inventory=1 AND current_stock_quantity>=? ORDER BY product_id LIMIT 1`,min);
}

test('manual ENTRADA on imported product persists, survives F5 and is visible on a second device',async(t)=>{
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql']});
  const product=trackedImport(f,0);
  assert.ok(product?.product_id);

  const tab=await inventoryTab(f,{productId:product.product_id,type:'entrada'});
  tab.el('mMovCant').value='3';
  assert.equal(await tab.context.NuevoAmanecerCanonicalInventoryBridge.save(),true);

  const after=f.sql('SELECT current_stock_quantity,stock_revision FROM products WHERE product_id=?',product.product_id);
  assert.equal(after.current_stock_quantity,product.current_stock_quantity+3);
  assert.equal(after.stock_revision,product.stock_revision+1);

  const movement=f.sql('SELECT * FROM canonical_manual_inventory_movements WHERE product_id=?',product.product_id);
  assert.equal(movement.movement_type,'ENTRADA');
  assert.equal(movement.delta,3);
  assert.equal(movement.stock_before,product.current_stock_quantity);
  assert.equal(movement.stock_after,product.current_stock_quantity+3);
  assert.equal(movement.product_provenance,'IMPORT');

  const legacy=tab.api.legacySnapshot();
  const projected=legacy.inventoryMovements.find((m)=>m.operationId===movement.operation_id);
  assert.ok(projected);
  assert.equal(projected.type,'ENTRADA');
  assert.equal(projected.delta,3);
  assert.equal(projected.source,'INVENTORY_MOVE');

  const reloaded=await inventoryTab(f,{productId:product.product_id,type:'entrada',localStorage:tab.localStorage,deviceId:undefined});
  assert.equal(reloaded.api.snapshot().products.find((p)=>p.product_id===product.product_id).current_stock_quantity,product.current_stock_quantity+3);

  const second=await inventoryTab(f,{productId:product.product_id,type:'salida',token:'device-b-token',deviceId:'device-b'});
  assert.equal(second.api.snapshot().products.find((p)=>p.product_id===product.product_id).current_stock_quantity,product.current_stock_quantity+3);
});

test('manual SALIDA works for LIVE product and updates stock revision exactly once',async(t)=>{
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql']});
  const tab=await inventoryTab(f,{productId:'pending'});
  const created=await tab.api.createProduct({
    product_id:'LIVE-INV-1',name:'LIVE INVENTORY',sku:'LIVE-INV-SKU',barcode:'775001111111',
    alternate_codes:[],category:'abarrotes',brand:'Test',description:null,icon:'📦',image:null,
    unit:'unidad',purchase_unit:'unidad',purchase_factor:1,cost_cents:100,price_cents:200,
    box_price_cents:null,units_per_box:null,initial_stock_quantity:5,stock_min_quantity:1,
    expiry_date:null,includes_igv:true,tax_type:'gravado',complementary_tax:'',tracks_inventory:true
  });
  assert.equal(created.status,'created');
  await tab.api.refresh();

  tab.context.invMovId='LIVE-INV-1';
  tab.context.invMovT='salida';
  tab.el('mMovCant').value='2';
  assert.equal(await tab.context.NuevoAmanecerCanonicalInventoryBridge.save(),true);

  const row=f.sql("SELECT current_stock_quantity,stock_revision FROM canonical_live_products WHERE product_id='LIVE-INV-1'");
  assert.equal(row.current_stock_quantity,3);
  assert.equal(row.stock_revision,1);
  const movement=f.sql("SELECT * FROM canonical_manual_inventory_movements WHERE product_id='LIVE-INV-1'");
  assert.equal(movement.product_provenance,'LIVE');
  assert.equal(movement.movement_type,'SALIDA');
  assert.equal(movement.delta,-2);
});

test('stale stock revision is rejected and does not change stock',async(t)=>{
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql']});
  const product=trackedImport(f,0);
  assert.ok(product?.product_id);
  const a=await inventoryTab(f,{productId:product.product_id,token:'device-a-token',deviceId:'device-a'});
  const b=await inventoryTab(f,{productId:product.product_id,token:'device-b-token',deviceId:'device-b'});

  const first=await a.api.adjustInventory({product_id:product.product_id,movement_type:'ENTRADA',quantity:1,reason:'Concurrent A'});
  assert.equal(first.status,'created');

  await assert.rejects(
    b.api.adjustInventory({product_id:product.product_id,movement_type:'ENTRADA',quantity:1,reason:'Concurrent B'}),
    /CANONICAL_FINANCIAL_REJECTED_409/
  );
  assert.equal(b.api.pendingSnapshot().last_error,'stale_stock');
  assert.equal(await b.api.discardRejectedInventory(),true);
  assert.equal(b.api.pendingSnapshot(),null);

  const after=f.sql('SELECT current_stock_quantity,stock_revision FROM products WHERE product_id=?',product.product_id);
  assert.equal(after.current_stock_quantity,product.current_stock_quantity+1);
  assert.equal(after.stock_revision,product.stock_revision+1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_manual_inventory_movements WHERE product_id=?',product.product_id).n,1);
});

test('lost ACK retries same inventory operation without applying stock twice',async(t)=>{
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql']});
  const product=trackedImport(f,0);
  let drop=true;
  const tab=await inventoryTab(f,{
    productId:product.product_id,
    onFetch:async(url,_options,forward)=>{
      if(url.endsWith('/commands/inventory.adjust')&&drop){drop=false;await forward();throw new TypeError('lost ack after commit');}
      return null;
    }
  });
  tab.el('mMovCant').value='4';

  assert.equal(await tab.context.NuevoAmanecerCanonicalInventoryBridge.save(),false);
  const pending=tab.api.pendingSnapshot();
  assert.equal(pending.command,'inventory.adjust');
  const operation=pending.payload.operation_id;
  const once=f.sql('SELECT current_stock_quantity,stock_revision FROM products WHERE product_id=?',product.product_id);
  assert.equal(once.current_stock_quantity,product.current_stock_quantity+4);
  assert.equal(once.stock_revision,product.stock_revision+1);

  assert.equal(await tab.context.NuevoAmanecerCanonicalInventoryBridge.save(),true);
  const twice=f.sql('SELECT current_stock_quantity,stock_revision FROM products WHERE product_id=?',product.product_id);
  assert.deepEqual(twice,once);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_inventory_operations WHERE operation_id=?',operation).n,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_manual_inventory_movements WHERE operation_id=?',operation).n,1);
  assert.equal(tab.api.pendingSnapshot(),null);
  assert.equal(tab.api.receiptSnapshot().status,'already_processed');
});

test('P1-5: 503 transitorio queda PENDIENTE (no "rechazó") y el reintento aplica la MISMA operación una sola vez',async(t)=>{
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql']});
  const product=trackedImport(f,0);
  let fail=true;
  const tab=await inventoryTab(f,{
    productId:product.product_id,
    onFetch:async(url)=>{
      if(url.endsWith('/commands/inventory.adjust')&&fail){fail=false;
        return new Response(JSON.stringify({error:'service_unavailable'}),{status:503,headers:{'content-type':'application/json'}});}
      return null;
    }
  });
  tab.el('mMovCant').value='1';
  assert.equal(await tab.context.NuevoAmanecerCanonicalInventoryBridge.save(),false);
  const last=tab.toasts.at(-1)[0];
  assert.doesNotMatch(last,/rechaz|No se modificó/i);
  assert.match(last,/PENDIENTE/);assert.match(last,/MISMA operación/);
  const pending=tab.api.pendingSnapshot();
  assert.equal(pending.command,'inventory.adjust');
  const operation=pending.payload.operation_id;
  assert.equal(f.sql('SELECT current_stock_quantity q FROM products WHERE product_id=?',product.product_id).q,product.current_stock_quantity);
  assert.equal(await tab.context.NuevoAmanecerCanonicalInventoryBridge.save(),true);
  assert.equal(f.sql('SELECT current_stock_quantity q FROM products WHERE product_id=?',product.product_id).q,product.current_stock_quantity+1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_manual_inventory_movements WHERE operation_id=?',operation).n,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_manual_inventory_movements WHERE product_id=?',product.product_id).n,1);
  assert.equal(tab.api.pendingSnapshot(),null);
});

test('SALIDA above stock is rejected before D1 mutation',async(t)=>{
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql']});
  const product=trackedImport(f,0);
  const tab=await inventoryTab(f,{productId:product.product_id,type:'salida'});
  tab.el('mMovCant').value=String(Math.floor(product.current_stock_quantity)+100);
  assert.equal(await tab.context.NuevoAmanecerCanonicalInventoryBridge.save(),false);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_inventory_operations').n,0);
  const after=f.sql('SELECT current_stock_quantity,stock_revision FROM products WHERE product_id=?',product.product_id);
  assert.equal(after.current_stock_quantity,product.current_stock_quantity);
  assert.equal(after.stock_revision,product.stock_revision);
});

test('user security lock blocks inventory.adjust without falling into legacy persistence',async(t)=>{
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql']});
  const product=trackedImport(f,0);
  const tab=await inventoryTab(f,{productId:product.product_id,locked:true});
  tab.el('mMovCant').value='1';
  assert.equal(await tab.context.NuevoAmanecerCanonicalInventoryBridge.save(),false);
  assert.equal(tab.fetchLog.filter((x)=>x.url.endsWith('/commands/inventory.adjust')).length,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_inventory_operations').n,0);
});

test('inventory bridge/client/schema contain no legacy authority escape hatch',()=>{
  assert.match(client,/['"]inventory\.adjust['"]/);
  assert.match(client,/function adjustInventory\(input\)/);
  assert.match(client,/discardRejectedInventory/);
  assert.match(inline16,/NuevoAmanecerCanonicalInventoryBridge/);
  assert.match(inline16,/return await canonicalBridge\.save\(\)/);
  assert.match(index,/js\/sync\/canonical-inventory-bridge\.js/);
  assert.match(sw,/\.\/js\/sync\/canonical-inventory-bridge\.js/);
  assert.match(adapter,/movement_type/);
  assert.match(migration,/canonical_inventory_operations/);
  assert.match(migration,/canonical_manual_inventory_movements/);
  assert.match(migration,/DROP TRIGGER IF EXISTS products_no_update/);
  assert.match(migration,/DROP TRIGGER IF EXISTS canonical_live_products_guarded_update/);
  assert.doesNotMatch(bridge,/saveAllData\s*\(|applyInventoryMovement\s*\(|inventoryMovements\s*\.push|productos\s*\./);
});
