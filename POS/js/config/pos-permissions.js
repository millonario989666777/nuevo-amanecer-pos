/* Shared browser and Worker role policy. Unknown identities always fail closed. */
(function (root) {
  'use strict';
  var owner = ['owner'], both = ['owner', 'empleado'];
  var SCREENS = {};
  ['pagePOS', 'pageInventario', 'pageVentas', 'pageClientes', 'pageCaja'].forEach(function (id) { SCREENS[id] = both; });
  ['pageGastos', 'pageConfig', 'ventas:reportes'].forEach(function (id) { SCREENS[id] = owner; });
  var ACTIONS = {};
  ['expense.create', 'settings.set', 'product-images.write', 'reports.view', 'devices.manage', 'owner-pin.set', 'pairing-code.create', 'reviews.resolve'].forEach(function (id) { ACTIONS[id] = owner; });
  var API_ROUTES = [
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
    { path: '/commands/expense.create', methods: ['POST'], roles: owner, action: 'expense.create' }
  ];
  var PRODUCT_IMAGE_PATHS = Array.from(new Set(API_ROUTES.filter(function (r) { return r.path.indexOf('/auth/product-images') === 0; }).map(function (r) { return r.path; })));
  var ROLE_PATHS = Array.from(new Set(API_ROUTES.filter(function (r) { return r.path !== '/commands/expense.create' && PRODUCT_IMAGE_PATHS.indexOf(r.path) < 0; }).map(function (r) { return r.path; })));
  function allowed(role, roles) { return (role === 'owner' || role === 'empleado') && roles.indexOf(role) >= 0; }
  function routeRoles(path, method) {
    var route = API_ROUTES.find(function (r) { return r.path === path && (!r.methods || r.methods.indexOf(String(method || 'GET').toUpperCase()) >= 0); });
    return route ? route.roles : owner;
  }
  function freeze(value) {
    Object.keys(value).forEach(function (key) { if (value[key] && typeof value[key] === 'object' && !Object.isFrozen(value[key])) freeze(value[key]); });
    return Object.freeze(value);
  }
  root.NA_PERMISSIONS = freeze({ SCREENS: SCREENS, ACTIONS: ACTIONS, API_ROUTES: API_ROUTES,
    ROLE_PATHS: ROLE_PATHS, PRODUCT_IMAGE_PATHS: PRODUCT_IMAGE_PATHS,
    PROXY_PREFIXES: ['/health', '/auth/*', '/read/*', '/commands/*', '/imports/*', '/sync/operations*', '/settings'],
    canAccessScreen: function (role, id) { return allowed(role, Object.prototype.hasOwnProperty.call(SCREENS, id) ? SCREENS[id] : owner); },
    canDo: function (role, action) { return allowed(role, Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : owner); },
    routeRoles: routeRoles
  });
})(globalThis);
