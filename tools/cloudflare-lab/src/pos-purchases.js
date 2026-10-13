// Etapa 2 (ítem 11): compra con proveedor y costo en una sola llamada.
// - POST /auth/purchases: registra la compra (pos_purchases + líneas) y aplica cada línea con inventory.adjust ENTRADA
//   usando operation_id '<compra>:<línea>' (el mismo que ya usaba la app). Líneas ya aplicadas se saltan: reintentar no duplica.
// - Permiso: igual que ajustar inventario (dueño; un empleado necesita la aprobación del dueño para esta compra).
// - GET /auth/purchases: últimas compras con sus líneas.
import { getDatabase } from './database-binding.js';
import { adjustCanonicalInventory } from './a6-inventory.js';
import { posRoleFor, verifyOwnerPin } from './pos-roles.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const PID = v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\x00-\x1f\x7f]/.test(v);
const uint = v => Number.isSafeInteger(v) && v >= 0;
const ALLOWED = ['operation_id','promotion_id','authority_epoch','expected_control_revision','client_contract','created_at','supplier','document_ref','lines'];
const LINE = ['line','product_id','quantity','unit_cost_cents'];
const opt = (v, max) => { if (v == null || v === '') return null; const t = String(v).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().replace(/\s+/g, ' '); return t ? t.slice(0, max) : null; };

