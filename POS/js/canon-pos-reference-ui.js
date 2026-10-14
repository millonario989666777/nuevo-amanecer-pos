(function (root) {
  'use strict';

  var customerId = '', previousLines = 0;

  function lineIcon(path) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', path);
    svg.appendChild(shape);
    return svg;
  }

  function decorateCategories() {
    var paths = [
      'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
      'M3 6h18l-2 13H5z M8 6V3h8v3 M8 10v5 M12 10v5 M16 10v5',
      'M8 3h8v4l2 3v11H6V10l2-3z M6 12h12',
      'M5 8h14l-2 13H7z M8 8V4 M12 8V3 M16 8V4',
      'M8 3h8l2 8-6 10-6-10z M6 11h12',
      'M8 3h8v4l2 3v11H6V10l2-3z M9 15h6',
      'M4 20l8-16 8 16z M8 14h8',
      'M5 21V9l7-6 7 6v12z M9 21v-7h6v7'
    ];
    var categoryIcons = {todo:0,abarrotes:1,bebidas:2,snacks:3,helados:4,licores:5,limpieza:6,cuidado:5,bebes:1,hogar:7,tecnologia:0,libreria:1,servicios:0};
    document.querySelectorAll('#posSidebar .cat-btn .ci').forEach(function (icon) {
      var category = icon.closest('[data-cat]').dataset.cat;
      var index = Object.prototype.hasOwnProperty.call(categoryIcons, category) ? categoryIcons[category] : 1;
      if (!icon.querySelector('svg')) icon.replaceChildren(lineIcon(paths[index]));
    });
  }

  function syncCustomer() {
    var select = document.getElementById('mVentaCliente');
    var label = document.getElementById('posCustomer');
    var option = select && Array.prototype.find.call(select.options, function (item) { return item.value === customerId; });
    if (label) label.textContent = customerId && option ? option.textContent.split(' · ')[0] : 'Cliente genérico';
  }

  function editLine(kind) {
    var items = cartSnapshot();
    if (!items.length || typeof root._naSaleUiLocked !== 'function' || root._naSaleUiLocked() || (typeof posProc !== 'undefined' && posProc)) return;
    var editor = document.getElementById('posLineEditor');
    if (!editor) {
      editor = element('div', 'pos-line-editor');
      editor.id = 'posLineEditor';
      editor.hidden = true;
      editor.setAttribute('role', 'dialog');
      editor.setAttribute('aria-modal', 'true');
      editor.setAttribute('aria-labelledby', 'posLineEditorTitle');
      var form = element('form');
      var title = element('strong'); title.id = 'posLineEditorTitle';
      var lineLabel = element('label', '', 'Producto');
      var select = element('select'); select.id = 'posLineChoice'; lineLabel.appendChild(select);
      var valueLabel = element('label'); valueLabel.id = 'posLineValueLabel';
      var input = element('input'); input.id = 'posLineValue'; input.type = 'number'; input.required = true;
      var error = element('div', 'pos-line-editor-error'); error.id = 'posLineError'; error.setAttribute('role', 'alert');
      var save = element('button', '', 'Aplicar'); save.type = 'submit';
      var cancel = actionButton('', 'Cancelar', function () { editor.hidden = true; document.getElementById(editor.dataset.kind === 'quantity' ? 'posQuantity' : 'posPrice').focus(); });
      form.append(title, lineLabel, valueLabel, input, error, save, cancel);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var current = cartSnapshot().find(function (item) { return String(item._lineKey) === select.value; });
        if (!current || root._naSaleUiLocked() || (typeof posProc !== 'undefined' && posProc)) { error.textContent = 'La venta no está disponible para editar.'; return; }
        var value = Number(input.value);
        if (!Number.isFinite(value) || value <= 0 || (editor.dataset.kind === 'quantity' ? !Number.isSafeInteger(value) : Number(value.toFixed(2)) !== value)) {
          error.textContent = 'Ingresa una cantidad entera o un precio con hasta dos decimales.'; return;
        }
        if (editor.dataset.kind === 'quantity') {
          if (current.ventaLibre && value > 9999) { error.textContent = 'VARIOS admite hasta 9999 unidades.'; return; }
          root.posQty(current._lineKey, value - Number(current.qty));
          if (Number(current.qty) !== value) { error.textContent = 'Stock insuficiente para esa cantidad.'; return; }
        } else {
          if (!Number.isSafeInteger(Math.round(value * 100)) || !Number.isSafeInteger(Math.round(value * 100) * Number(current.qty))) {
            error.textContent = 'El precio no produce un total válido en céntimos.'; return;
          }
          var cost = Number(current.costo || 0) * Number(current.unitsPerQty || 1);
          if (typeof appConfig !== 'undefined' && appConfig.margenActive && value < cost) { error.textContent = 'El precio no puede quedar bajo costo.'; return; }
          current.precio = value;
          delete current._precioOriginal; delete current._descuento;
          root.posUpdateCart();
        }
        editor.hidden = true;
        document.getElementById(editor.dataset.kind === 'quantity' ? 'posQuantity' : 'posPrice').focus();
      });
      editor.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { editor.hidden = true; document.getElementById(editor.dataset.kind === 'quantity' ? 'posQuantity' : 'posPrice').focus(); }
        if (event.key === 'Tab') {
          var controls = form.querySelectorAll('select,input,button');
          var first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      });
      select.addEventListener('change', function () {
        var row = cartSnapshot().find(function (item) { return String(item._lineKey) === select.value; });
        if (row) input.value = editor.dataset.kind === 'quantity' ? row.qty : Number(row.precio).toFixed(2);
        error.textContent = '';
      });
      editor.appendChild(form); document.getElementById('pagePOS').appendChild(editor);
    }
    editor.dataset.kind = kind;
    var choice = document.getElementById('posLineChoice'); choice.replaceChildren();
    items.forEach(function (item) { var option = element('option', '', item.name); option.value = String(item._lineKey); choice.appendChild(option); });
    document.getElementById('posLineEditorTitle').textContent = kind === 'quantity' ? 'Cantidad' : 'Cambiar precio';
    document.getElementById('posLineValueLabel').textContent = kind === 'quantity' ? 'Cantidad' : 'Precio por unidad de venta (S/)';
    var input = document.getElementById('posLineValue'); input.step = kind === 'quantity' ? '1' : '0.01'; input.min = kind === 'quantity' ? '1' : '0.01';
    input.value = kind === 'quantity' ? items[0].qty : Number(items[0].precio).toFixed(2);
    document.getElementById('posLineError').textContent = ''; editor.hidden = false; input.focus(); input.select();
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function actionButton(symbol, label, handler) {
    var button = element('button', '');
    button.type = 'button';
    var icon = element('span', '', symbol);
    var text = element('span', '', label);
    button.append(icon, text);
    button.addEventListener('click', handler);
    return button;
  }

  function cartSnapshot() {
    try {
      if (typeof cart !== 'undefined' && Array.isArray(cart)) return cart;
    } catch (_) {}
    return [];
  }

  function updateCartMeta() {
    var items = cartSnapshot();
    var lines = items.length;
    if (previousLines && !lines) { customerId = ''; var select = document.getElementById('mVentaCliente'); if (select) select.value = ''; }
    previousLines = lines;
    syncCustomer();
    ['posQuantity', 'posPrice', 'posDiscount'].forEach(function (id) { var button = document.getElementById(id); if (button) button.disabled = !lines; });
    var units = items.reduce(function (sum, item) {
      var qty = Number(item && item.qty);
      var factor = Number(item && item.unitsPerQty);
      if (!Number.isFinite(qty) || qty < 0) qty = 0;
      if (!Number.isFinite(factor) || factor < 1) factor = 1;
      return sum + qty * factor;
    }, 0);
    var productText = lines === 1 ? '1 producto' : lines + ' productos';
    var unitText = units === 1 ? '1 unidad' : units + ' unidades';
    var summary = document.getElementById('posCartSummary');
    var productCount = document.getElementById('posProductCount');
    var unitCount = document.getElementById('posUnitCount');
    if (summary) summary.textContent = productText;
    if (productCount) productCount.textContent = 'Nro. de productos: ' + lines;
    if (unitCount) unitCount.textContent = unitText;
  }

  function decoratePrices() {
    var badges = document.querySelectorAll('#pagePOS #posArea .p-price-badge');
    badges.forEach(function (badge) {
      var text = String(badge.textContent || '').trim();
      if (!text || /\bx\s+(?:und|caja)\b/i.test(text)) return;
      var box = text.match(/^Caja\s+x\d+\s+·\s+(S\/\s*[\d.,]+)/i);
      if (box) {
        badge.textContent = box[1] + ' x caja';
        return;
      }
      if (/^S\/\s*[\d.,]+$/i.test(text)) badge.textContent = text + ' x und';
    });
  }

  function buildCustomerButton() {
    var customer = actionButton('', 'Cliente genérico', function () {
      if (typeof root._naPopulateCreditClients !== 'function' || typeof root._naOpenClientPicker !== 'function') return;
      root._naPopulateCreditClients();
      var select = document.getElementById('mVentaCliente');
      if (select) select.value = customerId;
      root._naOpenClientPicker('mVentaCliente');
    });
    customer.className = 'pos-customer-button';
    customer.id = 'posCustomerButton';
    customer.setAttribute('aria-label', 'Seleccionar cliente de la venta');
    customer.insertBefore(lineIcon('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M4 21a8 8 0 0 1 16 0'), customer.firstChild);
    var label = customer.querySelector('span:last-child');
    if (label) label.id = 'posCustomer';
    return customer;
  }

  function decorateCartRows() {
    var items = cartSnapshot();
    document.querySelectorAll('#pagePOS #cartItems .cart-item').forEach(function (row, index) {
      var item = items[index];
      var name = row.querySelector('.ci-name');
      if (!item || !name) return;
      var unit = name.querySelector('.cart-line-unit');
      if (!unit) {
        unit = element('span', 'cart-line-unit');
        name.appendChild(unit);
      }
      var qty = Number(item.qty) || 0;
      unit.textContent = ' ' + qty + (qty === 1 ? ' unidad' : ' unidades');
    });
  }

  function installToolbar(page) {
    var toolbar = page.firstElementChild;
    if (!toolbar || toolbar.classList.contains('pos-commandbar')) return;
    toolbar.classList.add('pos-commandbar');
    toolbar.removeAttribute('style');

    var search = toolbar.querySelector('.pos-search-box');
    if (!search) return;

    var identity = element('div', 'pos-module-identity');
    identity.setAttribute('aria-label', 'Punto de Venta Nuevo Amanecer');

    var menu = element('button', 'pos-menu-button', '☰');
    menu.type = 'button';
    menu.title = 'Volver al menú';
    menu.setAttribute('aria-label', 'Volver al menú');
    menu.addEventListener('click', function () {
      if (typeof root.goMenu === 'function') root.goMenu();
    });

    var mark = element('div', 'pos-module-mark', '🛒');
    mark.setAttribute('aria-hidden', 'true');

    var copy = element('div', 'pos-module-copy');
    copy.append(element('strong', '', 'Nuevo Amanecer'), element('span', '', 'PUNTO DE VENTA'));
    identity.append(menu, mark, copy);
    toolbar.insertBefore(identity, search);

    // Only restyle a direct-child icon span; never match nested .scanner-dot inside #scannerIndicator.
    var searchIcon = search.querySelector(':scope > span:first-child');
    if (searchIcon && searchIcon.id !== 'scannerIndicator') {
      searchIcon.classList.add('pos-search-icon');
      searchIcon.textContent = '⌕';
      searchIcon.removeAttribute('style');
      searchIcon.setAttribute('aria-hidden', 'true');
    }
    var input = search.querySelector('#posSearch');
    if (input) input.placeholder = 'Buscar productos o escanear código...';

    var free = toolbar.querySelector('#btnVentaLibre');
    var cartButton = toolbar.querySelector('.cart-fab');
    var major = toolbar.querySelector('#btnMayorista');
    var actions = element('div', 'pos-toolbar-actions');
    if (free) {
      free.replaceChildren(document.createTextNode('＋ '), element('span', 'free-sale-label', 'VARIOS'));
      actions.appendChild(free);
    }
    if (major) {
      major.classList.add('pos-majorista-btn');
      major.removeAttribute('style');
      major.replaceChildren(document.createTextNode('▣ '), element('span', '', 'Mayor'));
      actions.appendChild(major);
    }
    actions.appendChild(buildCustomerButton());
    if (cartButton) {
      cartButton.type = 'button';
      cartButton.title = 'Ver venta actual';
      cartButton.setAttribute('aria-label', 'Ver venta actual');
      actions.appendChild(cartButton);
    }
    toolbar.appendChild(actions);
  }

  function installCartHead(page) {
    var head = page.querySelector('#cartDrawer .cart-head');
    if (!head || head.querySelector('#posCartSummary')) return;

    var title = head.querySelector('.cart-head-title');
    var actionHost = title && title.nextElementSibling;
    if (!title || !actionHost) return;

    var tag = title.querySelector('#modoMayoristaTag');
    if (tag) tag.remove();
    title.textContent = 'Venta actual';
    if (tag) {
      tag.className = 'cart-mode-tag';
      tag.setAttribute('style', 'display:none');
      title.append(document.createTextNode(' '), tag);
    }

    var copy = element('div', 'cart-head-copy');
    head.insertBefore(copy, title);
    copy.appendChild(title);
    copy.appendChild(element('div', 'cart-head-sub', '0 productos')).id = 'posCartSummary';
    var clear = actionButton('', 'Limpiar', function () { root.limpiarCarrito(); });
    clear.className = 'cart-head-clear'; clear.id = 'posClear';
    clear.insertBefore(lineIcon('M4 7h16 M9 7V4h6v3 M7 7l1 13h8l1-13 M10 11v5 M14 11v5'), clear.firstChild);
    actionHost.insertBefore(clear, actionHost.firstChild);

    actionHost.classList.add('cart-head-actions');
    actionHost.removeAttribute('style');
    var menuWrap = clear.nextElementSibling;
    if (menuWrap) {
      menuWrap.classList.add('cart-menu-wrap');
      menuWrap.removeAttribute('style');
    }
    var dropdown = page.querySelector('#cartMenuDropdown');
    if (dropdown) {
      dropdown.classList.add('cart-menu-dropdown');
      dropdown.setAttribute('style', 'display:none');
      var separator = dropdown.querySelector('div');
      if (separator) {
        separator.className = 'cart-menu-separator';
        separator.removeAttribute('style');
      }
      var danger = dropdown.querySelector('button[onclick="limpiarCarrito()"]');
      if (danger) {
        danger.classList.add('cart-menu-danger');
        danger.removeAttribute('style');
      }
    }

    var closeButtons = actionHost.querySelectorAll('.btn-close-x');
    if (closeButtons.length > 1) {
      closeButtons[closeButtons.length - 1].classList.add('cart-mobile-close');
      closeButtons[closeButtons.length - 1].title = 'Cerrar venta actual';
      closeButtons[closeButtons.length - 1].setAttribute('aria-label', 'Cerrar venta actual');
    }
  }

  function installCartFooter(page) {
    var footer = page.querySelector('#cartDrawer .cart-footer');
    if (!footer || footer.querySelector('.cart-secondary-actions')) return;
    var totals = footer.querySelector('.cart-totals');
    var actions = footer.querySelector('.cart-actions');
    if (!totals || !actions) return;

    var secondary = element('div', 'cart-secondary-actions');
    secondary.setAttribute('aria-label', 'Acciones rápidas de venta');
    var quantityAction = actionButton('', 'Cantidad', function () { editLine('quantity'); });
    quantityAction.insertBefore(lineIcon('M20 13l-7 7-9-9V4h7z M8.5 8.5h.01'), quantityAction.firstChild);
    var discountAction = actionButton('', 'Descuento', function () { if (typeof root.abrirDescuento === 'function') root.abrirDescuento(); });
    discountAction.insertBefore(lineIcon('M19 5L5 19 M7.5 7.5h.01 M16.5 16.5h.01'), discountAction.firstChild);
    var priceAction = actionButton('', 'Cambiar precio', function () { editLine('price'); });
    priceAction.insertBefore(lineIcon('M4 20h4l10-10-4-4L4 16z M13 7l4 4'), priceAction.firstChild);
    secondary.append(quantityAction, discountAction, priceAction);
    ['posQuantity','posDiscount','posPrice'].forEach(function (id, index) { secondary.children[index].id = id; });
    footer.insertBefore(secondary, actions);

    var countLine = element('div', 'cart-count-line');
    var productCount = element('span', '', '0 productos');
    productCount.id = 'posProductCount';
    var unitCount = element('span', '', '0 unidades');
    unitCount.id = 'posUnitCount';
    countLine.append(productCount, unitCount);
    totals.insertBefore(countLine, totals.firstChild);

    var quick = page.querySelector('#btnRapido');
    var pay = page.querySelector('#btnPagar');
    if (quick) {
      var quickIcon = lineIcon('M13 2L4 14h7l-1 8 9-12h-7z');
      quickIcon.classList.add('pay-action-icon');
      quick.replaceChildren(quickIcon, element('span', '', 'Pago rápido'));
    }
    if (pay) {
      var payIcon = lineIcon('M3 6h18v12H3z M3 10h18 M7 15h4');
      payIcon.classList.add('pay-action-icon');
      pay.replaceChildren(payIcon, element('span', '', 'Pagar'));
    }
    var cancel = actions.querySelector('.btn-cancelar-cart');
    if (cancel) cancel.remove();
  }

  function installObservers(page) {
    var products = page.querySelector('#posArea');
    var cartItems = page.querySelector('#cartItems');
    var sidebar = page.querySelector('#posSidebar');
    if (typeof MutationObserver !== 'function') return;
    if (products) new MutationObserver(decoratePrices).observe(products, { childList: true, subtree: true });
    if (cartItems) new MutationObserver(updateCartMeta).observe(cartItems, { childList: true, subtree: true });
    if (sidebar) new MutationObserver(decorateCategories).observe(sidebar, { childList: true });
  }

  function wrapRenderers() {
    if (typeof root.abrirCobro === 'function' && !root.abrirCobro.__naReferenceCustomer) {
      var openCheckout = root.abrirCobro;
      root.abrirCobro = function () {
        var result = openCheckout.apply(this, arguments);
        var select = document.getElementById('mVentaCliente');
        if (select && customerId) { select.value = customerId; select.dispatchEvent(new Event('change', { bubbles: true })); }
        return result;
      };
      root.abrirCobro.__naReferenceCustomer = true;
    }
    if (typeof root.posRender === 'function' && !root.posRender.__naReferenceUiWrapped) {
      var originalRender = root.posRender;
      var wrappedRender = function () {
        var result = originalRender.apply(this, arguments);
        decoratePrices();
        return result;
      };
      wrappedRender.__naReferenceUiWrapped = true;
      root.posRender = wrappedRender;
    }

    if (typeof root.posUpdateCart === 'function' && !root.posUpdateCart.__naReferenceUiWrapped) {
      var originalUpdate = root.posUpdateCart;
      var wrappedUpdate = function () {
        var result = originalUpdate.apply(this, arguments);
        updateCartMeta();
        decorateCartRows();
        return result;
      };
      wrappedUpdate.__naReferenceUiWrapped = true;
      root.posUpdateCart = wrappedUpdate;
    }
  }

  function install() {
    var page = document.getElementById('pagePOS');
    if (!page || page.dataset.naReferenceUi === '1') return;
    page.dataset.naReferenceUi = '1';
    installToolbar(page);
    installCartHead(page);
    installCartFooter(page);
    wrapRenderers();
    installObservers(page);
    decoratePrices();
    updateCartMeta();
    decorateCartRows();
    decorateCategories();
    var customer = document.getElementById('mVentaCliente');
    if (customer) customer.addEventListener('change', function () { customerId = customer.value; syncCustomer(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})(globalThis);


/* CANON-POS-REFERENCE-FIDELITY-002 · responsive real + estado operativo */
(function (root) {
  'use strict';

  function page() {
    return document.getElementById('pagePOS');
  }

  function phoneDevice() {
    try {
      var shortSide = Math.min(Number(root.screen && root.screen.width) || 9999, Number(root.screen && root.screen.height) || 9999);
      var coarse = typeof root.matchMedia === 'function' ? root.matchMedia('(pointer: coarse)').matches : false;
      return shortSide <= 600 && coarse;
    } catch (_) {
      return false;
    }
  }

  function syncDeviceClass() {
    document.body.classList.toggle('na-pos-phone-device', phoneDevice());
  }

  function syncPageClass() {
    var pos = page();
    document.body.classList.toggle('na-pos-reference-active', !!(pos && pos.classList.contains('active')));
  }

  function syncAllCategoryLabel() {
    var first = document.querySelector('#pagePOS #posSidebar .cat-btn[data-cat="todo"]');
    if (!first) return;
    var wide = !phoneDevice() && root.innerWidth >= 1280;
    var desired = wide ? 'Todas las categorías' : 'Todo';
    var textNode = Array.prototype.find.call(first.childNodes, function (node) {
      return node.nodeType === Node.TEXT_NODE && String(node.nodeValue || '').trim();
    });
    if (textNode && String(textNode.nodeValue || '').trim() !== desired) textNode.nodeValue = desired;
  }

  function installRuntimeStatus() {
    var toolbar = document.querySelector('#pagePOS .pos-commandbar');
    var actions = toolbar && toolbar.querySelector('.pos-toolbar-actions');
    if (!actions) return;

    var mirror = document.getElementById('posRuntimeStatus');
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.id = 'posRuntimeStatus';
      mirror.className = 'pos-runtime-status';
      mirror.setAttribute('role', 'status');
      mirror.setAttribute('aria-live', 'polite');

      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');
      var label = document.createElement('span');
      label.className = 'label';
      mirror.append(dot, label);
      actions.insertBefore(mirror, actions.firstChild);
    }

    var source = document.getElementById('localStatus');
    function sync() {
      var state = source ? source.getAttribute('data-state') || 'disconnected' : 'disconnected';
      var label = mirror.querySelector('.label');
      mirror.setAttribute('data-state', state);
      if (label) label.textContent = state === 'connected' ? 'Online' : state === 'update' ? 'Actualizar' : 'Sin conexión';
      mirror.title = source ? (source.getAttribute('title') || label.textContent) : 'Estado de conexión';
    }
    sync();

    if (source && typeof MutationObserver === 'function' && !source.__naReferenceStatusObserver) {
      source.__naReferenceStatusObserver = new MutationObserver(sync);
      source.__naReferenceStatusObserver.observe(source, { attributes: true, attributeFilter: ['data-state', 'title', 'aria-label'], childList: true, subtree: true });
    }
  }

  function enhance() {
    syncDeviceClass();
    syncPageClass();
    syncAllCategoryLabel();
    installRuntimeStatus();
  }

  function observePage() {
    var pos = page();
    if (!pos || typeof MutationObserver !== 'function' || pos.__naReferencePageObserver) return;
    pos.__naReferencePageObserver = new MutationObserver(function () {
      syncPageClass();
    });
    pos.__naReferencePageObserver.observe(pos, { attributes: true, attributeFilter: ['class'] });
  }

  function start() {
    enhance();
    observePage();
    root.addEventListener('resize', function () {
      syncDeviceClass();
      syncAllCategoryLabel();
    }, { passive: true });
    root.addEventListener('orientationchange', function () {
      setTimeout(function () {
        syncDeviceClass();
        syncAllCategoryLabel();
      }, 50);
    }, { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(globalThis);
