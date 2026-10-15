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
  if (auth.posRole === 'empleado' && !await employeeCashExpenseAllowed(db, body, auth)) return json({error:'forbidden_role',action:'expense.create'},403);
  const existing = await replay(db,body,hash,json,auth);
  if (existing) return existing;
  const denied = await authorityError(db,body,auth);
  if (denied) return json({error:denied},409);
  if (await namespaceCollision(db,body.operation_id)) return json({error:'operation_id_conflict',operation_id:body.operation_id},409);

  const serverNow = new Date().toISOString();
  const dateError = await expenseDateError(db, body, body.expense_date, true, serverNow);
  if (dateError) return json({error:dateError},409);
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

  // Recheck date locks inside the batch so a concurrent close cannot slip through.
  statements.push(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok)
    SELECT ?1,CASE WHEN NOT EXISTS(SELECT 1 FROM canonical_cash_closures
      WHERE (?2 IS NOT NULL AND session_id=?2) OR (?2 IS NULL AND date(closed_at,'-5 hours')=?3 AND julianday(closed_at)<=julianday(?4))) THEN 1 ELSE 0 END`)
    .bind(token + ':expense-date-lock',body.session_id||null,body.expense_date,serverNow));

  pushChecked(db.prepare(`INSERT INTO canonical_write_guards(operation_id,commit_token,promotion_id,authority_epoch,control_revision,client_contract,principal_id,credential_hash)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(body.operation_id,token,body.promotion_id,body.authority_epoch,body.expected_control_revision,body.client_contract,auth.principalId,auth.credentialHash),'guard');

  pushChecked(db.prepare(`INSERT INTO canonical_expense_operations(operation_id,request_hash,result_json,promotion_id,authority_epoch,control_revision,
    client_contract,device_id,credential_hash,expected_session_revision,created_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`).bind(
      body.operation_id,hash,stableStringify(result),body.promotion_id,body.authority_epoch,body.expected_control_revision,
      body.client_contract,auth.principalId,auth.credentialHash,expectedSessionRevision,body.created_at),'operation');

  pushChecked(db.prepare(`INSERT INTO canonical_expenses(expense_id,operation_id,promotion_id,session_id,amount_cents,cash_delta_cents,
    concept,category,payment_method,expense_date,note,created_at,server_received_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`).bind(
      body.expense_id,body.operation_id,body.promotion_id,hasSession?body.session_id:null,body.amount_cents,cashDelta,
      body.concept.trim(),body.category.trim(),body.payment_method,body.expense_date,note,body.created_at,serverNow),'expense');

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
    const dateError = await expenseDateError(db,body,body.expense_date,true,serverNow);
    if(dateError)return json({error:dateError},409);
    const message = String(error?.message || '');
    const conflict = /constraint|conflict|stale_|gate_p_control|operation_id|expense_session|cash_balance/i.test(message);
    return json({error:conflict?'expense_conflict':'expense_storage_error',operation_id:body.operation_id,retry_same_operation_id:true},conflict?409:503);
  }
  return json(result,201);
}

// Lima has a fixed UTC-5 offset (no DST).
export function limaDate(value) { const t=typeof value==='number'?value:Date.parse(String(value||'')); return Number.isFinite(t)?new Date(t-5*3600e3).toISOString().slice(0,10):''; }
export function limaToday(now=Date.now()) { return limaDate(now); }

