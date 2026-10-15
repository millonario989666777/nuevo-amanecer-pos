import { cashSessionCashierAvailable, authenticatedCashier } from './cash-session-cashier.js';
import { getDatabase } from './database-binding.js';
import { sha256Hex, stableStringify } from './a5-import-core.js';

export const FINANCIAL_COMMANDS = new Set(['payment.create','cash.open','cash.close','adjustment.create','compensation.create']);
const COMMON = ['operation_id','promotion_id','client_contract','authority_epoch','expected_control_revision','created_at'];
const FIELDS = {
  'payment.create': ['credit_id','expected_credit_revision','amount_cents','payment_method','session_id','reference'],
  'cash.open': ['session_id','opening_cents'],
  'cash.close': ['session_id','expected_session_revision','counted_cents'],
  'adjustment.create': ['session_id','expected_session_revision','amount_cents','reason'],
  // credit_id is optional: when present the Worker proves the annulled payment belongs to that credit.
  'compensation.create': ['compensates_operation_id','session_id','expected_session_revision','expected_credit_revision','reason','credit_id'],
};
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\x00-\x1f\x7f]/.test(v);
const uint = v => Number.isSafeInteger(v) && v >= 0;
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 500 && !/[\x00-\x1f\x7f]/.test(v);

// P1-1: a digital voucher (Yape/Plin/transferencia operation number) settles debt only once per
// promotion. Same rule as migration 0021: trim, no whitespace, ASCII lower-case.
export function normalizePaymentReference(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g,'').replace(/[A-Z]/g, c => c.toLowerCase()) : '';
}
let paymentReferencesTable = false; // cached only once seen: a missing table is re-probed every time
async function paymentReferenceGuard(db, promotionId, method, reference) {
  if (method === 'efectivo') return null;
  const norm = normalizePaymentReference(reference);
  if (!norm) return null;
  if (!paymentReferencesTable) {
    // Enforcement starts once migration 0021 is applied; before that the legacy behaviour stays.
    const table = await db.prepare(`SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='canonical_payment_references'`).first();
    if (!table) return null;
    paymentReferencesTable = true;
  }
  let row;
  try { row = await db.prepare('SELECT operation_id FROM canonical_payment_references WHERE promotion_id=?1 AND reference_norm=?2').bind(promotionId,norm).first(); }
  catch (error) {
    if (/no such table/i.test(String(error?.message))) { paymentReferencesTable = false; return null; }
    throw error;
  }
  return { norm, usedBy: row ? row.operation_id : null };
}
async function referenceTakenBy(db, guard, operationId) {
  if (!guard) return false;
  const row = await db.prepare('SELECT operation_id FROM canonical_payment_references WHERE promotion_id=?1 AND reference_norm=?2')
    .bind(guard.promotionId,guard.norm).first().catch(() => null);
  return !!(row && row.operation_id !== operationId);
}

