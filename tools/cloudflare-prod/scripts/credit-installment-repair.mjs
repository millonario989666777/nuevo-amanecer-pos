import { backupSelectSql } from './backup-select.mjs';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TursoD1Adapter } from '../../cloudflare-lab/src/turso-d1-adapter.js';

const TRIGGER_PATH = process.env.CREDIT_REPAIR_TRIGGER_PATH || 'ops/v1.3-canon-debt-ui-repair-trigger.json';
const TURSO_URL = process.env.TURSO_PROD_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_PROD_AUTH_TOKEN || '';

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}
function normalizeName(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function normalizeDocument(value) {
  return String(value || '').trim().replace(/^NTV\s+/i, '').replace(/\s+/g, ' ');
}
function validHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
}
function requireEnv() {
  if (!TURSO_URL) throw new Error('missing TURSO_PROD_DATABASE_URL');
  if (!TURSO_TOKEN) throw new Error('missing TURSO_PROD_AUTH_TOKEN');
}
function readTrigger() {
  const trigger = JSON.parse(readFileSync(TRIGGER_PATH, 'utf8'));
  if (trigger?.authorized !== true || trigger?.authorized_by !== 'owner') throw new Error('owner authorization missing');
  const repair = trigger?.credit_installment_repair;
  if (!repair || repair.mode !== 'apply' || repair.provider !== 'turso') throw new Error('credit installment repair payload missing');
  if (repair.preserve_prewrite_global_summary !== true) throw new Error('prewrite global-summary invariant missing');
  if (!Array.isArray(repair.targets) || repair.targets.length < 1 || repair.targets.length > 10) throw new Error('invalid repair target count');
  const aliases = new Set();
  for (const target of repair.targets) {
    if (!target || typeof target.alias !== 'string' || !/^[A-Z][A-Z0-9_-]{0,15}$/.test(target.alias)) throw new Error('invalid target alias');
    if (aliases.has(target.alias)) throw new Error('duplicate target alias');
    aliases.add(target.alias);
    if (!validHash(target.name_hash)) throw new Error('invalid target name hash');
    if (!Array.isArray(target.documents) || !target.documents.length || target.documents.length > 30) throw new Error('invalid document set');
    const docs = new Set();
    for (const doc of target.documents) {
      if (!validHash(doc.document_hash) || docs.has(doc.document_hash)) throw new Error('invalid or duplicate document hash');
      docs.add(doc.document_hash);
      for (const key of ['total_cents','paid_cents','current_cents']) {
        if (!Number.isSafeInteger(doc[key]) || doc[key] < 0) throw new Error('invalid document amount');
      }
      if (doc.total_cents - doc.paid_cents !== doc.current_cents) throw new Error('document arithmetic mismatch');
      if (!Array.isArray(doc.installments) || !doc.installments.length || doc.installments.length > 60) throw new Error('invalid installments');
      let scheduleTotal = 0;
      doc.installments.forEach((row, index) => {
        if (row.number !== index + 1 || !validDate(row.due_date) || !Number.isSafeInteger(row.amount_cents) || row.amount_cents <= 0) {
          throw new Error('invalid installment row');
        }
        scheduleTotal += row.amount_cents;
      });
      if (scheduleTotal > doc.total_cents) throw new Error('installment schedule exceeds document total');
      const baselinePaid = doc.total_cents - scheduleTotal;
      const scheduledPaid = doc.paid_cents - baselinePaid;
      if (scheduledPaid < 0 || scheduledPaid > scheduleTotal) throw new Error('installment schedule cannot reconcile paid amount');
    }
  }
  return { trigger, repair };
}
async function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const result = params.length ? await stmt.bind(...params).all() : await stmt.all();
  return Array.isArray(result.results) ? result.results : [];
}
async function first(db, sql, params = []) {
  const stmt = db.prepare(sql);
  return params.length ? stmt.bind(...params).first() : stmt.first();
}
async function assertHealthy(db) {
  const quick = await all(db, 'PRAGMA quick_check');
  const quickValue = String(Object.values(quick[0] || {})[0] || '').toLowerCase();
  if (quickValue !== 'ok') throw new Error('Turso quick_check failed');
  const fk = await all(db, 'PRAGMA foreign_key_check');
  if (fk.length) throw new Error('Turso foreign_key_check failed');
  const control = await first(db, 'SELECT mode,active_promotion_id,revision,authority_epoch FROM canonical_control WHERE id=1');
  if (!control || control.mode !== 'ACTIVE' || !control.active_promotion_id) throw new Error('Turso CANON is not ACTIVE');
  return control;
}
async function globalDebtSummary(db, promotionId) {
  const row = await first(db, `
    SELECT COUNT(*) AS positive_customers,COALESCE(SUM(balance_cents),0) AS total_cents
    FROM (
      SELECT customer_id,SUM(current_balance_cents) AS balance_cents
      FROM (
        SELECT c.customer_id,b.current_balance_cents
        FROM credits c JOIN canonical_credit_balances b
          ON b.promotion_id=c.promotion_id AND b.credit_id=c.credit_id AND b.provenance='IMPORT'
        WHERE c.promotion_id=?1
        UNION ALL
        SELECT l.customer_id,b.current_balance_cents
        FROM live_credits l JOIN canonical_credit_balances b
          ON b.promotion_id=l.promotion_id AND b.credit_id=l.credit_id AND b.provenance='LIVE'
        WHERE l.promotion_id=?1
        UNION ALL
        SELECT r.customer_id,b.current_balance_cents
        FROM canonical_reconciliation_credits r JOIN canonical_credit_balances b
          ON b.promotion_id=r.promotion_id AND b.credit_id=r.credit_id AND b.provenance='IMPORT'
        WHERE r.promotion_id=?1
      )
      GROUP BY customer_id
      HAVING SUM(current_balance_cents)>0
    )
  `, [promotionId]);
  return { positive_customers:Number(row?.positive_customers || 0), total_cents:Number(row?.total_cents || 0) };
}
function assertGlobalSummary(summary) {
  if (!Number.isSafeInteger(summary.total_cents) || summary.total_cents < 0 ||
      !Number.isSafeInteger(summary.positive_customers) || summary.positive_customers < 0) {
    throw new Error('invalid production debt snapshot');
  }
}
async function identities(db, promotionId) {
  return all(db, `
    SELECT customer_id,name FROM customers WHERE promotion_id=?1
    UNION ALL
    SELECT customer_id,name FROM canonical_live_customers WHERE promotion_id=?1
  `, [promotionId]);
}
async function importedCredits(db, promotionId, customerId) {
  return all(db, `
    SELECT c.credit_id,c.customer_id,c.document_number,
      c.original_amount_cents+COALESCE(b.baseline_delta_cents,0) AS total_cents,
      b.current_balance_cents AS current_cents
    FROM credits c JOIN canonical_credit_balances b
      ON b.promotion_id=c.promotion_id AND b.credit_id=c.credit_id AND b.provenance='IMPORT'
    WHERE c.promotion_id=?1 AND c.customer_id=?2
  `, [promotionId, customerId]);
}
async function metadata(db, promotionId, creditId) {
  return first(db, `
    SELECT account_id,account_name,account_mode,operation_id
    FROM canonical_credit_metadata
    WHERE promotion_id=?1 AND credit_id=?2 AND credit_provenance='IMPORT'
  `, [promotionId, creditId]);
}
async function installments(db, promotionId, creditId) {
  return all(db, `
    SELECT installment_number,due_date,amount_cents,operation_id
    FROM canonical_credit_installments
    WHERE promotion_id=?1 AND credit_id=?2 AND credit_provenance='IMPORT'
    ORDER BY installment_number
  `, [promotionId, creditId]);
}
function exactSchedule(actual, expected) {
  return actual.length === expected.length && actual.every((row, index) => {
    const want = expected[index];
    return Number(row.installment_number) === want.number &&
      String(row.due_date) === want.due_date &&
      Number(row.amount_cents) === want.amount_cents;
  });
}
async function resolveTargets(db, control, repair) {
  const ids = await identities(db, control.active_promotion_id);
  const resolved = [];
  for (const target of repair.targets) {
    const matches = ids.filter(row => sha256(normalizeName(row.name)) === target.name_hash);
    const unique = new Map(matches.map(row => [String(row.customer_id), row]));
    if (unique.size !== 1) throw new Error('customer match count for alias '+target.alias+' is '+unique.size);
    const customer = [...unique.values()][0];
    const credits = await importedCredits(db, control.active_promotion_id, customer.customer_id);
    const docs = [];
    for (const expected of target.documents) {
      const found = credits.filter(row => sha256(normalizeDocument(row.document_number)) === expected.document_hash);
      if (found.length !== 1) throw new Error('document match count for '+target.alias+' is '+found.length);
      const credit = found[0];
      const total = Number(credit.total_cents || 0);
      const current = Number(credit.current_cents || 0);
      const paid = total - current;
      if (total !== expected.total_cents || current !== expected.current_cents || paid !== expected.paid_cents) {
        throw new Error('financial mismatch for alias '+target.alias);
      }
      const meta = await metadata(db, control.active_promotion_id, credit.credit_id);
      if (meta && (meta.account_id !== 'small' || meta.account_name !== 'Créditos pequeños' || meta.account_mode !== 'accumulated')) {
        throw new Error('existing credit metadata conflict for alias '+target.alias);
      }
      const existingInstallments = await installments(db, control.active_promotion_id, credit.credit_id);
      if (existingInstallments.length && !exactSchedule(existingInstallments, expected.installments)) {
        throw new Error('existing installment schedule conflict for alias '+target.alias);
      }
      docs.push({ expected, credit, meta, existingInstallments });
    }
    resolved.push({ alias:target.alias, customer, docs });
  }
  return resolved;
}
function repairOperationId(promotionId, creditId) {
  return 'credit-schedule-repair-' + sha256(promotionId + '|' + creditId).slice(0, 32);
}
async function backup(db, control) {
  const tables = {};
  for (const name of [
    'canonical_control','customers','canonical_live_customers','credits','live_credits','credit_payments',
    'canonical_financial_events','canonical_reconciliation_credits','canonical_credit_baseline_adjustments',
    'canonical_credit_metadata','canonical_credit_installments'
  ]) {
    tables[name] = await all(db, backupSelectSql(name));
  }
  const payload = {
    format:'nuevo-amanecer-credit-installment-repair-backup-v1',
    created_at:new Date().toISOString(),
    provider:'turso',
    control,
    tables
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  const digest = sha256(bytes);
  writeFileSync('/tmp/credit-installment-repair-backup.json', bytes);
  writeFileSync('/tmp/credit-installment-repair-backup.sha256', digest + '\n');
  console.log(JSON.stringify({state:'CREDIT_INSTALLMENT_BACKUP_READY',size_bytes:bytes.length,sha256:digest}));
}
async function apply(db, control, repair) {
  const before = await globalDebtSummary(db, control.active_promotion_id);
  assertGlobalSummary(before);
  const resolved = await resolveTargets(db, control, repair);
  const statements = [];
  const createdAt = String(repair.requested_at_utc || new Date().toISOString());
  let metadataAdds = 0, installmentAdds = 0;
  for (const target of resolved) {
    for (const doc of target.docs) {
      const op = repairOperationId(control.active_promotion_id, doc.credit.credit_id);
      if (!doc.meta) {
        statements.push(db.prepare(`
          INSERT INTO canonical_credit_metadata
            (promotion_id,credit_id,credit_provenance,customer_id,account_id,account_name,account_mode,operation_id,assigned_at)
          SELECT ?1,?2,'IMPORT',?3,'small','Créditos pequeños','accumulated',?4,?5
          WHERE EXISTS(
            SELECT 1 FROM credits c JOIN canonical_credit_balances b
              ON b.promotion_id=c.promotion_id AND b.credit_id=c.credit_id AND b.provenance='IMPORT'
            WHERE c.promotion_id=?1 AND c.credit_id=?2 AND c.customer_id=?3
              AND c.original_amount_cents+COALESCE(b.baseline_delta_cents,0)=?6
              AND b.current_balance_cents=?7
          )
          AND NOT EXISTS(
            SELECT 1 FROM canonical_credit_metadata
            WHERE promotion_id=?1 AND credit_id=?2 AND credit_provenance='IMPORT'
          )
        `).bind(control.active_promotion_id,doc.credit.credit_id,doc.credit.customer_id,op,createdAt,doc.expected.total_cents,doc.expected.current_cents));
        metadataAdds += 1;
      }
      if (!doc.existingInstallments.length) {
        for (const row of doc.expected.installments) {
          statements.push(db.prepare(`
            INSERT INTO canonical_credit_installments
              (promotion_id,credit_id,credit_provenance,installment_number,due_date,amount_cents,operation_id,created_at)
            SELECT ?1,?2,'IMPORT',?3,?4,?5,?6,?7
            WHERE EXISTS(
              SELECT 1 FROM canonical_credit_metadata
              WHERE promotion_id=?1 AND credit_id=?2 AND credit_provenance='IMPORT'
                AND account_id='small' AND account_name='Créditos pequeños' AND account_mode='accumulated'
            )
          `).bind(control.active_promotion_id,doc.credit.credit_id,row.number,row.due_date,row.amount_cents,op,createdAt));
          installmentAdds += 1;
        }
      }
    }
  }
  if (statements.length) await db.batch(statements);
  const after = await globalDebtSummary(db, control.active_promotion_id);
  assertGlobalSummary(after);
  if (after.total_cents !== before.total_cents || after.positive_customers !== before.positive_customers) {
    throw new Error('financial invariants changed after repair');
  }
  const verified = await resolveTargets(db, control, repair);
  for (const target of verified) {
    for (const doc of target.docs) {
      if (!doc.meta || !exactSchedule(doc.existingInstallments, doc.expected.installments)) {
        throw new Error('post-apply verification failed for alias '+target.alias);
      }
    }
  }
  console.log('CREDIT_INSTALLMENT_REPAIR='+JSON.stringify({
    state:'APPLY_PASS',
    targets:verified.map(target => ({alias:target.alias,documents:target.docs.length,installments:target.docs.reduce((n,doc)=>n+doc.expected.installments.length,0)})),
    metadata_inserts_planned:metadataAdds,
    installment_inserts_planned:installmentAdds,
    debt_total_cents:after.total_cents,
    positive_customers:after.positive_customers,
    financial_ledgers_changed:false
  }));
}
async function verify(db, control, repair) {
  const summary = await globalDebtSummary(db, control.active_promotion_id);
  assertGlobalSummary(summary);
  const resolved = await resolveTargets(db, control, repair);
  for (const target of resolved) {
    for (const doc of target.docs) {
      if (!doc.meta || !exactSchedule(doc.existingInstallments, doc.expected.installments)) {
        throw new Error('repair verification incomplete for alias '+target.alias);
      }
    }
  }
  console.log('CREDIT_INSTALLMENT_REPAIR_VERIFY='+JSON.stringify({
    state:'PASS',
    targets:resolved.map(target => ({alias:target.alias,documents:target.docs.length,installments:target.docs.reduce((n,doc)=>n+doc.expected.installments.length,0)})),
    debt_total_cents:summary.total_cents,
    positive_customers:summary.positive_customers,
    writes_performed:false
  }));
}

async function main() {
  requireEnv();
  const command = process.argv[2] || 'verify';
  const { repair } = readTrigger();
  const db = new TursoD1Adapter({url:TURSO_URL,authToken:TURSO_TOKEN});
  const control = await assertHealthy(db);
  if (command === 'snapshot') {
    const summary = await globalDebtSummary(db, control.active_promotion_id);
    assertGlobalSummary(summary);
    if (process.env.GITHUB_ENV) {
      appendFileSync(process.env.GITHUB_ENV, 'EXPECTED_DEBT_CENTS='+summary.total_cents+'\n');
      appendFileSync(process.env.GITHUB_ENV, 'EXPECTED_DEBT_CUSTOMERS='+summary.positive_customers+'\n');
    }
    console.log('CREDIT_INSTALLMENT_REPAIR_SNAPSHOT='+JSON.stringify({state:'PASS',...summary,writes_performed:false}));
    return;
  }
  if (command === 'backup') return backup(db, control);
  if (command === 'apply') return apply(db, control, repair);
  if (command === 'verify') return verify(db, control, repair);
  throw new Error('unsupported command');
}
main().catch(error => {
  console.error('CREDIT_INSTALLMENT_REPAIR_FAIL='+String(error?.message || error));
  process.exit(1);
});
