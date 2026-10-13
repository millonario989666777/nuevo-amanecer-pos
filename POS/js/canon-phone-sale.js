(function (root) {
  'use strict';
  function start() {
    var page = document.getElementById('pagePOS');
    if (!page || document.getElementById('posPhoneAdd')) return;
    var toolbar = page.querySelector('.pos-commandbar'), actions = toolbar.querySelector('.pos-toolbar-actions');
    var phone = false, stream = null, cameraSession = 0, timer = 0;
    var rowButtons = new WeakMap();
    var viewportFrame = 0;
    function syncViewport() {
      viewportFrame = 0;
      var viewport = root.visualViewport;
      var checkout = document.getElementById('mCobro');
      if (checkout) {
        if (phone && (!viewport || viewport.scale === 1)) {
          checkout.style.setProperty('--phone-checkout-height',(viewport ? viewport.height : root.innerHeight) + 'px');
          checkout.style.setProperty('--phone-checkout-top',(viewport ? viewport.offsetTop : 0) + 'px');
        } else {
          checkout.style.removeProperty('--phone-checkout-height');
          checkout.style.removeProperty('--phone-checkout-top');
        }
      }
      if (!phone || !page.classList.contains('active') || (viewport && viewport.scale !== 1)) {
        page.style.removeProperty('--phone-visible-height');
        page.style.removeProperty('--phone-visible-top');
        return;
      }
      var height = viewport ? viewport.height : root.innerHeight;
      if (height > 0) page.style.setProperty('--phone-visible-height',height + 'px');
      page.style.setProperty('--phone-visible-top',(viewport ? viewport.offsetTop : 0) + 'px');
    }
    function scheduleViewport() {
      if (viewportFrame) return;
      // Antes del primer pintado se espera a que cargue la página; después, en el siguiente cuadro.
      if (document.readyState !== 'complete') { viewportFrame = -1; root.addEventListener('load', function () { setTimeout(function () { viewportFrame = 0; scheduleViewport(); }, 0); }, { once: true }); return; }
      viewportFrame = root.requestAnimationFrame(syncViewport);
    }
    root.addEventListener('resize',scheduleViewport);
    if (root.visualViewport) {
      root.visualViewport.addEventListener('resize',scheduleViewport);
      root.visualViewport.addEventListener('scroll',scheduleViewport);
    }
    function node(tag, text, id) {
      var el = document.createElement(tag); if (text) el.textContent = text; if (id) el.id = id; return el;
    }
    function button(text, id, label, callback) {
      var el = node('button', text, id); el.type = 'button'; el.setAttribute('aria-label', label); el.addEventListener('click', callback); return el;
    }
    function icon(path) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      [['viewBox','0 0 24 24'],['fill','none'],['stroke','currentColor'],['stroke-width','1.8'],['aria-hidden','true']].forEach(function (a) { svg.setAttribute(a[0],a[1]); });
      var p = document.createElementNS(svg.namespaceURI,'path'); p.setAttribute('d',path); svg.appendChild(p); return svg;
    }
    var heading = node('strong','Nueva venta','posPhoneTitle'); toolbar.querySelector('.pos-module-identity').appendChild(heading);
    var add = button('+ Agregar','posPhoneAdd','Agregar productos manualmente',openCatalog);
    var scan = button('','posPhoneScan','Escanear código con la cámara',openCamera);
    scan.appendChild(icon('M3 8V3h5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M7 7v10 M10 7v10 M14 7v10 M17 7v10'));
    actions.append(add,scan);
    var catalog = node('dialog',null,'posPhoneCatalog');
    catalog.setAttribute('aria-labelledby','posPhoneCatalogTitle');
    var catalogHead = node('div'); catalogHead.className = 'phone-dialog-head';
    catalogHead.append(node('strong','Agregar productos','posPhoneCatalogTitle'),button('Cerrar','posPhoneCatalogClose','Cerrar selección de productos',closeCatalog));
    var catalogTools = node('div'); catalogTools.className = 'phone-catalog-tools';
    var categoriesPanel = node('div',null,'posPhoneCategoryPanel'); categoriesPanel.hidden = true;
    var categories = button('Todo ⌄','posPhoneCategories','Seleccionar categoría de productos',function () {
      categoriesPanel.hidden = !categoriesPanel.hidden;
      categories.setAttribute('aria-expanded',String(!categoriesPanel.hidden));
    });
    categories.setAttribute('aria-controls','posPhoneCategoryPanel'); categories.setAttribute('aria-expanded','false');
    function syncCategory() {
      var selected = document.querySelector('#posSidebar .cat-btn.active');
      var text = selected ? Array.from(selected.childNodes).filter(function (item) { return item.nodeType === 3; }).map(function (item) { return item.textContent; }).join('').trim() : 'Todo';
      categories.textContent = (text || 'Todo') + ' ⌄';
    }
    document.getElementById('posSidebar').addEventListener('click',function (event) {
      if (!phone || !event.target.closest('.cat-btn')) return;
      syncCategory(); categoriesPanel.hidden = true; categories.setAttribute('aria-expanded','false'); categories.focus();
      document.getElementById('posArea').scrollTop = 0;
    });
    var catalogBody = node('div'); catalogBody.className = 'phone-catalog-body';
    catalog.append(catalogHead,catalogTools,categoriesPanel,catalogBody); page.appendChild(catalog);
    var movable = ['.pos-search-box','#btnVentaLibre','#btnMayorista','#posSidebar','#posArea'].map(function (selector) {
      var el = page.querySelector(selector), anchor = document.createComment('phone-sale-return'); el.before(anchor); return {el:el,anchor:anchor};
    });
    function openCatalog() {
      if (!phone) return;
      root.posRender(); syncCategory(); categoriesPanel.hidden = true; categories.setAttribute('aria-expanded','false'); catalog.showModal();
      catalog.scrollTop = 0;
      categories.focus();
    }
    function closeCatalog() { catalog.close(); if (phone) add.focus(); }
    document.getElementById('btnVentaLibre').addEventListener('click',function () { if (phone && catalog.open) closeCatalog(); },true);
    var camera = node('dialog',null,'posPhoneCamera'); camera.setAttribute('aria-labelledby','posPhoneCameraTitle');
    var cameraHead = node('div'); cameraHead.className = 'phone-dialog-head';
    cameraHead.append(node('strong','Escanear producto','posPhoneCameraTitle'),button('Cerrar','posPhoneCameraClose','Cerrar cámara',closeCamera));
    var video = node('video'); video.autoplay = true; video.muted = true; video.setAttribute('playsinline','');
    var status = node('p',null,'posPhoneCameraStatus'); status.setAttribute('role','status');
    camera.append(cameraHead,video,status,button('Buscar manualmente','posPhoneCameraManual','Buscar producto manualmente',function () { closeCamera(); openCatalog(); })); page.appendChild(camera);
    function stopCamera() {
      cameraSession++; clearTimeout(timer);
      if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
      stream = null; video.srcObject = null;
    }
    function closeCamera() { stopCamera(); camera.close(); if (phone) scan.focus(); }
    camera.addEventListener('cancel',stopCamera); camera.addEventListener('close',stopCamera);
    async function openCamera() {
      if (!phone || camera.open) return;
      stopCamera(); camera.showModal(); status.textContent = 'Preparando cámara…';
      var session = cameraSession;
      if (!root.BarcodeDetector || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        status.textContent = 'La cámara lectora no está disponible en este navegador. Usa la búsqueda manual.'; return;
      }
      try {
        var formats = await root.BarcodeDetector.getSupportedFormats();
        var supported = formats.filter(function (f) { return ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf','qr_code'].indexOf(f) !== -1; });
        if (!supported.length) throw new Error('NO_BARCODE_FORMATS');
        var detector = new root.BarcodeDetector({formats:supported});
        if (session !== cameraSession) return;
        var opened = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
        if (session !== cameraSession || !camera.open || !phone) { opened.getTracks().forEach(function (track) { track.stop(); }); return; }
        stream = opened; video.srcObject = stream; await video.play();
        status.textContent = 'Apunta la cámara al código de barras.';
        async function detect() {
          if (session !== cameraSession || !camera.open) return;
          try {
            var codes = await detector.detect(video);
            if (session !== cameraSession || !camera.open) return;
            var code = codes[0] && String(codes[0].rawValue || '').trim();
            if (code) { closeCamera(); await root._naProcessScannedCode(code,{scanner:true}); return; }
          } catch (_) { status.textContent = 'No se pudo leer. Acerca el código o busca manualmente.'; }
          if (session === cameraSession) timer = setTimeout(detect,180);
        }
        detect();
      } catch (_) {
        if (session !== cameraSession) return;
        stopCamera(); status.textContent = 'No se pudo abrir la cámara. Revisa el permiso o busca manualmente.';
      }
    }
    var pay = document.getElementById('btnPagar'), originalPay = Array.from(pay.childNodes);
    var label = node('span',null,'posPhonePayLabel');
    var account = button('Cuenta del cliente →','posPhoneAccount','Ver compras, abonos y deuda del cliente',function () {
      var id = document.getElementById('mVentaCliente').value;
      if (id && typeof root.naCanonOpenClientAccount === 'function') { root.goPage('pageClientes'); root.naCanonOpenClientAccount(id); }
    }); account.hidden = true; page.querySelector('.cart-footer').appendChild(account);
    function syncSale() {
      if (!phone) return;
      var text = 'Cobrar ' + document.getElementById('posTotal').textContent;
      if (label.textContent !== text) label.textContent = text;
      var count = document.getElementById('posCartSummary').textContent;
      var countEl = document.getElementById('posProductCount'); if (countEl.textContent !== count) countEl.textContent = count;
      var selected = document.getElementById('mVentaCliente').value;
      var evaluation = selected && typeof root._naEvaluateClientCredit === 'function' ? root._naEvaluateClientCredit(selected) : null;
      account.hidden = !(evaluation && evaluation.assignedLine > 0);
      page.querySelectorAll('.btn-rm').forEach(function (el) {
        if (!rowButtons.has(el)) rowButtons.set(el,{nodes:Array.from(el.childNodes),label:el.getAttribute('aria-label')});
        if (!el.querySelector('svg')) el.replaceChildren(icon('M4 7h16 M9 7V4h6v3 M7 7l1 13h8l1-13 M10 11v5 M14 11v5'));
        el.setAttribute('aria-label','Quitar producto');
      });
    }
    // Reuse the original menu and actions; never duplicate handlers or IDs.
    var menuWrap = document.getElementById('btnCartMenu').parentElement;
    var menuAnchor = document.createComment('phone-menu-return');
    menuWrap.before(menuAnchor);
    var dropdown = document.getElementById('cartMenuDropdown');
    var checkout = document.getElementById('mCobro');
    var extraActions = ['posQuantity','posPrice','btnRapido'].map(function (id) {
      var el = document.getElementById(id), anchor = document.createComment('phone-action-return');
      el.before(anchor); return {el:el,anchor:anchor};
    });
    function syncMenu() {
      var inCheckout = phone && checkout.classList.contains('open');
      var destination = inCheckout ? checkout.querySelector('.pay-modal-head') : menuAnchor.parentNode;
      if (menuWrap.parentNode !== destination) {
        root.closeCartMenu();
        if (inCheckout) destination.appendChild(menuWrap); else menuAnchor.after(menuWrap);
      }
    }
    dropdown.addEventListener('click',function (event) {
      if (phone && checkout.classList.contains('open') && event.target.closest('button')) {
        cerrarModal('mCobro');
      }
    },true);
    new MutationObserver(syncMenu).observe(checkout,{attributes:true,attributeFilter:['class']});
    function syncDevice() {
      var enabled = document.body.classList.contains('na-pos-phone-device');
      if (enabled === phone) { syncSale(); return; }
      phone = enabled;
      extraActions.forEach(function (item) { if (phone) dropdown.appendChild(item.el); else item.anchor.after(item.el); });
      syncMenu();
      page.classList.toggle('phone-sale',phone);
      scheduleViewport();
      if (phone) {
        movable.forEach(function (item,index) { (index < 3 ? catalogTools : index === 3 ? categoriesPanel : catalogBody).appendChild(item.el); });
        catalogTools.appendChild(categories);
        pay.replaceChildren(label); syncSale();
      } else {
        closeCatalog(); closeCamera(); movable.forEach(function (item) { item.anchor.after(item.el); });
        pay.replaceChildren.apply(pay,originalPay); account.hidden = true;
        page.querySelectorAll('.btn-rm').forEach(function (el) {
          var original = rowButtons.get(el); if (!original) return;
          el.replaceChildren.apply(el,original.nodes);
          if (original.label === null) el.removeAttribute('aria-label'); else el.setAttribute('aria-label',original.label);
          rowButtons.delete(el);
        });
      }
    }
    new MutationObserver(syncDevice).observe(document.body,{attributes:true,attributeFilter:['class']});
    new MutationObserver(syncSale).observe(document.getElementById('cartItems'),{childList:true,subtree:true});
    new MutationObserver(syncSale).observe(document.getElementById('posTotal'),{childList:true});
    document.getElementById('mVentaCliente').addEventListener('change',syncSale);
    root.addEventListener('na:canonical-updated',syncSale);
    new MutationObserver(function () { scheduleViewport(); if (!page.classList.contains('active')) { closeCatalog(); closeCamera(); } }).observe(page,{attributes:true,attributeFilter:['class']});
    document.addEventListener('visibilitychange',function () { if (document.hidden) closeCamera(); });
    root.addEventListener('pagehide',stopCamera); syncDevice();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',start,{once:true}); else start();
})(globalThis);
