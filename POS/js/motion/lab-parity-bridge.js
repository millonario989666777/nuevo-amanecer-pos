(function (root) {
  'use strict';

  var motion = root.NA_MOTION;
  if (!motion || !motion.page || !motion.scroll || typeof document === 'undefined') return;

  var presetByPage = Object.freeze({
    pageClientes: 'clientes',
    pageInventario: 'inventario',
    pageVentas: 'ventas',
    pageCaja: 'caja',
    pageGastos: 'gastos'
  });

  var bound = typeof WeakSet === 'function' ? new WeakSet() : null;
  var activeState = typeof WeakMap === 'function' ? new WeakMap() : null;
  var activationToken = typeof WeakMap === 'function' ? new WeakMap() : null;
  var observers = [];

  function wasActive(page) {
    return activeState ? activeState.get(page) === true : page.__naMotionParityActive === true;
  }

  function remember(page, active) {
    if (activeState) activeState.set(page, !!active);
    else page.__naMotionParityActive = !!active;
  }

  function nextToken(page) {
    var token = {};
    if (activationToken) activationToken.set(page, token);
    else page.__naMotionParityToken = token;
    return token;
  }

  function tokenIsCurrent(page, token) {
    return activationToken
      ? activationToken.get(page) === token
      : page.__naMotionParityToken === token;
  }

  function afterPaint(callback) {
    var raf = typeof root.requestAnimationFrame === 'function'
      ? root.requestAnimationFrame.bind(root)
      : function (cb) { return root.setTimeout(cb, 16); };
    raf(function () {
      raf(callback);
    });
  }

  function emit(page, preset) {
    try {
      root.dispatchEvent(new CustomEvent('na:motion-page-active', {
        detail: { pageId: page.id || '', preset: preset || null }
      }));
    } catch (_) {}
  }

  function startMotion(page, preset, token) {
    if (!page || !page.classList || !page.classList.contains('active')) return;
    if (!tokenIsCurrent(page, token)) return;

    try {
      if (motion.page && typeof motion.page.enter === 'function') {
        motion.page.enter(page, 'na-enter-fade');
      }
    } catch (_) {}

    if (preset) {
      try {
        var controller = motion.scroll && typeof motion.scroll.enablePreset === 'function'
          ? motion.scroll.enablePreset(preset)
          : null;
        if (controller && typeof controller.sync === 'function') controller.sync();
      } catch (_) {}
    }

    emit(page, preset);
  }

  function scheduleMotion(page) {
    // Mobile safe navigation must stay paint-first and free of page-entry Motion.
    // Clientes restores only its scroll-linked chrome from menu-navigation.js.
    if (Number(root.innerWidth || 0) <= 700 || root.NA_MOBILE_SAFE_NAV_ACTIVE === true) return;
    // Arranque: la primera pantalla se pinta sin animación de entrada (no compite con el primer pintado).
    if (root.document && root.document.readyState !== 'complete') return;
    var preset = presetByPage[page.id] || null;
    var token = nextToken(page);
    afterPaint(function () {
      startMotion(page, preset, token);
    });
  }

  function syncPage(page) {
    if (!page || !page.classList) return;
    var active = page.classList.contains('active');
    var previous = wasActive(page);
    remember(page, active);

    if (!active) {
      nextToken(page);
      return;
    }
    if (previous) return;

    scheduleMotion(page);
  }

  function bindPage(page) {
    if (!page || (bound && bound.has(page))) return;
    if (bound) bound.add(page);
    remember(page, false);

    if (typeof MutationObserver === 'function') {
      var observer = new MutationObserver(function () { syncPage(page); });
      observer.observe(page, { attributes: true, attributeFilter: ['class'] });
      observers.push(observer);
    }

    syncPage(page);
  }

  function bindAll() {
    if (!document.querySelectorAll) return;
    document.querySelectorAll('.page').forEach(bindPage);
  }

  function resyncActive() {
    if (!document.querySelectorAll) return;
    document.querySelectorAll('.page').forEach(syncPage);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAll, { once: true });
  } else {
    bindAll();
  }

  root.addEventListener('pageshow', resyncActive);

  motion.labParity = Object.assign(motion.labParity || {}, {
    sync: resyncActive,
    presetForPage: function (pageId) { return presetByPage[String(pageId || '')] || null; },
    inspect: function () {
      var active = document.querySelector ? document.querySelector('.page.active') : null;
      return {
        activePageId: active ? active.id : null,
        activePreset: active ? (presetByPage[active.id] || null) : null,
        observerCount: observers.length
      };
    }
  });
})(window);
