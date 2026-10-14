// Etapa 2 (G, punto 4): anular una venta CANON en el servidor (solo con internet).
// - La aprobación del dueño (acción 'sale.annul', atada al operation_id) la valida ownerGate antes de llegar aquí.
// - Una fila por venta en pos_sale_annulments: el stock vuelve una sola vez. Otro operation_id para la misma
//   venta recibe 409 already_annulled; el mismo operation_id es un reintento idempotente.
// - Efectos con comandos existentes y operation_id derivados (cada uno idempotente por sí mismo):
//   efectivo -> adjustment.create negativo en la caja abierta ('<op>:cash');
//   stock    -> inventory.adjust ENTRADA por cada movimiento de la venta ('<op>:inv:<línea>').
// - Ventas con crédito no se anulan aquí (el saldo del crédito se corrige desde Créditos).
// - Nunca borra ni edita la venta: la anulación es un registro aparte.
import { getDatabase } from './database-binding.js';
import { createCanonicalFinancial } from './a6-financial.js';
import { adjustCanonicalInventory } from './a6-inventory.js';
import { lotsReady } from './stock-lots.js';

export const SALE_ANNUL_COMMAND = 'sale.annul';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SALE_ID = v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\x00-\x1f\x7f]/.test(v);
const uint = v => Number.isSafeInteger(v) && v >= 0;
const ALLOWED = ['operation_id','promotion_id','authority_epoch','expected_control_revision','client_contract','created_at','sale_id','reason'];

function validate(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'invalid_body';
  if (Object.keys(b).some(k => !ALLOWED.includes(k))) return 'unexpected_field';
  if (!ID.test(String(b.operation_id || '')) || !SALE_ID(b.promotion_id) || !SALE_ID(b.sale_id)) return 'invalid_identity';
  if (!uint(b.authority_epoch) || !uint(b.expected_control_revision) || typeof b.client_contract !== 'string') return 'invalid_authority_revision';
  if (typeof b.created_at !== 'string' || !Number.isFinite(Date.parse(b.created_at))) return 'invalid_created_at';
  const reason = typeof b.reason === 'string' ? b.reason.trim().replace(/\s+/g, ' ') : '';
  if (!reason || reason.length > 300 || /[\x00-\x1f\x7f]/.test(reason)) return 'reason_required';
  b.reason = reason;
  return null;
}

