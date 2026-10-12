import { getDatabase } from './database-binding.js';
import { sha256Hex, stableStringify } from './a5-import-core.js';

const METHODS = new Set(['efectivo', 'yape', 'plin', 'transferencia', 'credito', 'mixto']);
export const CANONICAL_CLIENT_CONTRACT = 'a6-gate-c-v1';


const commerceCapabilityCache = new WeakMap();

function firstBatchRow(result) {
  return result && Array.isArray(result.results) ? (result.results[0] ?? null) : null;
}

async function commerceCapabilities(db) {
  let cached = commerceCapabilityCache.get(db);
  if (cached) return cached;
  const pending = db.prepare(`SELECT
      SUM(CASE WHEN type='table' AND name IN ('canonical_product_operations','canonical_live_products','canonical_live_inventory_effects') THEN 1 ELSE 0 END) AS live_product_tables,
      SUM(CASE WHEN type='table' AND name='canonical_generic_sale_lines' THEN 1 ELSE 0 END) AS generic_sale_tables,
      SUM(CASE WHEN type='table' AND name IN ('canonical_customer_operations','canonical_customer_registry','canonical_live_customers') THEN 1 ELSE 0 END) AS live_customer_tables,
      SUM(CASE WHEN type='table' AND name='canonical_customer_credit_policies' THEN 1 ELSE 0 END) AS credit_policy_tables,
      SUM(CASE WHEN type='table' AND name='canonical_reconciliation_credits' THEN 1 ELSE 0 END) AS reconciliation_tables
    FROM sqlite_master`).first().then(row => Object.freeze({
      liveProducts:Number(row?.live_product_tables)===3,
      genericSales:Number(row?.generic_sale_tables)===1,
      liveCustomers:Number(row?.live_customer_tables)===3,
      creditPolicy:Number(row?.credit_policy_tables)===1,
      reconciliation:Number(row?.reconciliation_tables)===1,
    }));
  commerceCapabilityCache.set(db,pending);
  try { return await pending; }
  catch (error) { commerceCapabilityCache.delete(db); throw error; }
}


