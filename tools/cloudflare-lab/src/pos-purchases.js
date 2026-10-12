// Etapa 2 (ítem 11): compra con proveedor y costo en una sola llamada.
// - POST /auth/purchases: registra la compra (pos_purchases + líneas) y aplica cada línea con inventory.adjust ENTRADA
//   usando operation_id '<compra>:<línea>' (el mismo que ya usaba la app). Líneas ya aplicadas se saltan: reintentar no duplica.
// - Permiso: igual que ajustar inventario (dueño; un empleado necesita la aprobación del dueño para esta compra).
// - GET /auth/purchases: últimas compras con sus líneas.
import { getDatabase } from './database-binding.js';
import { adjustCanonicalInventory } from './a6-inventory.js';

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
function subRequest(body) { return new Request('https://internal.invalid/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }

export async function purchasesRoute(request, env, auth, json) {
  const db = getDatabase(env);
  const ready = !!(await db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='pos_purchases'").first());
  if (request.method === 'GET') {
    if (!ready) return json({ purchases: [], ready: false });
    const rows = (await db.prepare('SELECT purchase_id,supplier,document_ref,total_cost_cents,line_count,status,created_at,completed_at FROM pos_purchases ORDER BY created_at DESC LIMIT 300').all()).results || [];
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
