/* Asistente (PROTOTIPO AISLADO): cargador apagado por defecto.
   Solo se activa con ?asistente=1 (queda guardado en este aparato) y se apaga con ?asistente=0.
   Carga los archivos DESPUÉS de que el POS terminó de abrir y el navegador está libre: no afecta el arranque. */
(function (root) {
  'use strict';
  var on = false;
  try {
    var q = new URLSearchParams(root.location.search).get('asistente');
    if (q === '1') root.localStorage.setItem('na_asistente_proto', '1');
    if (q === '0') root.localStorage.removeItem('na_asistente_proto');
    on = root.localStorage.getItem('na_asistente_proto') === '1';
  } catch (_) {}
  if (!on) return;
  function load() {
    var d = root.document, l = d.createElement('link'); l.rel = 'stylesheet'; l.href = 'css/asistente.css'; d.head.appendChild(l);
    var a = d.createElement('script'); a.src = 'js/modules/asistente/asistente-core.js';
    a.onload = function () { var b = d.createElement('script'); b.src = 'js/modules/asistente/asistente-ui.js'; d.body.appendChild(b); };
    d.body.appendChild(a);
  }
  function idle() { if (root.requestIdleCallback) root.requestIdleCallback(load, { timeout: 2500 }); else setTimeout(load, 800); }
  if (root.document.readyState === 'complete') idle(); else root.addEventListener('load', idle, { once: true });
})(window);
