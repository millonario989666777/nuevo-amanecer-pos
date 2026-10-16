/* Consulta local: no comandos, persistencia ni cambios en productos/ventas. */
(function (root) {
  'use strict';

  const PAGE = 'pageCodigosDuplicados';
  const identity = product => product.product_id ?? product.id ?? null;
  // Inventario usa activo === false (DESCONTINUADO). SIN_REPOSICION es
  // ocultación de la lista, no baja. Los eliminados normalmente ya no están
  // en productos; también rechazamos tombstones de catálogos importados.
  const isActive = product => !!product && product.activo !== false &&
    !product.eliminado && !product.deleted && !product.deleted_at;
  const codes = product => [...new Set([
    product.sku, product.barcode,
    ...(Array.isArray(product.codigosAlternativos) ? product.codigosAlternativos : []),
    product.codigoAlternativo
  ].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];

  // Fecha sin zona = calendario Lima; instante con zona = UTC-5.
  function saleDate(sale) {
    for (const value of [sale.timestamp, sale.fecha]) {
      if (typeof value !== 'string') continue;
      const raw = value.trim();
      if (!/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(raw)) continue;
      const normalized = raw.replace(' ', 'T');
      const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
      const date = new Date(zoned ? normalized : normalized.length === 10 ? normalized + 'T00:00:00-05:00' : normalized + '-05:00');
      if (!Number.isFinite(date.getTime())) continue;
      const lima = new Date(date.getTime() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (!zoned && lima !== normalized.slice(0, 10)) continue;
      return lima;
    }
    return null;
  }

  // Pura: devuelve una fila por código y par de identidades diferentes,
  // con valores de presentación separados de los objetos del catálogo.
  function listPairs(catalog, sales = []) {
    const lastSale = new Map();
    for (const sale of Array.isArray(sales) ? sales : []) {
      if (!sale || sale.anulada || String(sale.estado || '').toLowerCase() === 'anulada') continue;
      const date = saleDate(sale);
      if (!date) continue;
      for (const item of Array.isArray(sale.items) ? sale.items : []) {
        if (!item || item.ventaLibre || item.tipoLinea === 'venta_libre') continue;
        const id = identity(item);
        if (id === null) continue;
        const key = String(id);
        if (!lastSale.has(key) || date > lastSale.get(key)) lastSale.set(key, date);
      }
    }
    const byCode = new Map();
    (Array.isArray(catalog) ? catalog : []).forEach(product => {
      if (!isActive(product)) return;
      const id = identity(product), key = id === null ? product : String(id);
      const row = { id, name: String(product.name || product.nombre || 'Sin nombre'),
        stock: product.stock ?? null, lastSaleDate: id === null ? null : lastSale.get(String(id)) || null };
      for (const code of codes(product)) {
        if (!byCode.has(code)) byCode.set(code, new Map());
        // Dos representaciones del mismo ID nunca forman un par consigo mismo.
        if (!byCode.get(code).has(key)) byCode.get(code).set(key, row);
      }
    });
    const pairs = [];
    for (const [code, group] of byCode) {
      const products = [...group.values()];
      for (let left = 0; left < products.length; left++) {
        for (let right = left + 1; right < products.length; right++) {
          pairs.push({ code, products: [{ ...products[left] }, { ...products[right] }] });
        }
      }
    }
    return pairs;
  }

  const liveProducts = () => typeof productos !== 'undefined' ? productos : (root.productos || []);
  const liveSales = () => typeof ventas !== 'undefined' ? ventas : (root.ventas || []);
  const ownerAllowed = () => root.NA_ROLES?.role === 'owner' && root.NA_ROLES.isOwner?.() === true;
  const doc = root.document;
  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const formatDate = date => date ? date.split('-').reverse().join('/') : 'sin ventas';

  function openProduct(id) {
    if (!ownerAllowed() || id === null || id === undefined || typeof root.editProd !== 'function') return false;
    const product = liveProducts().find(candidate => isActive(candidate) && String(identity(candidate)) === String(id));
    if (!product || product.id === null || product.id === undefined) return false;
    // editProd busca con igualdad estricta: conservar el tipo del ID local.
    root.editProd(product.id);
    return true;
  }

  function render() {
    const page = doc?.getElementById(PAGE);
    if (!page) return false;
    const list = page.querySelector('[data-cd-list]'), status = page.querySelector('[data-cd-status]');
    if (!list || !status) return false;
    list.replaceChildren();
    const allowed = ownerAllowed();
    page.querySelectorAll('[data-cd-owner]').forEach(node => { node.hidden = !allowed; });
    if (!allowed) { status.textContent = 'Sin permiso'; return false; }
    const pairs = listPairs(liveProducts(), liveSales());
    status.textContent = pairs.length ? `${pairs.length} ${pairs.length === 1 ? 'par de productos' : 'pares de productos'} con códigos duplicados` : 'Sin códigos duplicados';
    const fragment = doc.createDocumentFragment();
    for (const pair of pairs) {
      const card = element('article', 'cd-pair');
      card.append(element('h2', 'cd-code', `Código: ${pair.code}`));
      const products = element('div', 'cd-products');
      for (const product of pair.products) {
        const section = element('section', 'cd-product');
        section.append(element('h3', 'cd-name', product.name));
        const details = element('dl', 'cd-details');
        for (const [label, value] of [['Stock', product.stock === null ? 'Sin dato' : String(product.stock)], ['Última venta', formatDate(product.lastSaleDate)]]) {
          const detail = element('div');
          detail.append(element('dt', '', label), element('dd', '', value));
          details.append(detail);
        }
        section.append(details);
        if (product.id !== null && typeof root.editProd === 'function') {
          const button = element('button', 'cd-button', 'Abrir producto');
          button.type = 'button';
          button.setAttribute('aria-label', `Abrir producto: ${product.name}`);
          button.addEventListener('click', () => openProduct(product.id));
          section.append(button);
        }
        products.append(section);
      }
      card.append(products);
      fragment.append(card);
    }
    list.append(fragment);
    return true;
  }

  function navigate(id) {
    if (typeof root.NA_MENU_NAVIGATION?.navigate === 'function') return root.NA_MENU_NAVIGATION.navigate(id);
    if (typeof root.goPage === 'function') { root.goPage(id); return true; }
    return false;
  }
  function open() {
    if (!render()) return false;
    return navigate(PAGE);
  }

  let menuObserver;
  let watchedPage;
  function attach() {
    const menu = doc.querySelector('#pageInventario .inv-secondary-menu');
    if (menu) {
      let button = menu.querySelector('[data-codigos-duplicados]');
      if (!ownerAllowed()) button?.remove();
      else if (!button) {
        button = element('button', 'top-btn-nuevo', 'Códigos duplicados');
        button.type = 'button';
        button.dataset.codigosDuplicados = '';
        button.addEventListener('click', open);
        menu.append(button);
      }
    }
    const page = doc.getElementById(PAGE);
    if (page && page !== watchedPage) {
      watchedPage = page;
      page.querySelector('[data-cd-back]')?.addEventListener('click', () => navigate('pageInventario'));
      page.querySelector('[data-cd-refresh]')?.addEventListener('click', render);
      new root.MutationObserver(() => { if (page.classList.contains('active')) render(); })
        .observe(page, { attributes: true, attributeFilter: ['class'] });
      if (page.classList.contains('active')) render();
    }
    if (menu && watchedPage) menuObserver?.disconnect();
  }
  function boot() {
    // Espera al menú que crea mobile-inventory.js sin envolver sus handlers.
    menuObserver = new root.MutationObserver(attach);
    menuObserver.observe(doc.body, { childList: true, subtree: true });
    attach();
    root.addEventListener('na:role', () => { attach(); render(); });
    root.addEventListener('na:canonical-updated', () => {
      // La proyección legacy se aplica por otros listeners del mismo evento.
      root.setTimeout(() => { if (watchedPage?.classList.contains('active')) render(); }, 0);
    });
  }
  root.NA_CODIGOS_DUPLICADOS = Object.freeze({ listPairs, open, render, openProduct });
  if (doc && root.MutationObserver) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }
})(globalThis);
