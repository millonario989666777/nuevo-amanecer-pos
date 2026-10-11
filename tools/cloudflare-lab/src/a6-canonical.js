import { getDatabase } from './database-binding.js';
import { A6_FIELD_MAP, A6_MAPPING_VERSION, A6_POLICY, A6_SCHEMA_VERSION, a6PolicyHash, mapStagingRow } from './a6-mapping.js';
import { buildManifest, sha256Hex, stableStringify } from './a5-import-core.js';

const HASH = /^[0-9a-f]{64}$/;
const PROMOTE_FIELDS = ['operation_id','promotion_id','import_id','expected_source_hash','expected_manifest_hash','expected_transform_version','expected_staging_revision','mapping_version','schema_version','policy_hash','expected_control_revision'];
const TABLES = {
  products: ['product_id','name','sku','barcode','alternate_codes_json','legacy_alternate_code','category','brand','description','icon','image','unit','purchase_unit','purchase_factor','cost_cents','price_cents','box_price_cents','units_per_box','opening_stock_quantity','current_stock_quantity','stock_revision','stock_min_quantity','expiry_date','includes_igv','tax_type','complementary_tax','tracks_inventory'],
  customers: ['customer_id','name','document','phone','address','color','total_purchases_cents','source_image_balance_cents','source_document_balance_cents','source_difference_cents','source_documents_total','source_documents_pending','source_documents_paid','source_payment_count','source_pending_original_cents','source_pending_paid_cents','source_pending_progress_ratio','source_historical_credit_cents','source_historical_paid_cents','source_first_credit_value','source_last_payment_value','source_expected_full_payment_value','source_max_term_days','source_days_until_due','source_status','source_reconciliation'],
  credits: ['credit_id','customer_id','sale_id','store','document_number','reference','concept','seller','issued_value','due_value','term_days','original_amount_cents','import_paid_cents','opening_balance_cents','current_balance_cents','source_progress_ratio','source_payment_count','source_days_until_due','source_status','source_customer_image_balance_cents','source_customer_document_balance_cents','source_customer_difference_cents'],
  credit_payments: ['payment_id','credit_id','source_payment_id','source_sequence','amount_cents','payment_date','payment_timestamp','payment_date_known','date_precision','method','source_method','source_origin','source_document_type','source_operation_reference','seller','date_observation','source_customer_document','source_customer_name','source_cumulative_paid_cents','source_balance_after_cents','source_progress_ratio','source_credit_original_cents','source_current_document_balance_cents'],
};
const PROVENANCE = ['promotion_id','source_import_id','source_entity_type','source_name','source_row','source_key','source_payload_json','source_payload_hash','mapping_version'];
const READ_TABLES = new Set(['products','customers','credits','credit-payments','credit-accounts','sales','sale-items','inventory-movements','cash-movements','cash-sessions','financial-events','expenses']);
const A3_PUBLIC_COLUMNS={
  sales:'sale_id,operation_id,payment_method,total_cents,payment_reference,created_at,received_at',
  sale_items:'sale_id,line_number,operation_id,product_id,quantity,unit_price_cents,line_total_cents,created_at',
  inventory_movements:'movement_id,operation_id,sale_id,line_number,product_id,quantity,created_at',
  cash_movements:'movement_id,operation_id,sale_id,payment_method,amount_cents,cash_cents,digital_cents,credit_cents,digital_method,reference,created_at',
};

export function isA6Path(path) {
  return path === '/commands/canonical.freeze' || path === '/commands/import.promote' || path === '/commands/canonical.rollback' || path.startsWith('/read/canonical/') || path.startsWith('/imports/canonical/');
}

export function a6LocalDenied(url, env, json) {
  if (env.A6_LOCAL_GATE !== 'enabled' || !['localhost','127.0.0.1'].includes(url.hostname)) return json({ error:'not_found' },404);
  return null;
}

export function canonicalRuntimeDenied(url, env, json) {
  const local = env.A6_LOCAL_GATE === 'enabled' && ['localhost','127.0.0.1'].includes(url.hostname);
  if (local || env.CANONICAL_RUNTIME_ENABLED === 'enabled') return null;
  return json({ error:'not_found' },404);
}

async function authorizeCanonicalRead(request, env, helpers) {
  if (request.headers.get('authorization') || request.headers.get('x-session-token')) {
    const auth = await helpers.authorizeSession(request, env);
    return auth instanceof Response ? auth : null;
  }
  return helpers.authorizeRead(request, env);
}

export async function handleA6(request, url, env, helpers) {
  if (url.pathname.startsWith('/read/canonical/')) {
    const runtimeDenied = canonicalRuntimeDenied(url, env, helpers.json);
    if (runtimeDenied) return runtimeDenied;

    // Preserve the original local promotion gate: local canonical reads remain
    // tied to the exact synthetic operational manifest. Remote runtime reads,
    // when explicitly enabled, do not depend on that local-only manifest.
    const localRuntime = env.A6_LOCAL_GATE === 'enabled' && ['localhost','127.0.0.1'].includes(url.hostname);
    if (localRuntime) {
      const configured = await operationalManifest(env);
      if (configured.error) return helpers.json({ error:'a6_manifest_invalid', message:configured.error },503);
    }

    if (request.method !== 'GET') return helpers.json({ error:'method_not_allowed' },405,{ allow:'GET, OPTIONS' });
    const denied = await authorizeCanonicalRead(request,env,helpers); if (denied) return denied;
    return canonicalRead(url,getDatabase(env),helpers.json);
  }

  const localDenied = a6LocalDenied(url, env, helpers.json);
  if (localDenied) return localDenied;
  const configured = await operationalManifest(env);
  if (configured.error) return helpers.json({ error:'a6_manifest_invalid', message:configured.error },503);
  const provenance = url.pathname.match(/^\/imports\/canonical\/([^/]+)$/);
  if (provenance) {
    if (request.method !== 'GET') return helpers.json({ error:'method_not_allowed' },405,{ allow:'GET, OPTIONS' });
    const auth = await helpers.authorizeSession(request,env); if (auth instanceof Response) return auth;
    return readProvenance(decodeURIComponent(provenance[1]),url,getDatabase(env),helpers.json);
  }
  if (request.method !== 'POST') return helpers.json({ error:'method_not_allowed' },405,{ allow:'POST, OPTIONS' });
  const auth=await helpers.authorizeSession(request,env); if (auth instanceof Response) return auth;
  const deviceId=auth.principalId;
  let body; try { body=await request.json(); } catch { return helpers.json({ error:'invalid_json' },400); }
  if (url.pathname==='/commands/canonical.freeze') return freeze(body,deviceId,auth.credentialHash,configured.value,getDatabase(env),helpers.json);
  if (url.pathname==='/commands/canonical.rollback') return rollback(body,deviceId,auth.credentialHash,configured.value,getDatabase(env),helpers.json);
  return promote(body,deviceId,auth.credentialHash,configured.value,getDatabase(env),helpers.json);
}

async function operationalManifest(env) {
  if (typeof env.A6_OPERATIONAL_MANIFEST!=='string') return { error:'A6_OPERATIONAL_MANIFEST is required' };
  let value; try { value=JSON.parse(env.A6_OPERATIONAL_MANIFEST); } catch { return { error:'A6_OPERATIONAL_MANIFEST must be JSON' }; }
  const exact=['environment','database_id','worker_hash','client_hash','operator','backup_hash','run','mapping_version','schema_version','policy_hash','expected','local_pending_count','local_delta_count'];
  if (!plainExact(value,exact)) return { error:'manifest fields mismatch' };
  for (const key of ['environment','database_id','worker_hash','client_hash','operator','backup_hash','mapping_version','schema_version','policy_hash']) if (typeof value[key]!=='string'||!value[key]) return { error:`manifest ${key} missing` };
  if (value.environment!=='local' || value.database_id!==env.A6_LOCAL_DATABASE_ID) return { error:'manifest environment/database mismatch' };
  for (const key of ['worker_hash','client_hash','backup_hash','policy_hash']) if (!HASH.test(value[key])) return { error:`manifest ${key} invalid` };
  if (!Number.isSafeInteger(value.local_pending_count)||value.local_pending_count!==0||!Number.isSafeInteger(value.local_delta_count)||value.local_delta_count!==0) return { error:'local pending/deltas must be zero' };
  if (!plainExact(value.run,['import_id','source_hash','manifest_hash','transform_version','staging_revision']) || !validId(value.run.import_id) || !HASH.test(value.run.source_hash)||!HASH.test(value.run.manifest_hash)||typeof value.run.transform_version!=='string'||!Number.isSafeInteger(value.run.staging_revision)) return { error:'manifest run invalid' };
  const expectedKeys=['products','customers','credits','credit_payments','sales','sale_items','cash_movements','inventory_movements','expenses','cash_closures','credit_amount_cents','credit_paid_cents','credit_balance_cents','payment_amount_cents','sales_total_cents','known_payment_dates','unknown_payment_dates'];
  if(!plainExact(value.expected,expectedKeys)||expectedKeys.some((key)=>!Number.isSafeInteger(value.expected[key])||value.expected[key]<0))return{error:'manifest expected invariants invalid'};
  if(['sales','sale_items','cash_movements','inventory_movements','expenses','cash_closures','sales_total_cents'].some((key)=>value.expected[key]!==0))return{error:'Gate P requires zero operational entities'};
  if (value.mapping_version!==A6_MAPPING_VERSION||value.schema_version!==A6_SCHEMA_VERSION||value.policy_hash!==await a6PolicyHash()) return { error:'manifest mapping/schema/policy mismatch' };
  return { value };
}