// Shared server-date policy for new expenses and metadata revisions.
export async function expenseDateError(db, expense, date, checkDate = true, serverNow = new Date().toISOString(), currentDate = null) {
  if (expense.session_id) {
    if (await db.prepare('SELECT 1 FROM canonical_cash_closures WHERE session_id=?1').bind(expense.session_id).first()) return 'expense_locked_closed_shift';
    if (!checkDate) return null;
    const shift = await db.prepare('SELECT opened_at FROM canonical_cash_sessions WHERE session_id=?1').bind(expense.session_id).first();
    if (date > limaDate(serverNow)) return 'expense_date_in_future';
    if (shift?.opened_at && date < limaDate(shift.opened_at)) return 'expense_date_outside_shift';
  } else {
    if (checkDate) {
      const today = limaDate(serverNow);
      if (date > today) return 'expense_date_in_future';
      if (date < limaDate(Date.parse(today + 'T12:00:00Z') - 31 * 86400e3)) return 'expense_date_out_of_range';
    }
    if (currentDate === null || checkDate && date !== currentDate) {
      if (await db.prepare("SELECT 1 FROM canonical_cash_closures WHERE date(closed_at,'-5 hours')=?1 AND julianday(closed_at)<=julianday(?2)").bind(date,serverNow).first()) return 'expense_date_locked_closed_day';
    }
    if (currentDate !== null && await db.prepare("SELECT 1 FROM canonical_cash_closures WHERE date(closed_at,'-5 hours')=?1 AND julianday(closed_at)>=julianday(?2)").bind(currentDate,expense.server_received_at ?? expense.created_at).first()) return 'expense_date_locked_closed_day';
  }
  return null;
}

export async function expenseRevisionsAvailable(db) {
  return !!await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='canonical_expense_revisions'").first();
}