function validate(command, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'invalid_body';
  if (Object.keys(b).some(k => ![...COMMON,...FIELDS[command]].includes(k))) return 'unexpected_field';
  if (!['operation_id','promotion_id'].every(k => id(b[k]))) return 'invalid_identity';
  if (b.client_contract !== 'a6-gate-c-v1' || !uint(b.authority_epoch) || !uint(b.expected_control_revision)) return 'invalid_authority_revision';
  if (typeof b.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(b.created_at) ||
      !Number.isFinite(Date.parse(b.created_at)) || !Number.isFinite(Date.parse(b.created_at.slice(0,10))) ||
      new Date(b.created_at.slice(0,10)).toISOString().slice(0,10) !== b.created_at.slice(0,10)) return 'invalid_created_at';
  if (b.session_id !== undefined && !id(b.session_id)) return 'invalid_session_id';
  if (b.expected_session_revision !== undefined && !uint(b.expected_session_revision)) return 'invalid_session_revision';
  if (b.expected_credit_revision !== undefined && !uint(b.expected_credit_revision)) return 'invalid_credit_revision';
  if (command === 'payment.create') {
    if (!id(b.credit_id) || !uint(b.expected_credit_revision) || !uint(b.amount_cents) || b.amount_cents === 0 ||
        !['efectivo','yape','plin','transferencia'].includes(b.payment_method)) return 'invalid_payment';
    if (b.payment_method === 'efectivo' ? !id(b.session_id) : b.session_id !== undefined) return 'invalid_payment_session';
    if (b.reference !== undefined && !id(b.reference)) return 'invalid_reference';
  }
  if (command === 'cash.open' && (!id(b.session_id) || !uint(b.opening_cents))) return 'invalid_opening';
  if (command === 'cash.close' && (!id(b.session_id) || !uint(b.expected_session_revision) || !uint(b.counted_cents))) return 'invalid_closure';
  if (command === 'adjustment.create' && (!id(b.session_id) || !uint(b.expected_session_revision) || !Number.isSafeInteger(b.amount_cents) || b.amount_cents === 0)) return 'invalid_adjustment';
  if (['adjustment.create','compensation.create'].includes(command) && !text(b.reason)) return 'reason_required';
  if (command === 'compensation.create' && (!id(b.compensates_operation_id) || (b.credit_id !== undefined && !id(b.credit_id)))) return 'invalid_compensation';
  return null;
}