async function freeze(body,deviceId,credentialHash,manifest,db,json) {
  if (!plainExact(body,['operation_id','expected_control_revision'])||!validId(body.operation_id)||!Number.isSafeInteger(body.expected_control_revision)) return json({ error:'invalid_freeze_request' },400);
  const requestHash=await sha256Hex(stableStringify(body));
  const replay=await receiptReplay(db,body.operation_id,requestHash,json); if(replay)return replay;
  const counts=await zeroTraffic(db); if(Object.values(counts).some(Number)) return json({ error:'freeze_not_empty',counts },409);
  const run=await db.prepare('SELECT status,revision FROM import_runs WHERE import_id=?1').bind(manifest.run.import_id).first();
  if(run?.status!=='PASS'||Number(run.revision)!==manifest.run.staging_revision||await verifyA5Run(db,manifest.run.import_id,manifest.run.source_hash,manifest.run.manifest_hash,manifest.run.transform_version))return json({error:'freeze_source_invalid'},409);
  const before=await control(db);if(!before||!['LEGACY','CANONICAL_READ_ONLY'].includes(before.mode)||Number(before.revision)!==body.expected_control_revision||before.first_live_operation_id!==null)return json({error:'freeze_conflict'},409);
  const result={status:'FROZEN',operation_id:body.operation_id,previous_mode:before.mode,revision:body.expected_control_revision+1,authority_epoch:Number(before.authority_epoch)+1};
  const assertion=`freeze:${crypto.randomUUID()}`;
  const statements=[
    db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok) SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM canonical_control c JOIN devices d ON d.device_id=?2 WHERE c.id=1 AND c.mode IN ('LEGACY','CANONICAL_READ_ONLY') AND c.first_live_operation_id IS NULL AND c.revision=?3 AND d.role='writer' AND d.status='active' AND d.credential_hash=?4) AND NOT EXISTS(SELECT 1 FROM sales UNION ALL SELECT 1 FROM sale_items UNION ALL SELECT 1 FROM cash_movements UNION ALL SELECT 1 FROM inventory_movements UNION ALL SELECT 1 FROM sync_operations) AND EXISTS(SELECT 1 FROM import_runs WHERE import_id=?5 AND status='PASS' AND revision=?6 AND source_hash=?7 AND manifest_hash=?8 AND transform_version=?9) THEN 1 ELSE 0 END`).bind(assertion,deviceId,body.expected_control_revision,credentialHash,manifest.run.import_id,manifest.run.staging_revision,manifest.run.source_hash,manifest.run.manifest_hash,manifest.run.transform_version),
    db.prepare(`UPDATE canonical_control SET mode='FROZEN',revision=revision+1,authority_epoch=authority_epoch+1,writer_device_id=?1 WHERE id=1 AND mode IN ('LEGACY','CANONICAL_READ_ONLY') AND revision=?2`).bind(deviceId,body.expected_control_revision),
    assertChanged(db,`${assertion}:control`),
    db.prepare(`INSERT INTO canonical_command_receipts(operation_id,command,request_hash,result_json) SELECT ?1,'freeze',?2,?3 WHERE EXISTS(SELECT 1 FROM canonical_assertions WHERE assertion_id=?4)`).bind(body.operation_id,requestHash,stableStringify(result),assertion),
    db.prepare('DELETE FROM canonical_assertions WHERE assertion_id=?1').bind(assertion),
    db.prepare('DELETE FROM canonical_assertions WHERE assertion_id=?1').bind(`${assertion}:control`),
  ];
  try { const out=await db.batch(statements); if(out.slice(0,4).some((r)=>r.meta?.changes!==1)) throw new Error('guard'); }
  catch { return (await receiptReplay(db,body.operation_id,requestHash,json))||json({error:'freeze_conflict'},409); }
  return json(result,201);
}

async function promote(body,deviceId,credentialHash,manifest,db,json) {
  if(body&&typeof body==='object'&&!Object.prototype.hasOwnProperty.call(body,'phase'))body={...body,phase:'publish'};
  if (!plainExact(body,[...PROMOTE_FIELDS,'phase'])||!['prepare','publish'].includes(body.phase)) return json({error:'invalid_promotion_request'},400);
  for(const field of PROMOTE_FIELDS.filter((key)=>key!=='expected_staging_revision'&&key!=='expected_control_revision')) if(!validId(body[field])) return json({error:'invalid_promotion_request',field},400);
  for(const field of ['expected_source_hash','expected_manifest_hash','policy_hash']) if(!HASH.test(body[field])) return json({error:'invalid_promotion_request',field},400);
  if(!Number.isSafeInteger(body.expected_staging_revision)||!Number.isSafeInteger(body.expected_control_revision)) return json({error:'invalid_promotion_request'},400);
  const hashBody={}; for(const key of PROMOTE_FIELDS) hashBody[key]=body[key];
  // These are operator attestations, not server measurements of deployed artifacts.
  const manifestJson=stableStringify(manifest),manifestHash=await sha256Hex(manifestJson);
  hashBody.operational_manifest_hash=manifestHash;
  const requestHash=await sha256Hex(stableStringify(hashBody));
  if (!manifestMatches(body,manifest)) return json({error:'operational_manifest_mismatch'},409);
  let promotion=await db.prepare('SELECT * FROM canonical_promotions WHERE operation_id=?1 OR promotion_id=?2').bind(body.operation_id,body.promotion_id).all();
  const matches=promotion.results??[];
  if(matches.some((row)=>row.request_hash!==requestHash||row.operation_id!==body.operation_id||row.promotion_id!==body.promotion_id)) return json({error:'promotion_conflict'},409);
  let current=matches[0];
  if(current?.result_json) return json(JSON.parse(current.result_json),200);
  if(current?.status==='ABANDONED')return json({error:'promotion_abandoned'},409);
  if(!current){
    let claimed;
    try{claimed=await claimPromotion(body,deviceId,credentialHash,requestHash,manifestJson,manifestHash,db);}catch(error){
      // Only an identity collision is a possible concurrent claim, not a storage failure.
      if(!/UNIQUE constraint failed: canonical_promotions\./i.test(String(error?.message)))return json({error:'promotion_claim_conflict'},409);
      current=await resumablePromotion(db,body,deviceId,credentialHash,requestHash);
      if(!current)return json({error:'promotion_claim_conflict'},409);
    }
    if(!claimed){current=await resumablePromotion(db,body,deviceId,credentialHash,requestHash);if(!current)return json({error:'promotion_claim_conflict'},409);}
    else current=await db.prepare('SELECT * FROM canonical_promotions WHERE promotion_id=?1').bind(body.promotion_id).first();
  }
  if(current?.result_json)return json(JSON.parse(current.result_json));
  // Bounded D1 batches, but one prepare/publish request resumes the whole candidate.
  const total=Number((await db.prepare('SELECT row_count FROM import_runs WHERE import_id=?1').bind(body.import_id).first()).row_count);
  // Every continuation consumes durable progress, even if other requests win one row
  // at a time. No polling, timer, or unbounded retries after ambiguous I/O errors.
  const batchLimit=total+1;
  let complete=false;
  for(let i=0;i<batchLimit;i++){
    const response=await prepareBatch(body,current,deviceId,credentialHash,requestHash,db,json);
    if(response.resume){current=response.resume;continue;}
    if(response.status>=400)return response;
    const outcome=await response.json();
    if(outcome.status==='COMMITTED')return json(outcome);
    if(outcome.remaining===0){if(body.phase==='prepare')return json(outcome);complete=true;break;}
    current=await db.prepare('SELECT * FROM canonical_promotions WHERE promotion_id=?1').bind(body.promotion_id).first();
    if(current?.result_json)return json(JSON.parse(current.result_json));
  }
  if(!complete)return json({error:'promotion_progress_exhausted'},409);
  current=await db.prepare('SELECT * FROM canonical_promotions WHERE promotion_id=?1').bind(body.promotion_id).first();
  if(current?.result_json)return json(JSON.parse(current.result_json));
  return publish(body,current,deviceId,credentialHash,requestHash,manifest,db,json);
}

async function resumablePromotion(db,body,deviceId,credentialHash,requestHash){
  return db.prepare(`SELECT p.* FROM canonical_promotions p JOIN devices d ON d.device_id=?1
    JOIN import_runs r ON r.import_id=p.import_id JOIN canonical_control c ON c.id=1
    WHERE p.promotion_id=?2 AND p.operation_id=?3 AND p.request_hash=?4 AND p.device_id=?1
    AND d.role='writer' AND d.status='active' AND d.credential_hash=?5
    AND r.status='PASS' AND r.revision=?6 AND r.source_hash=?7 AND r.manifest_hash=?8 AND r.transform_version=?9
    AND ((p.status IN ('COMMITTED','ABANDONED') AND p.result_json IS NOT NULL) OR
      (p.status='PREPARED' AND p.sealed_revision IS NULL AND c.mode='FROZEN' AND c.revision=?10
       AND c.writer_device_id=?1 AND c.first_live_operation_id IS NULL))`).bind(deviceId,body.promotion_id,body.operation_id,requestHash,credentialHash,
    body.expected_staging_revision,body.expected_source_hash,body.expected_manifest_hash,body.expected_transform_version,body.expected_control_revision).first();
}

async function candidateRowsMatch(db,promotionId){
  // One SQL read captures all four immutable tables at the same revision. Separate
  // table reads could miss parents inserted between reads while seeing their children.
  const selects=Object.keys(TABLES).map((table)=>{
    const columns=[...TABLES[table],...PROVENANCE];
    return `SELECT '${table}' AS entity_type,json_object(${columns.map((key)=>`'${key}',${key}`).join(',')}) AS row_json FROM ${table} WHERE promotion_id=?1`;
  });
  const snapshot=(await db.prepare(selects.join(' UNION ALL ')).bind(promotionId).all()).results??[];
  let count=0;
  for(const entry of snapshot){
      const table=entry.entity_type,row=JSON.parse(entry.row_json);
      const source=await db.prepare(`SELECT * FROM import_staging WHERE import_id=?1 AND entity_type=?2 AND source_name=?3 AND source_row=?4 AND source_key=?5`)
        .bind(row.source_import_id,row.source_entity_type,row.source_name,row.source_row,row.source_key).first();
      if(!source)return null;
      const mapped=await mapStagingRow(source,promotionId);
      if(mapped.table!==table||stableStringify(mapped.row)!==stableStringify(row))return null;
      count++;
  }
  return count;
}

async function claimPromotion(body,deviceId,credentialHash,requestHash,manifestJson,manifestHash,db){
  const result=await db.prepare(`INSERT INTO canonical_promotions(promotion_id,operation_id,request_hash,import_id,source_hash,manifest_hash,transform_version,staging_revision,mapping_version,schema_version,policy_hash,control_revision,operational_manifest_json,operational_manifest_hash,device_id,status,previous_promotion_id,previous_mode)
 SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?13,?15,?16,?12,'PREPARED',c.active_promotion_id,CASE WHEN c.active_promotion_id IS NULL THEN 'FROZEN' ELSE 'CANONICAL_READ_ONLY' END FROM canonical_control c JOIN import_runs r ON r.import_id=?4 JOIN devices d ON d.device_id=?12
 WHERE c.id=1 AND c.mode='FROZEN' AND c.first_live_operation_id IS NULL AND c.writer_device_id=?12 AND c.revision=?13 AND r.status='PASS' AND r.source_hash=?5 AND r.manifest_hash=?6 AND r.transform_version=?7 AND r.revision=?8
 AND d.role='writer' AND d.status='active' AND d.credential_hash=?14 AND NOT EXISTS(SELECT 1 FROM import_issues WHERE import_id=?4)
 AND NOT EXISTS(SELECT 1 FROM import_staging WHERE import_id=?4 AND validation_status<>'VALID')`).bind(body.promotion_id,body.operation_id,requestHash,body.import_id,body.expected_source_hash,body.expected_manifest_hash,body.expected_transform_version,body.expected_staging_revision,body.mapping_version,body.schema_version,body.policy_hash,deviceId,body.expected_control_revision,credentialHash,manifestJson,manifestHash).run();
  return result.meta.changes===1;
}

function assertChanged(db,id){return db.prepare('INSERT INTO canonical_assertions(assertion_id,ok) VALUES(?1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)').bind(id);}

async function prepareBatch(body,promotion,deviceId,credentialHash,requestHash,db,json){
  if(promotion.status!=='PREPARED'||promotion.sealed_revision!==null) return json({error:'candidate_sealed'},409);
  const staged=await db.prepare(`SELECT s.* FROM import_staging s WHERE s.import_id=?1 AND s.entity_type IN ('products','customers','credits','credit_payments') AND NOT EXISTS(
 SELECT 1 FROM products x WHERE x.promotion_id=?2 AND x.source_import_id=s.import_id AND x.source_entity_type=s.entity_type AND x.source_name=s.source_name AND x.source_row=s.source_row AND x.source_key=s.source_key UNION ALL
 SELECT 1 FROM customers x WHERE x.promotion_id=?2 AND x.source_import_id=s.import_id AND x.source_entity_type=s.entity_type AND x.source_name=s.source_name AND x.source_row=s.source_row AND x.source_key=s.source_key UNION ALL
 SELECT 1 FROM credits x WHERE x.promotion_id=?2 AND x.source_import_id=s.import_id AND x.source_entity_type=s.entity_type AND x.source_name=s.source_name AND x.source_row=s.source_row AND x.source_key=s.source_key UNION ALL
 SELECT 1 FROM credit_payments x WHERE x.promotion_id=?2 AND x.source_import_id=s.import_id AND x.source_entity_type=s.entity_type AND x.source_name=s.source_name AND x.source_row=s.source_row AND x.source_key=s.source_key)
 ORDER BY CASE s.entity_type WHEN 'products' THEN 1 WHEN 'customers' THEN 2 WHEN 'credits' THEN 3 ELSE 4 END,s.source_key,s.source_name,s.source_row LIMIT 25`).bind(body.import_id,body.promotion_id).all();
  const rows=staged.results??[];
  if(!rows.length){const count=await candidateCount(db,body.promotion_id);return json({status:'PREPARED',operation_id:body.operation_id,promotion_id:body.promotion_id,candidate_revision:Number(promotion.candidate_revision),prepared_rows:count,remaining:0,idempotent:true});}
  const assertion=`prepare:${crypto.randomUUID()}`;
  const statements=[guardStatement(db,assertion,body,deviceId,credentialHash,requestHash,promotion.candidate_revision)];
  try { for(const row of rows) statements.push(insertMapped(db,await mapStagingRow(row,body.promotion_id),assertion)); }
  catch(error){return json({error:'mapping_rejected',message:error.message},409);}
  statements.push(db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok) SELECT ?1,CASE WHEN EXISTS(
    SELECT 1 FROM canonical_promotions WHERE promotion_id=?2 AND candidate_revision=?3 AND status='PREPARED' AND sealed_revision IS NULL)
    THEN 1 ELSE 0 END`).bind(`${assertion}:revision`,body.promotion_id,Number(promotion.candidate_revision)+rows.length));
  statements.push(db.prepare('DELETE FROM canonical_assertions WHERE assertion_id IN (?1,?2)').bind(assertion,`${assertion}:revision`));
  // D1 meta.changes includes revision-trigger writes; SQLite's direct count does not.
  // SQL above proves the exact increment atomically. Zero affected rows never pass.
  try { const results=await db.batch(statements); if(results.some((r)=>!Number.isSafeInteger(r.meta?.changes)||r.meta.changes<1)) throw new Error('guard'); }
  catch(error) {
    // A failed CHECK guard can mean another exact retry advanced the candidate.
    // All other failures (including a lost prepare ACK) stay explicit to callers.
    if(!/CHECK constraint failed: ok\s*=\s*1/i.test(String(error?.message)))return json({error:'promotion_prepare_conflict'},409);
    const latest=await resumablePromotion(db,body,deviceId,credentialHash,requestHash);
    if(!latest)return json({error:'promotion_prepare_conflict'},409);
    if(latest.result_json)return json(JSON.parse(latest.result_json));
    if(Number(latest.candidate_revision)<=Number(promotion.candidate_revision))return json({error:'promotion_prepare_conflict'},409);
    let matchedCount;
    try{matchedCount=await candidateRowsMatch(db,body.promotion_id);}catch{return json({error:'promotion_prepare_conflict'},409);}
    // Validation awaits hashes while the winner can finish its next batch/publish.
    // Re-read after validation instead of comparing with an already stale revision.
    const after=await resumablePromotion(db,body,deviceId,credentialHash,requestHash);
    if(!after)return json({error:'promotion_prepare_conflict'},409);
    if(after.result_json)return json(JSON.parse(after.result_json));
    if(matchedCount===null||matchedCount<Number(latest.candidate_revision)||matchedCount>Number(after.candidate_revision))return json({error:'promotion_prepare_conflict'},409);
    // Resume only the revision actually checked. A later insert will fail the next
    // guard and consume another strictly advancing iteration, never bypass that guard.
    return {resume:{...after,candidate_revision:matchedCount}};
  }
  const after=await db.prepare('SELECT candidate_revision FROM canonical_promotions WHERE promotion_id=?1').bind(body.promotion_id).first();
  const count=await candidateCount(db,body.promotion_id);
  const expected=Number((await db.prepare('SELECT row_count FROM import_runs WHERE import_id=?1').bind(body.import_id).first()).row_count);
  return json({status:'PREPARED',operation_id:body.operation_id,promotion_id:body.promotion_id,candidate_revision:Number(after.candidate_revision),accepted:rows.length,prepared_rows:count,remaining:Math.max(0,expected-count)});
}

