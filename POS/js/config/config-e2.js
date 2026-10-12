/* Etapa 2: Configuración ordenada como CasaMarket + Apariencia por dispositivo + línea IGV opcional.
   Solo cambia la presentación en este dispositivo (localStorage). No escribe en el servidor. */
(function (root) {
  'use strict';
  var doc = root.document;
  var KEY = 'na_appearance_v1', IGV_KEY = 'na_show_igv_line';
  var MIN = 85, MAX = 125, STEPS = [85, 100, 115, 125];
  var FIELDS = [
    ['text', 'Tamaño de letra', 'Textos de toda la app'],
    ['cards', 'Tamaño de productos', 'Tarjetas en Nueva venta (menos o más columnas)'],
    ['cartTitle', 'Título "Venta actual"', 'Encabezado del carrito'],
    ['buttons', 'Tamaño de botones', 'Botones de cobro y acciones']
  ];
  function clamp(v) { v = Number(v); if (!isFinite(v)) return 100; return Math.max(MIN, Math.min(MAX, Math.round(v))); }
  function read() {
    var out = { text: 100, cards: 100, cartTitle: 100, buttons: 100 };
    try { var raw = JSON.parse(root.localStorage.getItem(KEY) || '{}'); for (var k in out) if (raw[k] != null) out[k] = clamp(raw[k]); } catch (_) {}
    return out;
  }
  function write(v) { try { root.localStorage.setItem(KEY, JSON.stringify(v)); } catch (_) {} }
  function apply(v) {
    var s = doc.documentElement.style;
    s.setProperty('--na-ap-text', (v.text / 100).toString());
    s.setProperty('--na-ap-cards', (v.cards / 100).toString());
    s.setProperty('--na-ap-cart-title', (v.cartTitle / 100).toString());
    s.setProperty('--na-ap-buttons', (v.buttons / 100).toString());
    doc.documentElement.classList.toggle('na-ap-custom', v.text !== 100 || v.cards !== 100 || v.cartTitle !== 100 || v.buttons !== 100);
  }
  function showIgvLine() { try { return root.localStorage.getItem(IGV_KEY) !== '0'; } catch (_) { return true; } }
  function syncIgvRow() {
    var el = doc.getElementById('posIgv'); var row = el && el.closest ? el.closest('.total-row') : null;
    if (row) row.hidden = !showIgvLine();
  }
  function canEdit() {
    try { if (typeof root._naF10HasPermission === 'function') return !!root._naF10HasPermission('configuration'); } catch (_) {}
    return true;
  }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function appearancePanel() {
    var v = read(), edit = canEdit();
    var rows = FIELDS.map(function (f) {
      var btns = STEPS.map(function (p) {
        var lbl = p === 85 ? 'Chico' : p === 100 ? 'Normal' : p === 115 ? 'Grande' : 'Muy grande';
        return '<button type="button" class="na-ap-step' + (v[f[0]] === p ? ' active' : '') + '" data-ap="' + f[0] + '" data-val="' + p + '"' + (edit ? '' : ' disabled') + '>' + lbl + '</button>';
      }).join('');
      return '<div class="na-ap-row"><div><strong>' + esc(f[1]) + '</strong><small>' + esc(f[2]) + '</small></div><div class="na-ap-steps" role="group" aria-label="' + esc(f[1]) + '">' + btns + '</div></div>';
    }).join('');
    return '<div class="cfg-panel na-ap-panel" id="naAppearancePanel"><div class="cfg-panel-title">Tamaños en este dispositivo</div>'
      + '<div class="cfg-panel-sub">Se guarda solo en este celular o computadora. Entre 85% y 125% para que Total y Cobrar siempre se vean.</div>'
      + (edit ? '' : '<div class="na-ap-note">Solo el dueño o un administrador puede cambiar estos tamaños.</div>')
      + rows
      + '<div class="na-ap-preview" aria-hidden="true"><div class="na-ap-pv-title">Venta actual</div><div class="na-ap-pv-cards"><div class="na-ap-pv-card">Producto</div><div class="na-ap-pv-card">Producto</div><div class="na-ap-pv-card">Producto</div></div><div class="na-ap-pv-text">Total S/ 12.50</div><button type="button" class="na-ap-pv-btn" tabindex="-1">Cobrar</button></div>'
      + '<div class="na-ap-actions"><button type="button" class="na-ap-reset"' + (edit ? '' : ' disabled') + '>Restablecer</button></div></div>';
  }
  function igvSetting() {
    var on = showIgvLine();
    return '<div class="cfg-panel na-igv-panel"><div class="cfg-panel-title">Línea de IGV en el total</div>'
      + '<div class="cfg-panel-sub">Muestra u oculta la línea "IGV (18%)" en Nueva venta. No cambia el precio ni el cálculo.</div>'
      + '<label class="na-igv-switch"><input type="checkbox" id="naIgvLine"' + (on ? ' checked' : '') + (canEdit() ? '' : ' disabled') + '> Mostrar "IGV (18%)" en el total</label></div>';
  }
  function sectionSave(cont) {
    if (cont.querySelector('.na-cfg-save')) return;
    if (typeof root.guardarConfig !== 'function') return;
    var bar = doc.createElement('div'); bar.className = 'na-cfg-save';
    var b = doc.createElement('button'); b.type = 'button'; b.className = 'na-cfg-save-btn'; b.textContent = 'Guardar';
    b.addEventListener('click', function () { root.guardarConfig(); });
    bar.appendChild(b); cont.appendChild(bar);
  }
  function cleanup(cont) {
    // Quitar etiquetas "Guardado seguro"/"Solo sesión" y los íconos "i" que no explican nada.
    cont.querySelectorAll('.cfg-help-toggle').forEach(function (n) { n.remove(); });
    cont.querySelectorAll('span,div').forEach(function (n) {
      if (n.children.length === 0 && /Guardado seguro|Solo sesión/.test(n.textContent || '')) {
        var pill = n.closest('[class*="pill"]') || n; pill.remove();
      }
    });
    flatten(cont);
  }
  // En celular cada sección ya es su propia pantalla: sin acordeones ni íconos "i".
  function flatten(cont) {
    cont = cont || doc.getElementById('cfgContent'); if (!cont) return;
    cont.querySelectorAll('.cfg-help-toggle').forEach(function (n) { n.remove(); });
    cont.querySelectorAll('.cfg-help-text').forEach(function (t) { t.classList.remove('cfg-help-text', 'is-open'); });
    cont.querySelectorAll('.cfg-accordion-panel').forEach(function (panel) {
      var heading = panel.querySelector(':scope>.cfg-panel-title'), button = heading && heading.querySelector('.cfg-accordion-toggle'), body = panel.querySelector(':scope>.cfg-accordion-body');
      if (button) { var label = button.querySelector('.cfg-accordion-label'); if (label) while (label.firstChild) heading.insertBefore(label.firstChild, button); button.remove(); }
      if (body) { while (body.firstChild) panel.insertBefore(body.firstChild, body); body.remove(); }
      if (heading) heading.classList.remove('cfg-accordion-heading'); panel.classList.remove('cfg-accordion-panel');
    });
  }
  function decorate(cat) {
    var cont = doc.getElementById('cfgContent'); if (!cont) return;
    cleanup(cont);
    if (cat === 'apariencia' && !doc.getElementById('naAppearancePanel')) cont.insertAdjacentHTML('afterbegin', appearancePanel());
    if (cat === 'negocio' && !cont.querySelector('.na-igv-panel')) cont.insertAdjacentHTML('beforeend', igvSetting());
    sectionSave(cont);
  }
  function showDetail() {
    var page = doc.getElementById('pageConfig');
    if (page) { page.classList.add('na-cfg-detail'); page.classList.remove('na-cfg-list'); }
  }
  function summaries() {
    var map = {
      negocio: function () { try { var b = root._naGetBusiness(); return (b.nombre || 'Negocio') + ' · ' + (b.direccion || 'Puerto Súngaro'); } catch (_) { return 'Datos del negocio'; } },
      pos: function () { try { return (root.appConfig.igvActive ? 'IGV activo' : 'IGV inactivo') + ' · stock mínimo ' + (root.appConfig.stockMinDefault || root.appConfig.stockMin || '—'); } catch (_) { return 'Reglas de venta'; } },
      apariencia: function () { var v = read(); return 'Letra ' + v.text + '% · productos ' + v.cards + '%'; }
    };
    doc.querySelectorAll('#cfgSidebar .cfg-cat-btn').forEach(function (btn) {
      var f = map[btn.dataset.cfgcat]; if (!f) return; var sm = btn.querySelector('small'); if (sm) sm.textContent = f();
    });
  }
  function showList() {
    var page = doc.getElementById('pageConfig'); if (!page) return;
    summaries(); page.classList.add('na-cfg-list'); page.classList.remove('na-cfg-detail');
    root.scrollTo(0, 0);
  }
  function addBack() {
    var bar = doc.querySelector('#pageConfig .cfg-topbar-simple'); if (!bar || bar.querySelector('.na-cfg-back')) return;
    var b = doc.createElement('button'); b.type = 'button'; b.className = 'na-cfg-back'; b.textContent = '‹ Secciones';
    b.addEventListener('click', showList);
    bar.insertBefore(b, bar.firstChild);
  }

  var userPick = false;
  doc.addEventListener('click', function (e) { if (e.target && e.target.closest && e.target.closest('#cfgSidebar .cfg-cat-btn')) userPick = true; }, true);
  doc.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('na-ap-step') && canEdit()) {
      var v = read(); v[t.dataset.ap] = clamp(t.dataset.val); write(v); apply(v);
      t.parentNode.querySelectorAll('.na-ap-step').forEach(function (b) { b.classList.toggle('active', b === t); });
    } else if (t && t.classList && t.classList.contains('na-ap-reset') && canEdit()) {
      try { root.localStorage.removeItem(KEY); } catch (_) {}
      var d = read(); apply(d);
      doc.querySelectorAll('.na-ap-step').forEach(function (b) { b.classList.toggle('active', Number(b.dataset.val) === 100); });
    }
  });
  doc.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'naIgvLine' && canEdit()) {
      try { root.localStorage.setItem(IGV_KEY, e.target.checked ? '1' : '0'); } catch (_) {}
      syncIgvRow();
    }
  });

  function install() {
    apply(read()); syncIgvRow();
    if (typeof root.renderCfgContent === 'function' && !root.renderCfgContent.__naE2) {
      var base = root.renderCfgContent;
      root.renderCfgContent = function (cat) { var r = base.apply(this, arguments); try { decorate(cat); } catch (_) {} return r; };
      root.renderCfgContent.__naE2 = true;
    }
    if (typeof root.posUpdateCart === 'function' && !root.posUpdateCart.__naE2) {
      var bu = root.posUpdateCart;
      root.posUpdateCart = function () { var r = bu.apply(this, arguments); syncIgvRow(); return r; };
      root.posUpdateCart.__naE2 = true;
    }
    if (typeof root.goPage === 'function' && !root.goPage.__naE2) {
      var bg = root.goPage;
      root.goPage = function (id) { var r = bg.apply(this, arguments); if (id === 'pageConfig') { addBack(); if (root.innerWidth <= 960) showList(); else summaries(); } return r; };
      root.goPage.__naE2 = true;
    }
    if (typeof root.switchCfgCategory === 'function' && !root.switchCfgCategory.__naE2) {
      var bs = root.switchCfgCategory;
      root.switchCfgCategory = function () { var r = bs.apply(this, arguments); if (userPick || root.innerWidth > 960) showDetail(); userPick = false; return r; };
      root.switchCfgCategory.__naE2 = true;
    }
    if (!install.__resize) { install.__resize = true; root.addEventListener('resize', function () { flatten(); }); }
    addBack(); summaries();
  }
  root.NA_CONFIG_E2 = { read: read, clamp: clamp, apply: apply, showList: showList, syncIgvRow: syncIgvRow, MIN: MIN, MAX: MAX };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', install); else install();
  root.addEventListener('load', install);
})(window);
