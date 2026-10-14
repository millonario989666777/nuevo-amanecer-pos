import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('POS/js/legacy-inline/inline-06.js','utf8');
function context(products,sales){
 const ctx={_naEffectiveExpiry:p=>p.venc||null,productos:products,ventas:sales,appConfig:{},document:{addEventListener(){},getElementById(){return null;}},invBadges(){},invRender(){},_naNormalizeData(){},_naInt:(v,d)=>Number.isFinite(Number(v))?Math.trunc(Number(v)):d,_naNumber:(v,d=0)=>Number.isFinite(Number(v))?Number(v):d,_naClean:v=>String(v??'').trim(),_naTracksStock:()=>true,_naUnitsSold:i=>Number(i.cantidad||0),obtenerHoy:()=> '2026-10-10',diasHasta:()=>null};
 ctx.window=ctx;ctx.renderCategorySelects=()=>{};ctx.invTab='todos';ctx.invRender=()=>ctx.renderHook?.();
 vm.createContext(ctx);vm.runInContext(source,ctx);return ctx;
}
const product=(id,sku)=>({id,sku,name:sku,stock:1,stockMin:3,costo:1,precio:2});
test('batch analysis preserves the independent original sales calculation',()=>{
 const products=[product(1,'a'),product(2,'b'),product(3,'a'),product(0,'z')];
 const sales=[{fecha:'2026-10-01',items:[{id:1,cantidad:2},{sku:'a',cantidad:3},{id:1,cantidad:1},{id:0,sku:'z',cantidad:4}]},{fecha:'2026-10-09',items:[{productoId:2,cantidad:1}]},{fecha:'2026-10-09',anulada:true,items:[{id:1,cantidad:100}]},{fecha:'2025-01-01',items:[{id:1,cantidad:100}]},{fecha:'2026-10-11',items:[{id:1,cantidad:100}]},{fecha:'bad',items:[]}];
 const ctx=context(products,sales),expected=products.map(p=>ctx._naF9ProductSales(p,90));
 const before=JSON.stringify({products,sales});
 const actual=ctx._naF9All().map(a=>a.sales);
 assert.deepEqual(JSON.parse(JSON.stringify(actual)),JSON.parse(JSON.stringify(expected)));
 assert.equal(JSON.stringify({products,sales}),before);
});
test('408 products traverse each sale date once per complete analysis',()=>{
 const products=Array.from({length:408},(_,i)=>product(i+1,'sku'+i));
 const sales=Array.from({length:1000},(_,i)=>({fecha:'2026-10-09',items:[{id:i%408+1,cantidad:1}]}));
 const ctx=context(products,sales);let reads=0;const original=ctx._naF9SaleDate;ctx._naF9SaleDate=s=>{reads++;return original(s);};
 ctx._naF9All();assert.equal(reads,sales.length,'history must not be rescanned for each product');
});
test('a subsequent analysis sees in-place sales, cancellations, stock and configuration edits',()=>{
 const products=[product(1,'a')],sales=[{fecha:'2026-10-09',items:[{id:1,cantidad:1}]}],ctx=context(products,sales);
 assert.equal(ctx._naF9All()[0].sales.units,1);sales[0].items[0].cantidad=7;products[0].stock=12;
 let a=ctx._naF9All()[0];assert.equal(a.sales.units,7);assert.equal(a.stock,12);
 sales[0].anulada=true;assert.equal(ctx._naF9All()[0].sales.units,0);
});
test('badges and content share one calculation, then refresh after a failed render',()=>{
 const sales=[{fecha:'2026-10-09',items:[{id:1,cantidad:1}]}],ctx=context([product(1,'a')],sales);let reads=0;
 const original=ctx._naF9SaleDate;ctx._naF9SaleDate=s=>{reads++;return original(s);};
 ctx.renderHook=()=>{for(let i=0;i<3;i++)assert.equal(ctx._naF9All()[0].sales.units,1);};
 ctx.invRender();assert.equal(reads,1);
 ctx.renderHook=()=>{ctx._naF9All();throw Error('render error');};assert.throws(()=>ctx.invRender());
 sales[0].items[0].cantidad=9;ctx.renderHook=()=>assert.equal(ctx._naF9All()[0].sales.units,9);
 ctx.invRender();assert.equal(reads,3);
});
