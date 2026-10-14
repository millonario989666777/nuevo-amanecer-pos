import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Small DOM harness: exercise the shared PIN handlers and rendered text without a browser dependency.
function harness({allow=false, pinSet=false, localPin=false, verify=async()=>({approval_id:'ok'}), products=[]}={}) {
  const doc={readyState:'loading',events:{},addEventListener(k,f){this.events[k]=f;},activeElement:null};
  class Node {
    constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.events={};this.value='';this.hidden=false;this.disabled=false;this.ownText='';}
    set innerHTML(v){
      this.children=[];
      for(const match of v.matchAll(/<(div|input|button)[^>]*class="([^"]+)"[^>]*>/g)){
        const n=new Node(match[1]);n.className=match[2];this.appendChild(n);
      }
    }
    set textContent(v){this.ownText=String(v??'');this.children=[];}
    get textContent(){return this.ownText+this.children.map(n=>n.textContent).join(' ');}
    setAttribute(k,v){this.attrs[k]=String(v);}
    getAttribute(k){return this.attrs[k]??null;}
    appendChild(n){n.parent=this;this.children.push(n);return n;}
    prepend(n){n.parent=this;this.children.unshift(n);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
    replaceChildren(){this.children=[];}
    focus(){doc.activeElement=this;}
    addEventListener(k,f){this.events[k]=f;}
    matches(s){return s[0]==='.'?(this.className||'').split(' ').includes(s.slice(1)):s[0]==='#'?this.id===s.slice(1):s==='button:not(:disabled)'?this.tagName==='button'&&!this.disabled:s==='input:not(:disabled)'?this.tagName==='input'&&!this.disabled:this.tagName===s;}
    querySelectorAll(s){const sels=s.split(',');return this.children.flatMap(n=>[...(sels.some(k=>n.matches(k.trim()))?[n]:[]),...n.querySelectorAll(s)]);}
    querySelector(s){return this.querySelectorAll(s)[0]||null;}
  }
  doc.body=new Node('body');doc.createElement=tag=>new Node(tag);
  doc.querySelector=s=>doc.body.querySelector(s);doc.querySelectorAll=s=>doc.body.querySelectorAll(s);
  doc.getElementById=id=>doc.querySelector('#'+id);
  const notices=[],requests=[];
  const c=vm.createContext({Date,console,crypto,document:doc,addEventListener(){},setTimeout:fn=>fn(),
    toast:m=>notices.push(m),_naGetSecurityPath:k=>k==='rules.allowExpiredLots'?allow:k==='pinEnabled'||k==='pinHash'?localPin:undefined,
    _naPinValid:pin=>localPin&&pin==='4821',
    NA_ROLES:{pinSet,api:async(path,body)=>{requests.push({path,body});return verify(body.pin);},message:e=>e.message},
    NuevoAmanecerCanonical:{enabled:()=>!localPin,snapshot:()=>({products})},
  });c.window=c;
  // Run the existing shared PIN functions, with a synthetic remote API.
  const roles=readFileSync('POS/js/config/pos-roles-client.js','utf8');
  vm.runInContext('var root=window;var doc=document;var PIN_ERRORS={pin_format:"El PIN debe tener de 4 a 8 dígitos."};var api=NA_ROLES.api;var message=NA_ROLES.message;'+
    roles.slice(roles.indexOf('  function askPin('),roles.indexOf('  function toast('))+
    roles.slice(roles.indexOf('  async function approve('),roles.indexOf('  var LABELS'))+
    'NA_ROLES.askPin=askPin;NA_ROLES.approve=approve;',c);
  for(const name of ['stock-lots','stock-lots-ui'])vm.runInContext(readFileSync('POS/js/inventory/'+name+'.js','utf8'),c);
  return {c,doc,notices,requests};
}
const expired={product_id:'P',tracks_inventory:1,name:'Arroz',unit:'kg',current_stock_quantity:2,lots:[{lot_id:'L',lot_code:'L',expiry_date:'2000-01-01',quantity:2,received_at:'1999-01-01T12:00:00Z'}]};