function guardStatement(db,id,body,deviceId,credentialHash,requestHash,candidateRevision){
  return db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok) SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM canonical_promotions p JOIN canonical_control c ON c.id=1 JOIN import_runs r ON r.import_id=p.import_id JOIN devices d ON d.device_id=?2
  WHERE p.promotion_id=?3 AND p.operation_id=?4 AND p.request_hash=?5 AND p.status='PREPARED' AND p.sealed_revision IS NULL AND p.candidate_revision=?6
   AND p.device_id=?2 AND p.control_revision=?7 AND c.writer_device_id=?2 AND c.mode='FROZEN' AND c.first_live_operation_id IS NULL AND c.revision=?7 AND r.status='PASS' AND r.revision=?8 AND r.source_hash=?9 AND r.manifest_hash=?10 AND r.transform_version=?11
  AND d.role='writer' AND d.status='active' AND d.credential_hash=?12) AND NOT EXISTS(SELECT 1 FROM sales UNION ALL SELECT 1 FROM sale_items UNION ALL SELECT 1 FROM cash_movements UNION ALL SELECT 1 FROM inventory_movements UNION ALL SELECT 1 FROM sync_operations)
  THEN 1 ELSE 0 END`).bind(id,deviceId,body.promotion_id,body.operation_id,requestHash,candidateRevision,body.expected_control_revision,body.expected_staging_revision,body.expected_source_hash,body.expected_manifest_hash,body.expected_transform_version,credentialHash);
}

function insertMapped(db,mapped,assertion){
  const columns=[...TABLES[mapped.table],...PROVENANCE];
  const values=columns.map((key)=>mapped.row[key]??null);
  return db.prepare(`INSERT INTO ${mapped.table}(${columns.join(',')}) SELECT ${columns.map((_,i)=>`?${i+1}`).join(',')} WHERE EXISTS(SELECT 1 FROM canonical_assertions WHERE assertion_id=?${columns.length+1})`).bind(...values,assertion);
}

async function publish(body,promotion,deviceId,credentialHash,requestHash,manifest,db,json){
  const remaining=await db.prepare(`SELECT COUNT(*) AS count FROM import_staging s WHERE s.import_id=?1 AND s.entity_type IN ('products','customers','credits','credit_payments') AND NOT EXISTS(
 SELECT 1 FROM products x WHERE x.promotion_id=?2 AND x.source_import_id=s.import_id AND x.source_entity_type=s.entity_type AND x.source_name=s.source_name AND x.source_row=s.source_row AND x.source_key=s.source_key UNION ALL SELECT 1 FROM customers x WHERE x.promotion_id=?2 AND x.source_import_id=s.import_id AND x.source_entity_type=s.entity_type AND x.source_name=s.source_name AND x.source_row=s.source_row AND x.source_key=s.source_key UNION ALL SELECT 1 FROM credits x WHERE x.promotion_id=?2 AND x.source_import_id=s.import_id AND x.source_entity_type=s.entity_type AND x.source_name=s.source_name AND x.source_row=s.source_row AND x.source_key=s.source_key UNION ALL SELECT 1 FROM credit_payments x WHERE x.promotion_id=?2 AND x.source_import_id=s.import_id AND x.source_entity_type=s.entity_type AND x.source_name=s.source_name AND x.source_row=s.source_row AND x.source_key=s.source_key)`).bind(body.import_id,body.promotion_id).first();
  if(Number(remaining.count)!==0)return json({error:'candidate_incomplete',remaining:Number(remaining.count)},409);
  const sourceIntegrity=await verifyA5Run(db,body.import_id,body.expected_source_hash,body.expected_manifest_hash,body.expected_transform_version);
  if(sourceIntegrity)return json({error:'manifest_integrity_mismatch',details:sourceIntegrity},409);
  const reconciled=await reconcile(db,body.promotion_id,body.import_id,manifest.expected);
  if(reconciled.error)return json({error:'canonical_reconciliation_failed',details:reconciled.error},409);
  const before=await control(db);
  const result={status:'COMMITTED',operation_id:body.operation_id,promotion_id:body.promotion_id,canonical_digest:reconciled.digest,entity_digests:reconciled.entityDigests,counts:reconciled.counts,amounts:reconciled.amounts,mode:'CANONICAL_READ_ONLY',read_only:true,revision:body.expected_control_revision+1,authority_epoch:Number(before.authority_epoch)+1};
  const assertion=`publish:${crypto.randomUUID()}`;
  const statements=[guardStatement(db,assertion,body,deviceId,credentialHash,requestHash,promotion.candidate_revision),
    db.prepare(`UPDATE canonical_promotions SET status='COMMITTED',sealed_revision=candidate_revision,canonical_digest=?1,result_json=?2,committed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE promotion_id=?3 AND status='PREPARED' AND candidate_revision=?4 AND sealed_revision IS NULL AND EXISTS(SELECT 1 FROM canonical_assertions WHERE assertion_id=?5)`).bind(reconciled.digest,stableStringify(result),body.promotion_id,promotion.candidate_revision,assertion),
    assertChanged(db,`${assertion}:promotion`),
    db.prepare(`UPDATE canonical_control SET mode='CANONICAL_READ_ONLY',active_promotion_id=?1,revision=revision+1,authority_epoch=authority_epoch+1 WHERE id=1 AND mode='FROZEN' AND revision=?2 AND first_live_operation_id IS NULL AND EXISTS(SELECT 1 FROM canonical_promotions WHERE promotion_id=?1 AND status='COMMITTED' AND sealed_revision=candidate_revision AND canonical_digest=?3)`).bind(body.promotion_id,body.expected_control_revision,reconciled.digest),
    assertChanged(db,`${assertion}:control`),
    db.prepare('DELETE FROM canonical_assertions WHERE assertion_id IN (?1,?2,?3)').bind(assertion,`${assertion}:promotion`,`${assertion}:control`)];
  try{const out=await db.batch(statements);if(out.slice(0,5).some((r)=>r.meta?.changes!==1))throw new Error('guard');}
  catch{const replay=await db.prepare('SELECT request_hash,result_json FROM canonical_promotions WHERE operation_id=?1').bind(body.operation_id).first();if(replay?.request_hash===requestHash&&replay.result_json)return json(JSON.parse(replay.result_json));return json({error:'promotion_publish_conflict'},409);}
  return json(result,201);
}

async function verifyA5Run(db,importId,sourceHash,manifestHash,transformVersion){
  const run=await db.prepare('SELECT sources_json,report_json FROM import_runs WHERE import_id=?1').bind(importId).first();
  const staged=await db.prepare('SELECT entity_type,source_key,source_name,source_row,payload_json,payload_hash,validation_status FROM import_staging WHERE import_id=?1 ORDER BY entity_type,source_key,source_name,source_row').bind(importId).all();
  try{
    const report=JSON.parse(run.report_json);const rebuilt=await buildManifest({importId,sources:JSON.parse(run.sources_json),rows:(staged.results??[]).map((row)=>({entity_type:row.entity_type,source_key:row.source_key,source_name:row.source_name,source_row:Number(row.source_row),payload:JSON.parse(row.payload_json)})),exclusions:report.exclusions??null});
    if(rebuilt.source_hash!==sourceHash||rebuilt.manifest_hash!==manifestHash||rebuilt.transform_version!==transformVersion||stableStringify(rebuilt.report)!==stableStringify(report))return'rebuilt run differs';
    if((staged.results??[]).some((row)=>rebuilt.rows.find((candidate)=>candidate.entity_type===row.entity_type&&candidate.source_key===row.source_key&&candidate.source_name===row.source_name&&candidate.source_row===Number(row.source_row))?.payload_hash!==row.payload_hash))return'staging payload differs';
    return null;
  }catch{return'invalid original run';}
}

async function reconcile(db,promotionId,importId,baseline){
  const counts={},amounts={credit_amount_cents:0,credit_paid_cents:0,credit_balance_cents:0,payment_amount_cents:0};
  const digestRows=[],entityDigests={},canonical={};
  const sourceRows=(await db.prepare('SELECT * FROM import_staging WHERE import_id=?1').bind(importId).all()).results??[];
  const identity=(row)=>stableStringify([row.entity_type??row.source_entity_type,row.source_name,Number(row.source_row),row.source_key]);
  const sourceByIdentity=new Map(sourceRows.map((row)=>[identity(row),row]));
  if(sourceByIdentity.size!==sourceRows.length||sourceRows.some((row)=>!TABLES[row.entity_type]||row.validation_status!=='VALID'))return{error:{field:'unsupported_or_invalid_staging'}};
  for(const table of Object.keys(TABLES)){
    const result=await db.prepare(`SELECT ${TABLES[table].join(',')},source_import_id,source_entity_type,source_name,source_row,source_key,source_payload_json,source_payload_hash,mapping_version FROM ${table} WHERE promotion_id=?1 ORDER BY ${TABLES[table][0]}`).bind(promotionId).all();
    const rows=result.results??[];canonical[table]=rows;counts[table]=rows.length;
    const entityRows=[];
    for(const row of rows){
      const source=sourceByIdentity.get(identity(row));
      if(!source||source.payload_json!==row.source_payload_json||source.payload_hash!==row.source_payload_hash||row.source_import_id!==importId)return{error:{field:'source_bijection'}};
      sourceByIdentity.delete(identity(row));
      let remapped;try{remapped=await mapStagingRow(source,promotionId);}catch(error){return{error:{field:'typed_round_trip',message:error.message}};}
      const actual=Object.fromEntries([...TABLES[table],...PROVENANCE].map((key)=>[key,key==='promotion_id'?promotionId:row[key]??null]));
      const expectedRow=Object.fromEntries([...TABLES[table],...PROVENANCE].map((key)=>[key,remapped.row[key]??null]));
      if(stableStringify(actual)!==stableStringify(expectedRow))return{error:{field:'typed_round_trip',entity_type:table,source_key:row.source_key}};
      const digestRow={entity_type:table,row:Object.fromEntries([...TABLES[table],'source_name','source_row','source_key','source_payload_hash'].map((key)=>[key,row[key]??null]))};
      digestRows.push(digestRow);entityRows.push(digestRow);
    }
    entityDigests[table]=await sha256Hex(stableStringify(entityRows));
    try{
      if(table==='credits')for(const row of rows){amounts.credit_amount_cents=safeAdd(amounts.credit_amount_cents,row.original_amount_cents);amounts.credit_paid_cents=safeAdd(amounts.credit_paid_cents,row.import_paid_cents);amounts.credit_balance_cents=safeAdd(amounts.credit_balance_cents,row.opening_balance_cents);}
      if(table==='credit_payments')for(const row of rows)amounts.payment_amount_cents=safeAdd(amounts.payment_amount_cents,row.amount_cents);
    }catch{return{error:{field:'unsafe_sum'}};}
  }
  const a3=await zeroTraffic(db); Object.assign(counts,{sales:a3.sales,sale_items:a3.sale_items,cash_movements:a3.cash_movements,inventory_movements:a3.inventory_movements,expenses:0,cash_closures:0});
  const known=(await db.prepare('SELECT COUNT(*) AS count FROM credit_payments WHERE promotion_id=?1 AND payment_date_known=1').bind(promotionId).first()).count;
  const unknown=counts.credit_payments-Number(known);
  const expected={...counts,...amounts,sales_total_cents:0,known_payment_dates:Number(known),unknown_payment_dates:unknown};
  for(const [key,value] of Object.entries(baseline))if(expected[key]!==value)return{error:{field:key,expected:value,actual:expected[key]}};
  const staged=await db.prepare(`SELECT COUNT(*) AS count FROM import_staging WHERE import_id=?1 AND validation_status='VALID'`).bind(importId).first();
  let expectedTotal,actualTotal;
  try{expectedTotal=Object.keys(TABLES).reduce((sum,key)=>safeAdd(sum,baseline[key]),0);actualTotal=Object.keys(TABLES).reduce((sum,key)=>safeAdd(sum,counts[key]),0);}catch{return{error:{field:'unsafe_count'}};}
  if(sourceByIdentity.size||Number(staged.count)!==expectedTotal||actualTotal!==expectedTotal)return{error:{field:'bijection',expected:expectedTotal,actual:Number(staged.count)}};
  const orphan=await db.prepare(`SELECT (SELECT COUNT(*) FROM credits c LEFT JOIN customers u ON u.promotion_id=c.promotion_id AND u.customer_id=c.customer_id WHERE c.promotion_id=?1 AND u.customer_id IS NULL)+(SELECT COUNT(*) FROM credit_payments p LEFT JOIN credits c ON c.promotion_id=p.promotion_id AND c.credit_id=p.credit_id WHERE p.promotion_id=?1 AND c.credit_id IS NULL) AS count`).bind(promotionId).first();
  if(Number(orphan.count))return{error:{field:'foreign_keys',actual:Number(orphan.count)}};
  const sums=await db.prepare(`SELECT COUNT(*) AS count FROM credits c WHERE c.promotion_id=?1 AND c.import_paid_cents<>(SELECT COALESCE(SUM(p.amount_cents),0) FROM credit_payments p WHERE p.promotion_id=c.promotion_id AND p.credit_id=c.credit_id)`).bind(promotionId).first();
  if(Number(sums.count))return{error:{field:'credit_payment_sums',actual:Number(sums.count)}};
  const customerSums=await db.prepare(`SELECT COUNT(*) AS count FROM customers u WHERE u.promotion_id=?1 AND (u.source_document_balance_cents IS NOT NULL AND u.source_document_balance_cents<>(SELECT COALESCE(SUM(c.opening_balance_cents),0) FROM credits c WHERE c.promotion_id=u.promotion_id AND c.customer_id=u.customer_id) OR u.source_historical_credit_cents IS NOT NULL AND u.source_historical_credit_cents<>(SELECT COALESCE(SUM(c.original_amount_cents),0) FROM credits c WHERE c.promotion_id=u.promotion_id AND c.customer_id=u.customer_id) OR u.source_historical_paid_cents IS NOT NULL AND u.source_historical_paid_cents<>(SELECT COALESCE(SUM(c.import_paid_cents),0) FROM credits c WHERE c.promotion_id=u.promotion_id AND c.customer_id=u.customer_id))`).bind(promotionId).first();
  if(Number(customerSums.count))return{error:{field:'customer_source_sums',actual:Number(customerSums.count)}};
  const customerById=new Map(canonical.customers.map((row)=>[row.customer_id,row]));
  const creditById=new Map(canonical.credits.map((row)=>[row.credit_id,row]));
  const creditsByCustomer=new Map(),paymentsByCredit=new Map();
  for(const credit of canonical.credits){const list=creditsByCustomer.get(credit.customer_id)??[];list.push(credit);creditsByCustomer.set(credit.customer_id,list);}
  for(const payment of canonical.credit_payments){const list=paymentsByCredit.get(payment.credit_id)??[];list.push(payment);paymentsByCredit.set(payment.credit_id,list);}
  try{
    for(const customer of canonical.customers){
      const credits=creditsByCustomer.get(customer.customer_id)??[],pending=credits.filter((credit)=>Number(credit.opening_balance_cents)>0);
      const paid=credits.filter((credit)=>Number(credit.opening_balance_cents)===0);
      const values={source_documents_total:credits.length,source_documents_pending:pending.length,source_documents_paid:paid.length,
        source_payment_count:credits.reduce((sum,credit)=>safeAdd(sum,(paymentsByCredit.get(credit.credit_id)??[]).length),0),
        source_pending_original_cents:pending.reduce((sum,credit)=>safeAdd(sum,credit.original_amount_cents),0),
        source_pending_paid_cents:pending.reduce((sum,credit)=>safeAdd(sum,credit.import_paid_cents),0),
        source_historical_credit_cents:credits.reduce((sum,credit)=>safeAdd(sum,credit.original_amount_cents),0),
        source_historical_paid_cents:credits.reduce((sum,credit)=>safeAdd(sum,credit.import_paid_cents),0)};
      if(customer.source_image_balance_cents!==null&&customer.source_document_balance_cents!==null&&customer.source_difference_cents!==null&&
        safeAdd(customer.source_document_balance_cents,customer.source_difference_cents)!==Number(customer.source_image_balance_cents))return{error:{field:'customer_balance_sources',customer_id:customer.customer_id}};
      for(const [field,value] of Object.entries(values))if(customer[field]!==null&&Number(customer[field])!==value)return{error:{field,customer_id:customer.customer_id,expected:customer[field],actual:value}};
      if(!ratioMatches(customer.source_pending_progress_ratio,values.source_pending_paid_cents,values.source_pending_original_cents))return{error:{field:'customer_pending_progress',customer_id:customer.customer_id}};
    }
    for(const credit of canonical.credits){
      const customer=customerById.get(credit.customer_id),payments=paymentsByCredit.get(credit.credit_id)??[];
      for(const [creditField,customerField] of [['source_customer_image_balance_cents','source_image_balance_cents'],['source_customer_document_balance_cents','source_document_balance_cents'],['source_customer_difference_cents','source_difference_cents']]){
        if(credit[creditField]!==null&&(customer[customerField]===null||Number(credit[creditField])!==Number(customer[customerField])))return{error:{field:creditField,credit_id:credit.credit_id}};
      }
      if(credit.source_payment_count!==null&&Number(credit.source_payment_count)!==payments.length)return{error:{field:'credit_payment_count',credit_id:credit.credit_id}};
      if(!ratioMatches(credit.source_progress_ratio,credit.import_paid_cents,credit.original_amount_cents))return{error:{field:'credit_progress',credit_id:credit.credit_id}};
    }
    for(const [creditId,payments] of paymentsByCredit){
      const credit=creditById.get(creditId),customer=customerById.get(credit.customer_id);
      for(const payment of payments){
        if(payment.source_credit_original_cents!==null&&Number(payment.source_credit_original_cents)!==Number(credit.original_amount_cents))return{error:{field:'payment_credit_original',payment_id:payment.payment_id}};
        if(payment.source_current_document_balance_cents!==null&&Number(payment.source_current_document_balance_cents)!==Number(credit.opening_balance_cents))return{error:{field:'payment_current_balance',payment_id:payment.payment_id}};
        if(payment.source_customer_document!==null&&payment.source_customer_document!==customer.document)return{error:{field:'payment_customer_document',payment_id:payment.payment_id}};
        if(payment.source_customer_name!==null&&payment.source_customer_name!==customer.name)return{error:{field:'payment_customer_name',payment_id:payment.payment_id}};
      }
      const sequences=payments.filter((payment)=>payment.source_sequence!==null).map((payment)=>Number(payment.source_sequence));
      if(new Set(sequences).size!==sequences.length||sequences.some((sequence)=>!Number.isSafeInteger(sequence)||sequence<1))return{error:{field:'payment_sequence',credit_id:creditId}};
      if(payments.every((payment)=>payment.source_sequence!==null)){
        const ordered=[...payments].sort((a,b)=>Number(a.source_sequence)-Number(b.source_sequence));
        if(new Set(ordered.map((payment)=>Number(payment.source_sequence))).size!==ordered.length||ordered.some((payment)=>Number(payment.source_sequence)<1))return{error:{field:'payment_sequence',credit_id:creditId}};
        let cumulative=0;
        for(const payment of ordered){
          cumulative=safeAdd(cumulative,payment.amount_cents);
          if(payment.source_cumulative_paid_cents!==null&&Number(payment.source_cumulative_paid_cents)!==cumulative)return{error:{field:'payment_cumulative',payment_id:payment.payment_id}};
          if(payment.source_balance_after_cents!==null&&Number(payment.source_balance_after_cents)!==Number(credit.original_amount_cents)-cumulative)return{error:{field:'payment_balance_after',payment_id:payment.payment_id}};
          if(!ratioMatches(payment.source_progress_ratio,cumulative,credit.original_amount_cents))return{error:{field:'payment_cumulative_progress',payment_id:payment.payment_id}};
        }
      }
    }
  }catch{return{error:{field:'unsafe_sum'}};}
  return{counts,amounts,entityDigests,digest:await sha256Hex(stableStringify(digestRows))};
}

function safeAdd(left,right){if(!Number.isSafeInteger(left)||!Number.isSafeInteger(right))throw new Error('unsafe_sum');const value=left+right;if(!Number.isSafeInteger(value))throw new Error('unsafe_sum');return value;}
function ratioMatches(value,paid,original){
  if(value===null)return true;
  const expected=original===0?0:paid/original;
  // XLSX ratios are binary REALs calculated from currency-unit doubles, not cents.
  // Allow only their floating arithmetic error; monetary comparisons remain exact.
  return Number.isFinite(value)&&value>=0&&value<=1&&Math.abs(value-expected)<=8*Number.EPSILON;
}

async function rollback(body,deviceId,credentialHash,manifest,db,json){
  if(!plainExact(body,['operation_id','promotion_id','expected_control_revision'])||!validId(body.operation_id)||!validId(body.promotion_id)||!Number.isSafeInteger(body.expected_control_revision))return json({error:'invalid_rollback_request'},400);
  const requestHash=await sha256Hex(stableStringify({ ...body,operational_manifest_hash:await sha256Hex(stableStringify(manifest)) }));const replay=await receiptReplay(db,body.operation_id,requestHash,json);if(replay)return replay;
  const p=await db.prepare('SELECT * FROM canonical_promotions WHERE promotion_id=?1').bind(body.promotion_id).first();if(!p)return json({error:'promotion_not_found'},404);
  if(!['PREPARED','COMMITTED'].includes(p.status)||p.device_id!==deviceId||p.operational_manifest_json!==stableStringify(manifest))return json({error:'rollback_conflict'},409);
  const counts=await zeroTraffic(db);if(Object.values(counts).some(Number))return json({error:'rollback_has_effects',counts},409);
  const restoreMode=p.previous_mode==='CANONICAL_READ_ONLY'?'CANONICAL_READ_ONLY':'FROZEN';
  const before=await control(db);if(!before||Number(before.revision)!==body.expected_control_revision)return json({error:'rollback_conflict'},409);
  const result={status:'ROLLED_BACK',operation_id:body.operation_id,promotion_id:body.promotion_id,mode:restoreMode,active_promotion_id:p.previous_promotion_id??null,write_permission_restored:false,revision:body.expected_control_revision+1,authority_epoch:Number(before.authority_epoch)+1};
  const assertion=`rollback:${crypto.randomUUID()}`;
  const statements=[db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok) SELECT ?1,CASE WHEN EXISTS(
    SELECT 1 FROM canonical_control c JOIN devices d ON d.device_id=?2 JOIN canonical_promotions p ON p.promotion_id=?3
    WHERE c.id=1 AND c.revision=?4 AND c.first_live_operation_id IS NULL AND c.writer_device_id=?2 AND p.device_id=?2
    AND d.role='writer' AND d.status='active' AND d.credential_hash=?5 AND p.status=?6
    AND ((p.status='COMMITTED' AND c.mode='CANONICAL_READ_ONLY' AND c.active_promotion_id=p.promotion_id) OR
         (p.status='PREPARED' AND c.mode='FROZEN' AND p.control_revision=c.revision AND c.active_promotion_id IS p.previous_promotion_id))
    AND (p.previous_promotion_id IS NULL AND p.previous_mode='FROZEN' OR p.previous_mode='CANONICAL_READ_ONLY' AND EXISTS(
         SELECT 1 FROM canonical_promotions prior WHERE prior.promotion_id=p.previous_promotion_id AND prior.status='COMMITTED')))
    AND NOT EXISTS(SELECT 1 FROM sales UNION ALL SELECT 1 FROM sale_items UNION ALL SELECT 1 FROM cash_movements UNION ALL SELECT 1 FROM inventory_movements UNION ALL SELECT 1 FROM sync_operations)
    THEN 1 ELSE 0 END`).bind(assertion,deviceId,body.promotion_id,body.expected_control_revision,credentialHash,p.status),
    db.prepare(`UPDATE canonical_control SET mode=?1,active_promotion_id=?2,revision=revision+1,authority_epoch=authority_epoch+1 WHERE id=1 AND revision=?3 AND EXISTS(SELECT 1 FROM canonical_assertions WHERE assertion_id=?4)`).bind(restoreMode,p.previous_promotion_id??null,body.expected_control_revision,assertion),
    assertChanged(db,`${assertion}:control`),
    db.prepare(`UPDATE canonical_promotions SET status='ABANDONED' WHERE promotion_id=?1 AND status=?3 AND EXISTS(SELECT 1 FROM canonical_assertions WHERE assertion_id=?2)`).bind(body.promotion_id,assertion,p.status),
    assertChanged(db,`${assertion}:promotion`),
    db.prepare(`INSERT INTO canonical_command_receipts(operation_id,command,request_hash,result_json) SELECT ?1,'rollback',?2,?3 WHERE EXISTS(SELECT 1 FROM canonical_assertions WHERE assertion_id=?4)`).bind(body.operation_id,requestHash,stableStringify(result),assertion),
    db.prepare('DELETE FROM canonical_assertions WHERE assertion_id IN (?1,?2,?3)').bind(assertion,`${assertion}:control`,`${assertion}:promotion`)];
  try{const out=await db.batch(statements);if(out.slice(0,6).some((r)=>r.meta?.changes!==1))throw new Error('guard');}catch{return(await receiptReplay(db,body.operation_id,requestHash,json))||json({error:'rollback_conflict'},409);}
  return json(result,201);
}

