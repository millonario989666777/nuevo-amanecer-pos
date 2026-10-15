(function (root) {
  'use strict';
  function freeze(value) {
    if (value && typeof value === 'object') { Object.keys(value).forEach(function (key) { freeze(value[key]); }); Object.freeze(value); }
    return value;
  }
  var FEATURES = freeze([
    { id: 'creditos-vencimiento', name: 'Créditos con vencimiento por documento y cobro múltiple', description: 'Organiza vencimientos y cobra varios documentos juntos.', icon: '📅', enabled: true, page: 'pageClientes', preview: { type: 'table', columns: ['Documento', 'Cliente', 'Vencimiento', 'Saldo'] } },
    { id: 'gastos', name: 'Gastos (categorías y reporte)', description: 'Clasifica egresos y consulta su reporte por categoría.', icon: '🧾', enabled: true, page: 'pageGastos', preview: { type: 'form', fields: ['Categoría', 'Descripción', 'Importe'] } },
    { id: 'reportes', name: 'Reportes', description: 'Ventas por día, productos más vendidos, utilidad, cajero y método de pago.', icon: '📊', enabled: true, page: 'pageVentas', preview: { type: 'table', columns: ['Día', 'Producto', 'Ventas', 'Utilidad', 'Cajero', 'Método de pago'] } },
    { id: 'cotizaciones', name: 'Cotizaciones', description: 'Prepara propuestas de venta para tus clientes.', icon: '📋', enabled: false, page: null, preview: { type: 'form', fields: ['Cliente', 'Producto', 'Cantidad', 'Precio'] } },
    { id: 'cuentas-pagar', name: 'Cuentas por pagar a proveedores', description: 'Consulta saldos y vencimientos de tus proveedores.', icon: '🏷️', enabled: false, page: null, preview: { type: 'table', columns: ['Proveedor', 'Documento', 'Vencimiento', 'Saldo'] } },
    { id: 'compartir-pdf-whatsapp', name: 'Compartir por PDF y WhatsApp', description: 'Prepara documentos para compartir con tus clientes.', icon: '📄', enabled: false, page: null, preview: { type: 'form', fields: ['Documento', 'Cliente', 'Teléfono'] } },
    { id: 'filtro-fechas-export', name: 'Filtro de fechas con exportación', description: 'Selecciona un período y prepara la exportación de datos.', icon: '🗓️', enabled: true, page: 'pageVentas', preview: { type: 'form', fields: ['Desde', 'Hasta', 'Formato'] } },
    { id: 'clientes-puntos', name: 'Clientes frecuentes y puntos', description: 'Acumula puntos por compra y premia a tus clientes frecuentes.', icon: '⭐', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Cliente', 'Compras', 'Puntos'] } },
    { id: 'conteo-fisico', name: 'Conteo físico de inventario', description: 'Cuenta el stock real y compáralo con el sistema antes de ajustar.', icon: '📦', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Producto', 'Sistema', 'Contado', 'Diferencia'] } },
    { id: 'sucursales', name: 'Sucursales / almacenes', description: 'Maneja varias tiendas o almacenes con su propio stock.', icon: '🏬', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Sucursal', 'Productos', 'Stock'] } },
    { id: 'recetas-psicotropicos', name: 'Recetas médicas y control de psicotrópicos', description: 'Registra recetas y controla la venta de medicamentos restringidos.', icon: '💊', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Paciente', 'Médico', 'N.º de receta', 'Medicamento'] } },
    { id: 'sunat-comprobantes', name: 'Facturación electrónica SUNAT (boletas/facturas)', description: 'Emite boletas y facturas electrónicas válidas ante SUNAT.', icon: '🧾', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Tipo', 'Serie', 'Cliente', 'Total'] } },
    { id: 'etiquetas-precios', name: 'Etiquetas e impresión de precios', description: 'Imprime etiquetas con precio y código de barras de tus productos.', icon: '🏷️', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Producto', 'Cantidad', 'Formato'] } },
    { id: 'promociones-combos', name: 'Promociones y combos', description: 'Crea ofertas, packs y descuentos por tiempo limitado.', icon: '🎁', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Promoción', 'Productos', 'Precio', 'Vigencia'] } },
    { id: 'delivery', name: 'Pedidos a domicilio / delivery', description: 'Registra pedidos para entregar y sigue su estado.', icon: '🛵', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Pedido', 'Cliente', 'Dirección', 'Estado'] } },
    { id: 'catalogo-en-linea', name: 'Catálogo en línea para clientes', description: 'Comparte un catálogo web para que tus clientes vean productos y precios.', icon: '🌐', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Producto', 'Precio', 'Disponible'] } },
    { id: 'recordatorios-recompra', name: 'Recordatorios de recompra a clientes', description: 'Avisa a tus clientes cuando les toca volver a comprar.', icon: '🔔', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Cliente', 'Producto', 'Próxima compra'] } },
    { id: 'kardex', name: 'Kardex por producto', description: 'Consulta entradas, salidas y saldo valorizado de cada producto.', icon: '📒', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Fecha', 'Movimiento', 'Entrada', 'Salida', 'Saldo'] } },
    { id: 'metas-comisiones', name: 'Metas y comisiones de vendedores', description: 'Define metas de venta y calcula comisiones por vendedor.', icon: '🎯', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Vendedor', 'Meta', 'Vendido', 'Comisión'] } },
    { id: 'notificaciones-dueno', name: 'Notificaciones al dueño (WhatsApp)', description: 'Recibe por WhatsApp avisos de cierres, stock bajo y ventas.', icon: '📲', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Teléfono', 'Avisos'] } },
    { id: 'offline-mejorado', name: 'Modo sin conexión mejorado', description: 'Trabaja más tiempo sin internet y sincroniza todo al volver.', icon: '📶', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Operación', 'Estado', 'Sincronizado'] } },
    { id: 'venta-voz', name: 'Venta rápida por voz', description: 'Agrega productos al carrito dictándolos en voz alta.', icon: '🎙️', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Dictado', 'Producto', 'Cantidad'] } },
    { id: 'cobro-qr-yape-plin', name: 'Pagos con Yape/Plin QR', description: 'Muestra un QR con el monto para que el cliente pague al instante.', icon: '📱', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Monto', 'Billetera', 'Referencia'] } },
    { id: 'cierre-billetes', name: 'Cierre de caja con conteo de billetes', description: 'Cuenta billetes y monedas por denominación al cerrar caja.', icon: '💵', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Denominación', 'Cantidad', 'Subtotal'] } },
    { id: 'asistencia-empleados', name: 'Control de asistencia de empleados', description: 'Registra entradas y salidas del personal.', icon: '🕘', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Empleado', 'Entrada', 'Salida'] } },
    { id: 'turnos-personal', name: 'Turnos y horarios del personal', description: 'Planifica los turnos y horarios de tu equipo.', icon: '🗓️', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Empleado', 'Día', 'Horario'] } },
    { id: 'proveedores', name: 'Gestión de proveedores', description: 'Guarda datos de contacto y condiciones de tus proveedores.', icon: '🚚', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Proveedor', 'RUC', 'Teléfono'] } },
    { id: 'sustitutos-genericos', name: 'Productos sustitutos/genéricos en farmacia', description: 'Sugiere genéricos o alternativas cuando un producto falta.', icon: '🔁', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Producto', 'Sustituto', 'Precio'] } },
    { id: 'interacciones-medicamentos', name: 'Alertas de interacción de medicamentos', description: 'Advierte combinaciones de medicamentos que no deben venderse juntas.', icon: '⚠️', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Medicamento', 'Interactúa con', 'Riesgo'] } },
    { id: 'historial-clinico', name: 'Historial clínico simple del cliente', description: 'Anota alergias y tratamientos del cliente para atenderlo mejor.', icon: '🩺', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Cliente', 'Alergias', 'Tratamiento'] } },
    { id: 'encuestas', name: 'Encuestas de satisfacción', description: 'Pregunta a tus clientes cómo fue su experiencia.', icon: '💬', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Fecha', 'Cliente', 'Calificación'] } },
    { id: 'apartados', name: 'Apartados / separación de productos', description: 'Separa productos con un adelanto y completa el pago después.', icon: '📌', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Cliente', 'Producto', 'Adelanto', 'Saldo'] } },
    { id: 'tarjetas-regalo', name: 'Tarjetas de regalo', description: 'Vende tarjetas con saldo que tus clientes canjean en compras.', icon: '🎟️', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Código', 'Saldo', 'Vence'] } },
    { id: 'auditoria-cambios', name: 'Auditoría de cambios (quién modificó qué)', description: 'Revisa quién cambió precios, stock o datos y cuándo.', icon: '🕵️', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Fecha', 'Usuario', 'Cambio'] } },
    { id: 'panel-tv-pedidos', name: 'Panel en TV para pedidos', description: 'Muestra en una pantalla los pedidos en preparación y listos.', icon: '📺', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Pedido', 'Estado'] } },
    { id: 'multi-moneda', name: 'Multi-moneda (dólares)', description: 'Cobra y registra ventas en dólares con tipo de cambio.', icon: '💱', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Moneda', 'Tipo de cambio', 'Monto'] } },
    { id: 'balanza', name: 'Integración con balanza para abarrotes', description: 'Lee el peso directo de la balanza al vender productos a granel.', icon: '⚖️', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Producto', 'Peso', 'Precio por kg'] } },
    { id: 'ventas-espera', name: 'Ventas en espera (carrito en pausa)', description: 'Pausa una venta para atender a otro cliente y retómala luego.', icon: '⏸️', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Venta', 'Cliente', 'Total'] } },
    { id: 'guias-remision', name: 'Guías de remisión SUNAT', description: 'Emite guías de remisión electrónicas para trasladar mercadería.', icon: '📃', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Destinatario', 'Punto de llegada', 'Productos'] } },
    { id: 'sunat-resumen-anulaciones', name: 'Resumen diario y anulaciones SUNAT', description: 'Envía el resumen diario de boletas y comunica anulaciones a SUNAT.', icon: '📤', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Fecha', 'Comprobantes', 'Estado'] } },
    { id: 'clientes-documentos-listas', name: 'Clientes con CE/pasaporte, grupos y listas de precios', description: 'Registra clientes extranjeros y asigna grupos con precios propios.', icon: '🪪', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Tipo de documento', 'Número', 'Grupo', 'Lista de precios'] } },
    { id: 'importar-clientes', name: 'Importar clientes (Excel/CSV)', description: 'Carga tu lista de clientes desde un archivo Excel o CSV.', icon: '📥', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Archivo', 'Hoja'] } },
    { id: 'precio-por-margen', name: 'Precio automático por margen', description: 'Calcula el precio de venta a partir del costo y el margen deseado.', icon: '🧮', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Costo', 'Margen %', 'Precio'] } },
    { id: 'edicion-masiva-precios', name: 'Edición masiva de precios', description: 'Cambia precios de muchos productos a la vez por % o monto.', icon: '✏️', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Categoría', 'Ajuste', 'Valor'] } },
    { id: 'transferencias-almacenes', name: 'Transferencias entre almacenes/tiendas', description: 'Mueve stock entre almacenes o tiendas con registro.', icon: '🔄', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Origen', 'Destino', 'Producto', 'Cantidad'] } },
    { id: 'transferencias-cajas', name: 'Transferencias entre cajas', description: 'Pasa efectivo de una caja a otra dejando constancia.', icon: '💸', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Caja origen', 'Caja destino', 'Monto'] } },
    { id: 'bancos-depositos', name: 'Bancos y depósitos (tesorería)', description: 'Registra depósitos y saldos de tus cuentas bancarias.', icon: '🏦', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Banco', 'Fecha', 'Depósito', 'Saldo'] } },
    { id: 'punto-equilibrio', name: 'Punto de equilibrio', description: 'Calcula cuánto debes vender para cubrir tus gastos.', icon: '📈', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Gastos fijos', 'Margen', 'Venta mínima'] } },
    { id: 'tarjeta-recargo', name: 'Pago con tarjeta con recargo %', description: 'Aplica un recargo porcentual cuando el cliente paga con tarjeta.', icon: '💳', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Recargo %', 'Monto'] } },
    { id: 'serie-por-cajero', name: 'Serie de comprobante por cajero', description: 'Asigna una serie de comprobantes distinta a cada cajero.', icon: '🔢', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Cajero', 'Serie', 'Correlativo'] } },
    { id: 'atajos-teclado', name: 'Atajos de teclado completos', description: 'Usa el teclado para vender y moverte más rápido por el sistema.', icon: '⌨️', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Tecla', 'Acción'] } },
    { id: 'servicios-recargas', name: 'Cobro de servicios y recargas', description: 'Cobra recibos de servicios y recargas de celular.', icon: '🔌', enabled: false, page: null, pending: true, preview: { type: 'form', fields: ['Servicio', 'Código', 'Monto'] } },
    { id: 'reporte-igv', name: 'Reporte de IGV', description: 'Resume el IGV de tus ventas y compras del período.', icon: '🧮', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Período', 'Base', 'IGV'] } },
    { id: 'rotacion-abc', name: 'Rotación ABC por categoría', description: 'Clasifica tus productos por cuánto se venden para priorizar compras.', icon: '🔤', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Producto', 'Categoría', 'Clase'] } },
    { id: 'calendario-gastos', name: 'Calendario de gastos', description: 'Programa gastos recurrentes y recibe recordatorios de pago.', icon: '📆', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['Fecha', 'Gasto', 'Monto'] } },
    { id: 'multi-ruc', name: 'Multi-RUC', description: 'Opera varias empresas (RUC) desde el mismo sistema.', icon: '🏢', enabled: false, page: null, pending: true, preview: { type: 'table', columns: ['RUC', 'Razón social', 'Estado'] } }
  ]);
  function list() { return FEATURES; }
  function get(id) { return FEATURES.find(function (feature) { return feature.id === id; }); }
  function isEnabled(id) { var feature = get(id); return !!(feature && feature.enabled && feature.page); }
  function isUnlocked(feature) { return !!(feature && feature.enabled && feature.page); }
  function ownerAllowed() {
    return !!(root.NA_ROLES && typeof root.NA_ROLES.canConfigure === 'function' && root.NA_ROLES.canConfigure());
  }
  function element(tag, className, text) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function openPreview(id) {
    var feature = get(id);
    if (!feature || !root.document || !ownerAllowed()) return;
    var old = root.document.getElementById('naProxPreview');
    if (old) old.remove();
    var dialog = element('dialog', 'na-prox-preview');
    dialog.id = 'naProxPreview';
    dialog.setAttribute('aria-labelledby', 'naProxPreviewTitle');
    dialog.appendChild(element('p', 'na-prox-banner', 'Función en preparación, aún no guarda datos'));
    var title = element('h2', '', feature.name); title.id = 'naProxPreviewTitle'; dialog.appendChild(title);
    if (feature.preview.type === 'form') {
      var form = element('div', 'na-prox-form');
      feature.preview.fields.forEach(function (field) {
        var label = element('label', '', field);
        var input = element('input'); input.type = 'text'; input.placeholder = field; input.readOnly = true; input.disabled = true;
        label.appendChild(input); form.appendChild(label);
      });
      dialog.appendChild(form);
    } else {
      var scroll = element('div', 'na-prox-table-scroll');
      var table = element('table'); var head = element('thead'); var row = element('tr');
      feature.preview.columns.forEach(function (column) { var cell = element('th', '', column); cell.scope = 'col'; row.appendChild(cell); });
      head.appendChild(row); table.appendChild(head);
      var body = element('tbody'); var sample = element('tr');
      feature.preview.columns.forEach(function () { sample.appendChild(element('td', '', '—')); });
      body.appendChild(sample); table.appendChild(body); scroll.appendChild(table); dialog.appendChild(scroll);
    }
    var actions = element('div', 'na-prox-actions');
    var save = element('button', '', 'Guardar'); save.type = 'button'; save.disabled = true;
    var close = element('button', '', 'Cerrar'); close.type = 'button'; close.addEventListener('click', function () { dialog.close(); });
    actions.appendChild(save); actions.appendChild(close); dialog.appendChild(actions);
    dialog.addEventListener('close', function () { dialog.remove(); });
    root.document.body.appendChild(dialog); dialog.showModal();
  }
  function openFeature(feature) {
    if (isUnlocked(feature) && typeof root.goPage === 'function') {
      var open = root.document && root.document.getElementById('naProxPreview');
      if (open) open.close();
      root.goPage(feature.page);
      return;
    }
    openPreview(feature.id);
  }
  function render(container) {
    if (!container || !ownerAllowed()) return;
    container.replaceChildren();
    FEATURES.forEach(function (feature) {
      var unlocked = isUnlocked(feature);
      var card = element('button', 'na-prox-card' + (unlocked ? ' is-enabled' : '')); card.type = 'button'; card.dataset.featureId = feature.id;
      if (!unlocked) card.appendChild(element('span', 'na-prox-badge', '🔒 Próximamente'));
      var icon = element('span', 'na-prox-icon', feature.icon); icon.setAttribute('aria-hidden', 'true'); card.appendChild(icon);
      card.appendChild(element('span', 'na-prox-name', feature.name));
      card.appendChild(element('span', 'na-prox-description', feature.description));
      card.addEventListener('click', function () { openFeature(feature); }); container.appendChild(card);
    });
  }
  root.NA_PROXIMAMENTE = freeze({ FEATURES: FEATURES, list: list, get: get, isEnabled: isEnabled, isUnlocked: isUnlocked, render: render, openPreview: openPreview, openFeature: openFeature });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.NA_PROXIMAMENTE;
  function init() {
    var page = root.document.getElementById('pageProximamente');
    if (!page) return;
    function update() {
      if (page.classList.contains('active')) render(page.querySelector('.na-prox-grid'));
      else { var dialog = root.document.getElementById('naProxPreview'); if (dialog) dialog.close(); }
    }
    new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    update();
  }
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
