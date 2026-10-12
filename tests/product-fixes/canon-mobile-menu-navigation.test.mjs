import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('POS/js/navigation/menu-navigation.js', 'utf8');
const index = readFileSync('POS/index.html', 'utf8');
const baseCss = readFileSync('POS/css/base.css', 'utf8');
const layoutCss = readFileSync('POS/css/layout.css', 'utf8');
const inline03 = readFileSync('POS/js/legacy-inline/inline-03.js', 'utf8');
const sw = readFileSync('POS/sw.js', 'utf8');

function classList(initial=[]) {
  const set=new Set(initial);
  return {
    contains:name=>set.has(name),
    add:function(){for(const name of arguments)set.add(name);},
    remove:function(){for(const name of arguments)set.delete(name);}
  };
}

function makeCard(pageId) {
  const attrs = new Map([['onclick', `goPage('${pageId}')`]]);
  const menuMarker = {};
  return {
    attrs,
    label: { textContent: pageId },
    getAttribute(name) { return attrs.get(name) ?? null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    hasAttribute(name) { return attrs.has(name); },
    querySelector(selector) { return selector === '.module-label' ? this.label : null; },
    closest(selector) {
      if (selector === '.module-card') return this;
      if (selector === '#pageMenu') return menuMarker;
      return null;
    }
  };
}

function harness(width=390) {
  const cards = [
    makeCard('pagePOS'),
    makeCard('pageInventario'),
    makeCard('pageVentas'),
    makeCard('pageClientes'),
    makeCard('pageCaja'),
    makeCard('pageGastos'),
    makeCard('pageConfig')
  ];
  const listeners = new Map();
  const menuAttrs = new Map();
  const frameQueue=[];
  const idleQueue=[];
  const timerQueue=[];
  const pages=['pageMenu','pagePOS','pageInventario','pageVentas','pageClientes','pageCaja','pageGastos','pageConfig']
    .map(id=>({id,classList:classList(id==='pageMenu'?['page','active']:['page'])}));
  const back={style:{display:'none'}};
  const menu = {
    id:'pageMenu',
    classList:pages.find(p=>p.id==='pageMenu').classList,
    getAttribute(name) { return menuAttrs.get(name) ?? null; },
    setAttribute(name, value) { menuAttrs.set(name, String(value)); },
    querySelectorAll(selector) { return selector === '.module-card' ? cards : []; },
    addEventListener(type, fn) { listeners.set(type, fn); }
  };
  const byId=new Map(pages.map(p=>[p.id,p]));
  byId.set('pageMenu',menu);
  byId.set('backBtn',back);
  const calls=[];
  const renders=[];
  const motionPresets=[];
  const persistedPages=[];
  let clock = 100;
  const html={classList:classList()};
  const body={classList:classList()};

  const context = {
    window: null,
    document: {
      readyState: 'complete',
      documentElement: html,
      body,
      getElementById(id) { return byId.get(id)||null; },
      querySelectorAll(selector) { return selector==='.page'?pages:[]; },
      addEventListener() {}
    },
    innerWidth: width,
    performance: { now: () => clock },
    requestAnimationFrame(cb){frameQueue.push(cb);return frameQueue.length;},
    requestIdleCallback(cb){idleQueue.push(cb);return idleQueue.length;},
    setTimeout(cb){timerQueue.push(cb);return timerQueue.length;},
    scrollTo(){},
    _naSchedulePageRender(id){renders.push(id);},
    saveAppState(){
      const active=pages.find(p=>p.classList.contains('active'));
      persistedPages.push(active?active.id:'pageMenu');
      return Promise.resolve({ok:true});
    },
    NA_MOTION:{
      scroll:{
        enablePreset(name){
          motionPresets.push(name);
          return {sync(){motionPresets.push(name+':sync');}};
        }
      }
    },
    Date,Object,Array,Map,Set,console,
    goPage(id){calls.push(id);}
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'menu-navigation.js' });

  function flushFrames(){
    const batch=frameQueue.splice(0,frameQueue.length);
    batch.forEach(cb=>cb());
  }
  function flushAfterPaint(){
    flushFrames();
    flushFrames();
  }
  function flushIdle(){
    const batch=idleQueue.splice(0,idleQueue.length);
    batch.forEach(cb=>cb({didTimeout:false,timeRemaining:()=>50}));
  }

  return {
    cards,listeners,calls,renders,motionPresets,persistedPages,pages,body,html,back,context,
    flushFrames,flushAfterPaint,flushIdle,
    setClock(value){clock=value;}
  };
}

function evt(target, extra = {}) {
  return Object.assign({
    target,
    pointerType: 'touch',
    pointerId: 7,
    clientX: 100,
    clientY: 200,
    key: '',
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; }
  }, extra);
}

test('mobile tap exposes the requested page without calling goPage', () => {
  const h=harness(390);
  const card=h.cards[3];
  h.listeners.get('pointerdown')(evt(card));
  h.listeners.get('pointerup')(evt(card));
  assert.deepEqual(h.calls,[]);
  assert.equal(h.pages.find(p=>p.id==='pageMenu').classList.contains('active'),false);
  assert.equal(h.pages.find(p=>p.id==='pageClientes').classList.contains('active'),true);
  assert.equal(h.back.style.display,'block');
  assert.equal(h.context.NA_MOBILE_SAFE_NAV_ACTIVE,true);
  assert.deepEqual(h.renders,[]);
  assert.deepEqual(h.persistedPages,[],'navigation persistence must not block the first paint');
  h.flushFrames();
  assert.deepEqual(h.persistedPages,[]);
  h.flushFrames();
  assert.deepEqual(h.persistedPages,['pageClientes']);
});