async function customerSchemaAvailable(db) {
  const row=await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type='table' AND name IN ('canonical_customer_operations','canonical_customer_registry','canonical_live_customers')`).first();
  return Number(row?.count)===3;
}

async function canonicalCustomerExists(db,promotionId,customerId) {
  if(!customerId)return false;
  const imported=await db.prepare('SELECT 1 AS ok FROM customers WHERE promotion_id=?1 AND customer_id=?2')
    .bind(promotionId,customerId).first();
  if(imported)return true;
  if(!await customerSchemaAvailable(db))return false;
  const live=await db.prepare(`SELECT 1 AS ok FROM canonical_customer_registry
    WHERE promotion_id=?1 AND customer_id=?2 AND provenance='LIVE'`).bind(promotionId,customerId).first();
  return !!live;
}
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;

function validAccountName(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 60 && !/[\x00-\x1f\x7f]/.test(value);
}
function normalizeCreditAccount(value) {
  if (value == null) return { account_id: 'small', name: 'Créditos pequeños', mode: 'accumulated', builtin: true };
  if (!isObject(value) || !validId(value.account_id) || !validAccountName(value.name) || !['accumulated','separate'].includes(value.mode)) return null;
  return { account_id: value.account_id, name: value.name.trim().replace(/\s+/g,' '), mode: value.mode, builtin: value.account_id === 'small' };
}
function normalizeInstallments(value,total) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 60) return null;
  let sum=0;
  const out=[];
  for (let i=0;i<value.length;i+=1) {
    const row=value[i];
    if (!isObject(row) || row.number !== i+1 || !validDate(row.due_date) || !Number.isSafeInteger(row.amount_cents) || row.amount_cents<=0) return null;
    sum+=row.amount_cents;
    if (!Number.isSafeInteger(sum)) return null;
    out.push({number:row.number,due_date:row.due_date,amount_cents:row.amount_cents});
  }
  return sum===total ? out : null;
}

export function validateCanonicalSale(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_body' };
  for (const key of ['operation_id','sale_id','promotion_id','client_contract']) if (!validId(body[key])) return { error: `invalid_${key}` };
  if (body.client_contract !== CANONICAL_CLIENT_CONTRACT || !Number.isSafeInteger(body.authority_epoch) || body.authority_epoch < 0 || !Number.isSafeInteger(body.expected_control_revision) || body.expected_control_revision < 0) return { error: 'invalid_authority_revision' };
  if (!METHODS.has(body.payment_method) || !Number.isSafeInteger(body.total_cents) || body.total_cents <= 0) return { error: 'invalid_sale' };
  if (typeof body.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(body.created_at) ||
      !validDate(body.created_at.slice(0,10)) || !Number.isFinite(Date.parse(body.created_at))) return { error: 'invalid_created_at' };
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 500) return { error: 'invalid_items' };
  let total = 0;
  const seen = new Set();
  for (const item of body.items) {
    if (!isObject(item) || !validId(item.product_id) || seen.has(item.product_id) || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(item.unit_price_cents) || item.unit_price_cents < 0 || !Number.isSafeInteger(item.line_total_cents) ||
        item.line_total_cents !== Math.round(item.quantity * item.unit_price_cents) ||
        !Number.isSafeInteger(item.expected_stock_revision) || item.expected_stock_revision < 0) return { error: 'invalid_item' };
    if (item.generic_line !== undefined) {
      const generic=item.generic_line;
      if (!isObject(generic) || item.product_id.slice(0,8)!=='GENERIC:' || !Number.isSafeInteger(item.quantity) || item.quantity>9999 ||
          item.unit_price_cents<=0 || item.expected_stock_revision!==0 ||
          typeof generic.name!=='string' || !generic.name.trim() || generic.name.trim().length>240 || /[\x00-\x1f\x7f]/.test(generic.name) ||
          typeof generic.code!=='string' || generic.code.trim().length>160 || /[\x00-\x1f\x7f]/.test(generic.code)) return { error:'invalid_generic_line' };
      item.generic_line={name:generic.name.trim().replace(/\s+/g,' '),code:generic.code.trim()};
    }
    seen.add(item.product_id); total += item.line_total_cents;
    if (!Number.isSafeInteger(total)) return { error: 'unsafe_total' };
  }
  if (total !== body.total_cents) return { error: 'total_mismatch' };
  const payment = body.payment;
  if (!isObject(payment) || !['cash_cents','digital_cents','credit_cents'].every(key => Number.isSafeInteger(payment[key]) && payment[key] >= 0)) return { error: 'invalid_payment' };
  const cash = body.payment_method === 'efectivo' ? total : body.payment_method === 'mixto' ? payment.cash_cents : 0;
  const digital = ['yape','plin','transferencia'].includes(body.payment_method) ? total : body.payment_method === 'mixto' ? payment.digital_cents : 0;
  const credit = body.payment_method === 'credito' ? total : 0;
  if (![cash,digital,credit].every(Number.isSafeInteger) || cash < 0 || digital < 0 || cash + digital + credit !== total) return { error: 'invalid_payment' };
  if (payment.cash_cents !== cash || payment.digital_cents !== digital || payment.credit_cents !== credit) return { error: 'invalid_payment' };
  if (body.payment_method === 'mixto' && (cash <= 0 || digital <= 0 || !['yape','plin','transferencia'].includes(payment.digital_method))) return { error: 'invalid_payment' };
  if (payment.reference !== undefined && payment.reference !== null && (typeof payment.reference !== 'string' || payment.reference.length > 160 || /[\x00-\x1f\x7f]/.test(payment.reference))) return { error: 'invalid_reference' };
  if (body.payment_method === 'credito' && (!validId(body.customer_id) || !validDate(body.credit_due))) return { error: 'invalid_credit' };
  if (body.customer_id != null && !validId(body.customer_id)) return { error: 'invalid_customer_id' };
  if (body.payment_method !== 'credito' && (body.credit_account !== undefined || body.installments !== undefined)) return { error: 'invalid_credit_metadata' };
  const creditAccount = body.payment_method === 'credito' ? normalizeCreditAccount(body.credit_account) : null;
  const installments = body.payment_method === 'credito' ? normalizeInstallments(body.installments, body.total_cents) : [];
  if (body.payment_method === 'credito' && (!creditAccount || installments === null)) return { error: 'invalid_credit_metadata' };
  if (body.session_id !== undefined && (!validId(body.session_id) || cash === 0)) return { error:'invalid_session_id' };
  const value = { ...body, created_at: new Date(body.created_at).toISOString(), payment: { cash_cents: cash, digital_cents: digital, credit_cents: credit,
    digital_method: digital ? (body.payment_method === 'mixto' ? payment.digital_method : body.payment_method) : null, reference: payment.reference || null } };
  if (body.payment_method === 'credito') { value.credit_account = creditAccount; value.installments = installments; }
  return { value };
}


export function canUseCanonicalSaleFastPath(body, env) {
  const turso = String(env?.DB_PROVIDER || '').trim().toLowerCase() === 'turso' || typeof env?.DB?._pipeline === 'function';
  if (!turso || String(env?.RUNTIME_ENVIRONMENT || '').trim().toLowerCase() !== 'production') return false;
  const checked = validateCanonicalSale(body);
  if (checked.error) return false;
  const value = checked.value;
  return value.payment_method !== 'credito' &&
    value.items.every(item => item.generic_line === undefined);
}

function fastProductSql() {
  return `SELECT product_id,current_stock_quantity,stock_revision,tracks_inventory,provenance FROM (
    SELECT product_id,current_stock_quantity,stock_revision,tracks_inventory,'IMPORT' AS provenance,0 AS source_rank
      FROM products WHERE promotion_id=?1 AND product_id=?2
    UNION ALL
    SELECT product_id,current_stock_quantity,stock_revision,tracks_inventory,'LIVE' AS provenance,1 AS source_rank
      FROM canonical_live_products WHERE promotion_id=?1 AND product_id=?2
  ) ORDER BY source_rank LIMIT 1`;
}

async function diagnoseFastSaleFailure(db, body, auth, payloadHash, json) {
  const reads = [
    db.prepare(`SELECT c.*,s.session_id,s.status AS session_status,d.device_id,d.role AS device_role,
      d.status AS device_status,d.credential_hash
      FROM canonical_control c
      LEFT JOIN auth_sessions s ON s.token_hash=?1
      LEFT JOIN devices d ON d.device_id='session:'||s.session_id
      WHERE c.id=1`).bind(auth.credentialHash),
    db.prepare('SELECT sale_id,payload_hash FROM sales WHERE operation_id=?1').bind(body.operation_id),
    db.prepare('SELECT operation_id FROM canonical_financial_operations WHERE operation_id=?1').bind(body.operation_id),
    db.prepare('SELECT operation_id FROM canonical_product_operations WHERE operation_id=?1').bind(body.operation_id),
  ];
  const productIndexes = body.items.map(item => {
    const index = reads.length;
    reads.push(db.prepare(fastProductSql()).bind(body.promotion_id,item.product_id));
    return index;
  });
  let customerIndex = -1;
  if (body.customer_id) {
    customerIndex = reads.length;
    reads.push(db.prepare(`SELECT customer_id FROM (
      SELECT customer_id,0 AS source_rank FROM customers WHERE promotion_id=?1 AND customer_id=?2
      UNION ALL
      SELECT customer_id,1 AS source_rank FROM canonical_customer_registry
        WHERE promotion_id=?1 AND customer_id=?2 AND provenance='LIVE'
    ) ORDER BY source_rank LIMIT 1`).bind(body.promotion_id,body.customer_id));
  }

  const rows = (await db.batch(reads)).map(firstBatchRow);
  const control = rows[0];
  if (!control?.session_id || !control?.device_id || control.credential_hash !== auth.credentialHash) {
    return json({error:'unauthorized'},401);
  }
  if (control.session_status !== 'active' || control.device_status !== 'active') {
    return json({error:'session_revoked'},403);
  }
  if (control.device_role !== 'writer') return json({error:'read_only_session'},403);
  if (control.mode !== 'ACTIVE') return json({error:'canonical_not_active'},409);
  if (control.active_promotion_id !== body.promotion_id || Number(control.authority_epoch) !== body.authority_epoch ||
      Number(control.revision) !== body.expected_control_revision || control.minimum_client_contract !== body.client_contract) {
    return json({error:'stale_authority'},409);
  }

  const existing = rows[1];
  if (existing) {
    return existing.payload_hash === payloadHash
      ? json({status:'already_processed',operation_id:body.operation_id,sale_id:existing.sale_id,idempotent:true})
      : json({error:'operation_id_conflict',operation_id:body.operation_id},409);
  }
  if (rows[2] || rows[3]) return json({error:'operation_id_conflict',operation_id:body.operation_id},409);

  for (let index=0; index<body.items.length; index++) {
    const item=body.items[index], product=rows[productIndexes[index]];
    if (!product || ![0,1].includes(product.tracks_inventory) ||
        Number(product.stock_revision) !== item.expected_stock_revision ||
        (product.tracks_inventory===1 && (product.current_stock_quantity===null || Number(product.current_stock_quantity)<item.quantity))) {
      return json({error:'stale_stock',product_id:item.product_id},409);
    }
  }
  if (customerIndex>=0 && !rows[customerIndex]) return json({error:'customer_not_found'},409);
  return json({error:'canonical_sale_conflict',operation_id:body.operation_id},409);
}

async function createCanonicalSaleFast(body, env, auth, json) {
  const db = getDatabase(env);
  const payloadHash = await sha256Hex(stableStringify(body));
  const token = crypto.randomUUID();
  const atomic = [];
  const assertion = statement => atomic.push(statement);
  const checked = (statement,label) => {
    atomic.push(statement);
    atomic.push(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok)
      VALUES(?1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)`).bind(`${token}:changed:${label}`));
  };

  // One guard does four jobs: session auth, writer role, canonical authority and
  // cross-ledger operation freshness. No pre-read leaves the Worker.
  checked(db.prepare(`INSERT INTO canonical_write_guards
    (operation_id,commit_token,promotion_id,authority_epoch,control_revision,client_contract,principal_id,credential_hash)
    SELECT ?1,?2,?3,?4,?5,?6,d.device_id,?7
    FROM canonical_control c
    JOIN auth_sessions s ON s.token_hash=?7
    JOIN devices d ON d.device_id='session:'||s.session_id
    WHERE c.id=1 AND c.mode='ACTIVE' AND c.active_promotion_id=?3
      AND c.authority_epoch=?4 AND c.revision=?5 AND c.minimum_client_contract=?6
      AND s.status='active' AND d.role='writer' AND d.status='active' AND d.credential_hash=?7
      AND NOT EXISTS(SELECT 1 FROM sales WHERE operation_id=?1)
      AND NOT EXISTS(SELECT 1 FROM canonical_financial_operations WHERE operation_id=?1)
      AND NOT EXISTS(SELECT 1 FROM canonical_product_operations WHERE operation_id=?1)
    LIMIT 1`).bind(body.operation_id,token,body.promotion_id,body.authority_epoch,
      body.expected_control_revision,body.client_contract,auth.credentialHash),'guard');

  checked(db.prepare(`INSERT INTO sales
    (sale_id,operation_id,payload_hash,commit_token,device_id,payment_method,total_cents,payment_reference,created_at)
    SELECT ?1,?2,?3,?4,g.principal_id,?5,?6,?7,?8
    FROM canonical_write_guards g WHERE g.operation_id=?2 AND g.commit_token=?4`)
    .bind(body.sale_id,body.operation_id,payloadHash,token,body.payment_method,
      body.total_cents,body.payment.reference,body.created_at),'sale');

  checked(db.prepare(`INSERT INTO canonical_sale_context
    (sale_id,operation_id,promotion_id,authority_epoch,control_revision,customer_id,client_contract,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8
    WHERE EXISTS(SELECT 1 FROM sales WHERE operation_id=?2 AND commit_token=?9)`)
    .bind(body.sale_id,body.operation_id,body.promotion_id,body.authority_epoch,
      body.expected_control_revision,body.customer_id||null,body.client_contract,body.created_at,token),'context');

  if (body.session_id) {
    assertion(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok)
      SELECT ?1,CASE WHEN EXISTS(
        SELECT 1 FROM canonical_cash_state
        WHERE promotion_id=?2 AND session_id=?3 AND status='OPEN'
      ) THEN 1 ELSE 0 END`).bind(`${token}:cash-session`,body.promotion_id,body.session_id));
  }

  if (body.customer_id) {
    assertion(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok)
      SELECT ?1,CASE WHEN
        EXISTS(SELECT 1 FROM customers WHERE promotion_id=?2 AND customer_id=?3)
        OR EXISTS(SELECT 1 FROM canonical_customer_registry
          WHERE promotion_id=?2 AND customer_id=?3 AND provenance='LIVE')
      THEN 1 ELSE 0 END`).bind(`${token}:customer`,body.promotion_id,body.customer_id));
  }

  for (let index=0; index<body.items.length; index++) {
    const item=body.items[index], line=index+1, movementId=`${body.operation_id}:inventory:${line}`;

    assertion(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok)
      SELECT ?1,CASE WHEN
        EXISTS(SELECT 1 FROM products
          WHERE promotion_id=?2 AND product_id=?3 AND stock_revision=?4
            AND tracks_inventory IN (0,1)
            AND (tracks_inventory=0 OR current_stock_quantity>=?5))
        OR (
          NOT EXISTS(SELECT 1 FROM products WHERE promotion_id=?2 AND product_id=?3)
          AND EXISTS(SELECT 1 FROM canonical_live_products
            WHERE promotion_id=?2 AND product_id=?3 AND stock_revision=?4
              AND tracks_inventory IN (0,1)
              AND (tracks_inventory=0 OR current_stock_quantity>=?5))
        )
      THEN 1 ELSE 0 END`).bind(`${token}:stock-before:${line}`,body.promotion_id,
        item.product_id,item.expected_stock_revision,item.quantity));

    checked(db.prepare(`INSERT INTO sale_items
      (sale_id,line_number,operation_id,product_id,quantity,unit_price_cents,line_total_cents,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8
      WHERE EXISTS(SELECT 1 FROM canonical_write_guards WHERE operation_id=?3)`)
      .bind(body.sale_id,line,body.operation_id,item.product_id,item.quantity,
        item.unit_price_cents,item.line_total_cents,body.created_at),`item:${line}`);

    // IMPORT wins if both catalogs ever contain the same id.
    atomic.push(db.prepare(`UPDATE products
      SET current_stock_quantity=current_stock_quantity-?1,stock_revision=stock_revision+1
      WHERE promotion_id=?2 AND product_id=?3 AND stock_revision=?4
        AND tracks_inventory=1 AND current_stock_quantity>=?1`)
      .bind(item.quantity,body.promotion_id,item.product_id,item.expected_stock_revision));
    atomic.push(db.prepare(`INSERT INTO inventory_movements
      (movement_id,operation_id,sale_id,line_number,product_id,quantity,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE changes()=1`)
      .bind(movementId,body.operation_id,body.sale_id,line,item.product_id,-item.quantity,body.created_at));
    atomic.push(db.prepare(`INSERT INTO canonical_inventory_effects
      (movement_id,operation_id,promotion_id,product_id,stock_revision_before,stock_revision_after,quantity)
      SELECT ?1,?2,?3,?4,?5,?6,?7
      WHERE EXISTS(SELECT 1 FROM inventory_movements WHERE movement_id=?1)
        AND EXISTS(SELECT 1 FROM products WHERE promotion_id=?3 AND product_id=?4)`)
      .bind(movementId,body.operation_id,body.promotion_id,item.product_id,
        item.expected_stock_revision,item.expected_stock_revision+1,-item.quantity));

    atomic.push(db.prepare(`UPDATE canonical_live_products
      SET current_stock_quantity=current_stock_quantity-?1,stock_revision=stock_revision+1
      WHERE promotion_id=?2 AND product_id=?3 AND stock_revision=?4
        AND tracks_inventory=1 AND current_stock_quantity>=?1
        AND NOT EXISTS(SELECT 1 FROM products WHERE promotion_id=?2 AND product_id=?3)`)
      .bind(item.quantity,body.promotion_id,item.product_id,item.expected_stock_revision));
    atomic.push(db.prepare(`INSERT INTO inventory_movements
      (movement_id,operation_id,sale_id,line_number,product_id,quantity,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE changes()=1`)
      .bind(movementId,body.operation_id,body.sale_id,line,item.product_id,-item.quantity,body.created_at));
    atomic.push(db.prepare(`INSERT INTO canonical_live_inventory_effects
      (movement_id,operation_id,promotion_id,product_id,stock_revision_before,stock_revision_after,quantity)
      SELECT ?1,?2,?3,?4,?5,?6,?7
      WHERE EXISTS(SELECT 1 FROM inventory_movements WHERE movement_id=?1)
        AND NOT EXISTS(SELECT 1 FROM products WHERE promotion_id=?3 AND product_id=?4)
        AND EXISTS(SELECT 1 FROM canonical_live_products WHERE promotion_id=?3 AND product_id=?4)`)
      .bind(movementId,body.operation_id,body.promotion_id,item.product_id,
        item.expected_stock_revision,item.expected_stock_revision+1,-item.quantity));

    assertion(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok)
      SELECT ?1,CASE WHEN
        EXISTS(SELECT 1 FROM products p
          WHERE p.promotion_id=?2 AND p.product_id=?3 AND (
            (p.tracks_inventory=0 AND p.stock_revision=?4)
            OR (p.tracks_inventory=1 AND p.stock_revision=?4+1
              AND EXISTS(SELECT 1 FROM inventory_movements m WHERE m.movement_id=?5)
              AND EXISTS(SELECT 1 FROM canonical_inventory_effects e WHERE e.movement_id=?5))
          ))
        OR (
          NOT EXISTS(SELECT 1 FROM products WHERE promotion_id=?2 AND product_id=?3)
          AND EXISTS(SELECT 1 FROM canonical_live_products p
            WHERE p.promotion_id=?2 AND p.product_id=?3 AND (
              (p.tracks_inventory=0 AND p.stock_revision=?4)
              OR (p.tracks_inventory=1 AND p.stock_revision=?4+1
                AND EXISTS(SELECT 1 FROM inventory_movements m WHERE m.movement_id=?5)
                AND EXISTS(SELECT 1 FROM canonical_live_inventory_effects e WHERE e.movement_id=?5))
            ))
        )
      THEN 1 ELSE 0 END`).bind(`${token}:stock-after:${line}`,body.promotion_id,
        item.product_id,item.expected_stock_revision,movementId));
  }

  checked(db.prepare(`INSERT INTO cash_movements
    (movement_id,operation_id,sale_id,payment_method,amount_cents,cash_cents,digital_cents,credit_cents,digital_method,reference,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11
    WHERE EXISTS(SELECT 1 FROM canonical_write_guards WHERE operation_id=?2)`)
    .bind(`${body.operation_id}:cash`,body.operation_id,body.sale_id,body.payment_method,
      body.total_cents,body.payment.cash_cents,body.payment.digital_cents,body.payment.credit_cents,
      body.payment.digital_method,body.payment.reference,body.created_at),'cash');

  checked(db.prepare(`UPDATE canonical_control
    SET first_live_operation_id=COALESCE(first_live_operation_id,?1)
    WHERE id=1 AND mode='ACTIVE' AND active_promotion_id=?2 AND authority_epoch=?3 AND revision=?4
      AND EXISTS(SELECT 1 FROM sales WHERE operation_id=?1 AND commit_token=?5)`)
    .bind(body.operation_id,body.promotion_id,body.authority_epoch,body.expected_control_revision,token),'control');

  checked(db.prepare('DELETE FROM canonical_write_guards WHERE operation_id=?1 AND commit_token=?2')
    .bind(body.operation_id,token),'guard-cleanup');

  atomic.push(db.prepare('DELETE FROM canonical_assertions WHERE assertion_id LIKE ?1').bind(`${token}:%`));

  try {
    await db.batch(atomic);
  } catch {
    return diagnoseFastSaleFailure(db,body,auth,payloadHash,json);
  }
  return json({status:'created',operation_id:body.operation_id,sale_id:body.sale_id,
    promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,idempotent:false},201);
}

