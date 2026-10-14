import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Small DOM harness: exercise actual focus, handlers and rendered text without a browser dependency.
function harness({allow=false, pinSet=false, localPin=false, verify=async()=>({approval_id:'ok'}), products=[]}={}) {
  const doc={readyState:'loading',events:{},addEventListener(k,f){this.events[k]=f;},activeElement:null};
  class Node {
    constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.events={};this.value='';this.hidden=false;this.disabled=false;this.ownText='';}
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
  const c=vm.createContext({Date,console,crypto,document:doc,addEventListener(){},
    toast:m=>notices.push(m),_naGetSecurityPath:k=>k==='rules.allowExpiredLots'?allow:k==='pinEnabled'||k==='pinHash'?localPin:undefined,
    _naPinValid:pin=>localPin&&pin==='4821',
    NA_ROLES:{pinSet,api:async(path,body)=>{requests.push({path,body});return verify(body.pin);},message:e=>e.message},
    NuevoAmanecerCanonical:{enabled:()=>true,snapshot:()=>({products})},
  });c.window=c;
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
test('modal de vencidos: Cancelar enfocado, Tab contenido, Escape restaura foco y nunca autoriza',async()=>{
  const h=harness({allow:true,pinSet:true});const source=h.doc.createElement('button');source.focus();
  const result=h.c.NA_STOCK_LOTS_UI.confirmConsumption(expired,1);
  const box=h.doc.querySelector('.na-lots-dialog'),wrap=h.doc.querySelector('.na-lots-overlay');
  assert.equal(box.getAttribute('role'),'dialog');assert.equal(box.getAttribute('aria-modal'),'true');
  assert.equal(h.doc.activeElement.textContent,'Cancelar');
  const buttons=box.querySelectorAll('button');buttons.at(-1).focus();let prevented=false;
  wrap.events.keydown({key:'Tab',shiftKey:false,preventDefault(){prevented=true;}});
  assert.ok(prevented);assert.ok(box.querySelectorAll('input,button').includes(h.doc.activeElement));
  wrap.events.keydown({key:'Escape',preventDefault(){}});
  assert.equal(await result,null);assert.equal(h.doc.activeElement,source);assert.equal(h.requests.length,0);
});
test('PIN remoto incorrecto mantiene modal y venta bloqueada; válido autoriza una sola vez',async()=>{
  const h=harness({allow:true,pinSet:true,verify:async pin=>{if(pin!=='4821')throw Error('PIN incorrecto');return {approval_id:'verified'};}});
  const result=h.c.NA_STOCK_LOTS_UI.confirmConsumption(expired,1);
  const box=h.doc.querySelector('.na-lots-dialog'),input=box.querySelector('input'),ok=box.querySelectorAll('button').at(-1);
  input.value='1234';await ok.onclick();assert.match(box.textContent,/PIN incorrecto/);assert.equal(input.value,'');
  input.value='4821';await ok.onclick();assert.equal(await result,true);assert.equal(input.value,'');
  assert.equal(h.doc.querySelector('.na-lots-dialog'),null);assert.equal(h.requests.length,2);
});
test('PIN maestro existente también se valida sin crear otro sistema de PIN',async()=>{
  const h=harness({allow:true,localPin:true});const result=h.c.NA_STOCK_LOTS_UI.confirmConsumption(expired,1);
  const box=h.doc.querySelector('.na-lots-dialog');box.querySelector('input').value='4821';await box.querySelectorAll('button').at(-1).onclick();
  assert.equal(await result,true);assert.equal(h.requests.length,0);
});
test('reporte muestra remanente sin vencimiento, fechas DD/MM/AAAA y día singular/plural',()=>{
  const day=new Date(Date.now()-5*3600000).toISOString().slice(0,10);
  const date=n=>new Date(Date.parse(day)+n*86400000).toISOString().slice(0,10);
  const h=harness({products:[{...expired,current_stock_quantity:5,lots:[{...expired.lots[0],expiry_date:date(1),quantity:1},{...expired.lots[0],lot_id:'L2',expiry_date:date(2),quantity:1}]}]});
  h.c.NA_STOCK_LOTS_UI.openReport();const text=h.doc.querySelector('.na-lots-dialog').textContent;
  assert.match(text,/sin vencimiento registrado/);assert.match(text,/Saldo: 3 kg/);
  assert.match(text,/En 1 día\b/);assert.doesNotMatch(text,/En 1 días/);assert.match(text,/En 2 días/);
  assert.ok(text.includes(date(1).split('-').reverse().join('/')));assert.ok(!text.includes(date(1)));
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
    const box=h.doc.querySelector('.na-lots-dialog'),buttons=box.querySelectorAll('button');
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
test('reporte se instala en navegación visible tablet y drawer móvil; evita duplicados',()=>{
  const h=harness(),hosts={};
  for(const key of ['#pageMenu .menu-desktop-sidebar','.na-mobile-drawer-nav']){hosts[key]=h.doc.createElement('nav');h.doc.body.appendChild(hosts[key]);}
  const query=h.doc.querySelector;h.doc.querySelector=s=>hosts[s]||query(s);
  h.doc.events.DOMContentLoaded();h.doc.events.DOMContentLoaded();
  for(const host of Object.values(hosts)){
    const buttons=host.querySelectorAll('.na-lot-report-button');assert.equal(buttons.length,1);assert.equal(buttons[0].hidden,false);
    buttons[0].onclick();assert.ok(h.doc.querySelector('.na-lots-dialog'));
    h.doc.querySelector('.na-lots-dialog').querySelector('button').onclick();
  }
});