export async function canonicalRead(url,db,json,options={}){
  const type=url.pathname.slice('/read/canonical/'.length);if(!READ_TABLES.has(type)&&type!=='status'&&type!=='snapshot')return json({error:'not_found'},404);
  // Subrequest budget: with Turso every statement is one external fetch, so the
  // read plan probes the schema once and reads authority in one statement.
  const plan=await readPlan(db,options);
  const initial=plan.schema?await plan.current():await control(db);if(!initial||!['CANONICAL_READ_ONLY','ACTIVE'].includes(initial.mode)||!initial.active_promotion_id)return json({error:'canonical_not_published'},409);
  const before=plan.schema?initial:initial.mode==='ACTIVE'?await readControl(db):initial;
  if(!sameControl({...initial,financial_revision:before?.financial_revision},before))return json({error:'authority_changed'},409);
  if(['cash-sessions','financial-events'].includes(type)&&before.mode!=='ACTIVE')return json({error:'canonical_not_active'},409);
  // FASE7 LAB: additive bulk snapshot under ONE financial_revision fence.
  if(type==='snapshot')return canonicalSnapshot(db,json,before,plan);
  if(type==='status'){
    const counts=await statusCounts(db,before,plan.schema);
    const after=await plan.current();
    if(!sameControl(before,after))return json({error:'authority_changed'},409);return json({...readMeta(before),counts,page_limit_max:CANONICAL_READ_PAGE_MAX});
  }
  const page=parsePage(url.searchParams,before);if(page.error)return json({error:page.error},400);
  const sqlName=type.replaceAll('-','_');
  const rows=await loadCollectionRows(db,type,before,page,plan.schema);
  const after=await plan.current();
  if(!sameControl(before,after))return json({error:'authority_changed'},409);
  const source=rows.results??[],selected=source.slice(0,page.limit),last=selected.at(-1);let lastKey=null;if(last)lastKey=last.read_key??(sqlName==='sale_items'?`${last.sale_id}\0${String(last.line_number).padStart(20,'0')}`:last[TABLES[sqlName]?.[0]??(sqlName==='sales'?'sale_id':'movement_id')]);
  for(const item of selected){
    delete item.read_key;
    // Preserve the imported read shape; only LIVE entries carry ledger metadata.
    if(sqlName==='credit_payments'&&item.provenance==='IMPORT')for(const field of ['provenance','operation_id','credit_provenance','credit_delta_cents','cash_delta_cents','session_id','reason','compensates_operation_id'])delete item[field];
  }
  return json({...readMeta(before),items:selected,next_cursor:source.length>page.limit?encodeCursor({promotion_id:before.active_promotion_id,authority_epoch:Number(before.authority_epoch),revision:Number(before.revision),...(before.mode==='ACTIVE'?{financial_revision:before.financial_revision}:{}),key:lastKey}):null,limit:page.limit});
}