export async function createCanonicalCreditAccount(request, env, auth, json) {
  let body; try { body = await request.json(); } catch { return json({ error:'invalid_json' },400); }
  if (!isObject(body) || !validId(body.operation_id) || !validId(body.promotion_id) || body.client_contract !== CANONICAL_CLIENT_CONTRACT ||
      !Number.isSafeInteger(body.authority_epoch) || body.authority_epoch < 0 || !Number.isSafeInteger(body.expected_control_revision) || body.expected_control_revision < 0 ||
      typeof body.created_at !== 'string' || !Number.isFinite(Date.parse(body.created_at)) || !validId(body.customer_id) ||
      !validId(body.account_id) || body.account_id === 'small' || !validAccountName(body.name) || !['accumulated','separate'].includes(body.mode)) {
    return json({error:'invalid_credit_account'},400);
  }
  const normalized={...body,name:body.name.trim().replace(/\s+/g,' '),created_at:new Date(body.created_at).toISOString()};
  const db=getDatabase(env), principalId=auth.principalId;
  async function authorityError() {
    const control=await db.prepare(`SELECT c.*,d.role,d.status,d.credential_hash FROM canonical_control c
      LEFT JOIN devices d ON d.device_id=?1 WHERE c.id=1`).bind(principalId).first();
    if(!control || control.mode!=='ACTIVE') return 'canonical_not_active';
    if(control.active_promotion_id!==normalized.promotion_id || Number(control.authority_epoch)!==normalized.authority_epoch ||
       Number(control.revision)!==normalized.expected_control_revision || control.minimum_client_contract!==normalized.client_contract ||
       control.role!=='writer' || control.status!=='active' || control.credential_hash!==auth.credentialHash) return 'stale_authority';
    return null;
  }
  const denied=await authorityError(); if(denied) return json({error:denied},409);
  const requestHash=await sha256Hex(stableStringify(normalized));
  const replay=await db.prepare('SELECT account_id,request_hash FROM canonical_credit_accounts WHERE operation_id=?1').bind(normalized.operation_id).first();
  if(replay){
    const stale=await authorityError(); if(stale) return json({error:stale},409);
    return replay.request_hash===requestHash
      ? json({status:'already_processed',command:'credit-account.create',operation_id:normalized.operation_id,promotion_id:normalized.promotion_id,
          authority_epoch:normalized.authority_epoch,account_id:replay.account_id,idempotent:true})
      : json({error:'operation_id_conflict',operation_id:normalized.operation_id},409);
  }
  if(!await canonicalCustomerExists(db,normalized.promotion_id,normalized.customer_id))
    return json({error:'customer_not_found'},409);
  const duplicate=await db.prepare('SELECT account_id,name,mode FROM canonical_credit_accounts WHERE promotion_id=?1 AND customer_id=?2 AND (account_id=?3 OR lower(name)=lower(?4))')
    .bind(normalized.promotion_id,normalized.customer_id,normalized.account_id,normalized.name).first();
  if(duplicate) return json({error:'credit_account_conflict',account_id:duplicate.account_id},409);
  try {
    const result=await db.prepare(`INSERT INTO canonical_credit_accounts
      (promotion_id,customer_id,account_id,name,mode,operation_id,request_hash,principal_id,credential_hash,created_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`)
      .bind(normalized.promotion_id,normalized.customer_id,normalized.account_id,normalized.name,normalized.mode,normalized.operation_id,requestHash,principalId,auth.credentialHash,normalized.created_at).run();
    if(result?.meta?.changes!==1) throw new Error('insert_failed');
  } catch {
    const after=await db.prepare('SELECT account_id,request_hash FROM canonical_credit_accounts WHERE operation_id=?1').bind(normalized.operation_id).first();
    if(after?.request_hash===requestHash) return json({status:'already_processed',command:'credit-account.create',operation_id:normalized.operation_id,
      promotion_id:normalized.promotion_id,authority_epoch:normalized.authority_epoch,account_id:after.account_id,idempotent:true});
    return json({error:'credit_account_conflict'},409);
  }
  return json({status:'created',command:'credit-account.create',operation_id:normalized.operation_id,promotion_id:normalized.promotion_id,
    authority_epoch:normalized.authority_epoch,account_id:normalized.account_id,idempotent:false},201);
}

