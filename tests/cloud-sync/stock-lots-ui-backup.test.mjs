import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPosSandbox, json } from '../release-invariants/lib/sandbox.mjs';

const engine=readFileSync('POS/js/inventory/stock-lots.js','utf8');
const receipt={lot_id:'lot-1',lot_code:'Arroz A',expiry_date:'2026-11-01',quantity:2,received_at:'2026-10-14T13:00:00.000Z'};
test('backup completo/restore conserva lotes; backup antiguo no inventa lotes; suma inválida se rechaza',async()=>{
  const pos=createPosSandbox();pos.seed();pos.run(engine);
  pos.seedData('productos',[{id:'P',name:'Arroz',stock:3,precio:1,costo:1,lots:[receipt]}]);
  const backup=await pos.run('_naCreateCompleteBackup()');pos.run('globalThis.__backup='+JSON.stringify(backup));
  const restored=pos.run('_naPrepareBackupSnapshot(__backup.payload)');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.snapshot.data.productos[0].lots)),[receipt]);
  pos.run('__backup.payload.data.productos[0].lots[0].quantity=4');
  assert.throws(()=>pos.run('_naPrepareBackupSnapshot(__backup.payload)'),/LOT_STOCK_INCOHERENT/);
  pos.run('delete __backup.payload.data.productos[0].lots');
  assert.equal(pos.run('_naPrepareBackupSnapshot(__backup.payload).snapshot.data.productos[0].lots'),undefined);
});
test('proyección offline reserva lotes en orden para dos ventas, sin doble reserva de ACK confirmado',()=>{
  const ctx=vm.createContext({Date,console});vm.runInContext(engine,ctx);vm.runInContext(readFileSync('POS/js/sync/canonical-sale-projection.js','utf8'),ctx);
  const base={products:[{product_id:'P',current_stock_quantity:3,tracks_inventory:1,lots:[receipt]}],customers:[],credits:[],sales:[]};
  const intent=id=>({version:1,operation_id:id,sale_id:id,created_at:'2026-10-14T14:00:00.000Z',payment_method:'efectivo',total_cents:100,payment:{cash_cents:100,digital_cents:0,credit_cents:0},items:[{product_id:'P',quantity:1,unit_price_cents:100,line_total_cents:100}]});
  let projected=ctx.NuevoAmanecerCanonicalSaleProjection.project(base,{version:1,intents:[intent('a'),intent('b')]});
  assert.equal(projected.products[0].lots[0].quantity,0);assert.equal(projected.products[0].projected_stock,1);assert.equal(base.products[0].lots[0].quantity,2);
  base.sales=[{operation_id:'a'}];projected=ctx.NuevoAmanecerCanonicalSaleProjection.project(base,{version:1,intents:[intent('a'),intent('b')]});
  assert.equal(projected.products[0].lots[0].quantity,1);
});
test('assets de lotes precacheados; UI usa DOM/textContent, PIN compartido y controles de 44px',()=>{
  const index=readFileSync('POS/index.html','utf8'),sw=readFileSync('POS/sw.js','utf8');
  for(const asset of ['js/inventory/stock-lots.js','js/inventory/stock-lots-ui.js','css/stock-lots.css']){assert.ok(index.includes(asset),asset);assert.ok(sw.includes(asset),asset);}
  const ui=readFileSync('POS/js/inventory/stock-lots-ui.js','utf8'),css=readFileSync('POS/css/stock-lots.css','utf8');
  assert.doesNotMatch(ui,/innerHTML|insertAdjacentHTML/);assert.match(css,/min-height:\s*44px/);assert.doesNotMatch(ui,/Productos a vencer|openReport|expiredModal/);assert.match(ui,/remote\.approve\('expired_lot_sale'/);assert.match(ui,/NA_ROLES\.askPin/);
});