async function loadCollectionRows(db,type,before,page,schema=null){
  const sqlName=type.replaceAll('-','_');let rows;
  if(sqlName==='products'&&before.mode==='ACTIVE'&&await liveProductSchemaAvailable(db,schema)){
    rows=await db.prepare(`SELECT * FROM (
      SELECT 'I:' || product_id AS read_key,${TABLES.products.join(',')},'IMPORT' AS provenance,NULL AS operation_id,NULL AS created_at
        FROM products WHERE promotion_id=?1
      UNION ALL
      SELECT 'L:' || product_id AS read_key,${TABLES.products.join(',')},'LIVE' AS provenance,operation_id,created_at
        FROM canonical_live_products WHERE promotion_id=?1
    ) WHERE read_key>?2 ORDER BY read_key LIMIT ?3`).bind(before.active_promotion_id,page.key,page.limit+1).all();
  } else if(sqlName==='customers'&&before.mode==='ACTIVE'&&await customerSchemaAvailable(db,schema)){
    const liveCustomerFields={customer_id:'l.customer_id',name:'l.name',document:'l.document',phone:'l.phone',address:'l.address',color:'l.color',total_purchases_cents:'l.total_purchases_cents'};
    const policyReady=await customerCreditPolicySchemaAvailable(db,schema);
    if(policyReady){
      const policyColumns=`p.mode AS credit_policy_mode,p.manual_limit_cents AS credit_policy_manual_limit_cents,
        p.reason AS credit_policy_reason,p.administrator_id AS credit_policy_administrator_id,
        p.administrator_name AS credit_policy_administrator_name,p.updated_at AS credit_policy_updated_at,
        p.revision AS credit_policy_revision`;
      rows=await db.prepare(`SELECT * FROM (
        SELECT 'I:' || c.customer_id AS read_key,${TABLES.customers.map(column=>`c.${column}`).join(',')},'IMPORT' AS provenance,NULL AS operation_id,NULL AS created_at,${policyColumns}
          FROM customers c LEFT JOIN canonical_customer_credit_policies p
            ON p.promotion_id=c.promotion_id AND p.customer_id=c.customer_id
          WHERE c.promotion_id=?1
        UNION ALL
        SELECT 'L:' || l.customer_id AS read_key,${TABLES.customers.map(column=>liveCustomerFields[column]??'NULL').join(',')},'LIVE' AS provenance,l.operation_id,l.created_at,${policyColumns}
          FROM canonical_live_customers l LEFT JOIN canonical_customer_credit_policies p
            ON p.promotion_id=l.promotion_id AND p.customer_id=l.customer_id
          WHERE l.promotion_id=?1
      ) WHERE read_key>?2 ORDER BY read_key LIMIT ?3`).bind(before.active_promotion_id,page.key,page.limit+1).all();
    }else{
      rows=await db.prepare(`SELECT * FROM (
        SELECT 'I:' || customer_id AS read_key,${TABLES.customers.join(',')},'IMPORT' AS provenance,NULL AS operation_id,NULL AS created_at
          FROM customers WHERE promotion_id=?1
        UNION ALL
        SELECT 'L:' || customer_id AS read_key,${TABLES.customers.map(column=>liveCustomerFields[column]?.replace(/^l\./,'')??'NULL').join(',')},'LIVE' AS provenance,operation_id,created_at
          FROM canonical_live_customers WHERE promotion_id=?1
      ) WHERE read_key>?2 ORDER BY read_key LIMIT ?3`).bind(before.active_promotion_id,page.key,page.limit+1).all();
    }
  } else if(sqlName==='credit_accounts'){
    rows=before.mode==='ACTIVE'
      ? await db.prepare(`SELECT customer_id || char(0) || account_id AS read_key,customer_id,account_id,name,mode,created_at
          FROM canonical_credit_accounts WHERE promotion_id=?1 AND customer_id || char(0) || account_id>?2
          ORDER BY customer_id,account_id LIMIT ?3`).bind(before.active_promotion_id,page.key,page.limit+1).all()
      : {results:[]};
  } else if(sqlName==='credits'&&before.mode==='ACTIVE'){
    const reconciliationReady=await debtReconciliationSchemaAvailable(db,schema);
    const importFields=TABLES.credits.map(column=>{
      if(column==='current_balance_cents')return'b.current_balance_cents AS current_balance_cents';
      if(column==='opening_balance_cents')return reconciliationReady?'b.opening_balance_cents AS opening_balance_cents':'c.opening_balance_cents';
      if(column==='original_amount_cents')return reconciliationReady?'c.original_amount_cents+b.baseline_delta_cents AS original_amount_cents':'c.original_amount_cents';
      return `c.${column}`;
    });
    const liveFields={
      credit_id:'l.credit_id',customer_id:'l.customer_id',sale_id:'l.sale_id',issued_value:'l.created_at',due_value:'l.due_date',
      original_amount_cents:reconciliationReady?'l.original_amount_cents+b.baseline_delta_cents':'l.original_amount_cents',
      import_paid_cents:'0',
      opening_balance_cents:reconciliationReady?'b.opening_balance_cents':'l.original_amount_cents',
      current_balance_cents:'b.current_balance_cents',source_status:'NULL'
    };
    const reconciliationFields={
      credit_id:'r.credit_id',customer_id:'r.customer_id',sale_id:'NULL',store:"'RECONCILIACION'",document_number:'NULL',
      reference:'r.reconciliation_id',concept:"'Saldo conciliado CasaMarket'",seller:'NULL',issued_value:'r.created_at',due_value:'NULL',
      term_days:'NULL',original_amount_cents:'r.original_amount_cents',import_paid_cents:'0',
      opening_balance_cents:'b.opening_balance_cents',current_balance_cents:'b.current_balance_cents',
      source_progress_ratio:'0',source_payment_count:'0',source_days_until_due:'NULL',source_status:"'vigente'",
      source_customer_image_balance_cents:'NULL',source_customer_document_balance_cents:'NULL',source_customer_difference_cents:'NULL'
    };
    const installmentJson=(alias,provenance)=>`(SELECT COALESCE(json_group_array(json_object('number',ci.installment_number,'due_date',ci.due_date,'amount_cents',ci.amount_cents)),'[]')
      FROM canonical_credit_installments ci WHERE ci.promotion_id=${alias}.promotion_id AND ci.credit_id=${alias}.credit_id AND ci.credit_provenance='${provenance}'
      ORDER BY ci.installment_number)`;
    const reconciliationUnion=reconciliationReady?`
      UNION ALL
      SELECT 'R:' || r.credit_id AS read_key,${TABLES.credits.map(column=>reconciliationFields[column]??'NULL').join(',')},
        'IMPORT' AS provenance,NULL AS operation_id,'RECONCILED' AS status,b.revision AS revision,r.created_at AS created_at,NULL AS due_date,
        NULL AS account_id,NULL AS account_name,NULL AS account_mode,'[]' AS installments_json
      FROM canonical_reconciliation_credits r
      JOIN canonical_credit_balances b ON b.promotion_id=r.promotion_id AND b.credit_id=r.credit_id AND b.provenance='IMPORT'
      WHERE r.promotion_id=?1`:'';
    rows=await db.prepare(`SELECT * FROM (
      SELECT 'I:' || c.credit_id AS read_key,${importFields.join(',')},
        'IMPORT' AS provenance,NULL AS operation_id,NULL AS status,b.revision AS revision,NULL AS created_at,NULL AS due_date,
        m.account_id,m.account_name,m.account_mode,${installmentJson('c','IMPORT')} AS installments_json
      FROM credits c JOIN canonical_credit_balances b ON b.promotion_id=c.promotion_id AND b.credit_id=c.credit_id AND b.provenance='IMPORT'
      LEFT JOIN canonical_credit_metadata m ON m.promotion_id=c.promotion_id AND m.credit_id=c.credit_id AND m.credit_provenance='IMPORT'
      WHERE c.promotion_id=?1
      UNION ALL
      SELECT 'L:' || l.credit_id AS read_key,${TABLES.credits.map(column=>liveFields[column]??'NULL').join(',')},
        'LIVE',l.operation_id,l.status,b.revision,l.created_at,l.due_date,
        m.account_id,m.account_name,m.account_mode,${installmentJson('l','LIVE')} AS installments_json
      FROM live_credits l JOIN canonical_credit_balances b ON b.promotion_id=l.promotion_id AND b.credit_id=l.credit_id AND b.provenance='LIVE'
      LEFT JOIN canonical_credit_metadata m ON m.promotion_id=l.promotion_id AND m.credit_id=l.credit_id AND m.credit_provenance='LIVE'
      WHERE l.promotion_id=?1
      ${reconciliationUnion}
    ) WHERE read_key>?2 ORDER BY read_key LIMIT ?3`).bind(before.active_promotion_id,page.key,page.limit+1).all();
  } else if(sqlName==='credit_payments'&&before.mode==='ACTIVE'){
    const fields={payment_id:'event_id',credit_id:'credit_id',amount_cents:'-credit_delta_cents',payment_date:'substr(created_at,1,10)',payment_timestamp:'created_at',payment_date_known:'1',date_precision:"'TIMESTAMP'",method:'payment_method',source_origin:"'LIVE'",source_operation_reference:'reference',source_balance_after_cents:"(SELECT CAST(json_extract(o.result_json,'$.current_balance_cents') AS INTEGER) FROM canonical_financial_operations o WHERE o.operation_id=canonical_financial_events.operation_id)"};
    rows=await db.prepare(`SELECT * FROM (SELECT 'I:' || payment_id AS read_key,${TABLES.credit_payments.join(',')},'IMPORT' AS provenance,NULL AS operation_id,NULL AS credit_provenance,NULL AS credit_delta_cents,NULL AS cash_delta_cents,NULL AS session_id,NULL AS reason,NULL AS compensates_operation_id FROM credit_payments WHERE promotion_id=?1 UNION ALL
      SELECT 'L:' || event_id AS read_key,${TABLES.credit_payments.map(c=>fields[c]??'NULL').join(',')},'LIVE',operation_id,credit_provenance,credit_delta_cents,cash_delta_cents,session_id,reason,compensates_operation_id FROM canonical_financial_events WHERE promotion_id=?1 AND credit_id IS NOT NULL)
      WHERE read_key>?2 ORDER BY read_key LIMIT ?3`).bind(before.active_promotion_id,page.key,page.limit+1).all();
  } else if(sqlName==='expenses'){
    const expenseReady=await expenseLedgerAvailable(db,schema);
    rows=before.mode==='ACTIVE'&&expenseReady
      ? await db.prepare(`SELECT expense_id AS read_key,expense_id,operation_id,promotion_id,session_id,amount_cents,cash_delta_cents,
          concept,category,payment_method,expense_date,note,created_at
          FROM canonical_expenses WHERE promotion_id=?1 AND expense_id>?2 ORDER BY expense_id LIMIT ?3`)
          .bind(before.active_promotion_id,page.key,page.limit+1).all()
      : {results:[]};
  } else if(sqlName==='cash_sessions'){
    rows=await db.prepare(`SELECT session_id AS read_key,session_id,promotion_id,open_operation_id,opening_cents,cash_movement_watermark,opened_at,status,
      close_operation_id,expected_cents,counted_cents,difference_cents,closing_watermark,closed_at,revision FROM canonical_cash_state
      WHERE promotion_id=?1 AND session_id>?2 ORDER BY session_id LIMIT ?3`).bind(before.active_promotion_id,page.key,page.limit+1).all();
  } else if(sqlName==='financial_events'){
    rows=await db.prepare(`SELECT event_id AS read_key,event_id,operation_id,promotion_id,event_type,session_id,credit_id,credit_provenance,
      credit_delta_cents,cash_delta_cents,payment_method,reference,reason,compensates_operation_id,created_at FROM canonical_financial_events
      WHERE promotion_id=?1 AND event_id>?2 ORDER BY event_id LIMIT ?3`).bind(before.active_promotion_id,page.key,page.limit+1).all();
  } else if(sqlName==='sale_items'&&before.mode==='ACTIVE'&&await genericSaleSchemaAvailable(db,schema)){
    const keyExpr="r.sale_id || char(0) || printf('%020d',r.line_number)";
    rows=await db.prepare(`SELECT ${keyExpr} AS read_key,
      r.sale_id,r.line_number,r.operation_id,r.product_id,r.quantity,r.unit_price_cents,r.line_total_cents,r.created_at,
      CASE WHEN g.sale_id IS NULL THEN 'PRODUCT' ELSE 'GENERIC' END AS line_type,
      g.name AS generic_name,g.code AS generic_code
      FROM canonical_sale_context x
      JOIN sale_items r ON r.sale_id=x.sale_id
      LEFT JOIN canonical_generic_sale_lines g
        ON g.sale_id=r.sale_id AND g.line_number=r.line_number AND g.operation_id=r.operation_id
      WHERE x.promotion_id=?1 AND ${keyExpr}>?2
      ORDER BY r.sale_id,r.line_number LIMIT ?3`)
      .bind(before.active_promotion_id,page.key,page.limit+1).all();
  } else if(sqlName==='inventory_movements'&&before.mode==='ACTIVE'){
    const liveProductsReady=await liveProductSchemaAvailable(db,schema);
    const inventoryAdjustReady=await inventoryLedgerAvailable(db,schema);
    if(inventoryAdjustReady){
      const saleEffects=liveProductsReady
        ?`SELECT movement_id,promotion_id FROM canonical_inventory_effects
           UNION ALL SELECT movement_id,promotion_id FROM canonical_live_inventory_effects`
        :`SELECT movement_id,promotion_id FROM canonical_inventory_effects`;
      rows=await db.prepare(`SELECT read_key,movement_id,operation_id,sale_id,line_number,product_id,quantity,created_at,movement_type,reason,movement_source
        FROM (
          SELECT 'S:' || r.movement_id AS read_key,r.movement_id,r.operation_id,r.sale_id,r.line_number,r.product_id,r.quantity,r.created_at,
            'SALE' AS movement_type,NULL AS reason,'SALE' AS movement_source,x.promotion_id
          FROM (${saleEffects}) x JOIN inventory_movements r ON r.movement_id=x.movement_id
          UNION ALL
          SELECT 'M:' || m.movement_id,m.movement_id,m.operation_id,NULL,NULL,m.product_id,m.delta,m.created_at,
            m.movement_type,m.reason,'MANUAL',m.promotion_id
          FROM canonical_manual_inventory_movements m
        ) WHERE promotion_id=?1 AND read_key>?2 ORDER BY read_key LIMIT ?3`)
        .bind(before.active_promotion_id,page.key,page.limit+1).all();
    }else{
      const join=liveProductsReady?`(
        SELECT movement_id,promotion_id FROM canonical_inventory_effects
        UNION ALL SELECT movement_id,promotion_id FROM canonical_live_inventory_effects
      ) x JOIN inventory_movements r ON r.movement_id=x.movement_id`:'canonical_inventory_effects x JOIN inventory_movements r ON r.movement_id=x.movement_id';
      rows=await db.prepare(`SELECT r.movement_id AS read_key,r.movement_id,r.operation_id,r.sale_id,r.line_number,r.product_id,r.quantity,r.created_at,
        'SALE' AS movement_type,NULL AS reason,'SALE' AS movement_source FROM ${join}
        WHERE x.promotion_id=?1 AND r.movement_id>?2 ORDER BY r.movement_id LIMIT ?3`)
        .bind(before.active_promotion_id,page.key,page.limit+1).all();
    }
  } else if(TABLES[sqlName]){const key=TABLES[sqlName][0];rows=await db.prepare(`SELECT ${TABLES[sqlName].join(',')} FROM ${sqlName} WHERE promotion_id=?1 AND ${key}>?2 ORDER BY ${key} LIMIT ?3`).bind(before.active_promotion_id,page.key,page.limit+1).all();}
  else if(before.mode==='ACTIVE'){
    const key=sqlName==='sale_items'?"r.sale_id || char(0) || printf('%020d',r.line_number)":sqlName==='sales'?'r.sale_id':'r.movement_id';
    const liveProductsReady=sqlName==='inventory_movements'?await liveProductSchemaAvailable(db,schema):false;
    const join=sqlName==='inventory_movements'?(liveProductsReady?`(
      SELECT movement_id,promotion_id FROM canonical_inventory_effects
      UNION ALL SELECT movement_id,promotion_id FROM canonical_live_inventory_effects
    ) x JOIN inventory_movements r ON r.movement_id=x.movement_id`:'canonical_inventory_effects x JOIN inventory_movements r ON r.movement_id=x.movement_id'):'canonical_sale_context x JOIN '+sqlName+' r ON r.sale_id=x.sale_id';
    const context=sqlName==='sales'?',x.customer_id,x.promotion_id,x.authority_epoch,x.control_revision,x.client_contract':'';
    const cashSession=sqlName==='cash_movements'?`,(SELECT s.session_id FROM canonical_cash_state s
      WHERE s.promotion_id=x.promotion_id AND r.rowid>s.cash_movement_watermark AND r.rowid<=s.closing_watermark
      ORDER BY s.opened_at DESC LIMIT 1) AS session_id`:'';
    rows=await db.prepare(`SELECT ${A3_PUBLIC_COLUMNS[sqlName].split(',').map(c=>'r.'+c).join(',')}${context}${cashSession} FROM ${join} WHERE x.promotion_id=?1 AND ${key}>?2 ORDER BY ${key} LIMIT ?3`).bind(before.active_promotion_id,page.key,page.limit+1).all();
  }
  else {const key=sqlName==='sale_items'?"sale_id || char(0) || printf('%020d',line_number)":sqlName==='sales'?'sale_id':'movement_id';rows=await db.prepare(`SELECT ${A3_PUBLIC_COLUMNS[sqlName]} FROM ${sqlName} WHERE ${key}>?1 ORDER BY ${key} LIMIT ?2`).bind(page.key,page.limit+1).all();}
  if(sqlName==='customers'&&before.mode==='ACTIVE'&&await customerContactSchemaAvailable(db,schema)){
    const selected=rows.results??[];
    if(selected.length){
      const ids=selected.map(item=>item.customer_id);
      // One JSON binding avoids D1's parameter limit on full customer pages.
      const edits=await db.prepare(`SELECT c.customer_id,c.name,c.phone,c.revision FROM canonical_customer_contacts c
        WHERE c.promotion_id=?1 AND c.customer_id IN (SELECT value FROM json_each(?2))
        AND c.revision=(SELECT MAX(e.revision) FROM canonical_customer_contacts e WHERE e.promotion_id=c.promotion_id AND e.customer_id=c.customer_id)`)
        .bind(before.active_promotion_id,JSON.stringify(ids)).all();
      const contacts=new Map((edits.results??[]).map(c=>[c.customer_id,c]));
      for(const row of selected){const contact=contacts.get(row.customer_id);if(contact){row.name=contact.name;row.phone=contact.phone;row.contact_revision=contact.revision;}}
    }
  }
  return rows||{results:[]};
}

