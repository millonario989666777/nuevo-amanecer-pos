import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const path='POS/js/modules/ticket/share-receipt.js';
function api(extra={}) {
  const ctx=vm.createContext({console,Blob,TextEncoder,Uint8Array,atob,...extra});
  if(existsSync(path))vm.runInContext(readFileSync(path,'utf8'),ctx);
  assert.ok(ctx.NAReceiptShare,'Receipt sharing module must exist');
  return ctx.NAReceiptShare;
}
test('normalizes Peru phone numbers and rejects invalid/ambiguous recipients',()=>{
  const a=api();
  assert.equal(a.normalizePhone('987 654 321'),'51987654321');
  assert.equal(a.normalizePhone('+51 987-654-321'),'51987654321');
  assert.equal(a.normalizePhone('+1 202 555 0100'),'12025550100');
  for(const bad of ['123','123456789','javascript:123456789','+51 123456789','']) assert.equal(a.normalizePhone(bad),'');
});
test('sale receipt preserves persisted ticket layout and historical product prices',()=>{
  let saved;
  const a=api({_naBuildThermalTicket(sale,fromDom){saved={sale,fromDom};return {text:'MI NEGOCIO\n2 Arroz S/ 14.00',lines:['MI NEGOCIO','2 Arroz S/ 14.00'],width:42,mm:80};}});
  const sale={id:'V-1',metodo:'efectivo',items:[{name:'Arroz',qty:2,precio:7}],recibido:20,vuelto:6};
  const receipt=a.build({kind:'sale',sale,customer:{nombre:'María',tel:'987654321'}});
  assert.equal(saved.fromDom,false);
  assert.equal(saved.sale.items[0].precio,7);
  assert.match(receipt.text,/MI NEGOCIO/);
  assert.equal(receipt.phone,'51987654321');
  assert.equal(sale.clienteNombre,undefined,'no mutation of financial records');
});
test('payment receipt identifies original products and confirmed payment balance, not current balance',()=>{
  const a=api({_naBuildThermalTicket(){return {text:'NEGOCIO\n2 Arroz S/ 14.00',lines:['NEGOCIO','2 Arroz S/ 14.00'],width:42,mm:80};}});
  const result=a.build({kind:'payment',credit:{id:'C-1',desc:'Compra',saldo:1,items:[{nombre:'Arroz',cantidad:2,precioUnitario:7}]},payment:{id:'P-1',monto:5,saldoAntes:20,saldoDespues:15,fecha:'2026-10-10',metodo:'efectivo'},customer:{nombre:'María'}});
  assert.match(result.text,/ABONO/);
  assert.match(result.text,/Saldo anterior.*20\.00/);
  assert.match(result.text,/Saldo pendiente.*15\.00/);
  assert.doesNotMatch(result.text,/Saldo pendiente.*1\.00/);
});
test('unknown historical balances and dates are not manufactured',()=>{
  const a=api({_naBuildThermalTicket(){return {text:'NEGOCIO',lines:['NEGOCIO'],width:42,mm:80};}});
  const result=a.build({kind:'payment',credit:{id:'C-1',saldo:123,desc:'Préstamo'},payment:{id:'P-1',monto:5,fecha:null}});
  assert.match(result.text,/no registrado/i);
  assert.doesNotMatch(result.text,/123\.00/);
});
test('WhatsApp text URL encodes receipt safely and rejects invalid phone',()=>{
  const a=api();
  const url=a.textUrl('987654321','Arroz & azúcar\nS/ 7.00');
  assert.equal(new URL(url).searchParams.get('text'),'Arroz & azúcar\nS/ 7.00');
  assert.equal(new URL(url).pathname,'/51987654321');
  assert.throws(()=>a.textUrl('123','x'));
});
test('settings persist through reload and reject invalid format',()=>{
  const config={ticket:{}};
  const a=api({appConfig:config});
  assert.equal(a.settings().format,'image');
  a.setSettings({format:'pdf',ask:false});
  assert.equal(config.ticket.shareFormat,'pdf');
  const b=api({appConfig:JSON.parse(JSON.stringify(config))});
  assert.equal(b.settings().format,'pdf');
  assert.equal(b.settings().ask,false);
  assert.throws(()=>b.setSettings({format:'exe',ask:true}));
});
test('PDF serializer embeds JPEG bytes with correct offsets and multiple pages',async()=>{
  const a=api();
  const blob=a.pdf([{bytes:new Uint8Array([255,216,255,217]),width:100,height:200},{bytes:new Uint8Array([255,216,255,217]),width:100,height:150}]);
  assert.equal(blob.type,'application/pdf');
  const bytes=new Uint8Array(await blob.arrayBuffer());
  const str=Buffer.from(bytes).toString('latin1');
  assert.match(str,/\/Count 2/);
  assert.match(str,/\/Filter \/DCTDecode/);
  const xref=Number(/startxref\n(\d+)/.exec(str)[1]);
  assert.equal(str.slice(xref,xref+4),'xref');
  const offsets=[...str.matchAll(/(\d{10}) 00000 n/g)].map(x=>Number(x[1]));
  offsets.forEach((offset,i)=>assert.equal(str.slice(offset,offset+String(i+1).length+6),`${i+1} 0 obj`));
});

function realTicketApi(){
  const ctx=vm.createContext({console,Blob,TextEncoder,Uint8Array,atob,navigator:{},document:{addEventListener(){}},_naDefaults:{ticket:{}},appConfig:{ticket:{}},_naGetBusiness:()=>({nombre:'Negocio',cajero:'Cajero actual'}),totalV:s=>(s.items||[]).reduce((sum,i)=>sum+i.qty*i.precio,0),desglosarIGV:total=>({subtotal:total,igv:0,total}),obtenerHoy:()=> '2099-12-31',nowT:()=> '23:59',_naHydrateTicket(){},_naSaveTicketSettings(){}});
  ctx.window=ctx;
  vm.runInContext(readFileSync('POS/js/core/utils.js','utf8'),ctx);
  for(const p of ['POS/js/modules/ticket/legacy.js','POS/js/modules/ticket/zones.js',path])vm.runInContext(readFileSync(p,'utf8'),ctx);
  return ctx.NAReceiptShare;
}
test('real thermal generator preserves unknown historical metadata instead of using current date or cashier',()=>{
  const a=realTicketApi();
  const result=a.build({kind:'payment',credit:{id:'C-OLD',monto:30,saldo:20},payment:{id:'P-OLD',monto:10}});
  assert.doesNotMatch(result.text,/2099|23:59|Cajero actual/);
  assert.match(result.text,/Fecha: No registrada/);
  assert.match(result.text,/Hora: No registrada/);
  const dated=a.build({kind:'sale',sale:{id:'V-DATED',fecha:'2026-10-10',hora:'10:30',cajero:'Frank',items:[]}});
  assert.match(dated.text,/10\/10\/2026/);
  assert.match(dated.text,/Frank/);
});
test('repayment receipt identifier distinguishes separate payments for the same sale',()=>{
  const a=realTicketApi(),sale={id:'V-1',items:[]};
  const one=a.build({kind:'payment',sale,payment:{id:'P-1',monto:5}});
  const two=a.build({kind:'payment',sale,payment:{id:'P-2',monto:5}});
  assert.equal(one.id,'P-1');assert.equal(two.id,'P-2');
});
