import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Date, console });
const path = 'POS/js/inventory/stock-lots.js';
if (existsSync(path)) vm.runInContext(readFileSync(path, 'utf8'), ctx);
const core = () => { assert.ok(ctx.NA_STOCK_LOTS, 'motor de lotes disponible'); return ctx.NA_STOCK_LOTS; };
const plain = x => JSON.parse(JSON.stringify(x));
const lot = (id, date, quantity, received = '2026-10-01T12:00:00Z') => ({ lot_id:id, lot_code:id, expiry_date:date, quantity, received_at:received });

test('FEFO ordena vencimiento, luego ingreso y finalmente id; no muta la fuente', () => {
  const rows=[lot('z','2026-11-01',3),lot('b','2026-10-20',2),lot('a','2026-10-20',1),lot('early','2026-10-20',1,'2026-09-01T12:00:00Z')];
  const before=plain(rows);
  assert.deepEqual(plain(core().plan(7, rows, 5, '2026-10-14').allocations), [{lot_id:'early',quantity:1},{lot_id:'a',quantity:1},{lot_id:'b',quantity:2},{lot_id:'z',quantity:1}]);
  assert.deepEqual(rows,before);
});
test('vigentes antes del remanente sin lote; productos antiguos conservan su stock', () => {
  assert.deepEqual(plain(core().plan(5,[lot('ok','2026-12-01',1)],3,'2026-10-14').allocations),[{lot_id:'ok',quantity:1},{lot_id:'',quantity:2}]);
  assert.deepEqual(plain(core().plan(5,[],3,'2026-10-14').allocations),[{lot_id:'',quantity:3}]);
});
test('vencidos bloqueados incluso con stock mixto insuficiente; confirmación permite completar al final', () => {
  const rows=[lot('old','2026-10-13',3),lot('today','2026-10-14',1)];
  assert.throws(()=>core().plan(5,rows,3,'2026-10-14'),/EXPIRED_LOTS_CONFIRMATION_REQUIRED/);
  assert.deepEqual(plain(core().plan(5,rows,3,'2026-10-14',true).allocations),[{lot_id:'today',quantity:1},{lot_id:'',quantity:1},{lot_id:'old',quantity:1}]);
  assert.throws(()=>core().plan(3,[lot('old','2026-10-13',3)],1,'2026-10-14'),/EXPIRED_LOTS_CONFIRMATION_REQUIRED/);
});
test('cantidades físicas decimales y validación estricta de ingresos/fechas/suma', () => {
  assert.deepEqual(plain(core().plan(0.3,[lot('a','2026-11-01',0.1)],0.3,'2026-10-14').allocations),[{lot_id:'a',quantity:0.1},{lot_id:'',quantity:0.2}]);
  assert.throws(()=>core().plan(1,[lot('bad','2026-02-30',1)],1,'2026-10-14'),/INVALID_LOT/);
  assert.throws(()=>core().plan(1,[lot('a','2026-11-01',2)],1,'2026-10-14'),/LOT_STOCK_INCOHERENT/);
  assert.throws(()=>core().normalizeReceipts([{lot_code:'a',expiry_date:'2026-11-01',quantity:3}],2),/INVALID_LOT_QUANTITY/);
});
test('reporte acumulativo 30/60/90, vencidos y frontera inclusiva; excluye saldo cero', () => {
  const p=[{product_id:'p',name:'Producto',current_stock_quantity:5,lots:[lot('old','2026-10-13',1),lot('30','2026-11-13',1),lot('60','2026-12-13',1),lot('90','2027-01-12',1),lot('91','2027-01-13',1),lot('zero','2026-10-20',0)]}];
  assert.deepEqual([30,60,90,'expired'].map(n=>core().report(p,n,'2026-10-14').length),[1,2,3,1]);
  assert.equal(core().businessDate('2026-10-15T02:00:00Z'),'2026-10-14');
});
test('empate compara instantes de ingreso aunque tengan offsets/formato distinto',()=>{
  const rows=[lot('a','2026-11-01',1,'2026-10-14T11:00:00Z'),lot('z','2026-11-01',1,'2026-10-14T07:00:00-05:00')];
  assert.equal(core().plan(2,rows,1,'2026-10-14').allocations[0].lot_id,'a');
});

test('ingreso rechaza códigos repetidos tras trim en el mismo producto',()=>{
  assert.throws(()=>core().normalizeReceipts([{lot_code:'A',expiry_date:'2026-11-01',quantity:1},{lot_code:' A ',expiry_date:'2026-12-01',quantity:1}],2),/DUPLICATE_LOT_CODE/);
});
test('cliente rechaza vencimiento pasado y códigos existentes, incluso con saldo cero',()=>{
  const p={lots:[lot('A','2026-11-01',0)]};
  assert.throws(()=>core().validateReceiptEntry(p,[{lot_code:'B',expiry_date:'2026-10-13',quantity:1}],1,'2026-10-14'),/EXPIRED_LOT_RECEIPT/);
  assert.throws(()=>core().validateReceiptEntry(p,[{lot_code:' A ',expiry_date:'2026-11-01',quantity:1}],1,'2026-10-14'),/DUPLICATE_LOT_CODE/);
  assert.equal(core().validateReceiptEntry(p,[{lot_code:'B',expiry_date:'2026-10-14',quantity:1}],1,'2026-10-14').length,1);
});