test('Clientes restores only its scroll-linked chrome after safe paint and idle', () => {
  const h=harness(390);
  h.context.NA_MENU_NAVIGATION.mobileSafeNavigate('pageClientes');

  assert.deepEqual(h.motionPresets,[],'scroll Motion must not run before the destination paints');
  h.flushFrames();
  assert.deepEqual(h.motionPresets,[],'first frame remains paint-only');
  h.flushFrames();

  assert.equal(h.body.classList.contains('module-mobile-scroll'),true);
  assert.deepEqual(h.motionPresets,[],'preset is still deferred until idle');
  h.flushIdle();

  assert.deepEqual(h.motionPresets,['clientes','clientes:sync']);
  assert.deepEqual(h.renders,['pageClientes']);
});

test('other mobile modules remain on safe navigation without re-enabling parity Motion in this fix', () => {
  const h=harness(390);
  h.context.NA_MENU_NAVIGATION.mobileSafeNavigate('pageInventario');
  h.flushAfterPaint();
  h.flushIdle();
  assert.deepEqual(h.motionPresets,[]);
  assert.deepEqual(h.renders,['pageInventario']);
});

test('mobile renderer is deferred until after paint and idle, while scroll mode is applied later', () => {
  const h=harness(390);
  h.context.NA_MENU_NAVIGATION.mobileSafeNavigate('pageInventario');
  assert.equal(h.body.classList.contains('module-mobile-scroll'),false);
  h.flushFrames();
  assert.equal(h.body.classList.contains('module-mobile-scroll'),false);
  h.flushFrames();
  assert.equal(h.body.classList.contains('module-mobile-scroll'),true);
  assert.deepEqual(h.renders,[]);
  h.flushIdle();
  assert.deepEqual(h.renders,['pageInventario']);
});

test('desktop keeps the existing goPage path', () => {
  const h=harness(1200);
  h.listeners.get('click')(evt(h.cards[0],{pointerType:'mouse'}));
  assert.deepEqual(h.calls,['pagePOS']);
  assert.equal(h.pages.find(p=>p.id==='pageMenu').classList.contains('active'),true);
});

test('top settings shortcut uses the same safe navigation API', () => {
  const mobile=harness(390);
  assert.equal(mobile.context.NA_MENU_NAVIGATION.navigate('pageConfig'),true);
  assert.equal(mobile.pages.find(p=>p.id==='pageConfig').classList.contains('active'),true);
  assert.deepEqual(mobile.calls,[]);

  const desktop=harness(1200);
  assert.equal(desktop.context.NA_MENU_NAVIGATION.navigate('pageConfig'),true);
  assert.deepEqual(desktop.calls,['pageConfig']);
});

test('CANON header uses a color-only connection indicator and direct settings gear', () => {
  const menu=index.slice(index.indexOf('<div class="page active" id="pageMenu">'),index.indexOf('<!-- POS -->'));
  assert.match(index,/id="localStatus" data-state="disconnected"/);
  assert.match(index,/id="topSettingsBtn"/);
  assert.match(index,/NA_MENU_NAVIGATION\.navigate\('pageConfig'\)/);
  assert.doesNotMatch(index,/id="topAvatar"/);
  assert.doesNotMatch(menu,/module-label">Configuración</);
  assert.match(menu,/module-label">Gastos</);
  assert.match(baseCss,/#localStatus\[data-state="connected"\]/);
  assert.match(baseCss,/#localStatus\[data-state="disconnected"\]/);
  assert.match(baseCss,/#localStatus\[data-state="update"\]/);
  assert.match(baseCss,/\.g-status-label\{position:absolute/);
  assert.match(baseCss,/\.g-avatar\{/);
  assert.match(layoutCss,/\.g-status span\{/);
  assert.match(layoutCss,/#localStatus\[data-state\]\{padding:0/);
  // Texto actual del indicador (antes «CANON validado»).
  assert.match(inline03,/Conectado/);
  assert.match(inline03,/Canónico no disponible · reintenta/);
  assert.match(inline03,/na:version-update-pending/);
  assert.match(index,/registration\.addEventListener\('updatefound'/);
});

test('finger scroll gesture still does not navigate', () => {
  const h=harness(390);
  const card=h.cards[1];
  h.listeners.get('pointerdown')(evt(card));
  h.listeners.get('pointerup')(evt(card,{clientY:245}));
  assert.equal(h.pages.find(p=>p.id==='pageMenu').classList.contains('active'),true);
  assert.deepEqual(h.calls,[]);
});

test('navigation layer stays free of business/storage/network authority', () => {
  assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|sale\.create\b|payment\.create\b|cash\.open\b|cash\.close\b|credit-account\.create\b/i);
  assert.match(source,/mobileSafeNavigate/);
  assert.match(source,/root\._naSchedulePageRender\(pageId\)/);
  assert.match(source,/persistVisiblePage\(target\)/);
  assert.match(source,/root\.saveAppState\(\)/);
  assert.match(source,/scheduleClientScrollMotion/);
  assert.match(source,/enablePreset\('clientes'\)/);
});

test('CANON shell still loads and precaches menu navigation', () => {
  const nav = index.indexOf('js/navigation/menu-navigation.js');
  const motion = index.indexOf('js/motion/core.js');
  assert.ok(nav >= 0);
  assert.ok(motion > nav);
  assert.match(sw, /'\.\/js\/navigation\/menu-navigation\.js'/);
});
