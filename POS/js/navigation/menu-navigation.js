(function (root) {
  'use strict';

  if (typeof document === 'undefined') return;

  var MOBILE_HOME_MAX_WIDTH = 767;
  // Ancho guardado: se actualiza al cambiar el tamaño, sin leer el layout en cada navegación.
  var naVw = Number(root.innerWidth || 0);
  if (typeof root.addEventListener === 'function') root.addEventListener('resize', function () { naVw = Number(root.innerWidth || 0); }, { passive: true });
  var ALLOWED_PAGES = Object.freeze([
    'pagePOS',
    'pageInventario',
    'pageCodigosDuplicados',
    'pageVentas',
    'pageClientes',
    'pageReporteDeuda',
    'pageCaja',
    'pageGastos',
    'pageProximamente',
    'pageValorizacion',
    'pageRotacionAbc',
    'pageKardex',
    'pageVentasStock',
    'pageReporteArqueo',
    'pageHistorialCompras',
    'pageClienteHistorial',
    'pageConfig'
  ]);
  var MOBILE_SCROLL_PAGES = Object.freeze({
    pageInventario:true,
    pageClientes:true,
    pageVentas:true,
    pageCaja:true,
    pageGastos:true
  });
  var allowed = Object.create(null);
  ALLOWED_PAGES.forEach(function (id) { allowed[id] = true; });

  var activeTouch = null;
  var suppressClick = null;
  var mobileActivityObserver = null;
  var mobileHomeObserver = null;
  var landscapeTimer = null;
  var mobileMoneyOriginals = Object.create(null);
  var MOVE_TOLERANCE_PX = 12;
  var SYNTHETIC_CLICK_WINDOW_MS = 900;

  function now() {
    return root.performance && typeof root.performance.now === 'function'
      ? root.performance.now()
      : Date.now();
  }

  function isMobile() {
    return naVw <= MOBILE_HOME_MAX_WIDTH;
  }

  function pageForCard(card) {
    if (!card || typeof card.getAttribute !== 'function') return null;
    var dataPage = card.getAttribute('data-page');
    if (dataPage && allowed[dataPage]) return dataPage;

    var inline = card.getAttribute('onclick') || '';
    var match = inline.match(/goPage\(\s*['"]([^'"]+)['"]\s*\)/);
    return match && allowed[match[1]] ? match[1] : null;
  }

  function cardFromTarget(target) {
    if (!target || typeof target.closest !== 'function') return null;
    var card = target.closest('.module-card');
    if (!card || typeof card.closest !== 'function') return null;
    return card.closest('#pageMenu') ? card : null;
  }

  function stopEvent(event) {
    if (!event) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
  }

  function paintThen(callback) {
    var raf = typeof root.requestAnimationFrame === 'function'
      ? root.requestAnimationFrame.bind(root)
      : function (cb) { return root.setTimeout(cb, 16); };
    raf(function () { raf(callback); });
  }

  function scheduleRenderer(pageId) {
    var run = function () {
      if (typeof root._naSchedulePageRender === 'function') {
        root._naSchedulePageRender(pageId);
      }
    };
    if (typeof root.requestIdleCallback === 'function') {
      root.requestIdleCallback(run, { timeout: 700 });
    } else {
      root.setTimeout(run, 80);
    }
  }

  function persistVisiblePage(target) {
    if (!target || !target.classList || !target.classList.contains('active')) return;
    if (typeof root.saveAppState !== 'function') return;
    try {
      var pending = root.saveAppState();
      if (pending && typeof pending.catch === 'function') pending.catch(function () {});
    } catch (_) {}
  }

  function scheduleClientScrollMotion(pageId, target) {
    if (pageId !== 'pageClientes') return;

    var run = function () {
      if (!target || !target.classList || !target.classList.contains('active')) return;
      if (!document.body || !document.body.classList.contains('module-mobile-scroll')) return;

      var motion = root.NA_MOTION;
      if (!motion || !motion.scroll || typeof motion.scroll.enablePreset !== 'function') return;

      try {
        var controller = motion.scroll.enablePreset('clientes');
        if (controller && typeof controller.sync === 'function') controller.sync();
      } catch (_) {
        // Motion is optional. Navigation and rendering must remain usable even
        // when the visual runtime is unavailable on a phone.
      }
    };

    if (typeof root.requestIdleCallback === 'function') {
      root.requestIdleCallback(run, { timeout: 900 });
    } else {
      root.setTimeout(run, 120);
    }
  }

  function mobileSafeNavigate(pageId) {
    if (!allowed[pageId]) return false;
    var target = document.getElementById(pageId);
    if (!target) return false;

    root.NA_MOBILE_SAFE_NAV_ACTIVE = true;

    document.documentElement.classList.remove('config-page-scroll', 'cfg-menu-lock');
    if (document.body) {
      document.body.classList.remove('config-page-scroll', 'module-mobile-scroll');
    }

    document.querySelectorAll('.page').forEach(function (page) {
      page.classList.remove('active');
    });
    target.classList.add('active');
    // El diseño final de la página (p. ej. cabecera compacta de Clientes en celular) se aplica
    // antes del primer pintado: si se agregaba después, la cabecera se reacomodaba (CLS 0,12).
    if (document.body && MOBILE_SCROLL_PAGES[pageId]) {
      document.body.classList.add('module-mobile-scroll');
    }

    var back = document.getElementById('backBtn');
    if (back) back.style.display = 'block';

    try { root.scrollTo(0, 0); } catch (_) {}

    paintThen(function () {
      if (!target.classList.contains('active')) return;

      var configMode = pageId === 'pageConfig' && Number(root.innerWidth || 0) <= 960;
      if (configMode) {
        document.documentElement.classList.add('config-page-scroll');
        if (document.body) document.body.classList.add('config-page-scroll');
      }

      // Persist only after the destination has painted so storage work never
      // competes with the visual page switch on mobile.
      persistVisiblePage(target);
      scheduleRenderer(pageId);
      scheduleClientScrollMotion(pageId, target);
    });

    return true;
  }

  function navigate(pageId) {
    if (!allowed[pageId]) return false;
    if (isMobile()) return mobileSafeNavigate(pageId);
    if (typeof root.goPage !== 'function') return false;
    root.goPage(pageId);
    return true;
  }

  function activateCard(card, event) {
    var pageId = pageForCard(card);
    if (!pageId) return false;
    stopEvent(event);
    return navigate(pageId);
  }

  function prepareCards(menu) {
    if (!menu || typeof menu.querySelectorAll !== 'function') return;
    menu.querySelectorAll('.module-card').forEach(function (card) {
      var pageId = pageForCard(card);
      if (!pageId) return;
      card.setAttribute('data-page', pageId);
      card.setAttribute('role', 'button');
      if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '0');
      if (!card.hasAttribute('aria-label')) {
        var label = card.querySelector && card.querySelector('.module-label');
        var name = label && label.textContent ? label.textContent.trim() : pageId;
        card.setAttribute('aria-label', 'Abrir ' + name);
      }
    });
  }

  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function ensureMobileStylesheet() {
    if (!isMobile() || typeof document.createElement !== 'function') return false;
    var head = document.head || (document.querySelector && document.querySelector('head'));
    if (!head || typeof head.appendChild !== 'function') return false;
    if (!document.getElementById('naMobileHomeBaseStyles') && !document.getElementById('naMobileHomeStyles')) {
      var link = node('link');
      link.id = 'naMobileHomeStyles';
      link.rel = 'stylesheet';
      link.href = 'css/canon-mobile-home.css';
      head.appendChild(link);
    }
    if (!document.getElementById('naMobileDrawerStyles')) {
      var drawerLink = node('link');
      drawerLink.id = 'naMobileDrawerStyles';
      drawerLink.rel = 'stylesheet';
      drawerLink.href = 'css/mobile-drawer.css';
      head.appendChild(drawerLink);
    }
    return true;
  }

  function insertAfter(reference, element) {
    if (!reference || !reference.parentNode) return;
    reference.parentNode.insertBefore(element, reference.nextSibling);
  }

  function closeMobileDrawer() {
    var drawer = document.getElementById('naMobileDrawer');
    var overlay = document.getElementById('naMobileDrawerOverlay');
    var toggle = document.getElementById('naMobileMenuToggle');
    var wasOpen = drawer && drawer.classList.contains('is-open');
    if (drawer) {
      drawer.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
      // Cerrado = fuera de pantalla: sin foco ni clics accidentales.
      drawer.inert = true;
    }
    if (overlay) overlay.classList.remove('is-open');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      if (wasOpen && isMobile()) toggle.focus();
    }
    if (document.body && document.body.classList) document.body.classList.remove('na-mobile-drawer-open');
  }

  function openMobileDrawer() {
    if (!isMobile()) return;
    var drawer = document.getElementById('naMobileDrawer');
    var overlay = document.getElementById('naMobileDrawerOverlay');
    var toggle = document.getElementById('naMobileMenuToggle');
    if (!drawer || !overlay) return;
    refreshMobileProfile();
    renderDrawerItems();
    drawer.inert = false;
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    overlay.classList.add('is-open');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    var first = drawer.querySelector('button');
    if (first) first.focus();
    if (document.body && document.body.classList) document.body.classList.add('na-mobile-drawer-open');
  }

  function showMobileHome() {
    closeMobileDrawer();
    if (typeof root.goMenu === 'function') {
      root.goMenu();
    } else {
      document.querySelectorAll('.page').forEach(function (page) { page.classList.remove('active'); });
      var menu = document.getElementById('pageMenu');
      if (menu) menu.classList.add('active');
      var back = document.getElementById('backBtn');
      if (back) back.style.display = 'none';
    }
    refreshMobileActivity();
  }

  function navigateFromMobileHome(pageId) {
    closeMobileDrawer();
    if (root.NA_MENU_NAVIGATION && typeof root.NA_MENU_NAVIGATION.navigate === 'function') {
      return root.NA_MENU_NAVIGATION.navigate(pageId);
    }
    return navigate(pageId);
  }

  function drawerItem(label, icon, pageId, description) {
    var button = node('button', 'na-mobile-drawer-link');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.setAttribute('data-page', pageId);
    var iconNode = node('span', 'na-mobile-drawer-icon');
    iconNode.setAttribute('data-icon', icon);
    iconNode.setAttribute('aria-hidden', 'true');
    button.appendChild(iconNode);
    var copy = node('span', 'na-mobile-drawer-label');
    copy.appendChild(node('strong', '', label));
    copy.appendChild(node('small', '', description));
    button.appendChild(copy);
    var chevron = node('span', 'na-mobile-drawer-chevron', '›');
    chevron.setAttribute('aria-hidden', 'true');
    button.appendChild(chevron);
    button.addEventListener('click', function () {
      if (pageId === 'pageMenu') showMobileHome();
      else navigateFromMobileHome(pageId);
    });
    return button;
  }

  function canShowDrawerPage(pageId) {
    var roles = root.NA_ROLES;
    // Unknown or unconfirmed identities get the restricted menu; isOwner() already requires a confirmed cloud role.
    var role = roles && typeof roles.isOwner === 'function' && roles.isOwner() ? 'owner' : 'empleado';
    if (pageId === 'pageMenu') return true;
    // The shared table (POS/js/config/pos-permissions.js, PR #668) plugs in here automatically.
    if (root.NA_PERMISSIONS && typeof root.NA_PERMISSIONS.canAccessScreen === 'function') {
      return root.NA_PERMISSIONS.canAccessScreen(role, pageId);
    }
    return (pageId !== 'pageConfig' && pageId !== 'pageGastos' && pageId !== 'pageProximamente' && pageId !== 'pageValorizacion' && pageId !== 'pageRotacionAbc' && pageId !== 'pageKardex' && pageId !== 'pageVentasStock' && pageId !== 'pageReporteArqueo' && pageId !== 'pageReporteDeuda' && pageId !== 'pageCodigosDuplicados' && pageId !== 'pageHistorialCompras' && pageId !== 'pageClienteHistorial') || role === 'owner';
  }

  function renderDrawerItems() {
    var drawer = document.getElementById('naMobileDrawer');
    var navigation = drawer && drawer.querySelector('.na-mobile-drawer-nav');
    if (!navigation || !isMobile()) return;
    while (navigation.firstChild) navigation.removeChild(navigation.firstChild);
    [
      ['Inicio', 'home', 'pageMenu', 'Resumen del día'],
      ['Nueva venta', 'sale', 'pagePOS', 'Punto de venta'],
      ['Ventas', 'sales', 'pageVentas', 'Historial y comprobantes'],
      ['Inventario', 'stock', 'pageInventario', 'Productos, stock e ingresos'],
      ['Clientes', 'search', 'pageClientes', 'Saldos, créditos y abonos'],
      ['Caja', 'cash', 'pageCaja', 'Abrir, cerrar y movimientos'],
      ['Gastos', 'expense', 'pageGastos', 'Registrar y consultar gastos'],
      ['Próximamente', 'soon', 'pageProximamente', 'Funciones en preparación'],
      ['Configuración', 'settings', 'pageConfig', 'Negocio, usuarios y equipos']
    ].forEach(function (item) {
      if (document.getElementById(item[2]) && canShowDrawerPage(item[2])) {
        navigation.appendChild(drawerItem(item[0], item[1], item[2], item[3]));
      }
    });
    updateDrawerSelection();
  }

  function updateDrawerSelection() {
    var active = document.querySelector('.page.active');
    var current = active ? active.id : 'pageMenu';
    document.querySelectorAll('.na-mobile-drawer-link').forEach(function (button) {
      if (button.getAttribute('data-page') === current) {
        button.setAttribute('aria-current', 'page');
      } else button.removeAttribute('aria-current');
    });
  }

  function refreshMobileProfile() {
    // Read the loaded identity directly; cashier helpers can normalize/write config.
    var config = typeof appConfig !== 'undefined' ? appConfig : root.appConfig;
    var cash = typeof cajEstado !== 'undefined' ? cajEstado : root.cajEstado;
    var cashDetail = document.getElementById('qsCajaSub');
    if (cashDetail) cashDetail.setAttribute('data-state', cash && cash.abierta && !cash.cerrada ? 'open' : 'closed');
    var ref = cash && cash.abierta && !cash.cerrada ? cash.cajeroId : config && config.activeCashierId;
    var cashiers = config && Array.isArray(config.cashiers) ? config.cashiers : [];
    var actor = cashiers.find(function (entry) { return entry && String(entry.id) === String(ref); });
    var name = actor && actor.nombre ? String(actor.nombre) : '';
    var heading = document.getElementById('naMobileGreeting');
    if (heading) heading.textContent = name ? 'Hola, ' + name.trim().split(/\s+/)[0] : 'Hola';
    var profile = document.getElementById('naMobileProfileName');
    var roles = root.NA_ROLES;
    var profileName = roles && roles.label ? String(roles.label) : name || 'Usuario';
    if (profile) profile.textContent = profileName;
    var avatar = document.getElementById('naMobileProfileAvatar');
    if (avatar) avatar.textContent = profileName.trim().split(/\s+/).filter(Boolean).map(function (part) { return part.charAt(0); }).slice(0, 2).join('').toUpperCase();
    var role = document.getElementById('naMobileProfileRole');
    var roleLabel = 'Verificando permisos…';
    if (roles && typeof roles.isOwner === 'function' && roles.isOwner()) roleLabel = 'Dueño';
    else if (roles && roles.confirmed && roles.role === 'empleado') roleLabel = 'Empleado';
    if (role) role.textContent = roleLabel;
  }

  function updateDrawerVersion() {
    var version = document.getElementById('naMobileDrawerVersion');
    if (!version) return;
    var info = root.NA_BUILD_INFO;
    version.textContent = 'Versión local';
    if (!info || !info.hash || info.hash.indexOf('__') === 0) return;
    var date = new Date(info.date);
    if (isNaN(date.getTime())) return;
    version.textContent = 'Versión ' + info.hash.slice(0, 7) + ' · ' + date.toLocaleDateString('es-PE', { timeZone:'America/Lima', day:'2-digit', month:'2-digit', year:'numeric' });
  }

  function loadDrawerBuildInfo() {
    updateDrawerVersion();
    if (root.NA_BUILD_INFO || document.getElementById('naBuildInfoScript')) return;
    var script = node('script');
    script.id = 'naBuildInfoScript';
    script.src = 'js/config/build-info.js';
    script.onload = updateDrawerVersion;
    document.body.appendChild(script);
  }

  function createMobileLandscape() {
    var scene = node('div', 'na-mobile-landscape');
    scene.id = 'naMobileLandscape';
    scene.setAttribute('aria-hidden', 'true');
    ['sun','moon','stars','cloud','cloud cloud-far','hill hill-back','hill hill-front','trees','flowers'].forEach(function (layer) {
      scene.appendChild(node('span', 'na-landscape-' + layer));
    });
    return scene;
  }

  function updateMobileLandscape() {
    var scene = document.getElementById('naMobileLandscape');
    if (!scene || !isMobile()) return;
    var date = new Date();
    var hour = date.getHours() + date.getMinutes() / 60;
    var phase = hour >= 5 && hour < 8 ? 'dawn' : hour >= 8 && hour < 17 ? 'day' : hour >= 17 && hour < 19 ? 'dusk' : hour >= 19 && hour < 22 ? 'night' : 'midnight';
    var month = date.getMonth();
    scene.setAttribute('data-phase', phase);
    scene.setAttribute('data-season', month === 11 || month < 2 ? 'summer' : month < 5 ? 'autumn' : month < 8 ? 'winter' : 'spring');
    // Interpolate local sky/hill colors throughout the day, including midnight wrap.
    var frames = [
      [0,[24,53,80],[61,111,139],[41,107,121]],
      [5,[224,234,242],[174,220,216],[109,190,177]],
      [7,[250,238,215],[177,226,219],[114,199,182]],
      [12,[224,247,252],[175,229,222],[109,196,183]],
      [17,[246,225,215],[170,191,212],[120,179,182]],
      [19,[112,151,180],[94,152,165],[62,131,143]],
      [22,[24,53,80],[61,111,139],[41,107,121]],
      [24,[24,53,80],[61,111,139],[41,107,121]]
    ];
    var index = 0;
    while (index < frames.length - 2 && hour >= frames[index + 1][0]) index++;
    var from = frames[index], to = frames[index + 1];
    var ratio = (hour - from[0]) / (to[0] - from[0]);
    ['--landscape-sky','--landscape-back','--landscape-front'].forEach(function (property, i) {
      var color = from[i + 1].map(function (channel, c) { return Math.round(channel + (to[i + 1][c] - channel) * ratio); });
      scene.style.setProperty(property, 'rgb(' + color.join(',') + ')');
    });
    var daylight = hour >= 5 && hour < 19;
    scene.style.setProperty('--sun-y', (daylight ? 52 - Math.sin((hour - 5) / 14 * Math.PI) * 36 : 65) + 'px');
  }

  function syncMobileLandscape() {
    if (landscapeTimer !== null) { root.clearInterval(landscapeTimer); landscapeTimer = null; }
    var scene = document.getElementById('naMobileLandscape');
    var menu = document.getElementById('pageMenu');
    var running = isMobile() && !document.hidden && menu && menu.classList.contains('active');
    if (scene) scene.setAttribute('data-motion', running ? 'running' : 'paused');
    if (!running) return;
    updateMobileLandscape();
    // Los colores iniciales se aplican sin transición; las de 5 s quedan para los cambios de hora.
    if (scene && !scene.hasAttribute('data-landscape-ready')) {
      var raf = typeof root.requestAnimationFrame === 'function' ? root.requestAnimationFrame.bind(root) : function (cb) { return root.setTimeout(cb, 16); };
      raf(function () { raf(function () { scene.setAttribute('data-landscape-ready', ''); }); });
    }
    landscapeTimer = root.setInterval(updateMobileLandscape, 60000);
  }

  function saleRows() {
    var rows = typeof ventas !== 'undefined' && Array.isArray(ventas) ? ventas : root.ventas;
    return Array.isArray(rows) ? rows : [];
  }

  function saleStamp(sale) {
    if (!sale || sale.canonicalDateKnown === false) return 0;
    var raw = sale.timestamp || sale.createdAt || sale.fechaCreacion || '';
    // Naive legacy dates belong to the store's Lima timezone.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw)) raw += '-05:00';
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw += 'T00:00:00-05:00';
    var parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
    var date = String(sale.fecha || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
    var time = typeof _naParseTime24 === 'function' ? _naParseTime24(sale.hora24 || sale.hora) : sale.hora24;
    parsed = Date.parse(date + 'T' + (time || '00:00:00') + '-05:00');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function activityWhen(source, stamp) {
    if (!stamp || source.canonicalDateKnown === false) return 'Fecha y hora no registradas';
    var date = new Date(stamp);
    var label = date.toLocaleDateString('es-PE', { timeZone:'America/Lima', weekday:'long' }) + ', ' + date.toLocaleDateString('es-PE', { timeZone:'America/Lima', day:'2-digit', month:'2-digit', year:'numeric' });
    var knownTime = /[T ]\d{2}:\d{2}/.test(String(source.timestamp || source.createdAt || source.fechaCreacion || '')) || !!(source.hora24 || source.hora);
    return label + ' · ' + (knownTime ? date.toLocaleTimeString('en-US', { timeZone:'America/Lima', hour:'2-digit', minute:'2-digit', hour12:true }) : 'Hora no registrada');
  }

  function saleAmount(sale) {
    if (!sale) return 0;
    if (typeof totalV === 'function') {
      try { return Number(totalV(sale)) || 0; } catch (_) {}
    }
    return Number(sale.total || sale.monto || 0) || 0;
  }

  var moneyFormat = null;
  function money(value) {
    var amount = Number(value);
    amount = Number.isFinite(amount) ? amount : 0;
    if (!moneyFormat && typeof Intl !== 'undefined' && Intl.NumberFormat) {
      try { moneyFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }); } catch (_) { moneyFormat = null; }
    }
    return 'S/ ' + (moneyFormat ? moneyFormat.format(amount) : amount.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }));
  }

  function syncMobileMoney() {
    ['qsVentas','qsCaja','qsPorCobrar'].forEach(function (id) {
      var element = document.getElementById(id);
      if (!element) return;
      var text = element.textContent;
      var original = mobileMoneyOriginals[id];
      if (!isMobile()) {
        if (original && text === original.formatted) element.textContent = original.raw;
        delete mobileMoneyOriginals[id];
        return;
      }
      if (original && text === original.formatted) return;
      var numeric = text.replace(/^S\/\s*/, '').replace(/,/g, '').trim();
      if (!/^-?\d+(\.\d+)?$/.test(numeric)) return;
      var formatted = money(Number(numeric));
      mobileMoneyOriginals[id] = { raw:text, formatted:formatted };
      if (text !== formatted) element.textContent = formatted;
    });
  }

  function activityClient(movement) {
    if (movement.clienteNombre) return String(movement.clienteNombre);
    var credits = typeof creditos !== 'undefined' && Array.isArray(creditos) ? creditos : [];
    var credit = credits.find(function (item) { return String(item.id) === String(movement.creditoId); });
    if (credit && credit.clienteNombre) return String(credit.clienteNombre);
    var clientId = movement.clienteId || (credit && (credit.clienteId || credit.cliId));
    var customers = typeof clientes !== 'undefined' && Array.isArray(clientes) ? clientes : [];
    var customer = clientId && customers.find(function (item) { return String(item.id) === String(clientId); });
    return customer ? String(customer.nombre || '') : String(movement.desc || 'Movimiento de caja');
  }

  function activityRow(icon, title, detail, amount, tone, when) {
    var row = node('div', 'na-mobile-activity-row' + (tone ? ' is-' + tone : ''));
    var iconNode = node('span', 'na-mobile-activity-icon');
    iconNode.setAttribute('data-icon', icon);
    iconNode.setAttribute('aria-hidden', 'true');
    var copy = node('span', 'na-mobile-activity-copy');
    copy.appendChild(node('strong', '', title));
    copy.appendChild(node('small', '', detail));
    if (when) copy.appendChild(node('small', 'na-mobile-activity-time', when));
    row.appendChild(iconNode);
    row.appendChild(copy);
    if (amount) row.appendChild(node('span', 'na-mobile-activity-value', amount));
    return row;
  }

  // P2-1: the Inicio activity list is only built while Inicio is on screen. Updates that
  // arrive on other pages (each abono, cierre, search keystroke) just mark it dirty; the
  // #pageMenu class observer rebuilds it when the cashier returns to Inicio.
  var mobileActivityDirty = false;
  function homeOnScreen() {
    var menu = document.getElementById('pageMenu');
    return !menu || !menu.classList || menu.classList.contains('active');
  }
  function activityRecord(record) {
    var source = record.source;
    if (record.sale) {
      var credit = source.metodo === 'credito' || source.metodoPago === 'credito' || source.estado === 'credito';
      return { icon:credit ? 'people' : 'sale', tone:credit ? 'credit' : 'sale', title:(credit ? 'Venta a crédito ' : 'Venta ') + String(source.id || source.ventaId || 'reciente').replace(/^V-/, '#'), detail:String(source.clienteNombre || source.customerName || 'Consumidor final'), amount:money(saleAmount(source)) };
    }
    var payment = source.tipo === 'cob';
    var expense = source.tipo === 'gas' || source.tipo === 'egr';
    return { icon:payment ? 'payment' : expense ? 'expense' : 'cash', tone:payment ? 'payment' : expense ? 'expense' : 'cash', title:payment ? 'Abono registrado' : expense ? 'Egreso registrado' : 'Ingreso de caja', detail:activityClient(source), amount:money(source.monto) };
  }
  // Coalesce bursts (observer mutations, canonical updates) into one refresh per frame.
  var mobileActivityScheduled = false;
  function scheduleMobileActivity() {
    if (mobileActivityScheduled) return;
    mobileActivityScheduled = true;
    var run = function () { mobileActivityScheduled = false; refreshMobileActivity(); };
    if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(run); else root.setTimeout(run, 16);
  }
  function refreshMobileActivity() {
    syncMobileMoney();
    if (!isMobile()) return;
    refreshMobileProfile();
    updateDrawerSelection();
    if (!homeOnScreen()) { mobileActivityDirty = true; return; }
    mobileActivityDirty = false;
    var list = document.getElementById('naMobileActivityList');
    if (!list || typeof list.replaceChildren !== 'function') return;
    // Sort on the timestamp only; names and amounts are formatted for the 6 shown rows.
    var records = saleRows().filter(function (sale) { return sale && !sale.anulada; }).map(function (sale) {
      return { source:sale, stamp:saleStamp(sale), sale:true };
    });
    var movements = typeof cajMovs !== 'undefined' ? cajMovs : root.cajMovs;
    (Array.isArray(movements) ? movements : []).forEach(function (movement) {
      // Cash projection already contains sales. Show each sale only once.
      if (!movement || movement.ventaId || movement.anulado) return;
      records.push({ source:movement, stamp:saleStamp(movement), sale:false });
    });
    records.sort(function (a, b) { return b.stamp - a.stamp; });
    var fragment = document.createDocumentFragment ? document.createDocumentFragment() : node('div');
    records.slice(0, 6).forEach(function (entry) {
      var record = activityRecord(entry);
      fragment.appendChild(activityRow(record.icon, record.title, record.detail, record.amount, record.tone, activityWhen(entry.source, entry.stamp)));
    });
    if (!records.length) fragment.appendChild(activityRow('sale', 'Sin movimientos recientes', 'La actividad aparecerá aquí al registrar movimientos.', '', 'muted'));
    list.replaceChildren(fragment);
  }

  function ensureMobileHome() {
    if (!isMobile() || typeof document.createElement !== 'function' || !document.body) return false;
    ensureMobileStylesheet();
    var page = document.getElementById('pageMenu');
    if (!page || typeof page.querySelector !== 'function') return false;
    var scroll = page.querySelector('.main-scroll.home-shell');
    var stats = page.querySelector('.quick-stats');
    if (!scroll || !stats) return false;

    if (!document.getElementById('naMobileWelcome')) {
      var welcome = node('section', 'na-mobile-welcome');
      welcome.id = 'naMobileWelcome';
      var welcomeCopy = node('div', 'na-mobile-welcome-copy');
      var greeting = node('h1', '', 'Hola');
      greeting.id = 'naMobileGreeting';
      welcomeCopy.appendChild(greeting);
      welcomeCopy.appendChild(node('p', '', '¿Qué quieres hacer hoy?'));
      welcome.appendChild(welcomeCopy);
      welcome.appendChild(createMobileLandscape());
      var summaryLabel = null;
      Array.prototype.forEach.call(page.querySelectorAll('.section-label'), function (label) {
        var text = String(label.textContent || '').trim().toLowerCase();
        if (text === 'resumen') summaryLabel = label;
        if (text === 'módulos principales') label.classList.add('menu-modules-label');
      });
      scroll.insertBefore(welcome, summaryLabel || scroll.firstChild);
    }

    if (!document.getElementById('naMobileActivity')) {
      var activitySection = node('section', 'na-mobile-home-section na-mobile-activity');
      activitySection.id = 'naMobileActivity';
      var activityHead = node('div', 'na-mobile-section-head');
      activityHead.appendChild(node('h2', '', 'Actividad reciente'));

      activitySection.appendChild(activityHead);
      var list = node('div', 'na-mobile-activity-list');
      list.id = 'naMobileActivityList';
      activitySection.appendChild(list);
      insertAfter(stats, activitySection);
    }

    if (!document.getElementById('naMobileMenuToggle')) {
      var topbar = document.querySelector && document.querySelector('.g-topbar');
      if (topbar && typeof topbar.insertBefore === 'function') {
        var toggle = node('button', 'na-mobile-menu-toggle', ''); var tic = root.document.createElement('i'); tic.className = 'na-ic na-ic-menu'; tic.setAttribute('aria-hidden', 'true'); toggle.appendChild(tic);
        toggle.id = 'naMobileMenuToggle';
        toggle.type = 'button';
        toggle.setAttribute('aria-label', 'Abrir menú principal');
        toggle.setAttribute('aria-controls', 'naMobileDrawer');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', openMobileDrawer);
        topbar.insertBefore(toggle, topbar.firstChild);
      }
    }

    if (!document.getElementById('naMobileDrawerOverlay')) {
      var overlay = node('div', 'na-mobile-drawer-overlay');
      overlay.id = 'naMobileDrawerOverlay';
      overlay.addEventListener('click', closeMobileDrawer);
      document.body.appendChild(overlay);
    }

    if (!document.getElementById('naMobileDrawer')) {
      var drawer = node('aside', 'na-mobile-drawer na-drawer-v2');
      drawer.id = 'naMobileDrawer';
      drawer.setAttribute('aria-label', 'Navegación principal');
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-modal', 'true');
      drawer.setAttribute('aria-hidden', 'true');
      drawer.inert = true;

      var drawerHead = node('div', 'na-mobile-drawer-head');
      // Same sun mark as the top bar logo (styled via .na-mobile-drawer-brand-icon).
      var logo = node('span', 'na-mobile-drawer-logo na-mobile-drawer-brand-icon');
      logo.setAttribute('aria-hidden', 'true');
      drawerHead.appendChild(logo);
      var brand = node('div', 'na-mobile-drawer-brand');
      var businessName = document.getElementById('topBusinessName');
      var businessSub = document.getElementById('topBusinessSub');
      brand.appendChild(node('strong', '', businessName && businessName.textContent.trim() || 'Nuevo Amanecer'));
      brand.appendChild(node('span', '', businessSub && businessSub.textContent.trim() || 'Sistema de gestión comercial'));
      drawerHead.appendChild(brand);
      var close = node('button', 'na-mobile-drawer-close', '✕');
      close.type = 'button';
      close.setAttribute('aria-label', 'Cerrar menú');
      close.addEventListener('click', closeMobileDrawer);
      drawerHead.appendChild(close);
      drawer.appendChild(drawerHead);

      var profile = node('div', 'na-mobile-profile');
      var avatar = node('span', 'na-mobile-profile-avatar');
      avatar.id = 'naMobileProfileAvatar';
      avatar.setAttribute('aria-hidden', 'true');
      profile.appendChild(avatar);
      var profileCopy = node('div');
      var profileName = node('strong'); profileName.id = 'naMobileProfileName';
      var profileRole = node('small'); profileRole.id = 'naMobileProfileRole';
      profileCopy.appendChild(profileName); profileCopy.appendChild(profileRole);
      profile.appendChild(profileCopy);
      drawer.appendChild(profile);
      var navigation = node('nav', 'na-mobile-drawer-nav');
      drawer.appendChild(navigation);
      var version = node('small', 'na-mobile-drawer-version', 'Versión local');
      version.id = 'naMobileDrawerVersion';
      drawer.appendChild(version);
      document.body.appendChild(drawer);
      loadDrawerBuildInfo();
      renderDrawerItems();
    }

    refreshMobileActivity();
    syncMobileLandscape();
    page.classList.add('na-mobile-ready');
    if (!mobileHomeObserver && root.MutationObserver) {
      mobileHomeObserver = new root.MutationObserver(function () { syncMobileLandscape(); scheduleMobileActivity(); });
      mobileHomeObserver.observe(page, { attributes:true, attributeFilter:['class'] });
    }

    if (!mobileActivityObserver && root.MutationObserver) {
      mobileActivityObserver = new root.MutationObserver(function () { scheduleMobileActivity(); });
      try { mobileActivityObserver.observe(stats, { subtree:true, childList:true, characterData:true }); } catch (_) {}
    }
    return true;
  }

  function bindMobileHomeEvents() {
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', function (event) {
        var drawer = document.getElementById('naMobileDrawer');
        if (!drawer || !drawer.classList.contains('is-open')) return;
        if (event && event.key === 'Escape') closeMobileDrawer();
        if (event && event.key === 'Tab') {
          var buttons = drawer.querySelectorAll('button');
          var first = buttons[0], last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      });
    }
    document.addEventListener('visibilitychange', syncMobileLandscape);
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('na:role', function () {
        if (isMobile()) { renderDrawerItems(); refreshMobileProfile(); }
      });
      root.addEventListener('resize', function () {
        if (!isMobile()) { closeMobileDrawer(); syncMobileMoney(); }
        else ensureMobileHome();
        syncMobileLandscape();
      });
      root.addEventListener('pageshow', function () {
        if (isMobile()) {
          ensureMobileHome();
          refreshMobileActivity();
        }
      });
      root.addEventListener('na:canonical-updated', function () {
        if (isMobile()) scheduleMobileActivity();
      });
    }
  }

  // P2-4/P2-5: with the on-screen keyboard open the modal overlay is sized to the visible
  // area (iOS ignores interactive-widget) so its sticky action bar stays above the keyboard,
  // and the focused field is centred. Layout only: no data, storage or network.
  var keyboardSafeBound = false;
  function bindKeyboardSafeModals() {
    var viewport = root.visualViewport;
    if (keyboardSafeBound || !viewport || typeof viewport.addEventListener !== 'function') return;
    keyboardSafeBound = true;
    var frame = 0;
    function sync() {
      frame = 0;
      var rootStyle = document.documentElement && document.documentElement.style;
      if (!rootStyle) return;
      var layoutHeight = Number(root.innerHeight) || 0, visible = Number(viewport.height) || 0;
      var keyboard = isMobile() && visible > 0 && layoutHeight - visible > 120 && Math.abs((Number(viewport.scale) || 1) - 1) < 0.01;
      if (!keyboard) { rootStyle.removeProperty('--na-visual-height'); return; }
      rootStyle.setProperty('--na-visual-height', Math.round(visible) + 'px');
      var active = document.activeElement;
      if (active && /^(?:INPUT|SELECT|TEXTAREA)$/.test(active.tagName || '') && active.closest && active.closest('.modal-overlay.open') && typeof active.scrollIntoView === 'function') {
        try { active.scrollIntoView({ block:'center' }); } catch (_) { active.scrollIntoView(); }
      }
    }
    viewport.addEventListener('resize', function () { if (!frame) frame = root.requestAnimationFrame(sync); });
  }

  function bind() {
    var menu = document.getElementById('pageMenu');
    if (!menu || menu.getAttribute('data-na-menu-nav-bound') === '1') return;
    menu.setAttribute('data-na-menu-nav-bound', '1');
    prepareCards(menu);
    ensureMobileHome();
    bindMobileHomeEvents();
    bindKeyboardSafeModals();

    menu.addEventListener('pointerdown', function (event) {
      if (!event || event.pointerType === 'mouse') return;
      var card = cardFromTarget(event.target);
      if (!card) return;
      activeTouch = {
        pointerId: event.pointerId,
        card: card,
        x: Number(event.clientX) || 0,
        y: Number(event.clientY) || 0
      };
    }, true);

    menu.addEventListener('pointerup', function (event) {
      if (!activeTouch || !event || event.pointerId !== activeTouch.pointerId) return;
      var touch = activeTouch;
      activeTouch = null;
      var card = cardFromTarget(event.target);
      var dx = Math.abs((Number(event.clientX) || 0) - touch.x);
      var dy = Math.abs((Number(event.clientY) || 0) - touch.y);
      var sameCard = card === touch.card;
      var isTap = sameCard && dx <= MOVE_TOLERANCE_PX && dy <= MOVE_TOLERANCE_PX;
      suppressClick = { card: touch.card, until: now() + SYNTHETIC_CLICK_WINDOW_MS };
      if (isTap) activateCard(touch.card, event);
    }, true);

    menu.addEventListener('pointercancel', function () {
      activeTouch = null;
    }, true);

    menu.addEventListener('click', function (event) {
      var card = cardFromTarget(event.target);
      if (!card) return;

      if (suppressClick && suppressClick.card === card && now() <= suppressClick.until) {
        suppressClick = null;
        stopEvent(event);
        return;
      }
      suppressClick = null;
      activateCard(card, event);
    }, true);

    menu.addEventListener('keydown', function (event) {
      if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;
      var card = cardFromTarget(event.target);
      if (!card) return;
      activateCard(card, event);
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }

  root.NA_MENU_NAVIGATION = Object.freeze({
    bind: bind,
    navigate: navigate,
    mobileSafeNavigate: mobileSafeNavigate,
    openMobileDrawer: openMobileDrawer,
    closeMobileDrawer: closeMobileDrawer,
    canShowDrawerPage: canShowDrawerPage,
    refreshMobileHome: refreshMobileActivity,
    pages: ALLOWED_PAGES.slice()
  });
})(window);
