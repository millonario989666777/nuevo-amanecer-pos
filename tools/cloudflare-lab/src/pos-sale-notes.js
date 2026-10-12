// Etapa 2 (ítem 10): nota opcional de una venta CANON en el servidor.
// - Registro aparte (pos_sale_notes): nunca toca montos, caja, crédito ni stock.
// - POST /auth/sale-notes {sale_id, note}: la venta debe existir; reenviar es idempotente; editar reemplaza el texto.
// - GET /auth/sale-notes: últimas notas para el Historial y el comprobante.
// - Comentario de abono: misma tabla con llave 'pay:<operation_id>' (el abono debe existir).
// - GET /auth/record-meta: quién atendió cada venta y abono (etiqueta del aparato; sin fila = Dueño).
import { getDatabase } from './database-binding.js';

const SALE_ID = v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\x00-\x1f\x7f]/.test(v);
const ALLOWED = ['sale_id', 'note'];

export async function saleNoteRoute(request, env, auth, json) {
  const db = getDatabase(env);
  const ready = await db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='pos_sale_notes'").first();
  if (request.method === 'GET') {
    if (!ready) return json({ notes: [], ready: false });
    const rows = (await db.prepare('SELECT sale_id,note,updated_at FROM pos_sale_notes ORDER BY updated_at DESC LIMIT 3000').all()).results || [];
    return json({ notes: rows });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST, OPTIONS' });
  if (!ready) return json({ error: 'sale_note_schema_not_ready' }, 503);
  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !ALLOWED.includes(k))) return json({ error: 'unexpected_field' }, 400);
  if (!SALE_ID(b.sale_id)) return json({ error: 'invalid_identity' }, 400);
  const note = typeof b.note === 'string' ? b.note.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().replace(/\s+/g, ' ') : '';
  if (!note || note.length > 300) return json({ error: 'invalid_note' }, 400);
  const isPay = b.sale_id.startsWith('pay:');
  const sale = isPay
    ? await db.prepare('SELECT 1 ok FROM canonical_financial_events WHERE operation_id=?1 AND credit_id IS NOT NULL LIMIT 1').bind(b.sale_id.slice(4)).first().catch(() => null)
    : await db.prepare('SELECT 1 ok FROM sales WHERE sale_id=?1').bind(b.sale_id).first();
  if (!sale) return json({ error: 'sale_not_found', sale_id: b.sale_id }, 404);
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO pos_sale_notes(sale_id,note,principal_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)
    ON CONFLICT(sale_id) DO UPDATE SET note=excluded.note, updated_at=excluded.updated_at WHERE pos_sale_notes.note<>excluded.note`)
    .bind(b.sale_id, note, String(auth.principalId || 'unknown'), now).run();
  return json({ status: 'ok', sale_id: b.sale_id, note });
}

const CASHIER = "COALESCE(r.label, CASE r.pos_role WHEN 'empleado' THEN 'Empleado' ELSE 'Dueño' END)";
async function hasTable(db, name) { return !!(await db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?1").bind(name).first()); }
export async function recordMetaRoute(env, json) {
  const db = getDatabase(env);
  const roles = await hasTable(db, 'pos_device_roles');
  const join = roles ? 'LEFT JOIN pos_device_roles r ON r.device_id=x.device_id' : 'LEFT JOIN (SELECT NULL device_id,NULL label,NULL pos_role) r ON 0';
  const sales = (await db.prepare(`SELECT x.sale_id, ${CASHIER} cashier FROM (SELECT sale_id,device_id,created_at FROM sales ORDER BY created_at DESC LIMIT 3000) x ${join}`).all()).results || [];
  let payments = [];
  if (await hasTable(db, 'canonical_financial_operations')) {
    payments = (await db.prepare(`SELECT x.operation_id, ${CASHIER} cashier FROM (SELECT operation_id,device_id,created_at FROM canonical_financial_operations WHERE command='payment.create' ORDER BY created_at DESC LIMIT 3000) x ${join}`).all()).results || [];
  }
  return json({ sales, payments });
}