test('vencidos bloqueados por defecto; habilitar sin PIN exige configurarlo',()=>{
  for(const allow of [false,true]){
    const h=harness({allow});
    assert.equal(h.c.NA_STOCK_LOTS_UI.confirmConsumption(expired,1),null);
    assert.equal(h.requests.length,0);
    assert.match(h.notices.at(-1),allow?/configur.*PIN/i:/bloqueada/i);
  }
});
test('PIN compartido: Cancelar y Escape nunca autorizan y limpian el campo',async()=>{
  for(const cancel of [true,false]){
    const h=harness({allow:true,pinSet:true});
    const result=h.c.NA_STOCK_LOTS_UI.confirmConsumption(expired,1);
    const wrap=h.doc.querySelector('.na-pin-overlay'),input=wrap.querySelector('.na-pin-input');
    assert.equal(wrap.getAttribute('role'),'dialog');assert.equal(wrap.getAttribute('aria-modal'),'true');
    assert.equal(h.doc.activeElement,input);input.value='4821';
    if(cancel)wrap.querySelector('.na-pin-cancel').onclick();else input.events.keydown({key:'Escape'});
    assert.equal(await result,null);assert.equal(input.value,'');assert.equal(h.requests.length,0);
  }
});
test('PIN remoto incorrecto mantiene modal y venta bloqueada; válido autoriza una sola vez',async()=>{
  const h=harness({allow:true,pinSet:true,verify:async pin=>{if(pin!=='4821')throw Error('owner_pin_invalid');return {approval_id:'verified'};}});
  const result=h.c.NA_STOCK_LOTS_UI.confirmConsumption(expired,1);
  const box=h.doc.querySelector('.na-pin-overlay'),input=box.querySelector('input'),ok=box.querySelectorAll('button').at(-1);
  input.value='1234';await ok.onclick();assert.match(box.textContent,/owner_pin_invalid/);assert.equal(input.value,'');
  input.value='4821';await ok.onclick();assert.equal((await result).approval_id,'verified');assert.equal(input.value,'');
  assert.equal(h.doc.querySelector('.na-pin-overlay'),null);assert.equal(h.requests.length,2);assert.ok(h.requests.every(r=>r.body.action==='expired_lot_sale'&&r.body.operation_id===null));
});
test('PIN maestro existente también se valida sin crear otro sistema de PIN',async()=>{
  const h=harness({allow:true,localPin:true});const result=h.c.NA_STOCK_LOTS_UI.confirmConsumption(expired,1);
  const box=h.doc.querySelector('.na-pin-overlay');box.querySelector('input').value='4821';await box.querySelectorAll('button').at(-1).onclick();
  assert.equal(await result,true);assert.equal(h.requests.length,0);
});
test('reporte retirado conserva el API de lotes y productos proyectados',()=>{
  const h=harness({products:[expired]});
  assert.equal(h.c.NA_STOCK_LOTS_UI.openReport,undefined);
  assert.equal(h.c.NA_STOCK_LOTS_UI.currentProducts()[0],expired);
  assert.equal(typeof h.c.NA_STOCK_LOTS_UI.readMovementLots,'function');
  assert.equal(h.doc.querySelector('.na-pin-overlay'),null);
});

function prepareSale(h){
  const enqueued=[];
  Object.assign(h.c,{cart:[{id:'P',qty:1,precio:2}],productos:[{id:'P',stock:2}],ventas:[],clientes:[],posPayM:'efectivo',posProc:false,
    isModuleLocked:()=>false,_naSessionOpen:()=>true,_naPaymentState:()=>({valid:true}),
    NuevoAmanecerCanonicalSaleOutbox:{enqueue:async intent=>{enqueued.push(intent);return intent;}}});
  for(const name of ['canonical-sale-intent','canonical-sale-projection','canonical-sale-integration'])vm.runInContext(readFileSync('POS/js/sync/'+name+'.js','utf8'),h.c);
  return enqueued;
}
test('venta espera el modal antes de enqueue; Cancelar conserva carrito, PIN válido captura consentimiento',async()=>{
  for(const authorize of [false,true]){
    const h=harness({allow:true,pinSet:true,products:[expired]}),enqueued=prepareSale(h);
    const result=h.c.confirmarVenta();assert.equal(enqueued.length,0);assert.equal(h.c.posProc,true);
    await h.c.confirmarVenta();assert.equal(enqueued.length,0);
    const box=h.doc.querySelector('.na-pin-overlay'),buttons=box.querySelectorAll('button');
    if(authorize){box.querySelector('input').value='4821';await buttons.at(-1).onclick();}else buttons[0].onclick();
    await result;assert.equal(h.c.posProc,false);
    assert.equal(enqueued.length,authorize?1:0);assert.equal(h.c.cart.length,authorize?0:1);
    if(authorize)assert.equal(enqueued[0].items[0].allow_expired_lots,true);
  }
});
test('venta habilitada sin PIN conserva el aviso de configuración antes del enqueue',async()=>{
  const h=harness({allow:true,products:[expired]}),enqueued=prepareSale(h);
  await h.c.confirmarVenta();assert.equal(enqueued.length,0);assert.match(h.notices.at(-1),/configur.*PIN/i);
});
test('fallo al construir modal de vencidos bloquea venta antes del enqueue',async()=>{
  const h=harness({allow:true,pinSet:true,products:[expired]}),enqueued=prepareSale(h);
  h.doc.createElement=()=>{throw Error('DOM_UNAVAILABLE');};
  await h.c.confirmarVenta();assert.equal(enqueued.length,0);assert.equal(h.c.cart.length,1);assert.equal(h.c.posProc,false);
});
test('ningún acceso al reporte se instala en Inventario, Ventas, sidebar o drawer',()=>{
  const h=harness(),hosts={};
  for(const key of ['#pageInventario .ocr-purchase-actions','#ventasReportControls','#pageMenu .menu-desktop-sidebar','.na-mobile-drawer-nav']){hosts[key]=h.doc.createElement('nav');h.doc.body.appendChild(hosts[key]);}
  const query=h.doc.querySelector;h.doc.querySelector=s=>hosts[s]||query(s);
  h.doc.events.DOMContentLoaded();h.doc.events.DOMContentLoaded();
  for(const host of Object.values(hosts))assert.equal(host.children.length,0);
  assert.equal(h.c.NA_STOCK_LOTS_UI.openReport,undefined);
});
