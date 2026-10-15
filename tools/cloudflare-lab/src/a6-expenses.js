import { getDatabase } from './database-binding.js';
import { sha256Hex, stableStringify } from './a5-import-core.js';

export const EXPENSE_COMMAND = 'expense.create';
const METHODS = new Set(['efectivo','yape','plin','transferencia']);
const CONTRACT = 'a6-gate-c-v1';

const id = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
const uint = value => Number.isSafeInteger(value) && value >= 0;
const text = (value,max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const optionalText = (value,max) => value == null || value === '' || (typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value));
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value + 'T00:00:00Z').toISOString().slice(0,10) === value;
const validTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function exactFields(body) {
  const allowed = new Set(['operation_id','expense_id','promotion_id','client_contract','authority_epoch','expected_control_revision',
    'created_at','amount_cents','concept','category','payment_method','expense_date','note','session_id','expected_session_revision']);
  return Object.keys(body).every(key => allowed.has(key));
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !exactFields(body)) return 'invalid_body';
  if (!id(body.operation_id) || !id(body.expense_id) || !id(body.promotion_id)) return 'invalid_identity';
  if (body.client_contract !== CONTRACT || !uint(body.authority_epoch) || !uint(body.expected_control_revision)) return 'invalid_authority_revision';
  if (!validTimestamp(body.created_at) || !uint(body.amount_cents) || body.amount_cents === 0) return 'invalid_expense';
  if (!text(body.concept,500) || !text(body.category,120) || !METHODS.has(body.payment_method) || !validDate(body.expense_date)) return 'invalid_expense';
  if (!optionalText(body.note,500)) return 'invalid_note';
  const hasSession = body.session_id !== undefined;
  const hasRevision = body.expected_session_revision !== undefined;
  if (hasSession !== hasRevision) return 'invalid_expense_session';
  if (hasSession && (!id(body.session_id) || !uint(body.expected_session_revision))) return 'invalid_expense_session';
  return null;
}

async function authorityError(db,body,auth) {
  const row = await db.prepare(`SELECT c.mode,c.active_promotion_id,c.authority_epoch,c.revision,c.minimum_client_contract,c.writer_device_id,
    d.role,d.status,d.credential_hash
    FROM canonical_control c LEFT JOIN devices d ON d.device_id=?1 WHERE c.id=1`).bind(auth.principalId).first();
  if (!row || row.mode !== 'ACTIVE' || row.active_promotion_id !== body.promotion_id ||
      Number(row.authority_epoch) !== body.authority_epoch || Number(row.revision) !== body.expected_control_revision ||
      row.minimum_client_contract !== body.client_contract ||
      row.role !== 'writer' || row.status !== 'active' || row.credential_hash !== auth.credentialHash) return 'stale_authority';
  return null;
}

async function replay(db,body,hash,json,auth) {
  const denied = await authorityError(db,body,auth);
  if (denied) return json({error:denied},409);
  const row = await db.prepare('SELECT request_hash,result_json FROM canonical_expense_operations WHERE operation_id=?1')
    .bind(body.operation_id).first();
  if (!row) return null;
  if (row.request_hash !== hash) return json({error:'operation_id_conflict',operation_id:body.operation_id},409);
  return json({...JSON.parse(row.result_json),status:'already_processed',idempotent:true});
}

async function namespaceCollision(db,operationId) {
  const row = await db.prepare(`SELECT
    EXISTS(SELECT 1 FROM sales WHERE operation_id=?1) AS sale_hit,
    EXISTS(SELECT 1 FROM canonical_financial_operations WHERE operation_id=?1) AS financial_hit,
    EXISTS(SELECT 1 FROM canonical_credit_accounts WHERE operation_id=?1) AS account_hit,
    EXISTS(SELECT 1 FROM canonical_credit_metadata WHERE operation_id=?1) AS metadata_hit`).bind(operationId).first();
  return !!(row && Object.values(row).some(Number));
}

export async function employeeCashExpenseAllowed(db, body, auth) {
  if (!body || !id(body.session_id) || body.payment_method !== 'efectivo' || !uint(body.amount_cents) || body.amount_cents === 0) return false;
  const session = await db.prepare(`SELECT s.session_id FROM canonical_cash_state s
    JOIN canonical_financial_operations o ON o.operation_id=s.open_operation_id
    WHERE s.session_id=?1 AND s.status='OPEN' AND o.device_id=?2
      AND s.promotion_id=(SELECT active_promotion_id FROM canonical_control WHERE id=1)`).bind(body.session_id, auth.principalId).first();
  return !!session;
}