// Exact set of the 12 current entity routes (kebab paths → snake payload keys).
const SNAPSHOT_COLLECTIONS=[
  ['products','products'],
  ['customers','customers'],
  ['credits','credits'],
  ['credit-payments','credit_payments'],
  ['credit-accounts','credit_accounts'],
  ['cash-sessions','cash_sessions'],
  ['financial-events','financial_events'],
  ['expenses','expenses'],
  ['sales','sales'],
  ['sale-items','sale_items'],
  ['inventory-movements','inventory_movements'],
  ['cash-movements','cash_movements'],
];

/**
 * LAB bulk snapshot: ONE financial_revision fence for meta + all 12 collections.
 * Control is captured by caller (before); we re-check after every page and at end.
 * Pagination: pages under the same fence until complete; lab dataset fits ≤100/page.
 * On mid-read drift → 409 entire response (ZERO partial payload).
 */
async function canonicalSnapshot(db,json,before,plan){
  if(!before||!['CANONICAL_READ_ONLY','ACTIVE'].includes(before.mode)||!before.active_promotion_id)return json({error:'canonical_not_published'},409);
  const payload={};
  for(const [type,key] of SNAPSHOT_COLLECTIONS){
    if(['cash-sessions','financial-events'].includes(type)&&before.mode!=='ACTIVE'){payload[key]=[];continue;}
    const items=[];
    let pageKey='';
    let pages=0;
    for(;;){
      pages+=1;
      if(pages>50)return json({error:'snapshot_pagination_overflow',collection:key},500);
      const page={limit:100,key:pageKey};
      const rows=await loadCollectionRows(db,type,before,page,plan.schema);
      const source=rows.results??[];
      const selected=source.slice(0,page.limit);
      const last=selected.at(-1);
      const sqlName=type.replaceAll('-','_');
      let lastKey=null;
      if(last)lastKey=last.read_key??(sqlName==='sale_items'?`${last.sale_id}\0${String(last.line_number).padStart(20,'0')}`:last[TABLES[sqlName]?.[0]??(sqlName==='sales'?'sale_id':'movement_id')]);
      for(const item of selected){
        delete item.read_key;
        if(sqlName==='credit_payments'&&item.provenance==='IMPORT')for(const field of ['provenance','operation_id','credit_provenance','credit_delta_cents','cash_delta_cents','session_id','reason','compensates_operation_id'])delete item[field];
      }
      items.push(...selected);
      const mid=await plan.current();
      if(!sameControl(before,mid))return json({error:'authority_changed'},409);
      if(source.length<=page.limit)break;
      if(lastKey==null)return json({error:'snapshot_pagination_key_missing',collection:key},500);
      pageKey=lastKey;
    }
    payload[key]=items;
  }
  const after=await plan.current();
  if(!sameControl(before,after))return json({error:'authority_changed'},409);
  // Flatten: meta + exact 12 keys (empty arrays never omitted). Additive lab endpoint.
  return json({...readMeta(before),lab_snapshot:true,...payload});
}

