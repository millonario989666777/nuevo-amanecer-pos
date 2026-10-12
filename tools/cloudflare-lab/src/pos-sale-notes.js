// Etapa 2 (ítem 10): nota opcional de una venta CANON en el servidor.
// - Registro aparte (pos_sale_notes): nunca toca montos, caja, crédito ni stock.
// - POST /auth/sale-notes {sale_id, note}: la venta debe existir; reenviar es idempotente; editar reemplaza el texto.
// - GET /auth/sale-notes: últimas notas para el Historial y el comprobante.
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
  const sale = await db.prepare('SELECT 1 ok FROM sales WHERE sale_id=?1').bind(b.sale_id).first();
  if (!sale) return json({ error: 'sale_not_found', sale_id: b.sale_id }, 404);
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO pos_sale_notes(sale_id,note,principal_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)
    ON CONFLICT(sale_id) DO UPDATE SET note=excluded.note, updated_at=excluded.updated_at WHERE pos_sale_notes.note<>excluded.note`)
    .bind(b.sale_id, note, String(auth.principalId || 'unknown'), now).run();
  return json({ status: 'ok', sale_id: b.sale_id, note });
}
