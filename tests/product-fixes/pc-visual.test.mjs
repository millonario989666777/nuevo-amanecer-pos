import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const ctx = vm.createContext({ window: {} });
vm.runInContext(readFileSync('POS/js/core/utils.js','utf8'),ctx);
const run = code => vm.runInContext(code,ctx);
test('document placeholders are hidden in display and export/search values', () => {
  for (const v of ['SIN-DOC-x','sin-doc123',' SIN-DOC ']) {
    assert.equal(ctx.window.NA_DOC.isPlaceholderDoc(v),true);
    assert.equal(ctx.window.NA_DOC.displayDoc(v),'Sin DNI');
    assert.equal(run(`_naDocumentValue(${JSON.stringify(v)})`),'');
  }
  for (const v of ['',null,undefined]) assert.equal(ctx.window.NA_DOC.displayDoc(v),'Sin DNI');
  assert.equal(ctx.window.NA_DOC.displayDoc('12345678'),'12345678');
  assert.equal(ctx.window.NA_DOC.isPlaceholderDoc('12345678'),false);
});
test('Inicio sums outstanding active credits only without mutating records', () => {
  const fixtures=[{monto:100,pagado:30},{monto:100,pagado:100},{monto:100,pagado:0,anulado:true},{monto:100,pagado:0,status:'anulado'},{monto:100,pagado:0,estado:'voided'},{monto:100,pagado:0,status:'paid'},{monto:0,pagado:0},{monto:20,pagado:30},{monto:100,pagado:0,saldo:0}];
  ctx.records=fixtures;
  assert.equal(run('_naInicioCredits(records).debt'),70);
  assert.equal(run('_naInicioCredits(records).active.length'),1);
  assert.equal(JSON.stringify(fixtures),JSON.stringify(ctx.records));
});
test('critical stock requires a positive minimum and tracked physical stock', () => {
  const fixtures=[{stock:1,stockMin:2},{stock:2,stockMin:2},{stock:3,stockMin:2},{stock:0},{stock:0,stockMin:null},{stock:0,stockMin:0},{stock:0,stockMin:2,trackStock:false},{stock:0,stockMin:2,controlInventario:false},{stock:0,stockMin:2,unidad:'service'},{stock:0,stockMin:2,tipo:'servicio'}];
  ctx.products=fixtures;
  assert.equal(run('products.filter(_naCriticalStock).length'),2);
});
test('Inicio money and opening time use grouping and Lima HH:MM', () => {
  assert.equal(run('_naInicioMoney(22270.15)'),'S/ 22,270.15');
  assert.equal(run('_naInicioMoney(0)'),'S/ 0.00');
  assert.equal(run(`_naInicioCashText({cajeroNombre:'Ana',timestampApertura:'2026-10-15T14:05:00Z'})`),'Abierta · Ana · 09:05');
  assert.equal(run(`_naInicioCashText({hora:'2:05:00 p. m.'})`),'Abierta · 14:05');
  assert.equal(run('_naInicioCashText({})'),'Abierta');
});
test('client headings have no stroke or horizontal scaling', () => {
  for(const file of ['POS/css/client-credit-accounts-v2.css','POS/css/experience-v2/pages/clientes.css']){
    const css=readFileSync(file,'utf8');
    assert.doesNotMatch(css, /text-stroke|scaleX/);
    assert.match(css,/font-family:inherit/);assert.match(css,/font-weight:800/);assert.match(css,/letter-spacing:-\.01em/);
  }
});
