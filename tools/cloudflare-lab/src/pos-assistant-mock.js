// Modo demostración del asistente: se usa cuando el Worker no tiene DEEPSEEK_API_KEY.
// Responde con reglas simples y devuelve las MISMAS llamadas de herramienta que haría el modelo,
// así la validación, los permisos y las tarjetas «Confirmar» se prueban igual sin gastar.
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function findProducts(text, products) {
  const t = norm(text);
  return products.filter((p) => norm(p.nombre).split(/\s+/).some((w) => w.length >= 4 && t.includes(w)));
}
function numberBefore(text, product) {
  const t = norm(text), w = norm(product.nombre).split(/\s+/).find((x) => x.length >= 4 && t.includes(x));
  const m = w ? new RegExp('(\\d+)\\s+(?:\\w+\\s+){0,2}' + w).exec(t) : null;
  return m ? Number(m[1]) : 1;
}
const call = (name, args) => ({ name, arguments: JSON.stringify(args) });

export function mockAssistantReply({ role, ctx, text, image }) {
  const t = norm(text), products = ctx.products || [];
  if (image) {
    const picks = products.slice(0, 3);
    const lineas = picks.map((p, i) => ({ product_id: p.id, nombre: p.nombre, cantidad: [24, 12, 6][i], costo_unitario: p.precio ? Math.round(p.precio * 0.62 * 100) / 100 : null }));
    lineas.push({ nombre: 'Producto no registrado (revisar)', cantidad: 2, costo_unitario: 4.5 });
    return { content: 'Leí la factura de la foto (demostración). Encontré ' + lineas.length + ' líneas. Revisa y pulsa Confirmar.',
      calls: [call('leer_factura_compra', { proveedor: 'Distribuidora Ejemplo SAC', documento: 'F001-000123', fecha: '2026-10-16', lineas })] };
  }
  if (/precio/.test(t)) {
    const p = findProducts(t, products)[0];
    const n = /(\d+(?:[.,]\d+)?)\s*(?:soles|sol)?\s*$/.exec(t) || /a\s+(?:s\/\s*)?(\d+(?:[.,]\d+)?)/.exec(t);
    if (!p) return { content: 'Dime qué producto quieres cambiar de precio.', calls: [] };
    const nuevo = n ? Number(String(n[1]).replace(',', '.')) : Math.round((p.precio || 1) * 1.1 * 10) / 10;
    // En demostración también se "pide" la herramienta al empleado: el Worker la debe descartar.
    return { content: role === 'owner' ? `Propongo cambiar ${p.nombre} a S/ ${nuevo.toFixed(2)}. Revisa y pulsa Confirmar.` : '',
      calls: [call('proponer_cambio_precio', { product_id: p.id, nombre: p.nombre, precio_nuevo: nuevo, motivo: 'Pedido en el chat' })] };
  }
  if (/compra|proveedor|llego|llegaron|pedido/.test(t)) {
    const ps = findProducts(t, products);
    if (!ps.length) return { content: 'Dime qué productos llegaron y cuántos.', calls: [] };
    return { content: 'Preparé la compra. Revisa cantidades y costos, y pulsa Confirmar.',
      calls: [call('preparar_compra', { lineas: ps.map((p) => ({ product_id: p.id, nombre: p.nombre, cantidad: numberBefore(t, p) })) })] };
  }
  if (/nota|cotiza|documento|lista de precios|pdf|ticket/.test(t)) {
    const ps = findProducts(t, products); const list = ps.length ? ps : products.slice(0, 5);
    const tipo = /cotiza/.test(t) ? 'cotizacion' : /lista/.test(t) ? 'lista_precios' : 'nota_venta';
    return { content: 'Preparé la vista previa. No es comprobante SUNAT. Pulsa Confirmar para verla.',
      calls: [call('preparar_documento', { tipo, lineas: list.map((p) => ({ nombre: p.nombre, cantidad: tipo === 'lista_precios' ? 1 : numberBefore(t, p), precio: p.precio })) })] };
  }
  if (/vend|agrega|carrito|cobra|quiere|llevar/.test(t)) {
    const ps = findProducts(t, products);
    if (!ps.length) return { content: 'No encontré ese producto en el inventario. ¿Cómo se llama exactamente?', calls: [] };
    return { content: 'Preparé la venta. Revisa y pulsa Confirmar. Después cobras como siempre.',
      calls: [call('preparar_venta', { lineas: ps.map((p) => ({ product_id: p.id, nombre: p.nombre, cantidad: numberBefore(t, p) })) })] };
  }
  if (/como|ayuda|donde|que hago/.test(t)) {
    if (/caja/.test(t)) return { content: 'Así se abre la caja:', calls: [call('explicar_pasos', { tema: 'Abrir caja', pantalla: 'pageCaja', pasos: ['Toca Caja en el menú.', 'Pulsa «Abrir caja».', 'Escribe el dinero inicial.', 'Confirma.'] })] };
    if (/abono|credito|deuda/.test(t)) return { content: 'Así registras un abono:', calls: [call('explicar_pasos', { tema: 'Registrar un abono', pantalla: 'pageClientes', pasos: ['Toca Clientes.', 'Abre la ficha del cliente.', 'Pulsa «Abonar».', 'Escribe el monto y elige la deuda.', 'Pulsa Confirmar.'] })] };
    return { content: 'Así se cobra una venta:', calls: [call('explicar_pasos', { tema: 'Cobrar una venta', pantalla: 'pagePOS', pasos: ['Toca Venta.', 'Agrega los productos.', 'Pulsa Cobrar.', 'Elige efectivo, Yape o Plin.', 'Confirma.'] })] };
  }
  return { content: 'Hola, soy Burbuja. Puedo preparar ventas, compras, documentos, leer fotos de facturas y explicarte cómo hacer las cosas.', calls: [] };
}
