/*
 * js/core/state.js - estado UI transversal compartido del POS (ETAPA 4, work item STATE).
 *
 * TRES bloques puros extraidos byte-exacto desde POS/index.html @ 4158e04
 * (checkpoint core-utils), con el bloque de gestos ADAPTADO (UI POLISH):
 *   1. modal-scroll: reset de scroll al abrir modales (Android);
 *   2. page-chrome-gestures: ocultar/mostrar .g-topbar y el chrome superior del
 *      módulo activo por GESTOS SIGNIFICATIVOS (abajo significativo oculta;
 *      2 gestos ascendentes consecutivos muestran; cerca del top muestra
 *      inmediato; jitter ignorado), incluida
 *      la API de pruebas window._naTopbarGesture (solo activa con ?na-test=1);
 *   3. modal-backdrop-close: click/tap en el backdrop de un modal normal
 *      cerrable mediante X ejecuta exactamente el mismo cierre que la X
 *      (cerrarModal), salvo operación en curso.
 * Cero persistencia, cero negocio, cero V10, cero globals del contrato 177.
 * Classic script SIN defer/async; ejecuta en la misma posicion documental
 * original (inmediatamente despues del script inline que lo contenia).
 * NAVEGACION (goPage/goMenu/toggleDark/etc) deliberadamente NO extraida:
 * acoplada a saveAppState/persistencia, renders de dominio y contrato 177.
 */

// Mantiene un único desplazamiento fluido al abrir modales en Android.
(function(){
  function prepareModalScroll(overlay){
    if(!overlay)return;
    requestAnimationFrame(()=>{
      overlay.scrollTop=0;
      const modal=overlay.querySelector('.modal');
      if(modal)modal.scrollTop=0;
    });
  }
  document.addEventListener('DOMContentLoaded',()=>{
    document.querySelectorAll('.modal-overlay').forEach(overlay=>{
      const observer=new MutationObserver(()=>{
        if(overlay.classList.contains('open'))prepareModalScroll(overlay);
      });
      observer.observe(overlay,{attributes:true,attributeFilter:['class']});
    });
  });
})();