async function readProvenance(promotionId,url,db,json){
  if(!validId(promotionId))return json({error:'invalid_promotion_id'},400);const type=url.searchParams.get('entity_type');if(!Object.hasOwn(TABLES,type))return json({error:'invalid_entity_type'},400);
  const promotion=await db.prepare('SELECT status FROM canonical_promotions WHERE promotion_id=?1').bind(promotionId).first();if(!promotion)return json({error:'promotion_not_found'},404);
  const page=parseAdminPage(url.searchParams,promotionId,type);if(page.error)return json({error:page.error},400);
  const rows=await db.prepare(`SELECT ${PROVENANCE.join(',')} FROM ${type} WHERE promotion_id=?1 AND (source_name>?2 OR (source_name=?2 AND source_row>?3) OR (source_name=?2 AND source_row=?3 AND source_key>?4)) ORDER BY source_name,source_row,source_key LIMIT ?5`).bind(promotionId,page.name,page.row,page.key,page.limit+1).all();
  const source=rows.results??[],selected=source.slice(0,page.limit),last=selected.at(-1);return json({promotion_id:promotionId,status:promotion.status,entity_type:type,items:selected,next_cursor:source.length>page.limit?encodeCursor({promotion_id:promotionId,entity_type:type,name:last.source_name,row:Number(last.source_row),key:last.source_key}):null,limit:page.limit});
}

