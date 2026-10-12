/* Ítem 12: hoja de descuento (reemplaza el prompt del navegador).
   - Porcentajes rápidos, % libre o monto en soles (se convierte a %), vista previa del total.
   - Solo devuelve el porcentaje; quien aplica sigue siendo aplicarDescuentoPorcentaje
     (con sus límites de margen y la aprobación del dueño para empleados). */
(function (root) {
  'use strict';
  var doc = root.document;
  function money(n) { try { return root.fmt(n); } catch (_) { return 'S/ ' + Number(n).toFixed(2); } }
  function open(subtotal) {
    subtotal = Number(subtotal) || 0;
    return new Promise(function (resolve) {
      var old = doc.getElementById('naDiscountSheet'); if (old) old.remove();
      var wrap = doc.createElement('div'); wrap.id = 'naDiscountSheet'; wrap.className = 'na-ds-overlay';
      wrap.innerHTML = '<div class="na-ds-sheet" role="dialog" aria-modal="true" aria-label="Descuento">' +
        '<div class="na-ds-head"><strong>Descuento a la venta</strong><span>Subtotal ' + money(subtotal) + '</span></div>' +
        '<div class="na-ds-chips">' + [5, 10, 15, 20].map(function (p) { return '<button type="button" data-pct="' + p + '">' + p + '%</button>'; }).join('') + '</div>' +
        '<div class="na-ds-mode"><button type="button" data-mode="pct" class="active">%</button><button type="button" data-mode="soles">S/</button></div>' +
        '<input id="naDsInput" inputmode="decimal" autocomplete="off" placeholder="Porcentaje (1 a 99)">' +
        '<div class="na-ds-preview" id="naDsPreview">Elige o escribe un descuento</div>' +
        '<div class="na-ds-actions"><button type="button" class="na-ds-cancel">Cancelar</button><button type="button" class="na-ds-ok" disabled>Aplicar</button></div></div>';
      doc.body.appendChild(wrap);
      var input = wrap.querySelector('#naDsInput'), ok = wrap.querySelector('.na-ds-ok'), preview = wrap.querySelector('#naDsPreview'), mode = 'pct', pct = null;
      function compute() {
        var v = Number(String(input.value || '').replace(',', '.'));
        pct = null;
        if (Number.isFinite(v) && v > 0) {
          var p = mode === 'pct' ? v : (subtotal > 0 ? v / subtotal * 100 : NaN);
          p = Math.round(p * 100) / 100;
          if (p > 0 && p < 100) pct = p;
        }
        ok.disabled = pct === null;
        preview.textContent = pct === null ? (input.value ? 'Escribe un valor entre 1% y 99% del subtotal' : 'Elige o escribe un descuento')
          : '−' + pct + '% · descuento ' + money(subtotal * pct / 100) + ' · total ' + money(subtotal * (100 - pct) / 100);
        wrap.querySelectorAll('[data-pct]').forEach(function (b) { b.classList.toggle('active', mode === 'pct' && Number(b.dataset.pct) === Number(input.value)); });
      }
      function done(v) { wrap.remove(); resolve(v); }
      wrap.querySelectorAll('[data-pct]').forEach(function (b) { b.onclick = function () { mode = 'pct'; setMode(); input.value = b.dataset.pct; compute(); }; });
      function setMode() {
        wrap.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
        input.placeholder = mode === 'pct' ? 'Porcentaje (1 a 99)' : 'Monto a descontar en soles';
      }
      wrap.querySelectorAll('[data-mode]').forEach(function (b) { b.onclick = function () { mode = b.dataset.mode; input.value = ''; setMode(); compute(); input.focus(); }; });
      input.oninput = compute;
      input.onkeydown = function (e) { if (e.key === 'Enter' && pct !== null) done(pct); if (e.key === 'Escape') done(null); };
      wrap.querySelector('.na-ds-cancel').onclick = function () { done(null); };
      wrap.onclick = function (e) { if (e.target === wrap) done(null); };
      ok.onclick = function () { if (pct !== null) done(pct); };
      setTimeout(function () { try { input.focus(); } catch (_) {} }, 60);
    });
  }
  root._naDiscountSheet = open;
})(window);