// Gestos de scroll: una sola máquina oculta/muestra el chrome COMPLETO de la página.
// Reutiliza g-topbar-hidden para el header global y g-page-chrome-hidden para el único
// contenedor .page-chrome de la página activa. Menú no tiene chrome fijo interno: su
// hero/KPIs ya forman parte de .main-scroll y se desplazan naturalmente con el contenido.
// En desktop el dueño real puede ser .main-scroll, .table-wrap, .cli-list, el contenido
// del módulo o un wrapper interno dinámico. Se resuelve desde el target real del evento,
// evitando que #ventasContent/#cajContent oculten al verdadero .v-list-wrap/.cj-mov-wrap.
(function(){
  var UP_GESTURES_REQUIRED=2,UP_GESTURE_MIN=60,DOWN_HIDE_MIN=80,NEAR_TOP=12,WHEEL_WINDOW=350;
  var upGestureCount=0,scrollAnchor=0,ticking=false,modeActive=false;
  var touchStartY=0,touchDelta=0,touchActive=false,touchOwner=null;
  var wheelGroupActive=false,wheelGroupDir=null,wheelGroupDist=0,wheelTimer=null,wheelOwner=null;
  var lastActivePage='';
  var DESKTOP_PAGES=['pageMenu','pageInventario','pageClientes','pageVentas','pageCaja','pageGastos'];
  var DESKTOP_SCROLL_SEL='.main-scroll,.table-wrap,.cli-list,#cajContent,#ventasContent,.v-list-wrap,#gasContent,.cj-mov-wrap';
  function activePageEl(){
    for(var i=0;i<DESKTOP_PAGES.length;i++){
      var p=document.getElementById(DESKTOP_PAGES[i]);
      if(p&&p.classList&&p.classList.contains('active'))return p;
    }
    return null;
  }
  function desktopMode(){return window.innerWidth>700&&!!activePageEl();}
  function isDesktopContainer(el){
    if(!el)return false;
    var keys=DESKTOP_SCROLL_SEL.split(',');
    for(var i=0;i<keys.length;i++){
      var k=keys[i].trim();
      if(k.charAt(0)==='#'){if(el.id===k.slice(1))return true;}
      else if(k.charAt(0)==='.'&&el.classList){if(el.classList.contains(k.slice(1)))return true;}
    }
    return false;
  }
  function scrollOwnerFromTarget(target){
    if(window.innerWidth<=700)return null;
    var page=activePageEl(),el=target;
    while(el&&el!==page){if(isDesktopContainer(el))return el;el=el.parentElement;}
    if(!page||!page.querySelectorAll)return null;
    var list=page.querySelectorAll(DESKTOP_SCROLL_SEL),fallback=null;
    for(var i=0;i<list.length;i++){
      if(!fallback)fallback=list[i];
      if((list[i].scrollHeight||0)>(list[i].clientHeight||0)+1)return list[i];
    }
    return fallback;
  }
  function activeScrollEl(preferred){return scrollOwnerFromTarget(preferred);}
  function clientesMotionOwnsMobileScroll(){
    var page=activePageEl(),motion=window.NA_MOTION;
    return window.innerWidth<=700
      &&page&&page.id==='pageClientes'
      &&motion&&motion.scroll
      &&typeof motion.scroll.enablePreset==='function';
  }
  var MODULE_LIST_PAGES=['pageInventario','pageClientes','pageVentas','pageCaja','pageGastos'];
  function gesturesActive(){
    // The compact inventory keeps its search and menus in a stable sticky chrome.
    // Legacy display:none removes that chrome from flow and changes scrollY while
    // the same gesture is still moving, causing jumps in products and suggestions.
    var page=activePageEl();
    // Etapa 2: en los módulos con lista (Inventario, Clientes, Historial, Caja,
    // Gastos) la cabecera queda fija. Ocultarla con display:none la saca del
    // diseño a mitad del gesto y la lista salta o rebota (CLS 1,4 en celular).
    if(page&&MODULE_LIST_PAGES.indexOf(page.id)!==-1){
      if(page.classList.contains('g-page-chrome-hidden'))setChromeHidden(false);
      return false;
    }
    if(window.innerWidth<=767&&page&&page.id==='pageInventario'
      &&page.classList.contains('inv-mobile-simple'))return false;
    if(document.body.classList.contains('module-mobile-scroll')){
      // Clientes ya tiene un único controlador visual (NA_MOTION.scroll).
      // Evita que la máquina legacy compita durante refresh/bootstrap y produzca
      // el salto: animación anterior -> pausa -> Motion estable.
      if(clientesMotionOwnsMobileScroll())return false;
      return true;
    }
    if(document.documentElement.classList.contains('config-page-scroll'))return true;
    return desktopMode();
  }
  function tb(){return document.querySelector('.g-topbar');}
  function setChromeHidden(hidden){
    var t=tb(),active=activePageEl();
    if(t)t.classList.toggle('g-topbar-hidden',hidden);
    for(var i=0;i<DESKTOP_PAGES.length;i++){
      var page=document.getElementById(DESKTOP_PAGES[i]);
      if(page)page.classList.toggle('g-page-chrome-hidden',!!hidden&&page===active);
    }
  }
  function show(){setChromeHidden(false);}
  function hide(){setChromeHidden(true);}
  function currentScroll(owner){
    var el=owner||activeScrollEl();
    if(el&&typeof el.scrollTop==='number')return el.scrollTop||0;
    return window.scrollY||document.documentElement.scrollTop||0;
  }
  function resetState(owner,noRead){upGestureCount=0;touchDelta=0;touchActive=false;touchOwner=null;scrollAnchor=noRead?0:currentScroll(owner);wheelGroupDir=null;wheelGroupDist=0;wheelGroupActive=false;wheelOwner=null;if(wheelTimer){clearTimeout(wheelTimer);wheelTimer=null;}}
  function significantDown(owner){var st=currentScroll(owner);if(st<=NEAR_TOP){show();resetState(owner);return;}hide();cancelGesture();scrollAnchor=st;}
  function isExcluded(el){
    while(el&&el!==document.body){
      if(el.closest){var c=el.closest('#cartDrawer,.cart-drawer,.modal-overlay,.modal,#mTicket,#mPrinter,#mCobro,#mMovInv,#mVentaLibre,#mDescuento,.cfg-sidebar,.pay-modal-body');if(c)return true;}
      if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.tagName==='SELECT')return true;
      el=el.parentElement;
    }
    return false;
  }
  /* Un gesto ascendente claro (= desplazar el contenido hacia abajo) suma; con 2 consecutivos se muestra. */
  function countGesture(owner){upGestureCount++;if(upGestureCount>=UP_GESTURES_REQUIRED){show();resetState(owner);}}
  function cancelGesture(){upGestureCount=0;}
  /* ── Touch: un gesto físico = máximo un incremento ── */
  document.addEventListener('touchstart',function(e){
    if(!gesturesActive())return;
    if(e.touches.length!==1)return;
    if(isExcluded(e.target)){touchActive=false;return;}
    touchActive=true;touchStartY=e.touches[0].clientY;touchDelta=0;touchOwner=activeScrollEl(e.target);
  },{passive:true});
  document.addEventListener('touchmove',function(e){
    if(!touchActive)return;
    touchDelta=e.touches[0].clientY-touchStartY;
  },{passive:true});
  document.addEventListener('touchend',function(){
    if(!touchActive)return;touchActive=false;
    if(touchDelta>=UP_GESTURE_MIN)countGesture(touchOwner);
    else if(touchDelta<=-DOWN_HIDE_MIN)significantDown(touchOwner);
    touchDelta=0;touchOwner=null;
  });
  document.addEventListener('touchcancel',function(){touchActive=false;touchDelta=0;touchOwner=null;});
  /* ── Wheel / trackpad: agrupa eventos consecutivos como un solo gesto ── */
  document.addEventListener('wheel',function(e){
    if(!gesturesActive())return;
    if(isExcluded(e.target))return;
    var d=e.deltaY,dir=d>1?'down':(d<-1?'up':null);if(!dir)return;
    var owner=activeScrollEl(e.target);
    if(!wheelGroupActive){wheelGroupActive=true;wheelGroupDir=dir;wheelGroupDist=Math.abs(d);wheelOwner=owner;}
    else{if(dir===wheelGroupDir)wheelGroupDist+=Math.abs(d);else{wheelGroupDir=dir;wheelGroupDist=Math.abs(d);wheelOwner=owner;}}
    if(wheelTimer)clearTimeout(wheelTimer);
    wheelTimer=setTimeout(function(){
      wheelGroupActive=false;wheelTimer=null;
      if(wheelGroupDir==='up'&&wheelGroupDist>=UP_GESTURE_MIN)countGesture(wheelOwner);
      if(wheelGroupDir==='down'&&wheelGroupDist>=DOWN_HIDE_MIN)significantDown(wheelOwner);
      wheelGroupDir=null;wheelGroupDist=0;wheelOwner=null;
    },WHEEL_WINDOW);
  },{passive:true});
  /* ── Scroll: ocultar solo con desplazamiento descendente significativo; top → mostrar inmediato ── */
  function handleScroll(owner){
    if(ticking)return;ticking=true;
    requestAnimationFrame(function(){
      ticking=false;
      if(!gesturesActive())return;
      if(!tb())return;
      var st=currentScroll(owner);
      if(st<=NEAR_TOP){show();resetState(owner);return;}
      var delta=st-scrollAnchor;
      if(delta>=DOWN_HIDE_MIN){hide();scrollAnchor=st;upGestureCount=0;}
    });
  }
  window.addEventListener('scroll',function(){handleScroll(null);},{passive:true});
  /* Scroll no burbujea: capture permite resolver exactamente el owner que emitió. */
  document.addEventListener('scroll',function(e){
    if(window.innerWidth<=700)return;
    if(!gesturesActive())return;
    var t=e&&e.target;
    if(!t||t===document)return;
    if(!isDesktopContainer(t))return;
    handleScroll(t);
  },true);
  /* ── Reinicio al cambiar de módulo o redimensionar ── */
  function syncMode(){
    var next=gesturesActive();
    if(next!==modeActive){modeActive=next;show();resetState();return;}
    var page=activePageEl();
    var id=page?page.id:'';
    if(id!==lastActivePage){lastActivePage=id;show();resetState();}
  }
  modeActive=gesturesActive();lastActivePage=(activePageEl()||{}).id||'';resetState(null,true); // arranque: la página está arriba; no leer scrollTop (evita forzar layout)
  if(typeof MutationObserver==='function'){
    new MutationObserver(syncMode).observe(document.body,{attributes:true,attributeFilter:['class']});
    new MutationObserver(syncMode).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  }
  /* HOTFIX DESKTOP: en desktop navegar no cambia clases del body, así que se envuelve
     goPage/goMenu para reiniciar la máquina en el mismo punto (misma clase g-topbar-hidden). */
  var _naOrigGoPage=goPage,_naOrigGoMenu=goMenu;
  if(typeof _naOrigGoPage==='function'){
    goPage=function(id){var r=_naOrigGoPage(id);syncMode();return r;};
  }
  if(typeof _naOrigGoMenu==='function'){
    goMenu=function(){var r=_naOrigGoMenu();syncMode();return r;};
  }
  window.addEventListener('resize',function(){syncMode();show();resetState();});
  /* ── API de pruebas: solo disponible con ?na-test=1 ── */
  if(location.search.indexOf('na-test=1')!==-1){
    window._naTopbarGesture={
      getCount:function(){return upGestureCount;},
      getRequired:function(){return UP_GESTURES_REQUIRED;},
      getUpMin:function(){return UP_GESTURE_MIN;},
      getHideMin:function(){return DOWN_HIDE_MIN;},
      reset:resetState,
      isHidden:function(){var t=tb();return !!(t&&t.classList&&t.classList.contains('g-topbar-hidden'));},
      isChromeHidden:function(){var p=activePageEl();return !!(p&&p.classList&&p.classList.contains('g-page-chrome-hidden'));},
      show:show,
      hide:hide,
      getTouchActive:function(){return touchActive;},
      getWheelActive:function(){return wheelGroupActive;},
      getWheelDir:function(){return wheelGroupDir;},
      getWheelDist:function(){return wheelGroupDist;},
      getNearTop:function(){return NEAR_TOP;},
      isActive:function(){return gesturesActive();},
      sync:function(){syncMode();},
      getActivePage:function(){var p=activePageEl();return p?p.id:'';},
      getContainerScrollTop:function(){var el=activeScrollEl();return el?(el.scrollTop||0):null;},
      getScrollOwner:function(){var el=activeScrollEl();if(!el)return'window';if(el.id)return'#'+el.id;var keys=DESKTOP_SCROLL_SEL.split(',');for(var i=0;i<keys.length;i++){var key=keys[i].trim();if(key.charAt(0)==='.'&&el.classList&&el.classList.contains(key.slice(1)))return key;}return String(el.tagName||'element').toLowerCase();},
      simulateUpGesture:function(){if(!gesturesActive())return;countGesture(activeScrollEl());},
      simulateDownScroll:function(){if(!gesturesActive())return;cancelGesture();hide();}
    };
  }
})();