export async function reviseCanonicalExpense(command, request, env, auth, json) {
  // Deny before parsing, replay or any financial state read.
  if (auth.posRole !== 'owner') return json({error:'forbidden_role',action:command},403);
  let body;
  try { body=await request.json(); } catch { return json({error:'invalid_json'},400); }
  const editing=command==='expense.update';
  const fields=['operation_id','expense_id','promotion_id','client_contract','authority_epoch','expected_control_revision','created_at','expected_revision'];
  if(editing) fields.push('concept','category','note','expense_date');
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!fields.includes(k)) ||
      !id(body.operation_id)||!id(body.expense_id)||!id(body.promotion_id)||!uint(body.expected_revision)||
      body.client_contract!==CONTRACT||!uint(body.authority_epoch)||!uint(body.expected_control_revision)||!validTimestamp(body.created_at)||
      editing&&(!text(body.concept,500)||!text(body.category,120)||!optionalText(body.note,500)||!validDate(body.expense_date)))
    return json({error:'invalid_expense_revision'},400);
  const db=getDatabase(env);
  if(!await expenseRevisionsAvailable(db)) return json({error:'expense_revisions_unavailable'},503);
  const hash=await sha256Hex(stableStringify({command,body}));
  async function previousDate(row) {
    const prior = await db.prepare("SELECT expense_date FROM canonical_expense_revisions WHERE expense_id=?1 AND promotion_id=?2 AND revision<?3 AND action='edit' ORDER BY revision DESC LIMIT 1").bind(row.expense_id,body.promotion_id,row.revision).first();
    const base = prior || await db.prepare('SELECT expense_date FROM canonical_expenses WHERE expense_id=?1 AND promotion_id=?2').bind(row.expense_id,body.promotion_id).first();
    return base?.expense_date || null;
  }
  const result=async row=>({previous_expense_date:await previousDate(row),expense_date:row.expense_date,status:'created',command,operation_id:body.operation_id,expense_id:row.expense_id,
    promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,revision:Number(row.revision),voided:row.action==='void',idempotent:false});
  async function replayRevision() {
    const denied=await authorityError(db,body,auth);
    if(denied) return json({error:denied},409);
    const row=await db.prepare('SELECT * FROM canonical_expense_revisions WHERE operation_id=?1').bind(body.operation_id).first();
    if(!row)return null;
    if(row.request_hash!==hash)return json({error:'operation_id_conflict'},409);
    return json({...await result(row),status:'already_processed',idempotent:true});
  }
  const existing=await replayRevision();if(existing)return existing;
  const expense=await db.prepare(`SELECT e.*,COALESCE(r.revision,0) AS revision,r.action,r.expense_date AS revised_expense_date FROM canonical_expenses e
    LEFT JOIN canonical_expense_revisions r ON r.expense_id=e.expense_id AND r.promotion_id=e.promotion_id
      AND r.revision=(SELECT MAX(revision) FROM canonical_expense_revisions WHERE expense_id=e.expense_id AND promotion_id=e.promotion_id)
    WHERE e.expense_id=?1 AND e.promotion_id=?2`).bind(body.expense_id,body.promotion_id).first();
  if(!expense)return json({error:'expense_not_found'},404);
  if(Number(expense.revision)!==body.expected_revision)return json({error:'stale_expense_revision'},409);
  if(expense.action==='void')return json({error:'expense_voided'},409);
  const serverNow=new Date().toISOString();
  const currentDate=expense.revised_expense_date||expense.expense_date;
  const effectiveDate=editing?body.expense_date:currentDate;
  const dateError=await expenseDateError(db,expense,effectiveDate,editing,serverNow,currentDate);
  if(dateError)return json({error:dateError},409);
  if(!editing&&Number(expense.cash_delta_cents)!==0)return json({error:'cash_expense_void_requires_adjustment'},409);
  if(await namespaceCollision(db,body.operation_id)||await db.prepare('SELECT 1 FROM canonical_expense_operations WHERE operation_id=?1').bind(body.operation_id).first())return json({error:'operation_id_conflict'},409);
  // CAS and authority are checked again in the same atomic INSERT; unique revision
  // rejects concurrent contenders. Nothing touches the base ledger or cash state.
  const action=editing?'edit':'void';
  try {
    const inserted=await db.prepare(`INSERT INTO canonical_expense_revisions
      (operation_id,expense_id,promotion_id,revision,action,concept,category,note,expense_date,request_hash,device_id,created_at)
      SELECT ?1,?2,?3,?4+1,?5,?6,?7,?8,?9,?10,?11,?12
      WHERE COALESCE((SELECT MAX(revision) FROM canonical_expense_revisions WHERE expense_id=?2 AND promotion_id=?3),0)=?4
        AND (?18 IS NULL OR NOT EXISTS(SELECT 1 FROM canonical_cash_closures WHERE session_id=?18))
        AND (?18 IS NOT NULL OR NOT EXISTS(SELECT 1 FROM canonical_cash_closures WHERE (date(closed_at,'-5 hours')=?17 AND julianday(closed_at)>=julianday(?19)) OR (?20=1 AND date(closed_at,'-5 hours')=?21 AND julianday(closed_at)<=julianday(?22))))
        AND EXISTS(SELECT 1 FROM canonical_control c JOIN devices d ON d.device_id=?11
          WHERE c.id=1 AND c.mode='ACTIVE' AND c.active_promotion_id=?3 AND c.authority_epoch=?13
          AND c.revision=?14 AND c.minimum_client_contract=?15 AND d.role='writer' AND d.status='active' AND d.credential_hash=?16)
      RETURNING *`).bind(body.operation_id,body.expense_id,body.promotion_id,body.expected_revision,action,
        editing?body.concept.trim():null,editing?body.category.trim():null,editing?(body.note||null):null,
        editing?body.expense_date:null,hash,auth.principalId,body.created_at,body.authority_epoch,body.expected_control_revision,body.client_contract,auth.credentialHash,currentDate,expense.session_id||null,expense.server_received_at ?? expense.created_at,editing&&effectiveDate!==currentDate?1:0,effectiveDate,serverNow).first();
    if(!inserted){const denied=await authorityError(db,body,auth);const dateError=denied?null:await expenseDateError(db,expense,effectiveDate,editing,serverNow,currentDate);return json({error:denied||dateError||'stale_expense_revision'},409);}
    return json(await result(inserted),201);
  } catch(error) {
    const recovered=await replayRevision();if(recovered)return recovered;
    return json({error:/constraint|unique/i.test(String(error?.message))?'stale_expense_revision':'expense_storage_error'},/constraint|unique/i.test(String(error?.message))?409:503);
  }
}
