import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('cached owner screens stay closed offline and retry confirms permissions', async () => {
  const elements = new Map(), listeners = new Map(), opened = [];
  function element() {
    const buttons = new Map();
    return { classList:{toggle(){},remove(){}}, setAttribute(){},
      querySelector(selector) { if (!buttons.has(selector)) buttons.set(selector, {}); return buttons.get(selector); },
      remove(){elements.delete('notice');} };
  }
  const doc = { readyState:'loading', documentElement:element(), body:{appendChild(el){elements.set('notice',el);}},
    addEventListener(){}, getElementById(){return null;},
    querySelector(selector){return selector === '.na-offline-cfg' ? elements.get('notice') : null;}, querySelectorAll(){return [];}, createElement:element };
  const storage = new Map([['na_cloud_sync_credentials',JSON.stringify({endpoint:'https://synthetic.test',token:'synthetic'})],['na_pos_role_v1',JSON.stringify({role:'owner'})]]);
  let online=false, checks=0;
  const root = {document:doc,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    navigator:{onLine:false},addEventListener:(name,fn)=>listeners.set(name,fn),dispatchEvent(){},goPage:id=>opened.push(id),ventasSetTab:()=>opened.push('reportes'),
    fetch:async()=>{checks++;if (!online) throw Error('offline');return {ok:true,json:async()=>({pos_role:'owner'})};}};
  const ctx=vm.createContext({window:root,globalThis:root,CustomEvent:function(){},setTimeout(){}});
  vm.runInContext(readFileSync('POS/js/config/pos-permissions.js','utf8'),ctx);
  vm.runInContext(readFileSync('POS/js/config/pos-roles-client.js','utf8'),ctx);
  listeners.get('load')();
  await root.NA_ROLES.refresh();
  for (const id of ['pageGastos','pageConfig']) assert.equal(root.goPage(id),false);
  assert.equal(root.ventasSetTab(null,'reportes'),false);
  assert.deepEqual(opened,[]);
  const notice=elements.get('notice');
  assert.match(notice.innerHTML,/Confirmando permisos…/);
  assert.match(notice.innerHTML,/Reintentar/);
  await notice.querySelector('.na-role-retry').onclick();
  assert.equal(root.NA_ROLES.confirmed,false);
  assert.ok(elements.has('notice'));
  online=true;
  const before=checks;
  await notice.querySelector('.na-role-retry').onclick();
  assert.equal(checks,before+1);
  assert.equal(root.NA_ROLES.confirmed,true);
  assert.equal(elements.has('notice'),false);
  root.goPage('pageGastos');
  assert.deepEqual(opened,['pageGastos']);
});