// UI POLISH: click/tap en el backdrop de un modal normal CERRABLE MEDIANTE X ejecuta
// exactamente el mismo cierre que la X (cerrarModal con el mismo id). Click dentro del
// contenido NO cierra; con una operación en curso (guards de procesamiento) NO cierra.
(function(){
  function anyBusy(){
    return !!(
      (typeof posProc!=='undefined'&&posProc)
      ||(typeof pagoProc!=='undefined'&&pagoProc)
      ||(typeof pagoRevProc!=='undefined'&&pagoRevProc)
      ||(typeof cajMovProc!=='undefined'&&cajMovProc)
      ||(typeof cajCloseProc!=='undefined'&&cajCloseProc)
      ||(typeof gastoProc!=='undefined'&&gastoProc)
      ||(typeof _naInventoryMoveBusy!=='undefined'&&_naInventoryMoveBusy)
      ||(typeof _naQuickPaymentProc!=='undefined'&&_naQuickPaymentProc)
      ||(typeof _naSaleAnnulmentProc!=='undefined'&&_naSaleAnnulmentProc)
    );
  }
  document.addEventListener('click',function(event){
    var target=event.target;
    if(!target||!target.classList||!target.classList.contains('modal-overlay'))return;
    var overlay=target;
    if(!overlay.classList.contains('open'))return;
    if(!overlay.querySelector('.btn-close-m,.pay-close'))return;
    if(anyBusy())return;
    if(typeof cerrarModal==='function'&&overlay.id)cerrarModal(overlay.id);
  },false);
})();
