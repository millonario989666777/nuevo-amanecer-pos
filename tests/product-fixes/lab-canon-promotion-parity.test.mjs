import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = path => readFileSync(path,'utf8');
const posIndex = read('POS/index.html');
const labIndex = read('laboratorio/pos-lab/index.html');

const sectionNames = ['menu','punto-venta','inventario','clientes','caja','ventas','gastos','configuracion'];
const labConfigMenuCard = `            <div class="module-card" style="--accent:#64748b;--icon-bg:#f8fafc" onclick="goPage('pageConfig')"><div class="module-icon">⚙️</div><div class="module-label">Configuración</div><div class="module-desc">Personaliza productos, ticket y el sistema.</div><div class="module-arrow">Entrar →</div></div>`;

function srcs(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(m=>m[1]);
}
function css(html) {
  return [...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+\.css)["'][^>]*>/gi)].map(m=>m[1]);
}

test('LAB approved page sections are the CANON shell with only explicit production chrome differences',()=>{
  for (const name of sectionNames) {
    const section=read(`laboratorio/pos-lab/sections/${name}.html`).replace(/\n$/,'');
    if (name === 'menu') {
      assert.ok(section.includes(labConfigMenuCard),'LAB menu must retain its protected Configuración card');
      const normalized=section.replace(labConfigMenuCard + '\n','');
      assert.ok(posIndex.includes(normalized),'menu differs beyond the approved CANON settings shortcut');
      assert.match(posIndex,/id="topSettingsBtn"/);
      assert.equal(posIndex.includes(labConfigMenuCard),false,'CANON must not retain the menu Configuración card');
    } else if (name === 'clientes') {
      const normalized=posIndex.replace('<span id="cliAuthorityBadge" hidden></span>','');
      assert.ok(normalized.includes(section),`Clientes differs beyond the allowed CANON authority badge`);
    } else if (name === 'inventario') {
      // LAB is historical. PR503 approves CANON's automatic OCR chooser and
      // three direct actions; every other inventory control remains identical.
      const inventory=posIndex.match(/<div class="page" id="pageInventario">[\s\S]*?(?=\n<!-- CLIENTES -->)/)?.[0];
      assert.ok(inventory,'CANON inventory section must exist');
      const actions=inventory.match(/<div class="ocr-purchase-actions">([\s\S]*?)<\/div>/)?.[1];
      assert.ok(actions,'CANON must expose its direct inventory actions');
      assert.equal((actions.match(/<button\b/g)||[]).length,3,'exactly three direct inventory actions');
      for(const handler of ["document.getElementById('mOcrPurchaseSource').classList.add('open')",'NuevoAmanecerImageBatch.open()','abrirModalProd()']) {
        assert.equal(actions.split(`onclick="${handler}"`).length-1,1,`exactly one action for ${handler}`);
      }
      for(const label of ['OCR compras','Cargar fotos','+ Nuevo']) assert.ok(actions.includes(`>${label}</button>`));
      const normalizeHeader=html=>html.replace(/<div class="top-mod-bar">[^\n]*<\/div>/,'<CANON_INVENTORY_HEADER>')
        .replace(/<div class="ocr-purchase-status"[^\n]*<\/div>/,'<CANON_OCR_STATUS>').trim();
      assert.equal(normalizeHeader(inventory),normalizeHeader(section),'filters, tabs, metrics and table must retain their complete historical contract');
      for(const id of ['ocrPurchaseCamera','ocrPurchaseFile','ocrPurchaseDocument']) {
        assert.equal((posIndex.match(new RegExp(`id="${id}"`,'g'))||[]).length,1,`one input for ${id}`);
      }
      assert.match(posIndex,/id="ocrPurchaseDocument"[^>]+accept="\.pdf,\.docx,/);
      assert.match(posIndex,/<script[^>]+src="js\/ocr\/ocr-document-extract\.js"/);
      assert.match(posIndex,/<script[^>]+src="js\/products\/image-batch\.js"/);
      assert.match(posIndex,/id="productImageBatchModal"[^>]+role="dialog"/);
    } else {
      assert.ok(posIndex.includes(section),`${name} LAB section drifted from CANON shell`);
    }
  }
});

test('LAB and CANON execute the same shared product core; environment overlays stay isolated',()=>{
  const labScripts=srcs(labIndex);
  const canonScripts=srcs(posIndex);
  const sharedLabScripts=labScripts.filter(src=>src.startsWith('js/'));
  for (const src of sharedLabScripts) assert.ok(canonScripts.includes(src),`CANON missing shared LAB core script ${src}`);

  const allowedLabOnly=[
    '../laboratorio/pos-lab/lab-guard.js',
    '../laboratorio/pos-lab/js/motion/page-transitions.js',
    '../laboratorio/pos-lab/js/motion/cart-motion.js',
    '../laboratorio/pos-lab/js/motion/modal-motion.js',
    '../laboratorio/pos-lab/js/motion/feedback-motion.js',
    '../laboratorio/pos-lab/js/lab-workspace.js',
    '../laboratorio/pos-lab/lab-overrides.js'
  ];
  const labOnly=labScripts.filter(src=>!canonScripts.includes(src));
  assert.deepEqual(labOnly,allowedLabOnly);
  assert.doesNotMatch(posIndex,/laboratorio\/pos-lab/);
  assert.doesNotMatch(posIndex,/lab-workspace\.js|lab-overrides\.js|lab-guard\.js/);
});

test('shared base CSS remains common while LAB-only styling never becomes a production runtime dependency',()=>{
  const labCss=css(labIndex), canonCss=css(posIndex);
  for (const src of ['css/base.css','css/layout.css','css/components.css','css/responsive.css','css/print.css']) {
    assert.ok(labCss.includes(src));
    assert.ok(canonCss.includes(src));
  }
  assert.ok(labCss.some(src=>src.includes('../laboratorio/pos-lab/styles/')));
  assert.ok(canonCss.includes('css/client-credit-accounts-v2.css'));
  assert.ok(canonCss.includes('css/motion/notifications.css'));
  assert.doesNotMatch(posIndex,/\.\.\/laboratorio\/pos-lab\/styles|\.\.\/laboratorio\/pos-lab\/animations/);
});

test('approved client financial capabilities exist in CANON without importing the LAB override runtime',()=>{
  const canon=read('POS/js/modules/client-credit-accounts-v2.js');
  const required=[
    'labCategoriesForClient',
    'labInstallmentPlan',
    'labGeneralHistoryHtml',
    'naCanonOpenCanceledCredits',
    'naCanonOpenClientPaymentHistory',
    'naCanonOpenCreditLine',
    'naCanonSelectCreditDestination',
    'createCreditAccount',
    'function naRenderClientList'
  ];
  for (const marker of required) assert.ok(canon.includes(marker),`CANON client V2 missing promoted capability: ${marker}`);
  assert.doesNotMatch(canon,/\bcliRender\s*=/);
  assert.equal(existsSync('POS/js/motion/client-list-motion.js'),false);
});

test('LAB motion controllers have productive CANON counterparts rather than runtime imports',()=>{
  const pairs=[
    ['laboratorio/pos-lab/js/motion/page-transitions.js','POS/js/motion/page-transitions.js'],
    ['laboratorio/pos-lab/js/motion/cart-motion.js','POS/js/motion/cart-motion.js'],
    ['laboratorio/pos-lab/js/motion/modal-motion.js','POS/js/motion/modal-motion.js'],
    ['laboratorio/pos-lab/js/motion/feedback-motion.js','POS/js/motion/feedback-motion.js']
  ];
  for (const [lab,canon] of pairs) {
    assert.ok(existsSync(lab),`missing LAB controller ${lab}`);
    assert.ok(existsSync(canon),`missing CANON counterpart ${canon}`);
  }
});

test('promoted Clientes and Motion selectors match the namespaces emitted by CANON runtime',()=>{
  const clientJs=read('POS/js/modules/client-credit-accounts-v2.js');
  const pageMotion=read('POS/js/motion/page-transitions.js');
  const scrollMotion=read('POS/js/motion/scroll-motion.js');
  const clientCss=read('POS/css/experience-v2/pages/clientes.css');
  const transitionCss=read('POS/css/experience-v2/animations/transitions.css');

  for(const marker of ['na-v2-screen','na-client-account-screen','na-client-refresh-out','na-client-refresh-in']){
    assert.ok(clientJs.includes(marker),`CANON client runtime missing ${marker}`);
    assert.ok(clientCss.includes(marker) || transitionCss.includes(marker),`promoted CSS missing runtime selector ${marker}`);
  }
  assert.ok(pageMotion.includes('na-enter-fade'));
  assert.ok(transitionCss.includes('na-enter-fade'));
  assert.ok(scrollMotion.includes('na-scroll-linked'));
  assert.ok(transitionCss.includes('na-scroll-linked'));
  assert.ok(scrollMotion.includes('na-module-scroll-linked'));
  assert.ok(transitionCss.includes('na-module-scroll-linked'));

  assert.doesNotMatch(clientCss,/\blab-(?:v2|client)-/);
  assert.doesNotMatch(transitionCss,/\blab-(?:enter|client|scroll|module|fade)-/);
});

