/* Shared browser and Worker role policy. Unknown identities always fail closed. */
(function (root) {
  'use strict';
  var owner = ['owner'], both = ['owner', 'empleado'];
  var SCREENS = {};
  ['pageMenu', 'pagePOS', 'pageInventario', 'pageVentas', 'pageClientes', 'pageCaja'].forEach(function (id) { SCREENS[id] = both; });
  ['pageGastos', 'pageConfig', 'pageProximamente', 'pageValorizacion', 'ventas:reportes'].forEach(function (id) { SCREENS[id] = owner; });
  var ACTIONS = {};
  ['expense.create', 'expense.update', 'expense.void', 'settings.set', 'product-images.write', 'reports.view', 'devices.manage', 'owner-pin.set', 'pairing-code.create', 'reviews.resolve'].forEach(function (id) { ACTIONS[id] = owner; });
  ['cash.expense', 'sync.write'].forEach(function (id) { ACTIONS[id] = both; });
  var SYNC_ENTITIES = {};
  ['products','sales','sale_items','customers','credits','credit_payments','cash_closures','inventory_movements'].forEach(function (id) { SYNC_ENTITIES[id] = 'sync.write'; });
  SYNC_ENTITIES.expenses = 'cash.expense';
  SYNC_ENTITIES.cash_movements = 'cash.expense';
  var API_ROUTES = [
    { path: '/features/:id', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], roles: both },
    { path: '/auth/reviews', methods: ['GET'], roles: both },
    { path: '/auth/reviews/resolve', methods: ['POST'], roles: owner, action: 'reviews.resolve' },
    { path: '/auth/me', methods: ['GET'], roles: both },
    { path: '/auth/owner-pin', methods: ['POST'], roles: owner, action: 'owner-pin.set' },
    { path: '/auth/owner-approval', methods: ['POST'], roles: both },
    { path: '/auth/pairing-code', methods: ['POST'], roles: owner, action: 'pairing-code.create' },
    { path: '/auth/pair', methods: ['POST'], roles: both },
    { path: '/auth/devices', methods: ['POST'], roles: owner, action: 'devices.manage' },
    { path: '/auth/devices/revoke', methods: ['POST'], roles: owner, action: 'devices.manage' },
    { path: '/settings', methods: ['GET'], roles: both },
    { path: '/settings', methods: ['POST'], roles: owner, action: 'settings.set' },
    { path: '/auth/product-images', methods: ['GET'], roles: both },
    { path: '/auth/product-images', methods: ['POST', 'DELETE'], roles: owner, action: 'product-images.write' },
    { path: '/auth/product-images/item', methods: ['GET'], roles: both },
    { path: '/commands/expense.create', methods: ['POST'], roles: both, action: 'cash.expense' }
  ];
  ['sale.create','cash.open','cash.close','payment.create','payment.batch','credit-account.create','product.create','product.update','customer.create','customer.contact.set','customer.credit-policy.set','inventory.adjust','adjustment.create','compensation.create','sale.annul'].forEach(function (name) { API_ROUTES.push({ path: '/commands/' + name, methods: ['POST'], roles: both }); });
  API_ROUTES.push({ path: '/commands/import.stage', methods: ['POST'], roles: owner });
  API_ROUTES.push({ path: '/auth/dni-lookup', methods: ['POST'], roles: both });
  API_ROUTES.push({ path: '/commands/sale.annul', methods: ['GET'], roles: both });
  ['/auth/session','/auth/record-meta','/auth/sale-annulments'].forEach(function (path) { API_ROUTES.push({ path: path, methods: ['GET'], roles: both }); });
  ['/auth/sale-notes','/auth/purchases'].forEach(function (path) { API_ROUTES.push({ path: path, methods: ['GET','POST'], roles: both }); });
  API_ROUTES.push({ path: '/auth/purchases/close-partial', methods: ['POST'], roles: both });
  API_ROUTES.push({ path: '/sync/operations', methods: ['POST'], roles: both });
  API_ROUTES.push({ path: '/sync/operations/:id', methods: ['GET'], roles: both });
  API_ROUTES.push({ path: '/imports/:id', methods: ['GET'], roles: both });
  ['status','sales','inventory-movements','sales/:id/items'].forEach(function (name) { API_ROUTES.push({ path: '/read/' + name, methods: ['GET'], roles: owner, action: 'reports.view' }); });
  ['status','snapshot','products','customers','credits','credit-payments','credit-accounts','sales','sale-items','inventory-movements','cash-movements','cash-sessions','financial-events'].forEach(function (name) { API_ROUTES.push({ path: '/read/canonical/' + name, methods: ['GET'], roles: both }); });
  ['expense.update', 'expense.void'].forEach(function (action) { API_ROUTES.push({ path: '/commands/' + action, methods: ['POST'], roles: owner, action: action }); });
  API_ROUTES.push({ path: '/read/canonical/expenses', methods: ['GET'], roles: owner, action: 'reports.view' });
  var PRODUCT_IMAGE_PATHS = Array.from(new Set(API_ROUTES.filter(function (r) { return r.path.indexOf('/auth/product-images') === 0; }).map(function (r) { return r.path; })));
  var ROLE_PATHS = ['/auth/reviews','/auth/reviews/resolve','/auth/me','/auth/owner-pin','/auth/owner-approval','/auth/pairing-code','/auth/pair','/auth/devices','/auth/devices/revoke','/settings'];
  function allowed(role, roles) { return (role === 'owner' || role === 'empleado') && roles.indexOf(role) >= 0; }
  function routeRoles(path, method) {
    var feature = /^\/features\/([a-z0-9-]+)(\/|$)/.exec(path); if (feature) return FEATURE_ROLES[feature[1]] || (featureLocked(feature[1]) ? both : owner);
    if (/^\/read\/sales\/[^/]+\/items$/.test(path)) path = '/read/sales/:id/items';
    if (/^\/sync\/operations\/[^/]+$/.test(path)) path = '/sync/operations/:id';
    if (/^\/imports\/[^/]+$/.test(path)) path = '/imports/:id';
    var route = API_ROUTES.find(function (r) { return r.path === path && (!r.methods || r.methods.indexOf(String(method || 'GET').toUpperCase()) >= 0); });
    return route ? route.roles : owner;
  }
  // Bloqueo de funciones Próximamente por id estable (única fuente, cliente y servidor).
  // true = bloqueada (sin rutas de escritura). Desbloquear = cambiar UNA línea a false.
  // Id ausente = bloqueada (default-deny).
  var FEATURE_ROLES = { 'asistencia-empleados': owner, 'valorizacion-inventario': owner };
  var FEATURE_LOCKS = {
    'venta-exitosa-comprobante': true,
    'credito-cuotas': true,
    'reparto-abono-multiples-deudas': true,
    'clonar-venta': true,
    'nota-credito-parcial-compras': true,
    'clientes-filtro-deuda': true,
    'clientes-dias-credito': true,
    'nota-credito-devolucion-parcial': true,
    'ordenes-compra': true,
    'sesion-unica-usuario': true,
    'firma-digital': true,
    'cierres-sucursal-moneda': true,
    'impresion-directa-xprinter': true,
    'clientes-direcciones-multiples': true,
    'clientes-descuento': true,
    'clientes-frecuencia': true,
    'listas-precios-asignacion-masiva': true,
    'historial-compras-producto': true,
    'inventario-padre-hijo': true,
    'inventario-ubicacion-responsables': true,
    'creditos-vencimiento': false,
    'gastos': false,
    'reportes': false,
    'cotizaciones': true,
    'cuentas-pagar': true,
    'compartir-pdf-whatsapp': true,
    'filtro-fechas-export': false,
    'pedidos-pos': true,
    'pedido-a-boleta': true,
    'venta-por-presentacion': true,
    'app-android-nativa': true,
    'valorizacion-inventario': false,
    'reporte-arqueo': true,
    'cpe-sin-internet': true,
    'venta-granel': true,
    'gaveta-dinero': true,
    'tipos-gasto': true,
    'gasto-con-foto': true,
    'gasto-a-cuenta': true,
    'comprobante-por-correo': true,
    'reporte-ventas-stock': true,
    'app-almaceneros': true,
    'equipos-pos': true,
    'tipo-cierre': true,
    'shopify-woocommerce': true,
    'bandeja-multicanal': true,
    'plan-distribuidor': true,
    'clientes-puntos': true,
    'conteo-fisico': true,
    'sucursales': true,
    'recetas-psicotropicos': true,
    'sunat-comprobantes': true,
    'etiquetas-precios': true,
    'promociones-combos': true,
    'delivery': true,
    'catalogo-en-linea': true,
    'recordatorios-recompra': true,
    'kardex': true,
    'metas-comisiones': true,
    'notificaciones-dueno': true,
    'offline-mejorado': true,
    'venta-voz': true,
    'cobro-qr-yape-plin': true,
    'cierre-billetes': true,
    'asistencia-empleados': true,
    'turnos-personal': true,
    'proveedores': true,
    'sustitutos-genericos': true,
    'interacciones-medicamentos': true,
    'historial-clinico': true,
    'encuestas': true,
    'apartados': true,
    'tarjetas-regalo': true,
    'auditoria-cambios': true,
    'panel-tv-pedidos': true,
    'multi-moneda': true,
    'balanza': true,
    'ventas-espera': true,
    'guias-remision': true,
    'sunat-resumen-anulaciones': true,
    'clientes-documentos-listas': true,
    'importar-clientes': true,
    'precio-por-margen': true,
    'edicion-masiva-precios': true,
    'transferencias-almacenes': true,
    'transferencias-cajas': true,
    'bancos-depositos': true,
    'punto-equilibrio': true,
    'tarjeta-recargo': true,
    'serie-por-cajero': true,
    'atajos-teclado': true,
    'servicios-recargas': true,
    'reporte-igv': true,
    'rotacion-abc': true,
    'calendario-gastos': true,
    'multi-ruc': true
  };
  function featureLocked(id) { return !Object.prototype.hasOwnProperty.call(FEATURE_LOCKS, id) || FEATURE_LOCKS[id] !== false; }
  function freeze(value) {
    Object.keys(value).forEach(function (key) { if (value[key] && typeof value[key] === 'object' && !Object.isFrozen(value[key])) freeze(value[key]); });
    return Object.freeze(value);
  }
  root.NA_PERMISSIONS = freeze({ SCREENS: SCREENS, ACTIONS: ACTIONS, SYNC_ENTITIES: SYNC_ENTITIES, API_ROUTES: API_ROUTES,
    ROLE_PATHS: ROLE_PATHS, PRODUCT_IMAGE_PATHS: PRODUCT_IMAGE_PATHS,
    PROXY_PREFIXES: ['/health', '/auth/*', '/read/*', '/features/*', '/commands/*', '/imports/*', '/sync/operations*', '/settings'],
    canAccessScreen: function (role, id) { return allowed(role, Object.prototype.hasOwnProperty.call(SCREENS, id) ? SCREENS[id] : owner); },
    canDo: function (role, action) { return allowed(role, Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : owner); },
    routeRoles: routeRoles, FEATURE_ROLES: FEATURE_ROLES, FEATURE_LOCKS: FEATURE_LOCKS, featureLocked: featureLocked
  });
})(globalThis);