export async function createCanonicalFinancial(command, request, env, auth, json) {
  let body;
  try { body = await request.json(); } catch { return json({error:'invalid_json'},400); }
  const invalid = validate(command,body);
  if (invalid) return json({error:invalid},400);
  const db = getDatabase(env);
  const hash = await sha256Hex(stableStringify({command,body}));
  async function authorityError() {
    const c = await db.prepare(`SELECT c.*,d.role,d.status,d.credential_hash FROM canonical_control c
      LEFT JOIN devices d ON d.device_id=?1 WHERE c.id=1`).bind(auth.principalId).first();
    if (!c || c.mode !== 'ACTIVE') return 'canonical_not_active';
    if (c.active_promotion_id !== body.promotion_id || c.authority_epoch !== body.authority_epoch ||
        c.revision !== body.expected_control_revision || c.minimum_client_contract !== body.client_contract ||
        c.role !== 'writer' || c.status !== 'active' || c.credential_hash !== auth.credentialHash) return 'stale_authority';
    return null;
  }
  async function replay() {
    const row = await db.prepare('SELECT command,request_hash,result_json FROM canonical_financial_operations WHERE operation_id=?1').bind(body.operation_id).first();
    const collision = row ? null : await db.prepare('SELECT operation_id FROM sales WHERE operation_id=?1').bind(body.operation_id).first();
    const denied = await authorityError();
    if (denied) return json({error:denied},409);
    if (collision || (row && (row.command !== command || row.request_hash !== hash))) return json({error:'operation_id_conflict',operation_id:body.operation_id},409);
    return row ? json({...JSON.parse(row.result_json),status:'already_processed',idempotent:true}) : null;
  }
  const denied = await authorityError();
  if (denied) return json({error:denied},409);
  const previous = await replay();
  if (previous) return previous;
  const referenceGuard = command === 'payment.create' ? await paymentReferenceGuard(db,body.promotion_id,body.payment_method,body.reference) : null;
  if (referenceGuard) referenceGuard.promotionId = body.promotion_id;
  if (referenceGuard && referenceGuard.usedBy) return json({error:'reference_already_used',reference:body.reference},409);

  const token = crypto.randomUUID();
  const assertions = [];
  const assert = (condition, ...params) => assertions.push(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok)
    SELECT ?1,CASE WHEN ${condition} THEN 1 ELSE 0 END`).bind(`${token}:cas:${assertions.length}`,...params));
  const result = {status:'created',operation_id:body.operation_id,command,promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,idempotent:false};
  let credit = null, session = null, target = null;
  let creditDelta = 0, cashDelta = 0;
  let method = body.payment_method ?? null;
  if (command === 'compensation.create') {
    target = await db.prepare(`SELECT * FROM canonical_financial_events WHERE operation_id=?1 AND promotion_id=?2
      AND event_type IN ('PAYMENT','ADJUSTMENT')`).bind(body.compensates_operation_id,body.promotion_id).first();
    if (!target) return json({error:'compensation_target_not_found'},409);
    // Anular abono: the payment must belong to the credit the cashier is looking at.
    if (body.credit_id !== undefined && String(target.credit_id ?? '') !== body.credit_id) return json({error:'compensation_credit_mismatch'},409);
    if (await db.prepare('SELECT 1 ok FROM canonical_financial_events WHERE compensates_operation_id=?1').bind(body.compensates_operation_id).first()) return json({error:'already_compensated'},409);
    creditDelta = -target.credit_delta_cents; cashDelta = -target.cash_delta_cents; method = target.payment_method;
    if (cashDelta !== 0 ? !id(body.session_id) || !uint(body.expected_session_revision) : body.session_id !== undefined || body.expected_session_revision !== undefined) return json({error:'invalid_compensation_session'},400);
    if (target.credit_id !== null ? !uint(body.expected_credit_revision) : body.expected_credit_revision !== undefined) return json({error:'invalid_credit_revision'},400);
    result.compensates_operation_id = body.compensates_operation_id;
  }
  if (command === 'payment.create') { creditDelta = -body.amount_cents; cashDelta = method === 'efectivo' ? body.amount_cents : 0; }
  if (command === 'adjustment.create') cashDelta = body.amount_cents;
  const creditId = command === 'payment.create' ? body.credit_id : target?.credit_id;
  if (creditId) {
    credit = await db.prepare('SELECT * FROM canonical_credit_balances WHERE promotion_id=?1 AND credit_id=?2').bind(body.promotion_id,creditId).first();
    if (!credit || credit.revision !== body.expected_credit_revision) return json({error:'stale_credit'},409);
    const balance = credit.current_balance_cents + creditDelta;
    if (!uint(balance) || balance > credit.opening_balance_cents) return json({error:'credit_balance_conflict'},409);
    assert(`EXISTS(SELECT 1 FROM canonical_credit_balances WHERE promotion_id=?2 AND credit_id=?3 AND provenance=?4
      AND revision=?5 AND current_balance_cents=?6)`,body.promotion_id,creditId,credit.provenance,credit.revision,credit.current_balance_cents);
    Object.assign(result,{credit_id:creditId,credit_provenance:credit.provenance,current_balance_cents:balance,credit_revision:credit.revision+1});
  }
  if (body.session_id && command !== 'cash.open') {
    session = await db.prepare('SELECT * FROM canonical_cash_state WHERE promotion_id=?1 AND session_id=?2').bind(body.promotion_id,body.session_id).first();
    if (!session || session.status !== 'OPEN' || (body.expected_session_revision !== undefined && session.revision !== body.expected_session_revision)) return json({error:'stale_session'},409);
    if (!uint(session.expected_cents + cashDelta)) return json({error:'cash_balance_conflict'},409);
    assert(`EXISTS(SELECT 1 FROM canonical_cash_state WHERE promotion_id=?2 AND session_id=?3 AND status='OPEN'
      AND revision=?4 AND expected_cents=?5 AND closing_watermark=?6)`,body.promotion_id,body.session_id,session.revision,session.expected_cents,session.closing_watermark);
    Object.assign(result,{session_id:body.session_id,session_revision:session.revision+1,expected_cents:session.expected_cents+cashDelta});
  }
  const effects = [];
  const cashierTable = command === 'cash.open' ? 'canonical_cash_sessions' : command === 'cash.close' ? 'canonical_cash_closures' : null;
  const cashierReady = cashierTable && await cashSessionCashierAvailable(db, cashierTable);
  const cashier = cashierReady ? await authenticatedCashier(db, auth) : null;
  if (command === 'cash.open') {
    Object.assign(result,{session_id:body.session_id,session_revision:0,expected_cents:body.opening_cents});
    effects.push(db.prepare(`INSERT INTO canonical_cash_sessions(session_id,promotion_id,open_operation_id,opening_cents,cash_movement_watermark,opened_at${cashierReady ? ',opened_by_user_id,opened_by_name' : ''})
      VALUES(?1,?2,?3,?4,(SELECT COALESCE(MAX(rowid),0) FROM cash_movements),?5${cashierReady ? ',?6,?7' : ''})`)
      .bind(body.session_id,body.promotion_id,body.operation_id,body.opening_cents,body.created_at,...(cashierReady ? [cashier.userId,cashier.name] : [])));
  } else if (command === 'cash.close') {
    Object.assign(result,{counted_cents:body.counted_cents,difference_cents:body.counted_cents-session.expected_cents});
    effects.push(db.prepare(`INSERT INTO canonical_cash_closures(session_id,close_operation_id,expected_cents,counted_cents,difference_cents,cash_movement_watermark,closed_at${cashierReady ? ',closed_by_user_id,closed_by_name' : ''})
      VALUES(?1,?2,?3,?4,?5,?6,?7${cashierReady ? ',?8,?9' : ''})`).bind(body.session_id,body.operation_id,session.expected_cents,body.counted_cents,result.difference_cents,session.closing_watermark,body.created_at,...(cashierReady ? [cashier.userId,cashier.name] : [])));
  } else {
    result.event_id = body.operation_id;
    result.cash_delta_cents = cashDelta;
    result.credit_delta_cents = creditDelta;
    effects.push(db.prepare(`INSERT INTO canonical_financial_events(event_id,operation_id,promotion_id,event_type,session_id,credit_id,credit_provenance,
      credit_delta_cents,cash_delta_cents,payment_method,reference,reason,compensates_operation_id,created_at)
      VALUES(?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`)
      .bind(body.operation_id,body.promotion_id,command==='payment.create'?'PAYMENT':command==='adjustment.create'?'ADJUSTMENT':'COMPENSATION',
        body.session_id??null,creditId??null,credit?.provenance??null,creditDelta,cashDelta,method,body.reference??null,body.reason??null,body.compensates_operation_id??null,body.created_at));
    if (referenceGuard) effects.push(db.prepare(`INSERT INTO canonical_payment_references(promotion_id,reference_norm,operation_id,created_at)
      VALUES(?1,?2,?3,?4)`).bind(body.promotion_id,referenceGuard.norm,body.operation_id,body.created_at));
  }
  const receipt = db.prepare(`INSERT INTO canonical_financial_operations(operation_id,command,request_hash,result_json,promotion_id,
    authority_epoch,control_revision,client_contract,device_id,credential_hash,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`)
    .bind(body.operation_id,command,hash,stableStringify(result),body.promotion_id,body.authority_epoch,body.expected_control_revision,body.client_contract,auth.principalId,auth.credentialHash,body.created_at);
  const guard = db.prepare(`INSERT INTO canonical_write_guards(operation_id,commit_token,promotion_id,authority_epoch,control_revision,client_contract,principal_id,credential_hash)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(body.operation_id,token,body.promotion_id,body.authority_epoch,body.expected_control_revision,body.client_contract,auth.principalId,auth.credentialHash);
  const marker = db.prepare(`UPDATE canonical_control SET first_live_operation_id=COALESCE(first_live_operation_id,?1)
    WHERE id=1 AND mode='ACTIVE' AND active_promotion_id=?2 AND authority_epoch=?3 AND revision=?4
    AND EXISTS(SELECT 1 FROM canonical_write_guards WHERE operation_id=?1 AND commit_token=?5)`)
    .bind(body.operation_id,body.promotion_id,body.authority_epoch,body.expected_control_revision,token);
  // D1 batch is the durable boundary: receipt, CAS checks and effect commit together.
  // A zero-row mutation cannot become a successful receipt.
  const statements = [];
  for (const [i, statement] of [guard,receipt,...assertions,...effects,marker,
    db.prepare('DELETE FROM canonical_write_guards WHERE operation_id=?1 AND commit_token=?2').bind(body.operation_id,token)].entries()) {
    statements.push(statement,db.prepare('INSERT INTO canonical_assertions(assertion_id,ok) VALUES(?1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)').bind(`${token}:changed:${i}`));
  }
  statements.push(db.prepare('DELETE FROM canonical_assertions WHERE assertion_id LIKE ?1').bind(`${token}:%`));
  try { await db.batch(statements); }
  catch (error) {
    const recovered = await replay();
    if (recovered) return recovered;
    if (await referenceTakenBy(db,referenceGuard,body.operation_id)) return json({error:'reference_already_used',reference:body.reference},409);
    // Two devices annulling the same payment: the UNIQUE(compensates_operation_id) fence lets one win.
    if (command === 'compensation.create' && await db.prepare('SELECT 1 ok FROM canonical_financial_events WHERE compensates_operation_id=?1 AND operation_id<>?2')
      .bind(body.compensates_operation_id,body.operation_id).first().catch(() => null)) return json({error:'already_compensated'},409);
    // Storage/transport failures are not disguised as business conflicts or success.
    const conflict = /constraint|conflict|stale_authority|gate_p_control|invalid_|forbidden/i.test(String(error?.message));
    return json({error:conflict?'financial_conflict':'financial_storage_error',operation_id:body.operation_id,retry_same_operation_id:true},conflict?409:503);
  }
  return json(result,201);
}


const PAYMENT_BATCH_MAX = 20;
const BATCH_FIELDS = [...COMMON,'payments'];

function validatePaymentBatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid_body';
  if (Object.keys(body).some(key => !BATCH_FIELDS.includes(key))) return 'unexpected_field';
  if (!id(body.operation_id) || !id(body.promotion_id) || body.client_contract !== 'a6-gate-c-v1' ||
      !uint(body.authority_epoch) || !uint(body.expected_control_revision)) return 'invalid_authority_revision';
  if (typeof body.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(body.created_at) ||
      !Number.isFinite(Date.parse(body.created_at)) || !Number.isFinite(Date.parse(body.created_at.slice(0,10))) ||
      new Date(body.created_at.slice(0,10)).toISOString().slice(0,10) !== body.created_at.slice(0,10)) return 'invalid_created_at';
  if (!Array.isArray(body.payments) || body.payments.length < 1 || body.payments.length > PAYMENT_BATCH_MAX) return 'invalid_payment_batch';

  const operationIds = new Set();
  const creditIds = new Set();
  let method = null, sessionId = null, reference = null;
  for (const payment of body.payments) {
    const invalid = validate('payment.create', payment);
    if (invalid) return invalid;
    if (payment.operation_id === body.operation_id || operationIds.has(payment.operation_id) || creditIds.has(payment.credit_id)) return 'invalid_payment_batch';
    if (payment.promotion_id !== body.promotion_id || payment.client_contract !== body.client_contract ||
        payment.authority_epoch !== body.authority_epoch || payment.expected_control_revision !== body.expected_control_revision) return 'invalid_payment_batch_authority';
    operationIds.add(payment.operation_id);
    creditIds.add(payment.credit_id);
    if (method === null) {
      method = payment.payment_method;
      sessionId = payment.session_id ?? null;
      reference = payment.reference ?? null;
    } else if (payment.payment_method !== method || (payment.session_id ?? null) !== sessionId || (payment.reference ?? null) !== reference) {
      return 'invalid_payment_batch_method';
    }
  }
  return null;
}

function inClause(count, startAt = 1) {
  return Array.from({length:count}, (_, index) => '?' + (startAt + index)).join(',');
}

export async function createCanonicalPaymentBatch(request, env, auth, json) {
  let body;
  try { body = await request.json(); } catch { return json({error:'invalid_json'},400); }
  const invalid = validatePaymentBatch(body);
  if (invalid) return json({error:invalid},400);

  const db = getDatabase(env);
  const payments = body.payments;
  const operationIds = payments.map(payment => payment.operation_id);
  const creditIds = payments.map(payment => payment.credit_id);
  const method = payments[0].payment_method;

  // Lean read phase: one D1 SELECT returns authority, replay rows, credit
  // baselines and optional cash session as JSON. This replaces four binding
  // calls without removing any field used by the existing validation/CAS path.
  const operationStart = 3;
  const creditStart = operationStart + operationIds.length;
  const sessionIndex = creditStart + creditIds.length;
  const packedSql = `
    SELECT
      (SELECT json_object(
        'mode',c.mode,
        'active_promotion_id',c.active_promotion_id,
        'authority_epoch',c.authority_epoch,
        'revision',c.revision,
        'minimum_client_contract',c.minimum_client_contract,
        'role',d.role,
        'status',d.status,
        'credential_hash',d.credential_hash
      ) FROM canonical_control c
        LEFT JOIN devices d ON d.device_id=?1
        WHERE c.id=1) AS authority_json,
      (SELECT COALESCE(json_group_array(json_object(
        'operation_id',operation_id,
        'command',command,
        'request_hash',request_hash,
        'result_json',result_json
      )),'[]') FROM canonical_financial_operations
        WHERE operation_id IN (${inClause(operationIds.length,operationStart)})) AS operations_json,
      (SELECT COALESCE(json_group_array(json_object(
        'credit_id',credit_id,
        'provenance',provenance,
        'revision',revision,
        'current_balance_cents',current_balance_cents,
        'opening_balance_cents',opening_balance_cents
      )),'[]') FROM canonical_credit_balances
        WHERE promotion_id=?2
          AND credit_id IN (${inClause(creditIds.length,creditStart)})) AS credits_json,
      ${method === 'efectivo'
        ? `(SELECT json_object(
            'session_id',session_id,
            'status',status,
            'revision',revision,
            'expected_cents',expected_cents,
            'closing_watermark',closing_watermark
          ) FROM canonical_cash_state
            WHERE promotion_id=?2 AND session_id=?${sessionIndex})`
        : 'NULL'} AS session_json`;

  const packedBindings = [auth.principalId,body.promotion_id,...operationIds,...creditIds];
  if (method === 'efectivo') packedBindings.push(payments[0].session_id);

  const [hashes, packed] = await Promise.all([
    Promise.all(payments.map(payment => sha256Hex(stableStringify({command:'payment.create',body:payment})))),
    db.prepare(packedSql).bind(...packedBindings).first()
  ]);

  function packedJson(value, fallback) {
    if (value == null) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  }
  const authority = packedJson(packed?.authority_json,null);
  const existingRows = packedJson(packed?.operations_json,[]);
  const creditRows = packedJson(packed?.credits_json,[]);
  const session = packedJson(packed?.session_json,null);

  if (!authority || authority.mode !== 'ACTIVE') return json({error:'canonical_not_active'},409);
  if (authority.active_promotion_id !== body.promotion_id || authority.authority_epoch !== body.authority_epoch ||
      authority.revision !== body.expected_control_revision || authority.minimum_client_contract !== body.client_contract ||
      authority.role !== 'writer' || authority.status !== 'active' || authority.credential_hash !== auth.credentialHash) {
    return json({error:'stale_authority'},409);
  }

  if (existingRows.length) {
    const byId = new Map(existingRows.map(row => [row.operation_id,row]));
    if (existingRows.length !== payments.length) return json({error:'batch_partial_replay_conflict'},409);
    const receipts = [];
    for (let index=0; index<payments.length; index+=1) {
      const payment = payments[index], row = byId.get(payment.operation_id);
      if (!row || row.command !== 'payment.create' || row.request_hash !== hashes[index]) {
        return json({error:'operation_id_conflict',operation_id:payment.operation_id},409);
      }
      receipts.push({...JSON.parse(row.result_json),status:'already_processed',idempotent:true});
    }
    return json({
      status:'already_processed',operation_id:body.operation_id,command:'payment.batch',
      promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,idempotent:true,receipts
    },200);
  }

  if (creditRows.length !== payments.length) return json({error:'credit_not_found'},409);
  // The whole batch shares one reference and counts as ONE use of it.
  const referenceGuard = await paymentReferenceGuard(db,body.promotion_id,method,payments[0].reference);
  if (referenceGuard) referenceGuard.promotionId = body.promotion_id;
  if (referenceGuard && referenceGuard.usedBy) return json({error:'reference_already_used',reference:payments[0].reference},409);
  const creditById = new Map(creditRows.map(row => [row.credit_id,row]));

  if (method === 'efectivo' && (!session || session.status !== 'OPEN')) {
    return json({error:'stale_session'},409);
  }

  const results = [];
  let cashCumulative = 0;
  for (let index=0; index<payments.length; index+=1) {
    const payment = payments[index];
    const credit = creditById.get(payment.credit_id);
    if (!credit || credit.revision !== payment.expected_credit_revision) return json({error:'stale_credit',credit_id:payment.credit_id},409);
    const balance = credit.current_balance_cents - payment.amount_cents;
    if (!uint(balance) || balance > credit.opening_balance_cents) return json({error:'credit_balance_conflict',credit_id:payment.credit_id},409);
    const result = {
      status:'created',operation_id:payment.operation_id,command:'payment.create',
      promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,idempotent:false,
      credit_id:payment.credit_id,credit_provenance:credit.provenance,current_balance_cents:balance,
      credit_revision:credit.revision+1,event_id:payment.operation_id,
      cash_delta_cents:method==='efectivo'?payment.amount_cents:0,credit_delta_cents:-payment.amount_cents
    };
    if (method === 'efectivo') {
      cashCumulative += payment.amount_cents;
      if (!uint(session.expected_cents + cashCumulative)) return json({error:'cash_balance_conflict'},409);
      Object.assign(result,{
        session_id:session.session_id,
        session_revision:session.revision+index+1,
        expected_cents:session.expected_cents+cashCumulative
      });
    }
    results.push(result);
  }

  const token = crypto.randomUUID();
  const statements = [];
  const first = payments[0];

  // Only the first operation needs the transient Gate-C marker guard. Every
  // canonical_financial_operations row independently rechecks authority through
  // the existing SQL trigger.
  statements.push(db.prepare(`INSERT INTO canonical_write_guards(operation_id,commit_token,promotion_id,authority_epoch,control_revision,client_contract,principal_id,credential_hash)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(first.operation_id,token,body.promotion_id,body.authority_epoch,body.expected_control_revision,body.client_contract,auth.principalId,auth.credentialHash));

  // One CAS assertion covers every DISTINCT credit. This is the transaction
  // fence that makes the pre-read revisions authoritative at commit time.
  const creditConditions = [];
  const creditBindings = [token+':credits',body.promotion_id];
  let parameter = 3;
  for (const payment of payments) {
    const credit = creditById.get(payment.credit_id);
    creditConditions.push(`(credit_id=?${parameter} AND provenance=?${parameter+1} AND revision=?${parameter+2} AND current_balance_cents=?${parameter+3})`);
    creditBindings.push(payment.credit_id,credit.provenance,credit.revision,credit.current_balance_cents);
    parameter += 4;
  }
  statements.push(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok)
    SELECT ?1,CASE WHEN (SELECT COUNT(*) FROM canonical_credit_balances WHERE promotion_id=?2
      AND (${creditConditions.join(' OR ')}))=${payments.length} THEN 1 ELSE 0 END`).bind(...creditBindings));

  if (session) {
    statements.push(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok)
      SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM canonical_cash_state WHERE promotion_id=?2 AND session_id=?3
        AND status='OPEN' AND revision=?4 AND expected_cents=?5 AND closing_watermark=?6) THEN 1 ELSE 0 END`)
      .bind(token+':session',body.promotion_id,session.session_id,session.revision,session.expected_cents,session.closing_watermark));
  }

  for (let index=0; index<payments.length; index+=1) {
    const payment = payments[index], result = results[index], credit = creditById.get(payment.credit_id);
    statements.push(db.prepare(`INSERT INTO canonical_financial_operations(operation_id,command,request_hash,result_json,promotion_id,
      authority_epoch,control_revision,client_contract,device_id,credential_hash,created_at)
      VALUES(?1,'payment.create',?2,?3,?4,?5,?6,?7,?8,?9,?10)`)
      .bind(payment.operation_id,hashes[index],stableStringify(result),body.promotion_id,body.authority_epoch,
        body.expected_control_revision,body.client_contract,auth.principalId,auth.credentialHash,payment.created_at));
    statements.push(db.prepare(`INSERT INTO canonical_financial_events(event_id,operation_id,promotion_id,event_type,session_id,credit_id,credit_provenance,
      credit_delta_cents,cash_delta_cents,payment_method,reference,reason,compensates_operation_id,created_at)
      VALUES(?1,?1,?2,'PAYMENT',?3,?4,?5,?6,?7,?8,?9,NULL,NULL,?10)`)
      .bind(payment.operation_id,body.promotion_id,payment.session_id??null,payment.credit_id,credit.provenance,
        -payment.amount_cents,method==='efectivo'?payment.amount_cents:0,method,payment.reference??null,payment.created_at));
  }

  if (referenceGuard) statements.push(db.prepare(`INSERT INTO canonical_payment_references(promotion_id,reference_norm,operation_id,created_at)
    VALUES(?1,?2,?3,?4)`).bind(body.promotion_id,referenceGuard.norm,body.operation_id,body.created_at));

  statements.push(db.prepare(`UPDATE canonical_control SET first_live_operation_id=COALESCE(first_live_operation_id,?1)
    WHERE id=1 AND mode='ACTIVE' AND active_promotion_id=?2 AND authority_epoch=?3 AND revision=?4
      AND EXISTS(SELECT 1 FROM canonical_write_guards WHERE operation_id=?1 AND commit_token=?5)`)
    .bind(first.operation_id,body.promotion_id,body.authority_epoch,body.expected_control_revision,token));
  statements.push(db.prepare('DELETE FROM canonical_write_guards WHERE operation_id=?1 AND commit_token=?2').bind(first.operation_id,token));
  statements.push(db.prepare('DELETE FROM canonical_assertions WHERE assertion_id LIKE ?1').bind(token+':%'));

  try {
    await db.batch(statements);
  } catch (error) {
    // A lost response after commit is recovered by replaying the same child
    // operation ids. A true SQL/CAS failure rolls the whole D1 batch back.
    const rows = await db.prepare(`SELECT operation_id,command,request_hash,result_json FROM canonical_financial_operations
      WHERE operation_id IN (${inClause(operationIds.length)})`).bind(...operationIds).all();
    const recovered = rows?.results || [];
    if (recovered.length === payments.length) {
      const byId = new Map(recovered.map(row => [row.operation_id,row]));
      const receipts = [];
      for (let index=0; index<payments.length; index+=1) {
        const row = byId.get(payments[index].operation_id);
        if (!row || row.command !== 'payment.create' || row.request_hash !== hashes[index]) {
          return json({error:'operation_id_conflict',operation_id:payments[index].operation_id},409);
        }
        receipts.push({...JSON.parse(row.result_json),status:'already_processed',idempotent:true});
      }
      return json({
        status:'already_processed',operation_id:body.operation_id,command:'payment.batch',
        promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,idempotent:true,receipts
      },200);
    }
    if (await referenceTakenBy(db,referenceGuard,body.operation_id)) return json({error:'reference_already_used',reference:payments[0].reference},409);
    const conflict = /constraint|conflict|stale_authority|gate_p_control|invalid_|forbidden/i.test(String(error?.message));
    return json({error:conflict?'payment_batch_conflict':'payment_batch_storage_error',operation_id:body.operation_id,retry_same_operation_id:true},conflict?409:503);
  }

  return json({
    status:'created',operation_id:body.operation_id,command:'payment.batch',
    promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,idempotent:false,receipts:results
  },201);
}