function validate(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !ALLOWED.includes(k))) return 'unexpected_field';
  if (!ID.test(String(b.operation_id || '')) || !PID(b.promotion_id)) return 'invalid_identity';
  if (!uint(b.authority_epoch) || !uint(b.expected_control_revision) || typeof b.client_contract !== 'string') return 'invalid_authority_revision';
  if (typeof b.created_at !== 'string' || !Number.isFinite(Date.parse(b.created_at))) return 'invalid_created_at';
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 200) return 'invalid_lines';
  const seen = new Set();
  for (const l of b.lines) {
    if (!l || typeof l !== 'object' || Object.keys(l).some(k => !LINE.includes(k))) return 'invalid_line';
    if (!Number.isSafeInteger(l.line) || l.line < 0 || l.line > 10000 || seen.has(l.line)) return 'invalid_line';
    seen.add(l.line);
    if (!PID(l.product_id) || !(typeof l.quantity === 'number' && Number.isFinite(l.quantity) && l.quantity > 0 && l.quantity <= 1e6)) return 'invalid_line';
    if (l.unit_cost_cents != null && !(uint(l.unit_cost_cents) && l.unit_cost_cents <= 1e9)) return 'invalid_line';
  }
  return null;
}
async function closuresReady(db) { return !!(await db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='pos_purchase_closures'").first()); }
async function closureOf(db, id) { return (await closuresReady(db)) ? await db.prepare('SELECT * FROM pos_purchase_closures WHERE purchase_id=?1').bind(id).first() : null; }
function subRequest(body) { return new Request('https://internal.invalid/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }

export async function purchasesRoute(request, env, auth, json) {
  const db = getDatabase(env);
  const ready = !!(await db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='pos_purchases'").first());
  if (request.method === 'GET') {
    if (!ready) return json({ purchases: [], ready: false });
    // Estado de una compra puntual (la app lo consulta antes de cambiar de id): applied | in_progress | not_found.
    const one = new URL(request.url).searchParams.get('id');
    if (one != null) {
      if (!ID.test(one)) return json({ error: 'invalid_identity' }, 400);
      const r = await db.prepare('SELECT purchase_id,status,line_count,total_cost_cents,supplier,document_ref,created_at,completed_at FROM pos_purchases WHERE purchase_id=?1').bind(one).first();
      // Para una compra a medias, qué líneas ya sumaron stock (la app las muestra y completa solo las que faltan).
      let lines = [];
      if (r) {
        lines = (await db.prepare('SELECT line_number,product_id,quantity,unit_cost_cents FROM pos_purchase_lines WHERE purchase_id=?1 ORDER BY line_number').bind(one).all()).results || [];
        for (const l of lines) l.applied = !!(await db.prepare('SELECT 1 ok FROM canonical_inventory_operations WHERE operation_id=?1').bind(one + ':' + l.line_number).first());
      }
      const closed = r ? await closureOf(db, one) : null;
      return json({ purchase_id: one, status: !r ? 'not_found' : r.status === 'aplicada' ? 'applied' : closed ? 'closed_partial' : 'in_progress', purchase: r || null, lines,
        closure: closed ? { reason: closed.reason, closed_at: closed.closed_at, missing_lines: JSON.parse(closed.missing_lines || '[]') } : null });
    }
    const COLS = 'purchase_id,supplier,document_ref,total_cost_cents,line_count,status,created_at,completed_at';
    const recent = (await db.prepare('SELECT ' + COLS + ' FROM pos_purchases ORDER BY created_at DESC LIMIT 300').all()).results || [];
    // Las compras incompletas se listan SIEMPRE, aunque sean más antiguas que las últimas 300.
    const cr = await closuresReady(db);
    const open = (await db.prepare('SELECT ' + COLS + ' FROM pos_purchases WHERE status=\'en_curso\'' + (cr ? ' AND purchase_id NOT IN (SELECT purchase_id FROM pos_purchase_closures)' : '') + ' ORDER BY created_at DESC').all()).results || [];
    const seenIds = new Set(recent.map(r => r.purchase_id));
    const rows = open.filter(r => !seenIds.has(r.purchase_id)).concat(recent);
    if (cr) {
      const cl = (await db.prepare('SELECT purchase_id,reason,closed_at FROM pos_purchase_closures').all()).results || [];
      const byId = new Map(cl.map(c => [c.purchase_id, c]));
      rows.forEach(r => { const c = byId.get(r.purchase_id); if (c && r.status !== 'aplicada') { r.status = 'cerrada_parcial'; r.closure = { reason: c.reason, closed_at: c.closed_at }; } });
    }
    const ids = rows.map(r => r.purchase_id);
    const lines = ids.length ? ((await db.prepare(`SELECT purchase_id,line_number,product_id,quantity,unit_cost_cents FROM pos_purchase_lines WHERE purchase_id IN (${ids.map((_, i) => '?' + (i + 1)).join(',')}) ORDER BY purchase_id,line_number`).bind(...ids).all()).results || []) : [];
    rows.forEach(r => { r.lines = lines.filter(l => l.purchase_id === r.purchase_id); });
    return json({ purchases: rows });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST, OPTIONS' });
  if (!ready) return json({ error: 'purchase_schema_not_ready' }, 503);
  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const invalid = validate(b); if (invalid) return json({ error: invalid }, 400);
  const supplier = opt(b.supplier, 120), doc = opt(b.document_ref, 80);
  const total = b.lines.reduce((s, l) => s + (l.unit_cost_cents == null ? 0 : Math.round(l.unit_cost_cents * l.quantity)), 0);

  let claim = await db.prepare('SELECT * FROM pos_purchases WHERE purchase_id=?1').bind(b.operation_id).first();
  // Mismo id con otro contenido (líneas, cantidades, costos, proveedor o comprobante): 409 y no se aplica nada.
  // Se compara contra lo guardado en la primera llamada (pos_purchases + pos_purchase_lines); no hace falta migración.
  if (claim) {
    const stored = (await db.prepare('SELECT line_number,product_id,quantity,unit_cost_cents FROM pos_purchase_lines WHERE purchase_id=?1 ORDER BY line_number').bind(b.operation_id).all()).results || [];
    const want = [...b.lines].sort((x, y) => x.line - y.line).map(l => [l.line, String(l.product_id), Number(l.quantity), l.unit_cost_cents ?? null]);
    const have = stored.map(l => [Number(l.line_number), String(l.product_id), Number(l.quantity), l.unit_cost_cents == null ? null : Number(l.unit_cost_cents)]);
    const same = JSON.stringify(want) === JSON.stringify(have) && (claim.supplier ?? null) === supplier && (claim.document_ref ?? null) === doc;
    if (!same) return json({ error: 'purchase_payload_mismatch', purchase_id: b.operation_id, status: claim.status === 'aplicada' ? 'applied' : 'in_progress' }, 409);
  }
  if (claim && claim.status !== 'aplicada' && await closureOf(db, b.operation_id))
    return json({ error: 'purchase_closed_partial', purchase_id: b.operation_id, status: 'closed' }, 409);
  if (claim && claim.status === 'aplicada') return json({ status: 'already_processed', purchase_id: b.operation_id, idempotent: true }, 200);
  if (!claim) {
    const stmts = [db.prepare(`INSERT INTO pos_purchases(purchase_id,promotion_id,supplier,document_ref,total_cost_cents,line_count,status,principal_id,created_at)
      VALUES(?1,?2,?3,?4,?5,?6,'en_curso',?7,?8) ON CONFLICT DO NOTHING`).bind(b.operation_id, b.promotion_id, supplier, doc, total, b.lines.length, String(auth.principalId || 'unknown'), b.created_at)];
    b.lines.forEach(l => stmts.push(db.prepare('INSERT INTO pos_purchase_lines(purchase_id,line_number,product_id,quantity,unit_cost_cents) VALUES(?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING')
      .bind(b.operation_id, l.line, l.product_id, l.quantity, l.unit_cost_cents ?? null)));
    await db.batch(stmts);
  }
  const common = { promotion_id: b.promotion_id, authority_epoch: b.authority_epoch, expected_control_revision: b.expected_control_revision, client_contract: b.client_contract, created_at: b.created_at };
  const applied = [], skipped = [];
  for (const l of b.lines) {
    const op = b.operation_id + ':' + l.line;
    if (await db.prepare('SELECT 1 ok FROM canonical_inventory_operations WHERE operation_id=?1').bind(op).first()) { skipped.push({ line: l.line, reason: 'ALREADY_APPLIED' }); continue; }
    let product = await db.prepare('SELECT stock_revision,tracks_inventory FROM products WHERE promotion_id=?1 AND product_id=?2').bind(b.promotion_id, l.product_id).first();
    if (!product) product = await db.prepare('SELECT stock_revision,tracks_inventory FROM canonical_live_products WHERE promotion_id=?1 AND product_id=?2').bind(b.promotion_id, l.product_id).first();
    if (!product) return json({ error: 'purchase_line_failed', line: l.line, detail: { error: 'product_not_found' }, applied, retry_same_operation_id: true }, 409);
    const reason = ('Compra ' + (supplier ? supplier + ' ' : '') + (doc ? doc + ' ' : '') + b.operation_id + ', línea ' + l.line + ': +' + l.quantity).slice(0, 480);
    const res = await adjustCanonicalInventory(subRequest({ ...common, operation_id: op, product_id: l.product_id, movement_type: 'ENTRADA', quantity: l.quantity, expected_stock_revision: Number(product.stock_revision), reason }), env, auth, json);
    if (res.status !== 200 && res.status !== 201) {
      let detail = null; try { detail = await res.json(); } catch {}
      return json({ error: 'purchase_line_failed', line: l.line, detail, applied, retry_same_operation_id: true }, res.status >= 500 ? 503 : 409);
    }
    let out = {}; try { out = await res.json(); } catch {}
    applied.push({ line: l.line, product_id: l.product_id, quantity: l.quantity, stock_after: out.stock_after });
  }
  const at = new Date().toISOString();
  await db.prepare("UPDATE pos_purchases SET status='aplicada',completed_at=?2 WHERE purchase_id=?1 AND status='en_curso'").bind(b.operation_id, at).run();
  return json({ status: 'applied', purchase_id: b.operation_id, supplier, document_ref: doc, total_cost_cents: total, applied, skipped }, 201);
}

// Bot 6 ítem 9: «Cerrar como parcial». Solo el aparato del dueño y con PIN maestro + motivo. Conserva las líneas
// aplicadas y marca las demás como no aplicadas. No toca stock, kardex ni caja. Repetir devuelve lo mismo.
export async function closePartialRoute(request, env, auth, json) {
  const db = getDatabase(env);
  if (!(await closuresReady(db))) return json({ error: 'purchase_schema_not_ready' }, 503);
  const role = auth.posRole === 'empleado' ? 'empleado' : await posRoleFor(db, auth.principalId);
  if (role !== 'owner') return json({ error: 'owner_only' }, 403);
  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const id = String(b && b.purchase_id || ''), reason = opt(b && b.reason, 300);
  if (!ID.test(id)) return json({ error: 'invalid_identity' }, 400);
  if (!reason || reason.length < 3) return json({ error: 'reason_required' }, 400);
  const failure = await verifyOwnerPin(db, b.pin, auth.principalId);
  if (failure) { const { status, ...rest } = failure; return json(rest, status); }
  const p = await db.prepare('SELECT status FROM pos_purchases WHERE purchase_id=?1').bind(id).first();
  if (!p) return json({ error: 'purchase_not_found' }, 404);
  if (p.status === 'aplicada') return json({ error: 'purchase_already_applied' }, 409);
  const prev = await closureOf(db, id);
  if (prev) return json({ status: 'closed_partial', purchase_id: id, idempotent: true, applied_lines: JSON.parse(prev.applied_lines), missing_lines: JSON.parse(prev.missing_lines) }, 200);
  const lines = (await db.prepare('SELECT line_number,product_id,quantity FROM pos_purchase_lines WHERE purchase_id=?1 ORDER BY line_number').bind(id).all()).results || [];
  const applied = [], missing = [];
  for (const l of lines) (await db.prepare('SELECT 1 ok FROM canonical_inventory_operations WHERE operation_id=?1').bind(id + ':' + l.line_number).first() ? applied : missing).push({ line: Number(l.line_number), product_id: l.product_id, quantity: Number(l.quantity) });
  await db.prepare('INSERT INTO pos_purchase_closures(purchase_id,reason,applied_lines,missing_lines,approval_id,principal_id,closed_at) VALUES(?1,?2,?3,?4,NULL,?5,?6) ON CONFLICT DO NOTHING')
    .bind(id, reason, JSON.stringify(applied), JSON.stringify(missing), String(auth.principalId || 'unknown'), new Date().toISOString()).run();
  return json({ status: 'closed_partial', purchase_id: id, applied_lines: applied, missing_lines: missing }, 201);
}