// Canonical collection pages may be larger than admin pages: fewer sequential round
// trips per reload with the same 5 Turso subrequests per request. 250 keeps the
// heaviest page (products) far from the Workers Free CPU limit (measured ~6.6 ms).
const CANONICAL_READ_PAGE_MAX=250;
function pageLimit(params,max=100){const raw=params.get('limit');if(raw!==null&&!/^\d+$/.test(raw))return null;const limit=raw===null?25:Number(raw);return Number.isSafeInteger(limit)&&limit>=1&&limit<=max?limit:null;}
function parsePage(params,controlRow){const limit=pageLimit(params,CANONICAL_READ_PAGE_MAX);if(limit===null)return{error:'invalid_limit'};const token=params.get('cursor');if(token===null)return{limit,key:''};try{const c=decodeCursor(token);if(c.promotion_id!==controlRow.active_promotion_id||c.authority_epoch!==Number(controlRow.authority_epoch)||c.revision!==Number(controlRow.revision)||(controlRow.mode==='ACTIVE'&&c.financial_revision!==controlRow.financial_revision)||typeof c.key!=='string'||c.key.length>512)return{error:'stale_cursor'};return{limit,key:c.key};}catch{return{error:'invalid_cursor'};}}
function parseAdminPage(params,promotionId,type){const limit=pageLimit(params);if(limit===null)return{error:'invalid_limit'};const token=params.get('cursor');if(token===null)return{limit,name:'',row:0,key:''};try{const c=decodeCursor(token);if(!plainExact(c,['promotion_id','entity_type','name','row','key'])||c.promotion_id!==promotionId||c.entity_type!==type||typeof c.name!=='string'||c.name.length>240||!Number.isSafeInteger(c.row)||c.row<1||typeof c.key!=='string'||c.key.length>240)throw new Error();return{limit,name:c.name,row:c.row,key:c.key};}catch{return{error:'invalid_cursor'};}}
function encodeCursor(value){const bytes=new TextEncoder().encode(JSON.stringify(value));let binary='';for(const b of bytes)binary+=String.fromCharCode(b);return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function decodeCursor(value){if(value.length>8192||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error();const s=value.replace(/-/g,'+').replace(/_/g,'/');return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s+'='.repeat((4-s.length%4)%4)),(c)=>c.charCodeAt(0))));}
async function control(db){return db.prepare('SELECT mode,active_promotion_id,revision,authority_epoch,minimum_client_contract,first_live_operation_id FROM canonical_control WHERE id=1').first();}
function sameControl(a,b){return b&&a.mode===b.mode&&a.active_promotion_id===b.active_promotion_id&&Number(a.revision)===Number(b.revision)&&Number(a.authority_epoch)===Number(b.authority_epoch)&&(a.mode!=='ACTIVE'||a.financial_revision===b.financial_revision);}
function readMeta(c){return{authority:'canonical',promotion_id:c.active_promotion_id,authority_epoch:Number(c.authority_epoch),revision:Number(c.revision),...(c.mode==='ACTIVE'?{financial_revision:c.financial_revision}:{}),read_only:c.mode!=='ACTIVE',mode:c.mode,minimum_client_contract:c.minimum_client_contract};}
// One SQL snapshot binds authority and the append-only commit count. Counts do
// not change on replay, and a rolled-back batch cannot advance the read version.
async function expenseLedgerAvailable(db,schema=null){
  if(schema)return hasAll(schema,EXPENSE_SCHEMA_TABLES);
  const row=await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='canonical_expenses'").first();
  return row?.ok===1;
}
async function expenseLedgerCount(db,promotionId){
  if(!promotionId||!await expenseLedgerAvailable(db))return 0;
  const row=await db.prepare('SELECT COUNT(*) AS count FROM canonical_expense_operations WHERE promotion_id=?1').bind(promotionId).first();
  return Number(row?.count)||0;
}
async function productLedgerAvailable(db){
  const row=await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='canonical_product_operations'").first();
  return row?.ok===1;
}
async function productLedgerCount(db,promotionId){
  if(!promotionId||!await productLedgerAvailable(db))return 0;
  const row=await db.prepare('SELECT COUNT(*) AS count FROM canonical_product_operations WHERE promotion_id=?1').bind(promotionId).first();
  return Number(row?.count)||0;
}
async function liveProductSchemaAvailable(db,schema=null){
  if(schema)return hasAll(schema,LIVE_PRODUCT_SCHEMA_TABLES);
  const row=await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type='table' AND name IN ('canonical_product_operations','canonical_live_products','canonical_live_inventory_effects')`).first();
  return Number(row?.count)===3;
}
async function inventoryLedgerAvailable(db,schema=null){
  if(schema)return hasAll(schema,INVENTORY_SCHEMA_TABLES);
  const row=await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type='table' AND name IN ('canonical_inventory_operations','canonical_manual_inventory_movements')`).first();
  return Number(row?.count)===2;
}
async function genericSaleSchemaAvailable(db,schema=null){
  if(schema)return hasAll(schema,GENERIC_SALE_SCHEMA_TABLES);
  const row=await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='canonical_generic_sale_lines'").first();
  return row?.ok===1;
}
async function inventoryLedgerCount(db,promotionId){
  if(!promotionId||!await inventoryLedgerAvailable(db))return 0;
  const row=await db.prepare('SELECT COUNT(*) AS count FROM canonical_inventory_operations WHERE promotion_id=?1').bind(promotionId).first();
  return Number(row?.count)||0;
}
async function customerSchemaAvailable(db,schema=null){
  if(schema)return hasAll(schema,CUSTOMER_SCHEMA_TABLES);
  const row=await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type='table' AND name IN ('canonical_customer_operations','canonical_customer_registry','canonical_live_customers')`).first();
  return Number(row?.count)===3;
}
async function customerLedgerCount(db,promotionId){
  if(!promotionId||!await customerSchemaAvailable(db))return 0;
  const row=await db.prepare('SELECT COUNT(*) AS count FROM canonical_customer_operations WHERE promotion_id=?1').bind(promotionId).first();
  return Number(row?.count)||0;
}
async function customerCreditPolicySchemaAvailable(db,schema=null){
  if(schema)return hasAll(schema,CREDIT_POLICY_SCHEMA_TABLES);
  const row=await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type='table' AND name IN ('canonical_customer_credit_policy_operations','canonical_customer_credit_policies')`).first();
  return Number(row?.count)===2;
}
async function customerCreditPolicyLedgerCount(db,promotionId){
  if(!promotionId||!await customerCreditPolicySchemaAvailable(db))return 0;
  const row=await db.prepare('SELECT COUNT(*) AS count FROM canonical_customer_credit_policy_operations WHERE promotion_id=?1').bind(promotionId).first();
  return Number(row?.count)||0;
}
async function debtReconciliationSchemaAvailable(db,schema=null){
  if(schema)return hasAll(schema,DEBT_RECONCILIATION_SCHEMA_TABLES);
  const row=await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type='table' AND name IN ('canonical_reconciliation_credits','canonical_credit_baseline_adjustments')`).first();
  return Number(row?.count)===2;
}
async function debtReconciliationLedgerCount(db,promotionId){
  if(!promotionId||!await debtReconciliationSchemaAvailable(db))return 0;
  const row=await db.prepare(`SELECT
    (SELECT COUNT(*) FROM canonical_reconciliation_credits WHERE promotion_id=?1)+
    (SELECT COUNT(*) FROM canonical_credit_baseline_adjustments WHERE promotion_id=?1) AS count`).bind(promotionId).first();
  return Number(row?.count)||0;
}
async function customerContactSchemaAvailable(db,schema=null){
  if(schema)return hasAll(schema,CUSTOMER_CONTACT_SCHEMA_TABLES);
  const row=await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='canonical_customer_contacts'").first();return Number(row?.n)===1;
}
async function customerContactLedgerCount(db,promotionId){
  if(!promotionId||!await customerContactSchemaAvailable(db))return 0;
  const row=await db.prepare('SELECT COUNT(*) n FROM canonical_customer_contacts WHERE promotion_id=?1').bind(promotionId).first();return Number(row?.n)||0;
}
async function readControl(db){
  const row=await db.prepare(`SELECT c.mode,c.active_promotion_id,c.revision,c.authority_epoch,
    c.minimum_client_contract,c.first_live_operation_id,CASE WHEN c.mode='ACTIVE' THEN
    (SELECT COUNT(*) FROM canonical_sale_context WHERE promotion_id=c.active_promotion_id)+
    (SELECT COUNT(*) FROM canonical_financial_operations WHERE promotion_id=c.active_promotion_id)
    ELSE NULL END AS financial_revision FROM canonical_control c WHERE c.id=1`).first();
  if(row?.mode==='ACTIVE')row.financial_revision=Number(row.financial_revision)+await expenseLedgerCount(db,row.active_promotion_id)+await productLedgerCount(db,row.active_promotion_id)+await inventoryLedgerCount(db,row.active_promotion_id)+await customerLedgerCount(db,row.active_promotion_id)+await customerCreditPolicyLedgerCount(db,row.active_promotion_id)+await debtReconciliationLedgerCount(db,row.active_promotion_id)+await customerContactLedgerCount(db,row.active_promotion_id);
  return row;
}
// ---------------------------------------------------------------------------
// Read plan (subrequest budget). With DB_PROVIDER=turso every statement is one
// external HTTP fetch and Workers Free allows 50 per invocation. The legacy
// read path issued 53 statements for an ACTIVE /read/canonical/status. The plan
// below keeps identical response bodies with: one sqlite_master probe per
// request, one statement per authority read (control + financial_revision
// ledger sums) and one statement for all status counts. Every statement is a
// plain SELECT: no BEGIN, no write lock. The schema probe is request scoped on
// purpose (never cached on the isolate) so a later additive migration is seen
// by the next request exactly as the legacy per-call probes saw it.
const CONTROL_SCHEMA_TABLES=['canonical_control','canonical_sale_context','canonical_financial_operations'];
const EXPENSE_SCHEMA_TABLES=['canonical_expenses'];
const PRODUCT_LEDGER_SCHEMA_TABLES=['canonical_product_operations'];
const LIVE_PRODUCT_SCHEMA_TABLES=['canonical_product_operations','canonical_live_products','canonical_live_inventory_effects'];
const INVENTORY_SCHEMA_TABLES=['canonical_inventory_operations','canonical_manual_inventory_movements'];
const GENERIC_SALE_SCHEMA_TABLES=['canonical_generic_sale_lines'];
const CUSTOMER_SCHEMA_TABLES=['canonical_customer_operations','canonical_customer_registry','canonical_live_customers'];
const CREDIT_POLICY_SCHEMA_TABLES=['canonical_customer_credit_policy_operations','canonical_customer_credit_policies'];
const DEBT_RECONCILIATION_SCHEMA_TABLES=['canonical_reconciliation_credits','canonical_credit_baseline_adjustments'];
const CUSTOMER_CONTACT_SCHEMA_TABLES=['canonical_customer_contacts'];
const READ_PLAN_SCHEMA_TABLES=[...new Set([...CONTROL_SCHEMA_TABLES,...EXPENSE_SCHEMA_TABLES,...PRODUCT_LEDGER_SCHEMA_TABLES,...LIVE_PRODUCT_SCHEMA_TABLES,...INVENTORY_SCHEMA_TABLES,...GENERIC_SALE_SCHEMA_TABLES,...CUSTOMER_SCHEMA_TABLES,...CREDIT_POLICY_SCHEMA_TABLES,...DEBT_RECONCILIATION_SCHEMA_TABLES,...CUSTOMER_CONTACT_SCHEMA_TABLES])];
// Same order and conditions as the legacy readControl ledger additions.
const LEDGER_REVISION_TERMS=[
  [EXPENSE_SCHEMA_TABLES,['canonical_expense_operations']],
  [PRODUCT_LEDGER_SCHEMA_TABLES,['canonical_product_operations']],
  [INVENTORY_SCHEMA_TABLES,['canonical_inventory_operations']],
  [CUSTOMER_SCHEMA_TABLES,['canonical_customer_operations']],
  [CREDIT_POLICY_SCHEMA_TABLES,['canonical_customer_credit_policy_operations']],
  [DEBT_RECONCILIATION_SCHEMA_TABLES,['canonical_reconciliation_credits','canonical_credit_baseline_adjustments']],
  [CUSTOMER_CONTACT_SCHEMA_TABLES,['canonical_customer_contacts']],
];
function hasAll(schema,tables){return tables.every((name)=>schema.has(name));}
async function loadReadSchema(db){
  const rows=await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${READ_PLAN_SCHEMA_TABLES.map((name)=>`'${name}'`).join(',')})`).all();
  return new Set((rows.results??[]).map((row)=>row.name));
}
async function readPlan(db,options={}){
  const legacy={schema:null,current:async()=>{const c=await control(db);return c?.mode==='ACTIVE'?await readControl(db):c;}};
  if(options.legacy===true)return legacy;
  const schema=await loadReadSchema(db);
  // A database without the authority tables keeps the exact legacy behaviour.
  if(!hasAll(schema,CONTROL_SCHEMA_TABLES))return legacy;
  return {schema,current:()=>readControlSnapshot(db,schema)};
}
// One statement equivalent to control() followed (when ACTIVE) by readControl().
// Non-ACTIVE rows carry financial_revision:null, which readMeta/sameControl/
// parsePage/encodeCursor ignore exactly as they ignore the missing key.
async function readControlSnapshot(db,schema){
  const terms=[];
  for(const [required,tables] of LEDGER_REVISION_TERMS){
    if(hasAll(schema,required))for(const table of tables)terms.push(`(SELECT COUNT(*) FROM ${table} WHERE promotion_id=c.active_promotion_id)`);
  }
  const ledger=terms.length?terms.join('+'):'0';
  const row=await db.prepare(`SELECT c.mode,c.active_promotion_id,c.revision,c.authority_epoch,
    c.minimum_client_contract,c.first_live_operation_id,CASE WHEN c.mode='ACTIVE' THEN
    (SELECT COUNT(*) FROM canonical_sale_context WHERE promotion_id=c.active_promotion_id)+
    (SELECT COUNT(*) FROM canonical_financial_operations WHERE promotion_id=c.active_promotion_id)
    ELSE NULL END AS financial_revision,
    CASE WHEN c.mode='ACTIVE' THEN CASE WHEN c.active_promotion_id IS NULL OR c.active_promotion_id='' THEN 0 ELSE ${ledger} END
    ELSE NULL END AS na_ledger_revision FROM canonical_control c WHERE c.id=1`).first();
  if(!row)return row;
  if(row.mode==='ACTIVE')row.financial_revision=Number(row.financial_revision)+(Number(row.na_ledger_revision)||0);
  delete row.na_ledger_revision;
  return row;
}
async function statusCounts(db,before,schema){
  if(!schema)return legacyStatusCounts(db,before);
  const count=(source,where='promotion_id=?1')=>`(SELECT COUNT(*) FROM ${source} WHERE ${where})`;
  const columns=Object.keys(TABLES).map((table)=>`${count(table)} AS t_${table}`);
  const active=before.mode==='ACTIVE';
  const liveProductsReady=active&&hasAll(schema,LIVE_PRODUCT_SCHEMA_TABLES);
  const liveCustomersReady=active&&hasAll(schema,CUSTOMER_SCHEMA_TABLES);
  const reconciliationReady=active&&hasAll(schema,DEBT_RECONCILIATION_SCHEMA_TABLES);
  const inventoryAdjustReady=active&&hasAll(schema,INVENTORY_SCHEMA_TABLES);
  const expenseReady=active&&hasAll(schema,EXPENSE_SCHEMA_TABLES);
  if(active){
    columns.push(
      `${liveProductsReady?count('canonical_live_products'):'0'} AS live_products`,
      `${liveCustomersReady?count('canonical_live_customers'):'0'} AS live_customers`,
      `${count('live_credits')} AS live_credits`,
      `${reconciliationReady?count('canonical_reconciliation_credits'):'0'} AS reconciliation_credits`,
      `${count('canonical_financial_events','promotion_id=?1 AND credit_id IS NOT NULL')} AS live_credit_payments`,
      `${count('canonical_sale_context x','x.promotion_id=?1')} AS sales`,
      `${count('canonical_sale_context x JOIN sale_items r ON r.sale_id=x.sale_id','x.promotion_id=?1')} AS sale_items`,
      `${count('canonical_sale_context x JOIN cash_movements r ON r.sale_id=x.sale_id','x.promotion_id=?1')} AS cash_movements`,
      `${liveProductsReady
        ?`(SELECT COUNT(*) FROM (
          SELECT movement_id FROM canonical_inventory_effects WHERE promotion_id=?1
          UNION ALL SELECT movement_id FROM canonical_live_inventory_effects WHERE promotion_id=?1
        ))`
        :count('canonical_inventory_effects')} AS inventory_movements`,
      `${inventoryAdjustReady?count('canonical_manual_inventory_movements'):'0'} AS manual_inventory_movements`,
      `${expenseReady?count('canonical_expense_operations'):'0'} AS expenses`,
    );
  }
  const row=await db.prepare(`SELECT ${columns.join(',')}`).bind(before.active_promotion_id).first();
  // Same keys, same insertion order and same arithmetic as legacyStatusCounts.
  const counts={};for(const table of Object.keys(TABLES))counts[table]=Number(row[`t_${table}`]);
  if(active){
    counts.imported_products=counts.products;
    counts.live_products=liveProductsReady?Number(row.live_products):0;
    counts.products+=counts.live_products;
    counts.imported_customers=counts.customers;
    counts.live_customers=liveCustomersReady?Number(row.live_customers):0;
    counts.customers+=counts.live_customers;
    counts.imported_credits=counts.credits;
    counts.live_credits=Number(row.live_credits);
    counts.reconciliation_credits=reconciliationReady?Number(row.reconciliation_credits):0;
    counts.credits+=counts.live_credits+counts.reconciliation_credits;
    counts.credit_payments+=Number(row.live_credit_payments);
    for(const name of ['sales','sale_items','cash_movements'])counts[name]=Number(row[name]);
    counts.inventory_movements=Number(row.inventory_movements);
    if(inventoryAdjustReady)counts.inventory_movements+=Number(row.manual_inventory_movements);
    counts.expenses=before.active_promotion_id&&expenseReady?Number(row.expenses)||0:0;
  }
  return counts;
}
// Legacy statement-per-count path, kept verbatim for databases without the
// authority tables and as the parity oracle in tests.
async function legacyStatusCounts(db,before){
    const counts={};for(const table of Object.keys(TABLES))counts[table]=Number((await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE promotion_id=?1`).bind(before.active_promotion_id).first()).count);
    if(before.mode==='ACTIVE'){
      const liveProductsReady=await liveProductSchemaAvailable(db);
      counts.imported_products=counts.products;
      counts.live_products=liveProductsReady?Number((await db.prepare('SELECT COUNT(*) AS count FROM canonical_live_products WHERE promotion_id=?1').bind(before.active_promotion_id).first()).count):0;
      counts.products+=counts.live_products;
      const liveCustomersReady=await customerSchemaAvailable(db);
      counts.imported_customers=counts.customers;
      counts.live_customers=liveCustomersReady?Number((await db.prepare('SELECT COUNT(*) AS count FROM canonical_live_customers WHERE promotion_id=?1').bind(before.active_promotion_id).first()).count):0;
      counts.customers+=counts.live_customers;
      counts.imported_credits=counts.credits;
      counts.live_credits=Number((await db.prepare('SELECT COUNT(*) AS count FROM live_credits WHERE promotion_id=?1').bind(before.active_promotion_id).first()).count);
      const reconciliationReady=await debtReconciliationSchemaAvailable(db);
      counts.reconciliation_credits=reconciliationReady?Number((await db.prepare('SELECT COUNT(*) AS count FROM canonical_reconciliation_credits WHERE promotion_id=?1').bind(before.active_promotion_id).first()).count):0;
      counts.credits+=counts.live_credits+counts.reconciliation_credits;
      counts.credit_payments+=Number((await db.prepare('SELECT COUNT(*) AS count FROM canonical_financial_events WHERE promotion_id=?1 AND credit_id IS NOT NULL').bind(before.active_promotion_id).first()).count);
      for(const [name,sql] of Object.entries({sales:'canonical_sale_context x',sale_items:'canonical_sale_context x JOIN sale_items r ON r.sale_id=x.sale_id',cash_movements:'canonical_sale_context x JOIN cash_movements r ON r.sale_id=x.sale_id'}))
        counts[name]=Number((await db.prepare(`SELECT COUNT(*) AS count FROM ${sql} WHERE x.promotion_id=?1`).bind(before.active_promotion_id).first()).count);
      const inventoryAdjustReady=await inventoryLedgerAvailable(db);
      counts.inventory_movements=liveProductsReady
        ?Number((await db.prepare(`SELECT COUNT(*) AS count FROM (
          SELECT movement_id FROM canonical_inventory_effects WHERE promotion_id=?1
          UNION ALL SELECT movement_id FROM canonical_live_inventory_effects WHERE promotion_id=?1
        )`).bind(before.active_promotion_id).first()).count)
        :Number((await db.prepare('SELECT COUNT(*) AS count FROM canonical_inventory_effects WHERE promotion_id=?1').bind(before.active_promotion_id).first()).count);
      if(inventoryAdjustReady)counts.inventory_movements+=Number((await db.prepare('SELECT COUNT(*) AS count FROM canonical_manual_inventory_movements WHERE promotion_id=?1').bind(before.active_promotion_id).first()).count);
      counts.expenses=await expenseLedgerCount(db,before.active_promotion_id);
    }
    return counts;
}
async function zeroTraffic(db){const row=await db.prepare('SELECT (SELECT COUNT(*) FROM sales) sales,(SELECT COUNT(*) FROM sale_items) sale_items,(SELECT COUNT(*) FROM cash_movements) cash_movements,(SELECT COUNT(*) FROM inventory_movements) inventory_movements,(SELECT COUNT(*) FROM sync_operations) sync_operations').first();return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v)]));}
async function candidateCount(db,id){let total=0;for(const table of Object.keys(TABLES))total+=Number((await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE promotion_id=?1`).bind(id).first()).count);return total;}
async function receiptReplay(db,id,hash,json){const row=await db.prepare('SELECT request_hash,result_json FROM canonical_command_receipts WHERE operation_id=?1').bind(id).first();if(!row)return null;return row.request_hash===hash?json(JSON.parse(row.result_json)):json({error:'operation_id_conflict'},409);}
function manifestMatches(body,m){return body.import_id===m.run.import_id&&body.expected_source_hash===m.run.source_hash&&body.expected_manifest_hash===m.run.manifest_hash&&body.expected_transform_version===m.run.transform_version&&body.expected_staging_revision===m.run.staging_revision&&body.mapping_version===m.mapping_version&&body.schema_version===m.schema_version&&body.policy_hash===m.policy_hash;}
function validId(value){return typeof value==='string'&&value.length>0&&value.length<=160&&!/[\x00-\x1f\x7f]/.test(value);}
function plainExact(value,fields){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every((key)=>Object.prototype.hasOwnProperty.call(value,key));}

export const A6_API_CONTRACT={
  env:{A6_LOCAL_GATE:'enabled',A6_LOCAL_DATABASE_ID:'exact D1 database_id',A6_OPERATIONAL_MANIFEST:{environment:'local',database_id:'exact D1 database_id',worker_hash:'sha256',client_hash:'sha256',operator:'non-empty',backup_hash:'sha256',run:{import_id:'text',source_hash:'sha256',manifest_hash:'sha256',transform_version:'text',staging_revision:'integer'},mapping_version:A6_MAPPING_VERSION,schema_version:A6_SCHEMA_VERSION,policy_hash:'sha256(A6_POLICY)',expected:'all exact counts, amounts, known/unknown dates',local_pending_count:0,local_delta_count:0}},
  promote:{...Object.fromEntries(PROMOTE_FIELDS.map((field)=>[field,'required'])),phase:'prepare|publish'},
  freeze:{operation_id:'required',expected_control_revision:'required integer'},rollback:{operation_id:'required',promotion_id:'required',expected_control_revision:'required integer'},
  mapping:A6_FIELD_MAP,policy:A6_POLICY,
};
