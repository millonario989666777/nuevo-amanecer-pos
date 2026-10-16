// Datos INVENTADOS para el prototipo local del asistente (nunca datos reales).
// Los mismos productos se cargan en el navegador (posSeed) y en el lector en memoria del servidor (readerData),
// así las consultas del Worker y los documentos del aparato muestran lo mismo.
const P = [
  ['P1', 'Paracetamol 500 mg x100', 0.5, 0.31, 240, 50, 'medicamentos'], ['P2', 'Ibuprofeno 400 mg x10', 2.5, 1.4, 6, 20, 'medicamentos'],
  ['P3', 'Amoxicilina 500 mg x10', 4.8, 2.9, 0, 10, 'medicamentos'], ['P4', 'Alcohol 70° 1 L', 9.5, 6.1, 14, 6, 'cuidado'],
  ['P5', 'Suero oral 500 ml', 3.8, 2.2, 25, 12, 'medicamentos'], ['P6', 'Gasa estéril 10x10', 1.2, 0, 40, 20, 'curación'],
  ['P7', 'Vitamina C 1 g x10', 6.0, 3.6, 3, 8, 'vitaminas'], ['P8', 'Mascarilla KN95', 1.5, 0.8, 120, 30, 'cuidado'],
  ['P9', 'Jarabe para la tos 120 ml', 12.0, 7.5, 4, 5, 'medicamentos'], ['P10', 'Termómetro digital', 18.0, 0, 7, 2, 'equipos'],
  ['P11', 'Omeprazol 20 mg x10', 3.0, 1.6, 2, 10, 'medicamentos'], ['P12', 'Curitas x20', 2.0, 1.1, 33, 10, 'curación']
];
function iso(daysAgo, h) { const d = new Date(Date.now() - daysAgo * 86400000); d.setUTCHours(h + 5, 10, 0, 0); return d.toISOString(); }
function lima(isoS) { return new Date(Date.parse(isoS) - 5 * 3600 * 1000).toISOString().slice(0, 10); }
const SALES = [], ITEMS = [];
const pattern = [[0, 9, 'efectivo', [['P1', 6], ['P5', 2]]], [0, 11, 'yape', [['P4', 1], ['P8', 4]]], [0, 16, 'efectivo', [['P9', 1], ['P12', 2]]], [1, 10, 'plin', [['P1', 10], ['P2', 2]]],
  [1, 18, 'credito', [['P10', 1]]], [2, 12, 'efectivo', [['P5', 3], ['P7', 1]]], [3, 9, 'yape', [['P8', 10]]], [5, 15, 'efectivo', [['P1', 12], ['P11', 2]]], [6, 10, 'transferencia', [['P4', 2], ['P6', 5]]]];
pattern.forEach(([d, h, metodo, lines], i) => {
  const id = 'V-' + (1000 + i), created = iso(d, h); let total = 0;
  lines.forEach(([pid, q], n) => { const p = P.find((x) => x[0] === pid); const c = Math.round(p[2] * q * 100); total += c; ITEMS.push({ sale_id: id, line_number: n + 1, product_id: pid, quantity: q, line_total_cents: c }); });
  SALES.push({ sale_id: id, created_at: created, metodo, total_cents: total });
});
const CUSTOMERS = [{ id: 'C1', nombre: 'Rosa Quispe', dni: '40112233' }, { id: 'C2', nombre: 'Juan Mamani', dni: '45556677' }, { id: 'C3', nombre: 'Lucía Torres', dni: '47778899' }];
const CREDITS = [{ id: 'CR1', cliId: 'C1', desc: 'Venta V-0991', monto: 48.5, pagado: 20, saldo: 28.5, vence: '2026-10-30' }, { id: 'CR2', cliId: 'C2', desc: 'Venta V-0995', monto: 18, pagado: 0, saldo: 18, vence: '2026-10-20' },
  { id: 'CR3', cliId: 'C1', desc: 'Venta V-1004', monto: 18, pagado: 0, saldo: 18, vence: '2026-11-15' }, { id: 'CR4', cliId: 'C3', desc: 'Venta V-0950', monto: 30, pagado: 30, saldo: 0, vence: '2026-09-30' }];
const PURCHASES = [{ supplier: 'Distribuidora Ejemplo SAC', document_ref: 'F001-000120', total_cost_cents: 18640, line_count: 4, status: 'aplicada', created_at: iso(2, 10) },
  { supplier: 'Droguería Inventada EIRL', document_ref: 'F002-004512', total_cost_cents: 7420, line_count: 2, status: 'aplicada', created_at: iso(8, 15) }];

export const readerData = {
  products: P.map(([id, nombre, precio, costo, stock, min]) => ({ id, nombre, precio, costo: costo || null, stock, min, controla: true })),
  sales: SALES, saleItems: ITEMS, purchases: PURCHASES,
  customers: CUSTOMERS.map((c) => ({ id: c.id, nombre: c.nombre })),
  credits: CREDITS.map((c) => ({ cliente: c.cliId, saldo: c.saldo, vence: c.vence }))
};
export const posSeed = {
  productos: P.map(([id, name, precio, costo, stock, stockMin, cat]) => ({ id, name, precio, costo, stock, stockMin, cat, icon: '💊', controlInventario: true })),
  ventas: SALES.map((s) => ({ id: s.sale_id, fecha: lima(s.created_at), total: s.total_cents / 100, metodo: s.metodo, metodoPago: s.metodo, estado: s.metodo === 'credito' ? 'credito' : 'completada',
    items: ITEMS.filter((i) => i.sale_id === s.sale_id).map((i) => { const p = P.find((x) => x[0] === i.product_id); return { id: i.product_id, name: p[1], precio: p[2], qty: i.quantity, costo: p[3] }; }) })),
  clientes: CUSTOMERS, creditos: CREDITS
};
