import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function ticket(width='80mm'){
  const state={
    console,Intl,Blob,TextEncoder,Uint8Array,atob,
    navigator:{},document:{addEventListener(){}},
    _naDefaults:{ticket:{}},appConfig:{ticket:{ancho:width,zoneOrder:'h,i,p,t,y,f'}},
    _naGetBusiness:()=>({nombre:'Tienda de prueba',cajero:'Cajero'}),
    totalV:s=>(s.items||[]).reduce((v,i)=>v+Number(i.qty)*Number(i.precio),0),
    desglosarIGV:total=>({subtotal:total,igv:0,total}),
    obtenerHoy:()=> '2026-01-01',nowT:()=> '10:30',
    _naHydrateTicket(){},_naSaveTicketSettings(){},
    clientes:[{id:'CLIENT-1',nombre:'Cliente de prueba',lineaCreditoManualActiva:true,lineaCreditoManual:100}],
    creditos:[{id:'C-1',cliId:'CLIENT-1',ventaId:'V-1',monto:15,saldo:10}]
  };
  const ctx=vm.createContext(state);
  for(const file of ['legacy.js','zones.js','share-receipt.js']){
    vm.runInContext(fs.readFileSync('POS/js/modules/ticket/'+file,'utf8'),ctx,{filename:file});
  }
  return ctx;
}

test('six saved zones migrate to eight without changing saved preferences',()=>{
  const ctx=ticket();
  assert.equal(ctx._naF11State().order.join(','),'h,i,p,t,y,c,a,f');
  assert.equal(ctx.appConfig.ticket.zoneOrder,'h,i,p,t,y,f');
  assert.equal(ctx._naF11State().settings.c.enabled,true);
  assert.equal(ctx._naF11State().settings.a.enabled,true);
});

test('receipt editor keeps the eight zones aligned, removes VARIOS, and never exposes synchronization state',()=>{
  for(const width of ['40mm','58mm','80mm']){
    const ctx=ticket(width);
    const sale={id:'V-2',fecha:'2026-01-01',hora:'10:30',cajero:'Cajero',clienteId:'CLIENT-1',clienteNombre:'Cliente de prueba',
      metodo:'credito',status:'PENDING_SYNC',items:[{name:'Pan',qty:1,precio:3,ventaLibre:true},{name:'Queso',qty:1,precio:5,ventaLibre:true}]};
    const before=JSON.stringify(sale);
    const receipt=ctx.NAReceiptShare.build({kind:'sale',sale,customer:ctx.clientes[0],fresh:true,pendingSync:true,due:'2026-02-01'});
    const printed=ctx._naBuildThermalTicket(sale,false);
    for(const value of [receipt,printed]){
      assert.equal((value.text.match(/ESTADO DE CUENTA DEL CLIENTE/g)||[]).length,1);
      assert.equal((value.text.match(/DETALLE DEL CREDITO/g)||[]).length,1);
      assert.doesNotMatch(value.text,/Pan VARIOS|Queso VARIOS|guardado local|pendiente de sincronizar/i);
      assert.ok(value.lines.every(line=>line.length<=value.width));
      assert.ok(value.text.indexOf('DETALLE DEL CREDITO')<value.text.indexOf('ESTADO DE CUENTA DEL CLIENTE'));
    }
    assert.equal(JSON.stringify(sale),before);
  }
});