export async function createCanonicalExpense(request,env,auth,json) {
  let body;
  try { body = await request.json(); } catch { return json({error:'invalid_json'},400); }
  const invalid = validate(body);
  if (invalid) return json({error:invalid},400);

  const db = getDatabase(env);
  const hash = await sha256Hex(stableStringify({command:EXPENSE_COMMAND,body}));
  const existing = await replay(db,body,hash,json,auth);
  if (existing) return existing;
  if (auth.posRole === 'empleado' && !await employeeCashExpenseAllowed(db, body, auth)) return json({error:'forbidden_role',action:'expense.create'},403);
  const denied = await authorityError(db,body,auth);
  if (denied) return json({error:denied},409);
  if (await namespaceCollision(db,body.operation_id)) return json({error:'operation_id_conflict',operation_id:body.operation_id},409);

  const hasSession = body.session_id !== undefined;
  const cashDelta = hasSession && body.payment_method === 'efectivo' ? -body.amount_cents : 0;
  let session = null;
  if (hasSession) {
    session = await db.prepare('SELECT session_id,status,revision,expected_cents FROM canonical_cash_state WHERE promotion_id=?1 AND session_id=?2')
      .bind(body.promotion_id,body.session_id).first();
    if (!session || session.status !== 'OPEN' || Number(session.revision) !== body.expected_session_revision) {
      return json({error:'stale_session'},409);
    }
    if (!uint(Number(session.expected_cents) + cashDelta)) return json({error:'cash_balance_conflict'},409);
  }

  const result = {
    status:'created',operation_id:body.operation_id,command:EXPENSE_COMMAND,
    promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,
    expense_id:body.expense_id,session_id:hasSession?body.session_id:null,
    cash_delta_cents:cashDelta,idempotent:false
  };
  if (session) {
    result.session_revision = Number(session.revision) + 1;
    result.expected_cents = Number(session.expected_cents) + cashDelta;
  }

  const token = crypto.randomUUID();
  const note = body.note == null || body.note === '' ? null : body.note;
  const expectedSessionRevision = hasSession ? body.expected_session_revision : null;
  const statements = [];
  function pushChecked(statement,label) {
    statements.push(statement);
    statements.push(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok)
      VALUES(?1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)`).bind(token + ':' + label));
  }

  if (auth.posRole === 'empleado') statements.push(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok) SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM canonical_cash_state s JOIN canonical_financial_operations o ON o.operation_id=s.open_operation_id WHERE s.session_id=?2 AND s.status='OPEN' AND o.device_id=?3) THEN 1 ELSE 0 END`).bind(token + ':employee-shift',body.session_id,auth.principalId));

  pushChecked(db.prepare(`INSERT INTO canonical_write_guards(operation_id,commit_token,promotion_id,authority_epoch,control_revision,client_contract,principal_id,credential_hash)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(body.operation_id,token,body.promotion_id,body.authority_epoch,body.expected_control_revision,body.client_contract,auth.principalId,auth.credentialHash),'guard');

  pushChecked(db.prepare(`INSERT INTO canonical_expense_operations(operation_id,request_hash,result_json,promotion_id,authority_epoch,control_revision,
    client_contract,device_id,credential_hash,expected_session_revision,created_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`).bind(
      body.operation_id,hash,stableStringify(result),body.promotion_id,body.authority_epoch,body.expected_control_revision,
      body.client_contract,auth.principalId,auth.credentialHash,expectedSessionRevision,body.created_at),'operation');

  pushChecked(db.prepare(`INSERT INTO canonical_expenses(expense_id,operation_id,promotion_id,session_id,amount_cents,cash_delta_cents,
    concept,category,payment_method,expense_date,note,created_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`).bind(
      body.expense_id,body.operation_id,body.promotion_id,hasSession?body.session_id:null,body.amount_cents,cashDelta,
      body.concept.trim(),body.category.trim(),body.payment_method,body.expense_date,note,body.created_at),'expense');

  pushChecked(db.prepare(`UPDATE canonical_control SET first_live_operation_id=COALESCE(first_live_operation_id,?1)
    WHERE id=1 AND mode='ACTIVE' AND active_promotion_id=?2 AND authority_epoch=?3 AND revision=?4
      AND EXISTS(SELECT 1 FROM canonical_write_guards WHERE operation_id=?1 AND commit_token=?5)`)
    .bind(body.operation_id,body.promotion_id,body.authority_epoch,body.expected_control_revision,token),'marker');

  pushChecked(db.prepare('DELETE FROM canonical_write_guards WHERE operation_id=?1 AND commit_token=?2').bind(body.operation_id,token),'guard-delete');
  statements.push(db.prepare('DELETE FROM canonical_assertions WHERE assertion_id LIKE ?1').bind(token + ':%'));

  try {
    await db.batch(statements);
  } catch (error) {
    const recovered = await replay(db,body,hash,json,auth);
    if (recovered) return recovered;
    const message = String(error?.message || '');
    const conflict = /constraint|conflict|stale_|gate_p_control|operation_id|expense_session|cash_balance/i.test(message);
    return json({error:conflict?'expense_conflict':'expense_storage_error',operation_id:body.operation_id,retry_same_operation_id:true},conflict?409:503);
  }
  return json(result,201);
}