export async function createCanonicalSale(request, env, auth, json) {
  let body; try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const checked = validateCanonicalSale(body);
  if (checked.error) return json({ error: checked.error }, 400);
  body = checked.value;
  if (auth?.deferredSaleAuth && canUseCanonicalSaleFastPath(body,env)) {
    return createCanonicalSaleFast(body,env,auth,json);
  }
  if (auth?.deferredSaleAuth) return json({error:'unauthorized'},401);
  const principalId = auth.principalId;
  const db = getDatabase(env);
  // Authorization and the authority contract apply even to a durable replay.
  // On Turso, every standalone .first() is a separate HTTPS pipeline. Keep the
  // same guards, but read independent validation state in one batch so the
  // durable receipt is not delayed by a chain of remote round trips.
  function authorityErrorFor(control) {
    if (!control || control.mode !== 'ACTIVE') return 'canonical_not_active';
    if (control.active_promotion_id !== body.promotion_id || Number(control.authority_epoch) !== body.authority_epoch ||
        Number(control.revision) !== body.expected_control_revision || control.minimum_client_contract !== body.client_contract ||
        control.device_role !== 'writer' || control.device_status !== 'active' ||
        control.credential_hash !== auth.credentialHash) return 'stale_authority';
    return null;
  }
  async function authorityError() {
    const control = await db.prepare(`SELECT c.*,d.role AS device_role,d.status AS device_status,d.credential_hash
      FROM canonical_control c LEFT JOIN devices d ON d.device_id=?1 WHERE c.id=1`).bind(principalId).first();
    return authorityErrorFor(control);
  }

  const capabilities = await commerceCapabilities(db);
  const genericRequested=body.items.some(item=>item.generic_line!==undefined);
  if (genericRequested && !capabilities.genericSales) return json({error:'generic_sale_schema_not_ready'},503);

  const reads=[];
  const readIndex={products:[]};
  const addRead=statement=>{ const index=reads.length; reads.push(statement); return index; };
  readIndex.control=addRead(db.prepare(`SELECT c.*,d.role AS device_role,d.status AS device_status,d.credential_hash
    FROM canonical_control c LEFT JOIN devices d ON d.device_id=?1 WHERE c.id=1`).bind(principalId));
  readIndex.existing=addRead(db.prepare('SELECT sale_id,payload_hash FROM sales WHERE operation_id=?1').bind(body.operation_id));
  readIndex.financialOperation=addRead(db.prepare('SELECT operation_id FROM canonical_financial_operations WHERE operation_id=?1').bind(body.operation_id));
  readIndex.productOperation=capabilities.liveProducts
    ? addRead(db.prepare('SELECT operation_id FROM canonical_product_operations WHERE operation_id=?1').bind(body.operation_id))
    : -1;

  for (const item of body.items) {
    if (item.generic_line !== undefined) {
      const collisionSql=capabilities.liveProducts
        ? `SELECT product_id FROM (
            SELECT product_id FROM products WHERE promotion_id=?1 AND product_id=?2
            UNION ALL
            SELECT product_id FROM canonical_live_products WHERE promotion_id=?1 AND product_id=?2
          ) LIMIT 1`
        : 'SELECT product_id FROM products WHERE promotion_id=?1 AND product_id=?2 LIMIT 1';
      readIndex.products.push(addRead(db.prepare(collisionSql).bind(body.promotion_id,item.product_id)));
      continue;
    }
    const productSql=capabilities.liveProducts
      ? `SELECT product_id,current_stock_quantity,stock_revision,tracks_inventory,provenance FROM (
          SELECT product_id,current_stock_quantity,stock_revision,tracks_inventory,'IMPORT' AS provenance,0 AS source_rank
            FROM products WHERE promotion_id=?1 AND product_id=?2
          UNION ALL
          SELECT product_id,current_stock_quantity,stock_revision,tracks_inventory,'LIVE' AS provenance,1 AS source_rank
            FROM canonical_live_products WHERE promotion_id=?1 AND product_id=?2
        ) ORDER BY source_rank LIMIT 1`
      : `SELECT product_id,current_stock_quantity,stock_revision,tracks_inventory,'IMPORT' AS provenance
          FROM products WHERE promotion_id=?1 AND product_id=?2`;
    readIndex.products.push(addRead(db.prepare(productSql).bind(body.promotion_id,item.product_id)));
  }

  readIndex.customer=-1;
  if (body.customer_id) {
    const customerSql=capabilities.liveCustomers
      ? `SELECT customer_id FROM (
          SELECT customer_id,0 AS source_rank FROM customers WHERE promotion_id=?1 AND customer_id=?2
          UNION ALL
          SELECT customer_id,1 AS source_rank FROM canonical_customer_registry
            WHERE promotion_id=?1 AND customer_id=?2 AND provenance='LIVE'
        ) ORDER BY source_rank LIMIT 1`
      : 'SELECT customer_id FROM customers WHERE promotion_id=?1 AND customer_id=?2 LIMIT 1';
    readIndex.customer=addRead(db.prepare(customerSql).bind(body.promotion_id,body.customer_id));
  }

  // P1-2: the customer's credit line is enforced by the Worker, not only by the screen.
  // MANUAL policy: open balance of every credit of the customer + this sale <= manual limit.
  // AUTOMATIC/no policy keeps today's behaviour (the automatic line is computed on the client),
  // but the policy row itself is CAS-fenced so a concurrent switch to MANUAL is not bypassed.
  const creditOwnersSql=`SELECT credit_id,'IMPORT' AS provenance FROM credits WHERE promotion_id=?1 AND customer_id=?2
      UNION ALL SELECT credit_id,'LIVE' FROM live_credits WHERE promotion_id=?1 AND customer_id=?2${capabilities.reconciliation ? `
      UNION ALL SELECT credit_id,'IMPORT' FROM canonical_reconciliation_credits WHERE promotion_id=?1 AND customer_id=?2` : ''}`;
  const customerDebtSql=`(SELECT COALESCE(SUM(b.current_balance_cents),0) FROM canonical_credit_balances b
      JOIN (${creditOwnersSql}) o ON o.credit_id=b.credit_id AND o.provenance=b.provenance WHERE b.promotion_id=?1)`;
  readIndex.creditLine=-1;
  if (body.payment_method === 'credito' && capabilities.creditPolicy) {
    readIndex.creditLine=addRead(db.prepare(`SELECT
        (SELECT mode FROM canonical_customer_credit_policies WHERE promotion_id=?1 AND customer_id=?2) AS mode,
        (SELECT manual_limit_cents FROM canonical_customer_credit_policies WHERE promotion_id=?1 AND customer_id=?2) AS manual_limit_cents,
        (SELECT revision FROM canonical_customer_credit_policies WHERE promotion_id=?1 AND customer_id=?2) AS policy_revision,
        ${customerDebtSql} AS debt_cents`).bind(body.promotion_id,body.customer_id));
  }

  readIndex.account=-1;
  if (body.payment_method === 'credito' && body.credit_account && body.credit_account.account_id !== 'small') {
    readIndex.account=addRead(db.prepare('SELECT account_id,name,mode FROM canonical_credit_accounts WHERE promotion_id=?1 AND customer_id=?2 AND (account_id=?3 OR lower(name)=lower(?4))')
      .bind(body.promotion_id,body.customer_id,body.credit_account.account_id,body.credit_account.name));
  }

  const payloadHashPromise=sha256Hex(stableStringify(body));
  let validation;
  if (String(env?.DB_PROVIDER || '').trim().toLowerCase() === 'turso' || typeof db?._pipeline === 'function') {
    const batched=await db.batch(reads);
    validation=batched.map(firstBatchRow);
  } else {
    // Preserve the existing D1/local binding contract. The production latency
    // optimization is Turso-specific because its adapter turns db.batch into a
    // single remote HTTP pipeline; legacy/local test bindings may implement
    // batch as mutation-only.
    validation=[];
    for (const statement of reads) validation.push(await statement.first());
  }
  const payloadHash=await payloadHashPromise;
  const denied=authorityErrorFor(validation[readIndex.control]);
  if (denied) return json({error:denied},409);

  const existing=validation[readIndex.existing];
  if (existing) {
    // Preserve the replay rule: an old durable operation is returned only while
    // this session still owns current write authority.
    const stale=await authorityError();
    if (stale) return json({error:stale},409);
    return existing.payload_hash===payloadHash
      ? json({status:'already_processed',operation_id:body.operation_id,sale_id:existing.sale_id,idempotent:true})
      : json({error:'operation_id_conflict',operation_id:body.operation_id},409);
  }
  if (validation[readIndex.financialOperation]) return json({error:'operation_id_conflict',operation_id:body.operation_id},409);
  if (readIndex.productOperation>=0 && validation[readIndex.productOperation]) return json({error:'operation_id_conflict',operation_id:body.operation_id},409);

  const products=[];
  for (let index=0; index<body.items.length; index++) {
    const item=body.items[index], row=validation[readIndex.products[index]];
    if (item.generic_line !== undefined) {
      if (row) return json({error:'generic_product_id_conflict',product_id:item.product_id},409);
      products.push({product_id:item.product_id,current_stock_quantity:0,stock_revision:0,tracks_inventory:0,provenance:'GENERIC'});
      continue;
    }
    const product=row;
    if (!product || ![0,1].includes(product.tracks_inventory) || Number(product.stock_revision) !== item.expected_stock_revision ||
        (product.tracks_inventory === 1 && (product.current_stock_quantity === null || Number(product.current_stock_quantity) < item.quantity))) {
      return json({error:'stale_stock',product_id:item.product_id},409);
    }
    products.push(product);
  }

  if (body.customer_id && !validation[readIndex.customer]) return json({error:'customer_not_found'},409);

  let creditLine=null;
  if (readIndex.creditLine>=0) {
    const line=validation[readIndex.creditLine]||{};
    creditLine={mode:line.mode||null,limit:line.manual_limit_cents==null?null:Number(line.manual_limit_cents),
      revision:line.policy_revision==null?null:Number(line.policy_revision),debt:Number(line.debt_cents)||0};
    if (creditLine.mode==='MANUAL' && creditLine.debt+body.total_cents>creditLine.limit) {
      return json({error:'credit_limit_exceeded',customer_id:body.customer_id,limit_cents:creditLine.limit,
        debt_cents:creditLine.debt,available_cents:Math.max(0,creditLine.limit-creditLine.debt),requested_cents:body.total_cents},409);
    }
  }

  let accountExists=false;
  if (readIndex.account>=0) {
    const account=validation[readIndex.account];
    if(account){
      if(account.account_id!==body.credit_account.account_id || account.name!==body.credit_account.name || account.mode!==body.credit_account.mode)
        return json({error:'credit_account_conflict',account_id:account.account_id},409);
      accountExists=true;
    }
  }
  const token = crypto.randomUUID();
  const statements = [
    db.prepare(`INSERT INTO canonical_write_guards(operation_id,commit_token,promotion_id,authority_epoch,control_revision,client_contract,principal_id,credential_hash)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM canonical_control c JOIN devices d ON d.device_id=?7
      WHERE c.id=1 AND c.mode='ACTIVE' AND c.active_promotion_id=?3 AND c.authority_epoch=?4 AND c.revision=?5
      AND c.minimum_client_contract=?6 AND d.role='writer' AND d.status='active' AND d.credential_hash=?8)`).bind(body.operation_id,token,body.promotion_id,body.authority_epoch,body.expected_control_revision,body.client_contract,principalId,auth.credentialHash),
    db.prepare(`INSERT INTO sales(sale_id,operation_id,payload_hash,commit_token,device_id,payment_method,total_cents,payment_reference,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE EXISTS(SELECT 1 FROM canonical_write_guards WHERE operation_id=?2 AND commit_token=?4)`).bind(body.sale_id,body.operation_id,payloadHash,token,principalId,body.payment_method,body.total_cents,body.payment.reference,body.created_at),
    db.prepare(`INSERT INTO canonical_sale_context(sale_id,operation_id,promotion_id,authority_epoch,control_revision,customer_id,client_contract,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM sales WHERE operation_id=?2 AND commit_token=?9)`).bind(body.sale_id,body.operation_id,body.promotion_id,body.authority_epoch,body.expected_control_revision,body.customer_id||null,body.client_contract,body.created_at,token),
  ];
  // Optional explicit identity fences a stale till selection. Without it, the
  // unique open session owns the sale through immutable rowid watermarks.
  if (body.session_id) statements.push(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok)
    SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM canonical_cash_state WHERE promotion_id=?2 AND session_id=?3 AND status='OPEN') THEN 1 ELSE 0 END`)
    .bind(`${token}:session`,body.promotion_id,body.session_id));
  if (creditLine) {
    // Evaluated inside the same atomic batch, before this sale's credit exists: two concurrent
    // sales cannot both fit into the same remaining line, and a policy change in between fails.
    statements.push(creditLine.mode==='MANUAL'
      ? db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok) SELECT ?3,CASE WHEN
          EXISTS(SELECT 1 FROM canonical_customer_credit_policies WHERE promotion_id=?1 AND customer_id=?2 AND mode='MANUAL'
            AND manual_limit_cents=?4 AND revision=?5)
          AND ${customerDebtSql}+?6<=?4 THEN 1 ELSE 0 END`)
          .bind(body.promotion_id,body.customer_id,`${token}:credit-line`,creditLine.limit,creditLine.revision,body.total_cents)
      : db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok) SELECT ?3,CASE WHEN
          COALESCE((SELECT revision FROM canonical_customer_credit_policies WHERE promotion_id=?1 AND customer_id=?2),-1)=?4
          THEN 1 ELSE 0 END`)
          .bind(body.promotion_id,body.customer_id,`${token}:credit-line`,creditLine.revision==null?-1:creditLine.revision));
  }
  for (let index=0; index<body.items.length; index++) {
    const item=body.items[index], line=index+1, product=products[index];
    if (product.provenance==='GENERIC') {
      statements.push(db.prepare(`INSERT INTO canonical_generic_sale_lines
        (sale_id,line_number,operation_id,promotion_id,generic_product_id,name,code,quantity,unit_price_cents,line_total_cents,created_at)
        SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11
        WHERE EXISTS(SELECT 1 FROM canonical_write_guards WHERE operation_id=?3)`)
        .bind(body.sale_id,line,body.operation_id,body.promotion_id,item.product_id,item.generic_line.name,item.generic_line.code||null,
          item.quantity,item.unit_price_cents,item.line_total_cents,body.created_at));
      statements.push(db.prepare(`INSERT INTO sale_items(sale_id,line_number,operation_id,product_id,quantity,unit_price_cents,line_total_cents,created_at)
        SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM canonical_write_guards WHERE operation_id=?3)`)
        .bind(body.sale_id,line,body.operation_id,item.product_id,item.quantity,item.unit_price_cents,item.line_total_cents,body.created_at));
      continue;
    }
    const stockTable=product.provenance==='LIVE'?'canonical_live_products':'products';
    statements.push(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok) SELECT ?1,CASE WHEN EXISTS(
      SELECT 1 FROM ${stockTable} WHERE promotion_id=?2 AND product_id=?3 AND stock_revision=?4 AND tracks_inventory=?5
      AND (tracks_inventory=0 OR current_stock_quantity>=?6)) THEN 1 ELSE 0 END`).bind(`${token}:stock:${line}`,body.promotion_id,item.product_id,item.expected_stock_revision,product.tracks_inventory,item.quantity));
    statements.push(db.prepare(`INSERT INTO sale_items(sale_id,line_number,operation_id,product_id,quantity,unit_price_cents,line_total_cents,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM canonical_write_guards WHERE operation_id=?3)`).bind(body.sale_id,line,body.operation_id,item.product_id,item.quantity,item.unit_price_cents,item.line_total_cents,body.created_at));
    if (product.tracks_inventory !== 0) {
      const effectTable=product.provenance==='LIVE'?'canonical_live_inventory_effects':'canonical_inventory_effects';
      statements.push(db.prepare(`UPDATE ${stockTable} SET current_stock_quantity=current_stock_quantity-?1,stock_revision=stock_revision+1
        WHERE promotion_id=?2 AND product_id=?3 AND stock_revision=?4 AND current_stock_quantity>=?1`).bind(item.quantity,body.promotion_id,item.product_id,item.expected_stock_revision));
      statements.push(db.prepare(`INSERT INTO inventory_movements(movement_id,operation_id,sale_id,line_number,product_id,quantity,created_at)
        SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE changes()=1`).bind(`${body.operation_id}:inventory:${line}`,body.operation_id,body.sale_id,line,item.product_id,-item.quantity,body.created_at));
      statements.push(db.prepare(`INSERT INTO ${effectTable}(movement_id,operation_id,promotion_id,product_id,stock_revision_before,stock_revision_after,quantity)
        SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE changes()=1`).bind(`${body.operation_id}:inventory:${line}`,body.operation_id,body.promotion_id,item.product_id,item.expected_stock_revision,item.expected_stock_revision+1,-item.quantity));
    }
  }
  statements.push(db.prepare(`INSERT INTO cash_movements(movement_id,operation_id,sale_id,payment_method,amount_cents,cash_cents,digital_cents,credit_cents,digital_method,reference,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11 WHERE EXISTS(SELECT 1 FROM canonical_write_guards WHERE operation_id=?2)`).bind(`${body.operation_id}:cash`,body.operation_id,body.sale_id,body.payment_method,body.total_cents,body.payment.cash_cents,body.payment.digital_cents,body.payment.credit_cents,body.payment.digital_method,body.payment.reference,body.created_at));
  if (body.payment_method === 'credito') {
    const creditId=`${body.operation_id}:credit`, account=body.credit_account || {account_id:'small',name:'Créditos pequeños',mode:'accumulated'};
    statements.push(db.prepare(`INSERT INTO live_credits(promotion_id,credit_id,operation_id,sale_id,customer_id,original_amount_cents,current_balance_cents,due_date,status,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?6,?7,'LIVE',?8 WHERE EXISTS(SELECT 1 FROM canonical_write_guards WHERE operation_id=?3)`)
      .bind(body.promotion_id,creditId,body.operation_id,body.sale_id,body.customer_id,body.total_cents,body.credit_due,body.created_at));
    if(account.account_id!=='small' && !accountExists) statements.push(db.prepare(`INSERT INTO canonical_credit_accounts
      (promotion_id,customer_id,account_id,name,mode,operation_id,request_hash,principal_id,credential_hash,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE EXISTS(SELECT 1 FROM canonical_write_guards WHERE operation_id=?6)`)
      .bind(body.promotion_id,body.customer_id,account.account_id,account.name,account.mode,body.operation_id,payloadHash,principalId,auth.credentialHash,body.created_at));
    statements.push(db.prepare(`INSERT INTO canonical_credit_metadata
      (promotion_id,credit_id,credit_provenance,customer_id,account_id,account_name,account_mode,operation_id,assigned_at)
      SELECT ?1,?2,'LIVE',?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM live_credits WHERE promotion_id=?1 AND credit_id=?2 AND operation_id=?7)`)
      .bind(body.promotion_id,creditId,body.customer_id,account.account_id,account.name,account.mode,body.operation_id,body.created_at));
    for(const installment of body.installments || []) statements.push(db.prepare(`INSERT INTO canonical_credit_installments
      (promotion_id,credit_id,credit_provenance,installment_number,due_date,amount_cents,operation_id,created_at)
      SELECT ?1,?2,'LIVE',?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM canonical_credit_metadata WHERE promotion_id=?1 AND credit_id=?2 AND operation_id=?6)`)
      .bind(body.promotion_id,creditId,installment.number,installment.due_date,installment.amount_cents,body.operation_id,body.created_at));
  }
  statements.push(db.prepare(`UPDATE canonical_control SET first_live_operation_id=COALESCE(first_live_operation_id,?1)
    WHERE id=1 AND mode='ACTIVE' AND active_promotion_id=?2 AND authority_epoch=?3 AND revision=?4
    AND EXISTS(SELECT 1 FROM sales WHERE operation_id=?1 AND commit_token=?5)`).bind(body.operation_id,body.promotion_id,body.authority_epoch,body.expected_control_revision,token));
  statements.push(db.prepare('DELETE FROM canonical_write_guards WHERE operation_id=?1').bind(body.operation_id));
  // Every zero-row mutation is fatal inside D1, not an optimistic HTTP success.
  const atomic=[];
  for (const [index,statement] of statements.entries()) {
    atomic.push(statement,db.prepare('INSERT INTO canonical_assertions(assertion_id,ok) VALUES(?1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)').bind(`${token}:changed:${index}`));
  }
  atomic.push(db.prepare('DELETE FROM canonical_assertions WHERE assertion_id LIKE ?1').bind(`${token}:%`));
  try { await db.batch(atomic); }
  catch { const replay=await db.prepare('SELECT sale_id,payload_hash FROM sales WHERE operation_id=?1').bind(body.operation_id).first();
    const stale=await authorityError();
    if(stale)return json({error:stale},409);
    if(replay?.payload_hash===payloadHash)return json({status:'already_processed',operation_id:body.operation_id,sale_id:replay.sale_id,idempotent:true});
    if(replay)return json({error:'operation_id_conflict',operation_id:body.operation_id},409);
    if(await db.prepare('SELECT operation_id FROM canonical_financial_operations WHERE operation_id=?1').bind(body.operation_id).first())return json({error:'operation_id_conflict',operation_id:body.operation_id},409);
    if(creditLine&&creditLine.mode==='MANUAL'){
      // The batch lost a race on the credit line (another sale or a policy change): report it clearly.
      const now=await db.prepare(`SELECT (SELECT manual_limit_cents FROM canonical_customer_credit_policies WHERE promotion_id=?1 AND customer_id=?2 AND mode='MANUAL') AS limit_cents,
        ${customerDebtSql} AS debt_cents`).bind(body.promotion_id,body.customer_id).first().catch(()=>null);
      if(now&&now.limit_cents!=null&&Number(now.debt_cents)+body.total_cents>Number(now.limit_cents))
        return json({error:'credit_limit_exceeded',customer_id:body.customer_id,limit_cents:Number(now.limit_cents),debt_cents:Number(now.debt_cents),
          available_cents:Math.max(0,Number(now.limit_cents)-Number(now.debt_cents)),requested_cents:body.total_cents},409);
    }
    return json({error:'canonical_sale_conflict',operation_id:body.operation_id},409); }
  return json({status:'created',operation_id:body.operation_id,sale_id:body.sale_id,promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,idempotent:false},201);
}
