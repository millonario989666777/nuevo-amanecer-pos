/* Nuevo Amanecer CANON — decorador visual del Inicio para tablet y escritorio. */
(function (root) {
  'use strict';

  const NAV_ITEMS = [
    ['pageMenu', 'Inicio', '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/>'],
    ['pagePOS', 'Punto de Venta', '<circle cx="9" cy="19" r="1.5"/><circle cx="18" cy="19" r="1.5"/><path d="M3 4h2l2.2 10h10.9l2-7H6"/>'],
    ['pageVentas', 'Ventas', '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M7.5 11h9M8 15h3M14 15h2"/>'],
    ['pageInventario', 'Inventario', '<path d="m4 8 8-4 8 4-8 4-8-4Z"/><path d="M4 8v8l8 4 8-4V8M12 12v8"/>'],
    ['pageClientes', 'Clientes', '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20c.7-4 3-6 6.5-6s5.8 2 6.5 6"/>'],
    ['pageCaja', 'Caja', '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 10h5v5h-5a2.5 2.5 0 0 1 0-5Z"/><path d="M7 6V4h10v2"/>'],
    ['pageGastos', 'Gastos', '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6M9 16h4"/>'],
    ['pageConfig', 'Configuración', '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>']
  ];

  function navigationHtml() {
    return '<div class="menu-sidebar-title">Navegación</div>' + NAV_ITEMS.map(function (item, index) {
      const target = item[0], label = item[1], icon = item[2];
      const action = target === 'pageMenu' ? 'goMenu()' : "goPage('" + target + "')";
      const spacer = target === 'pageConfig' ? '<div class="menu-sidebar-spacer"></div>' : '';
      return spacer + '<button class="menu-side-link' + (index === 0 ? ' is-active' : '') + '" type="button" onclick="' + action + '" data-menu-target="' + target + '"' + (index === 0 ? ' aria-current="page"' : '') + '>' +
        '<span class="menu-side-icon" aria-hidden="true"><svg viewBox="0 0 24 24">' + icon + '</svg></span>' +
        '<span>' + label + '</span><span class="menu-side-chevron">›</span></button>';
    }).join('');
  }

  function ensureDashboardDom() {
    const page = document.getElementById('pageMenu');
    if (!page) return false;
    const scroll = page.querySelector('.main-scroll.home-shell');
    if (!scroll) return false;

    if (!page.querySelector('.menu-desktop-sidebar')) {
      const sidebar = document.createElement('aside');
      sidebar.className = 'menu-desktop-sidebar';
      sidebar.setAttribute('aria-label', 'Navegación principal');
      sidebar.innerHTML = navigationHtml();
      page.insertBefore(sidebar, scroll);
    }

    if (!scroll.querySelector('.menu-desktop-heading')) {
      const heading = document.createElement('div');
      heading.className = 'menu-desktop-heading';
      heading.innerHTML = '<div><span class="menu-desktop-eyebrow">Panel principal</span><h1>Resumen</h1><p id="menuDesktopDate">Estado actual del negocio</p></div>' +
        '<div class="menu-desktop-live"><span aria-hidden="true"></span> Operación del día</div>';
      const anchor = scroll.querySelector('.section-label');
      scroll.insertBefore(heading, anchor || scroll.firstChild);
    }

    const salesValue = document.getElementById('qsVentas');
    const salesCard = salesValue && salesValue.closest('.qs-card');
    if (salesCard) {
      salesCard.classList.add('qs-card-sales');
      if (!document.getElementById('qsVentasTrend')) {
        const trend = document.createElement('div');
        trend.className = 'qs-trend';
        trend.id = 'qsVentasTrend';
        trend.dataset.trend = 'flat';
        trend.textContent = '— vs ayer';
        salesCard.appendChild(trend);
      }
      if (!document.getElementById('qsVentasPrev')) {
        const previous = document.createElement('div');
        previous.className = 'qs-prev';
        previous.id = 'qsVentasPrev';
        previous.textContent = 'Ayer: S/ 0.00';
        const sub = document.getElementById('qsVentasSub');
        salesCard.insertBefore(previous, sub || null);
      }
    }

    const labels = Array.from(scroll.querySelectorAll('.section-label'));
    const modulesLabel = labels.find(function (node) {
      return String(node.textContent || '').trim().toLowerCase() === 'módulos principales';
    });
    if (modulesLabel) modulesLabel.classList.add('menu-modules-label');

    if (!scroll.querySelector('.menu-desktop-sections')) {
      const sections = document.createElement('div');
      sections.className = 'menu-desktop-sections';
      sections.innerHTML = '<section class="menu-data-panel" aria-labelledby="menuActivityTitle">' +
        '<div class="menu-panel-head"><div><span>Movimientos</span><h2 id="menuActivityTitle">Actividad reciente</h2></div></div>' +
        '<div class="menu-activity-list">' +
          '<div class="menu-activity-row"><span class="menu-activity-dot"></span><span id="menuActivity0Label">Sin movimientos recientes</span><strong id="menuActivity0Amount">—</strong></div>' +
          '<div class="menu-activity-row"><span class="menu-activity-dot"></span><span id="menuActivity1Label">—</span><strong id="menuActivity1Amount">—</strong></div>' +
          '<div class="menu-activity-row"><span class="menu-activity-dot"></span><span id="menuActivity2Label">—</span><strong id="menuActivity2Amount">—</strong></div>' +
        '</div></section>' +
        '<section class="menu-data-panel" aria-labelledby="menuPendingTitle">' +
          '<div class="menu-panel-head"><div><span>Control</span><h2 id="menuPendingTitle">Pendientes</h2></div></div>' +
          '<div class="menu-pending-list">' +
            '<div class="menu-pending-row"><span class="menu-pending-mark amber"></span><span id="menuPendingCredits">Créditos por revisar</span></div>' +
            '<div class="menu-pending-row"><span class="menu-pending-mark red"></span><span id="menuPendingStock">Stock por revisar</span></div>' +
            '<div class="menu-pending-row"><span class="menu-pending-mark teal"></span><span id="menuPendingCash">Estado de caja</span></div>' +
          '</div></section>';
      scroll.insertBefore(sections, modulesLabel || null);
    }
    return true;
  }

  function localIso(date) {
    const d = date instanceof Date ? date : new Date(date);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function recentTimestamp(sale) {
    const rawDate = String(sale && sale.fecha || '');
    const rawTime = String(sale && (sale.hora24 || sale.hora) || '00:00:00').slice(0, 8);
    const parsed = Date.parse(rawDate + 'T' + (/^\d{2}:\d{2}/.test(rawTime) ? rawTime : '00:00:00'));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function updateDesktopDashboard() {
    if (!ensureDashboardDom()) return;
    const now = new Date(), yesterdayDate = new Date(now.getTime());
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const today = typeof obtenerHoy === 'function' ? obtenerHoy() : localIso(now);
    const yesterday = localIso(yesterdayDate);
    const rows = typeof ventas !== 'undefined' && Array.isArray(ventas) ? ventas : [];
    const todaySales = rows.filter(function (sale) { return sale && sale.fecha === today && !sale.anulada; });
    const ayerVentas = rows.filter(function (sale) { return sale && sale.fecha === yesterday && !sale.anulada; });
    const saleTotal = function (sale) { return typeof totalV === 'function' ? Number(totalV(sale)) || 0 : Number(sale && sale.total) || 0; };
    const money = function (value) { return typeof fmt === 'function' ? fmt(value) : 'S/ ' + Number(value || 0).toFixed(2); };
    const todayTotal = todaySales.reduce(function (sum, sale) { return sum + saleTotal(sale); }, 0);
    const yesterdayTotal = ayerVentas.reduce(function (sum, sale) { return sum + saleTotal(sale); }, 0);

    const trend = document.getElementById('qsVentasTrend');
    const previous = document.getElementById('qsVentasPrev');
    if (trend) {
      if (yesterdayTotal > 0) {
        const pct = ((todayTotal - yesterdayTotal) / yesterdayTotal) * 100;
        const up = pct > 0.049, down = pct < -0.049;
        trend.dataset.trend = up ? 'up' : down ? 'down' : 'flat';
        trend.textContent = (up ? '↑' : down ? '↓' : '—') + ' ' + Math.abs(pct).toFixed(1) + '% vs ayer';
      } else if (todayTotal > 0) {
        trend.dataset.trend = 'up';
        trend.textContent = '↑ Sin ventas ayer';
      } else {
        trend.dataset.trend = 'flat';
        trend.textContent = '— Sin variación vs ayer';
      }
    }
    if (previous) previous.textContent = 'Ayer: ' + money(yesterdayTotal);

    const dateLabel = document.getElementById('menuDesktopDate');
    if (dateLabel) dateLabel.textContent = now.toLocaleDateString('es-PE', { weekday:'long', day:'2-digit', month:'long' });

    const recent = rows.filter(function (sale) { return sale && !sale.anulada; }).slice().sort(function (a, b) {
      return recentTimestamp(b) - recentTimestamp(a);
    }).slice(0, 3);
    for (let i = 0; i < 3; i += 1) {
      const label = document.getElementById('menuActivity' + i + 'Label');
      const amount = document.getElementById('menuActivity' + i + 'Amount');
      const sale = recent[i];
      if (!label || !amount) continue;
      if (!sale) {
        label.textContent = i === 0 ? 'Sin movimientos recientes' : '—';
        amount.textContent = '—';
        continue;
      }
      const id = String(sale.id || 'Venta').replace(/^V-/, '#');
      const time = String(sale.hora24 || sale.hora || '').slice(0, 5);
      label.textContent = 'Venta ' + id + (time ? ' · ' + time : '');
      amount.textContent = money(saleTotal(sale));
    }

    const pendingCredits = document.getElementById('menuPendingCredits');
    const pendingStock = document.getElementById('menuPendingStock');
    const pendingCash = document.getElementById('menuPendingCash');
    const debtValue = document.getElementById('qsPorCobrar')?.textContent || 'S/ 0.00';
    const debtCount = document.getElementById('qsPorCobrarSub')?.textContent || 'Sin créditos activos';
    const stockValue = document.getElementById('qsStockCritico')?.textContent || '0';
    const stockCopy = document.getElementById('qsStockCriticoSub')?.textContent || 'productos por reponer';
    const cashState = document.getElementById('qsCajaSub')?.textContent || 'Caja no abierta';
    if (pendingCredits) pendingCredits.textContent = debtCount + ' · ' + debtValue;
    if (pendingStock) pendingStock.textContent = stockValue + ' ' + stockCopy;
    if (pendingCash) pendingCash.textContent = cashState;
  }

  function bindDashboardRenderer() {
    if (typeof updateDashboard !== 'function' || updateDashboard.__naDesktopDashboard) return;
    const base = updateDashboard;
    const wrapped = function () {
      const result = base.apply(this, arguments);
      try { updateDesktopDashboard(); } catch (error) { console.warn('[Nuevo Amanecer] No se pudo actualizar el dashboard de escritorio.', error && error.message || error); }
      return result;
    };
    wrapped.__naDesktopDashboard = true;
    updateDashboard = wrapped;
  }

  function init() {
    ensureDashboardDom();
    bindDashboardRenderer();
    try { updateDesktopDashboard(); } catch (error) { console.warn('[Nuevo Amanecer] No se pudo iniciar el dashboard de escritorio.', error && error.message || error); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
  root.addEventListener('pageshow', init);
  root.addEventListener('na:canonical-updated', function () { setTimeout(updateDesktopDashboard, 0); });

  root.NA_CANON_DESKTOP_DASHBOARD = Object.freeze({ ensure:ensureDashboardDom, refresh:updateDesktopDashboard });
})(window);