function subRequest(body) {
  return new Request('https://internal.invalid/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export async function annulCanonicalSale(request, env, auth, json) {
  let body; try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const invalid = validate(body);
  if (invalid) return json({ error: invalid }, 400);
  const db = getDatabase(env);
  const ready = await db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='pos_sale_annulments'").first();
  if (!ready) return json({ error: 'annul_schema_not_ready' }, 503);

  let claim = await db.prepare('SELECT * FROM pos_sale_annulments WHERE sale_id=?1').bind(body.sale_id).first();
  if (claim && claim.operation_id !== body.operation_id) {
    return json({ error: 'already_annulled', sale_id: body.sale_id, status: claim.status, operation_id: claim.operation_id }, 409);
  }
  if (claim && claim.status === 'anulada') return json({ ...JSON.parse(claim.result_json || '{}'), status: 'already_processed', idempotent: true }, 200);

  const sale = await db.prepare(`SELECT s.sale_id,s.payment_method,s.total_cents,x.promotion_id,m.cash_cents,m.digital_cents,m.credit_cents
      FROM sales s JOIN canonical_sale_context x ON x.sale_id=s.sale_id LEFT JOIN cash_movements m ON m.sale_id=s.sale_id
     WHERE s.sale_id=?1`).bind(body.sale_id).first();
  if (!sale || sale.promotion_id !== body.promotion_id) return json({ error: 'sale_not_found', sale_id: body.sale_id }, 404);
  if (sale.payment_method === 'credito' || Number(sale.credit_cents) > 0) return json({ error: 'annul_credit_sale_unsupported', sale_id: body.sale_id }, 409);
  const cash = Number(sale.cash_cents || 0), digital = Number(sale.digital_cents || 0);

  if (!claim) {
    // Antes de reservar: si hay efectivo que devolver debe existir una caja abierta con saldo suficiente.
    if (cash > 0) {
      const open = await db.prepare("SELECT expected_cents FROM canonical_cash_state WHERE promotion_id=?1 AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(body.promotion_id).first();
      if (!open) return json({ error: 'cash_session_required' }, 409);
      if (Number(open.expected_cents) < cash) return json({ error: 'cash_insufficient', expected_cents: Number(open.expected_cents), cash_cents: cash }, 409);
    }
    await db.prepare(`INSERT INTO pos_sale_annulments(sale_id,operation_id,promotion_id,reason,status,cash_cents,digital_cents,principal_id,created_at)
      VALUES(?1,?2,?3,?4,'en_curso',?5,?6,?7,?8) ON CONFLICT DO NOTHING`)
      .bind(body.sale_id, body.operation_id, body.promotion_id, body.reason, cash, digital, auth.principalId, body.created_at).run();
    claim = await db.prepare('SELECT * FROM pos_sale_annulments WHERE sale_id=?1').bind(body.sale_id).first();
    if (!claim || claim.operation_id !== body.operation_id) return json({ error: 'already_annulled', sale_id: body.sale_id }, 409);
  }

  const common = { promotion_id: body.promotion_id, authority_epoch: body.authority_epoch, expected_control_revision: body.expected_control_revision,
    client_contract: body.client_contract, created_at: body.created_at };
  const reason = ('Anulación de venta ' + body.sale_id + ': ' + claim.reason).slice(0, 480);
  const effects = { cash_refund_cents: 0, stock_returned: [] };
  const exists = async (table, op) => !!(await db.prepare(`SELECT 1 ok FROM ${table} WHERE operation_id=?1`).bind(op).first());
  const fail = async (step, res) => {
    let detail = null; try { detail = await res.json(); } catch {}
    return json({ error: 'annul_step_failed', step, detail, operation_id: body.operation_id, retry_same_operation_id: true }, res.status >= 500 ? 503 : 409);
  };

  // 1) Devolución de efectivo (una vez).
  if (Number(claim.cash_cents) > 0) {
    const op = body.operation_id + ':cash';
    if (!await exists('canonical_financial_operations', op)) {
      const open = await db.prepare("SELECT session_id,revision FROM canonical_cash_state WHERE promotion_id=?1 AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(body.promotion_id).first();
      if (!open) return json({ error: 'cash_session_required', operation_id: body.operation_id, retry_same_operation_id: true }, 409);
      const res = await createCanonicalFinancial('adjustment.create', subRequest({ ...common, operation_id: op, session_id: open.session_id,
        expected_session_revision: Number(open.revision), amount_cents: -Number(claim.cash_cents), reason }), env, auth, json);
      if (res.status !== 200 && res.status !== 201 && !await exists('canonical_financial_operations', op)) return fail('cash', res);
    }
    effects.cash_refund_cents = Number(claim.cash_cents);
  }

  // 2) Stock de vuelta (una vez por movimiento de la venta).
  const moves = (await db.prepare('SELECT line_number,product_id,quantity FROM inventory_movements WHERE sale_id=?1 ORDER BY line_number').bind(body.sale_id).all()).results || [];
  const restoreLots=await lotsReady(db);
  for (const m of moves) {
    const op = body.operation_id + ':inv:' + m.line_number, qty = -Number(m.quantity);
    if (!(qty > 0)) continue;
    if (!await exists('canonical_inventory_operations', op)) {
      let product = await db.prepare('SELECT stock_revision,tracks_inventory FROM products WHERE promotion_id=?1 AND product_id=?2').bind(body.promotion_id, m.product_id).first();
      if (!product) product = await db.prepare('SELECT stock_revision,tracks_inventory FROM canonical_live_products WHERE promotion_id=?1 AND product_id=?2').bind(body.promotion_id, m.product_id).first();
      if (!product || Number(product.tracks_inventory) !== 1) continue;
      const res = await adjustCanonicalInventory(subRequest({ ...common, operation_id: op, product_id: m.product_id, movement_type: 'ENTRADA',
        quantity: qty, expected_stock_revision: Number(product.stock_revision), reason }), env, auth, json,
        restoreLots?{operation_id:body.operation_id}:null);
      if (res.status !== 200 && res.status !== 201 && !await exists('canonical_inventory_operations', op)) return fail('stock:' + m.line_number, res);
    }
    effects.stock_returned.push({ line_number: m.line_number, product_id: m.product_id, quantity: qty });
  }

  const result = { status: 'annulled', command: SALE_ANNUL_COMMAND, operation_id: body.operation_id, sale_id: body.sale_id, reason: claim.reason,
    cash_refund_cents: effects.cash_refund_cents, digital_to_refund_cents: Number(claim.digital_cents), stock_returned: effects.stock_returned,
    annulled_at: new Date().toISOString(), idempotent: false };
  await db.prepare("UPDATE pos_sale_annulments SET status='anulada',result_json=?2,completed_at=?3 WHERE sale_id=?1 AND operation_id=?4 AND status='en_curso'")
    .bind(body.sale_id, JSON.stringify(result), result.annulled_at, body.operation_id).run();
  return json(result, 201);
}

// Lista para la app: ventas anuladas (y en curso) para marcar el Historial.
export async function listSaleAnnulments(env, json) {
  const db = getDatabase(env);
  try {
    const rows = (await db.prepare('SELECT sale_id,operation_id,reason,status,cash_cents,digital_cents,created_at,completed_at FROM pos_sale_annulments ORDER BY created_at DESC LIMIT 2000').all()).results || [];
    return json({ annulments: rows });
  } catch (e) {
    if (/no such table/i.test(String(e?.message))) return json({ annulments: [], ready: false });
    throw e;
  }
}
