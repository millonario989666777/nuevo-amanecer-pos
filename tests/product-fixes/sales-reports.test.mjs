import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
function context(){
 const c=vm.createContext({console,productos:[{id:1,cat:'farmacia',costo:3}],ventas:[],clientes:[],creditos:[],gastos:[],cajMovs:[],ventasRender(){},document:{addEventListener(){},getElementById(){return null;}},_naNumber:(n,d=0)=>Number.isFinite(Number(n))?Number(n):d,_naClean:n=>String(n??'').trim(),_naEsc:n=>String(n??''),_naUnitsSold:i=>i.unidadesFisicas??i.qty??i.cantidad??0,_naCategoryLabel:c=>c==='farmacia'?'Farmacia':c,totalV:v=>v.total,fmt:n=>`S/ ${n}`, _naIsSaleIncomeMove:()=>false,_naIsSaleReversalMove:()=>false});
 c.window=c;vm.runInContext(readFileSync('POS/js/core/lima-time.js','utf8'),c);vm.runInContext(readFileSync('POS/js/legacy-inline/inline-05.js','utf8'),c);return c;
}
test('categories, cashier identities, physical units, missing costs and all CSV sections',()=>{
 const c=context();c.ventas=[{id:'a',fecha:'2026-10-15',total:20,cajeroId:'a',cajeroNombre:'Ana; "A"',metodo:'yape',items:[{id:1,name:'Medicina',precio:10,qty:2,costo:3}]},{id:'b',fecha:'2026-10-15',total:7,items:[{id:2,name:'Libre',precio:7,qty:1}]},{id:'void',fecha:'2026-10-15',anulada:true,total:100,items:[]}];
 const r=c._naF8BuildReport({from:'2026-10-15',to:'2026-10-15'});
 assert.equal(r.categories[0].name,'Farmacia');assert.equal(r.categories[0].revenue,20);assert.equal(r.categories[0].units,2);assert.equal(r.categories[0].margin,70);assert.equal(r.categories[1].margin,null);assert.equal(r.cashiers[1].name,'Sin cajero');assert.equal(r.metrics.gross,null);
 const csv=c._naF8Csv(r);for(const section of ['Resumen','Categorias','Cajeros','Formas_pago','Productos','Clientes','Dias','Meses'])assert.ok(csv.includes(section));assert.ok(csv.includes('"Ana; ""A"""'));assert.equal(r.sales.length,2);
});
test('Lima instant boundaries, unzoned timestamps and periods independent of device zone',()=>{
 const c=context();assert.equal(c._naF8Day('2026-10-16T04:59:59Z'),'2026-10-15');assert.equal(c._naF8Day('2026-10-16T05:00:00Z'),'2026-10-16');assert.equal(c._naF8Day('2026-10-15T23:00:00'),'2026-10-15');assert.equal(c._naF8DateInRange('2026-10-16T04:00:00Z',{from:'2026-10-15',to:'2026-10-15'}),true);
 c.NALimaTime={today:()=> '2026-03-01'};
 for(const [period,from,to] of [['today','2026-03-01','2026-03-01'],['week','2026-02-23','2026-03-01'],['month','2026-03-01','2026-03-31'],['previousMonth','2026-02-01','2026-02-28']]){const r=c._naF8RangeFromPeriod(period);assert.equal(r.from,from);assert.equal(r.to,to);}
});
test('top products shows ten ordered by revenue rather than profit',()=>{
 const c=context();const rows=c._naF8ProductRows([{id:'a',items:Array.from({length:12},(_,i)=>({id:i+10,name:'Product '+i,precio:i+1,qty:1,costo:i===11?11.9:0.1}))}]);assert.equal(rows[0].revenue,12);const html=c._naF8RankHtml('Top productos',rows,'product');assert.equal((html.match(/report-rank-row/g)||[]).length,10);assert.ok(html.includes('Top 10 por importe'));
});

test('custom range reverses inputs and daily/monthly missing costs remain unknown',()=>{
 const c=context(),els={salesReportPeriod:{value:'custom'},salesReportFrom:{value:'2026-10-16'},salesReportTo:{value:'2026-10-15'}};
 c.document.getElementById=id=>els[id];const range=c._naF8CurrentRange();assert.equal(range.from,'2026-10-15');assert.equal(range.to,'2026-10-16');
 const daily=c._naF8DailyRows([{id:'missing',timestamp:'2026-10-16T04:00:00Z',total:7,items:[{id:99,name:'No cost',qty:1,precio:7}]}],[]);
 assert.equal(daily[0].date,'2026-10-15');assert.equal(daily[0].gross,null);assert.equal(c._naF8MonthlyRows(daily)[0].gross,null);assert.equal(c._naF8MonthlyRows(daily)[0].net,null);
});
