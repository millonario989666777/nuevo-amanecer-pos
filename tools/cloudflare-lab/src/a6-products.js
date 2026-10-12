import { getDatabase } from './database-binding.js';
import { sha256Hex, stableStringify } from './a5-import-core.js';

export const PRODUCT_COMMANDS = new Set(['product.create','product.update']);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TAX_TYPES = new Set(['gravado','exonerado','inafecto','gratuito','']);
const COMPLEMENTARY = new Set(['','isc','icbper']);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function clean(value, max) {
  if (value === undefined || value === null) return null;
  const out = String(value).trim().replace(/\s+/g, ' ');
  if (!out || out.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(out)) return null;
  return out;
}
function optionalText(value, max) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return clean(value, max);
}
function validId(value) { return typeof value === 'string' && SAFE_ID.test(value); }
function uint(value) { return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE; }
function finiteNonNegative(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

function normalize(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error:'invalid_product_request' };
  const allowed = new Set([
    'operation_id','product_id','promotion_id','authority_epoch','expected_control_revision','client_contract','created_at',
    'name','sku','barcode','alternate_codes','category','brand','description','icon','image','unit','purchase_unit',
    'purchase_factor','cost_cents','price_cents','box_price_cents','units_per_box','initial_stock_quantity',
    'stock_min_quantity','expiry_date','includes_igv','tax_type','complementary_tax','tracks_inventory'
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return { error:'invalid_product_request' };
  for (const key of ['operation_id','product_id','promotion_id','client_contract']) if (!validId(body[key])) return { error:'invalid_product_request', field:key };
  if (!uint(body.authority_epoch) || !uint(body.expected_control_revision)) return { error:'invalid_product_request' };
  if (typeof body.created_at !== 'string' || !TIMESTAMP.test(body.created_at) || !Number.isFinite(Date.parse(body.created_at))) return { error:'invalid_product_request',field:'created_at' };

  const name=clean(body.name,240), unit=clean(body.unit,80), purchaseUnit=clean(body.purchase_unit,80);
  if (!name || !unit || !purchaseUnit) return { error:'invalid_product_request' };
  if (!uint(body.cost_cents) || !Number.isSafeInteger(body.price_cents) || body.price_cents<=0 || body.price_cents>MAX_SAFE) return { error:'invalid_product_request' };
  if (body.box_price_cents !== null && body.box_price_cents !== undefined && (!Number.isSafeInteger(body.box_price_cents) || body.box_price_cents<=0 || body.box_price_cents>MAX_SAFE)) return { error:'invalid_product_request' };
  if (!finiteNonNegative(body.initial_stock_quantity) || !finiteNonNegative(body.stock_min_quantity)) return { error:'invalid_product_request' };
  if (typeof body.purchase_factor !== 'number' || !Number.isFinite(body.purchase_factor) || body.purchase_factor<=0) return { error:'invalid_product_request' };
  if (body.units_per_box !== null && body.units_per_box !== undefined && (typeof body.units_per_box !== 'number' || !Number.isFinite(body.units_per_box) || body.units_per_box<=0)) return { error:'invalid_product_request' };
  if (![true,false].includes(body.includes_igv) || ![true,false].includes(body.tracks_inventory)) return { error:'invalid_product_request' };
  if (body.expiry_date !== null && body.expiry_date !== undefined && body.expiry_date !== '' && (typeof body.expiry_date !== 'string' || !DATE.test(body.expiry_date))) return { error:'invalid_product_request' };

  const sku=optionalText(body.sku,160), barcode=optionalText(body.barcode,160);
  const alternate=Array.isArray(body.alternate_codes) ? body.alternate_codes.map((value)=>clean(value,160)) : [];
  if (alternate.length>10 || alternate.some((value)=>!value)) return { error:'invalid_product_request',field:'alternate_codes' };
  const codes=[sku,barcode,...alternate].filter(Boolean).map((value)=>value.toLowerCase());
  if (new Set(codes).size!==codes.length) return { error:'duplicate_product_code' };

  const tax=body.tax_type == null ? '' : String(body.tax_type).trim().toLowerCase();
  const complementary=body.complementary_tax == null ? '' : String(body.complementary_tax).trim().toLowerCase();
  if (!TAX_TYPES.has(tax) || !COMPLEMENTARY.has(complementary)) return { error:'invalid_product_request' };

  const tracks=body.tracks_inventory;
  const initial=tracks ? body.initial_stock_quantity : 0;
  const minimum=tracks ? body.stock_min_quantity : 0;
  return { value:{
    operation_id:body.operation_id, product_id:body.product_id, promotion_id:body.promotion_id,
    authority_epoch:body.authority_epoch, expected_control_revision:body.expected_control_revision,
    client_contract:body.client_contract, created_at:body.created_at, name,
    sku, barcode, alternate_codes:alternate,
    category:optionalText(body.category,120), brand:optionalText(body.brand,160),
    description:optionalText(body.description,2000), icon:optionalText(body.icon,24),
    image:optionalText(body.image,250000), unit, purchase_unit:purchaseUnit,
    purchase_factor:body.purchase_factor, cost_cents:body.cost_cents, price_cents:body.price_cents,
    box_price_cents:body.box_price_cents ?? null, units_per_box:body.units_per_box ?? null,
    initial_stock_quantity:initial, stock_min_quantity:minimum,
    expiry_date:body.expiry_date || null, includes_igv:body.includes_igv ? 1 : 0,
    tax_type:tax || null, complementary_tax:complementary || null, tracks_inventory:tracks ? 1 : 0
  }};
}

async function operationConflict(db, operationId) {
  const row=await db.prepare(`SELECT operation_id FROM (
    SELECT operation_id FROM sales WHERE operation_id=?1
    UNION ALL SELECT operation_id FROM canonical_financial_operations WHERE operation_id=?1
    UNION ALL SELECT operation_id FROM canonical_expense_operations WHERE operation_id=?1
    UNION ALL SELECT operation_id FROM canonical_credit_accounts WHERE operation_id=?1
  ) LIMIT 1`).bind(operationId).first();
  return !!row;
}

async function authorityError(db, auth, body) {
  const control=await db.prepare(`SELECT c.*,d.role AS device_role,d.status AS device_status,d.credential_hash
    FROM canonical_control c LEFT JOIN devices d ON d.device_id=?1 WHERE c.id=1`).bind(auth.principalId).first();
  if (!control || control.mode!=='ACTIVE') return 'canonical_not_active';
  if (control.active_promotion_id!==body.promotion_id || Number(control.authority_epoch)!==body.authority_epoch ||
      Number(control.revision)!==body.expected_control_revision || control.minimum_client_contract!==body.client_contract ||
      control.device_role!=='writer' || control.device_status!=='active' || control.credential_hash!==auth.credentialHash) return 'stale_authority';
  return null;
}

async function conflictingCode(db, body, revisionsReady=false) {
  for (const code of [body.sku,body.barcode,...body.alternate_codes].filter(Boolean)) {
    const imported=await db.prepare(`SELECT p.product_id FROM products p
      WHERE p.promotion_id=?1 AND (
        lower(trim(COALESCE(p.sku,'')))=lower(trim(?2))
        OR lower(trim(COALESCE(p.barcode,'')))=lower(trim(?2))
        OR lower(trim(COALESCE(p.legacy_alternate_code,'')))=lower(trim(?2))
        OR EXISTS(SELECT 1 FROM json_each(p.alternate_codes_json) j
          WHERE j.type='text' AND lower(trim(CAST(j.value AS TEXT)))=lower(trim(?2)))
      ) LIMIT 1`).bind(body.promotion_id,code).first();
    if (imported) return { code, product_id:imported.product_id };
    const live=await db.prepare(`SELECT p.product_id FROM canonical_live_products p
      WHERE p.promotion_id=?1 AND (
        lower(trim(COALESCE(p.sku,'')))=lower(trim(?2))
        OR lower(trim(COALESCE(p.barcode,'')))=lower(trim(?2))
        OR EXISTS(SELECT 1 FROM json_each(p.alternate_codes_json) j
          WHERE j.type='text' AND lower(trim(CAST(j.value AS TEXT)))=lower(trim(?2)))
      ) LIMIT 1`).bind(body.promotion_id,code).first();
    if (live) return { code, product_id:live.product_id };
    if (revisionsReady) {
      const revised=await db.prepare(`SELECT r.product_id FROM canonical_product_revisions r
        WHERE r.promotion_id=?1
          AND r.revision=(SELECT MAX(x.revision) FROM canonical_product_revisions x WHERE x.promotion_id=r.promotion_id AND x.product_id=r.product_id)
          AND (lower(trim(COALESCE(r.sku,'')))=lower(trim(?2))
            OR lower(trim(COALESCE(r.barcode,'')))=lower(trim(?2))
            OR EXISTS(SELECT 1 FROM json_each(r.alternate_codes_json) j
              WHERE j.type='text' AND lower(trim(CAST(j.value AS TEXT)))=lower(trim(?2))))
        LIMIT 1`).bind(body.promotion_id,code).first();
      if (revised) return { code, product_id:revised.product_id };
    }
  }
  return null;
}

async function productRevisionsReady(db) {
  const row=await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='canonical_product_revisions'").first();
  return Number(row?.n)===1;
}

export async function createCanonicalProduct(request, env, auth, json) {
  let raw; try { raw=await request.json(); } catch { return json({error:'invalid_json'},400); }
  const checked=normalize(raw);
  if (checked.error) return json({error:checked.error,...(checked.field?{field:checked.field}:{})},400);
  const body=checked.value, db=getDatabase(env);

  const denied=await authorityError(db,auth,body);
  if (denied) return json({error:denied},409);

  const requestHash=await sha256Hex(stableStringify(body));
  const existing=await db.prepare('SELECT request_hash,result_json FROM canonical_product_operations WHERE operation_id=?1').bind(body.operation_id).first();
  if (existing) {
    const stale=await authorityError(db,auth,body); if (stale) return json({error:stale},409);
    if (existing.request_hash!==requestHash) return json({error:'operation_id_conflict',operation_id:body.operation_id},409);
    const result=JSON.parse(existing.result_json);
    return json({...result,status:'already_processed',idempotent:true},200);
  }
  if (await operationConflict(db,body.operation_id)) return json({error:'operation_id_conflict',operation_id:body.operation_id},409);

  if (await db.prepare(`SELECT product_id FROM (
      SELECT product_id FROM products WHERE promotion_id=?1 AND product_id=?2
      UNION ALL SELECT product_id FROM canonical_live_products WHERE promotion_id=?1 AND product_id=?2
    ) LIMIT 1`).bind(body.promotion_id,body.product_id).first()) return json({error:'product_id_conflict',product_id:body.product_id},409);

  // product.update may have moved codes onto other products after cutover.
  let revisionsReady=false;
  try { revisionsReady=await productRevisionsReady(db); } catch { revisionsReady=false; }
  const codeConflict=await conflictingCode(db,body,revisionsReady);
  if (codeConflict) return json({error:'product_code_conflict',code:codeConflict.code,product_id:codeConflict.product_id},409);

  const result={
    status:'created',command:'product.create',operation_id:body.operation_id,product_id:body.product_id,
    promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,idempotent:false
  };
  const token='product:'+crypto.randomUUID();
  const statements=[
    db.prepare(`INSERT INTO canonical_product_operations
      (operation_id,command,request_hash,result_json,promotion_id,product_id,authority_epoch,control_revision,client_contract,principal_id,credential_hash,created_at)
      VALUES(?1,'product.create',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`)
      .bind(body.operation_id,requestHash,stableStringify(result),body.promotion_id,body.product_id,body.authority_epoch,body.expected_control_revision,body.client_contract,auth.principalId,auth.credentialHash,body.created_at),
    db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok) VALUES(?1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)`).bind(token+':operation'),
    db.prepare(`INSERT INTO canonical_live_products
      (promotion_id,product_id,operation_id,name,sku,barcode,alternate_codes_json,legacy_alternate_code,category,brand,description,icon,image,unit,purchase_unit,purchase_factor,
       cost_cents,price_cents,box_price_cents,units_per_box,opening_stock_quantity,current_stock_quantity,stock_revision,stock_min_quantity,expiry_date,includes_igv,tax_type,
       complementary_tax,tracks_inventory,created_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,NULL,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?20,0,?21,?22,?23,?24,?25,?26,?27)`)
      .bind(body.promotion_id,body.product_id,body.operation_id,body.name,body.sku,body.barcode,JSON.stringify(body.alternate_codes),body.category,body.brand,body.description,body.icon,body.image,
        body.unit,body.purchase_unit,body.purchase_factor,body.cost_cents,body.price_cents,body.box_price_cents,body.units_per_box,body.initial_stock_quantity,body.stock_min_quantity,
        body.expiry_date,body.includes_igv,body.tax_type,body.complementary_tax,body.tracks_inventory,body.created_at),
    db.prepare(`INSERT INTO canonical_assertions(assertion_id,ok) VALUES(?1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)`).bind(token+':product'),
    db.prepare('DELETE FROM canonical_assertions WHERE assertion_id IN (?1,?2)').bind(token+':operation',token+':product')
  ];
  try { await db.batch(statements); }
  catch {
    const replay=await db.prepare('SELECT request_hash,result_json FROM canonical_product_operations WHERE operation_id=?1').bind(body.operation_id).first();
    const stale=await authorityError(db,auth,body); if (stale) return json({error:stale},409);
    if (replay?.request_hash===requestHash) return json({...JSON.parse(replay.result_json),status:'already_processed',idempotent:true},200);
    if (replay) return json({error:'operation_id_conflict',operation_id:body.operation_id},409);
    const collision=await conflictingCode(db,body,revisionsReady);
    if (collision) return json({error:'product_code_conflict',code:collision.code,product_id:collision.product_id},409);
    return json({error:'canonical_product_conflict',operation_id:body.operation_id},409);
  }
  return json(result,201);
}

// ---------------------------------------------------------------------------
// product.update: append-only metadata revision with CAS on
// expected_metadata_revision. Stock, unit, tax and inventory tracking are not
// editable here (stock keeps moving only through sales and inventory.adjust).
// Subrequests (Turso): schema+authority+replay probe (1), product+codes (1),
// one atomic batch (1) on the happy path, plus session auth in the router.
const UPDATE_FIELDS = [
  'operation_id','product_id','promotion_id','authority_epoch','expected_control_revision','client_contract','created_at',
  'expected_metadata_revision','name','sku','barcode','alternate_codes','category','brand','description','icon',
  'cost_cents','price_cents','box_price_cents','units_per_box','stock_min_quantity','expiry_date'
];

function normalizeUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error:'invalid_product_update' };
  const allowed=new Set(UPDATE_FIELDS);
  if (Object.keys(body).some((key)=>!allowed.has(key))) return { error:'invalid_product_update' };
  for (const key of ['operation_id','product_id','promotion_id','client_contract']) if (!validId(body[key])) return { error:'invalid_product_update', field:key };
  if (!uint(body.authority_epoch) || !uint(body.expected_control_revision) || !uint(body.expected_metadata_revision)) return { error:'invalid_product_update' };
  if (typeof body.created_at !== 'string' || !TIMESTAMP.test(body.created_at) || !Number.isFinite(Date.parse(body.created_at))) return { error:'invalid_product_update',field:'created_at' };
  const name=clean(body.name,240);
  if (!name) return { error:'invalid_product_update',field:'name' };
  if (!uint(body.cost_cents) || !Number.isSafeInteger(body.price_cents) || body.price_cents<=0) return { error:'invalid_product_update',field:'price_cents' };
  const hasBoxPrice=body.box_price_cents!==null && body.box_price_cents!==undefined;
  const hasBoxUnits=body.units_per_box!==null && body.units_per_box!==undefined;
  if (hasBoxPrice!==hasBoxUnits) return { error:'invalid_product_update',field:'box_price_cents' };
  if (hasBoxPrice && (!Number.isSafeInteger(body.box_price_cents) || body.box_price_cents<=0)) return { error:'invalid_product_update',field:'box_price_cents' };
  if (hasBoxUnits && (typeof body.units_per_box!=='number' || !Number.isFinite(body.units_per_box) || body.units_per_box<=0)) return { error:'invalid_product_update',field:'units_per_box' };
  if (!finiteNonNegative(body.stock_min_quantity)) return { error:'invalid_product_update',field:'stock_min_quantity' };
  if (body.expiry_date!==null && body.expiry_date!==undefined && body.expiry_date!=='' && (typeof body.expiry_date!=='string' || !DATE.test(body.expiry_date))) return { error:'invalid_product_update',field:'expiry_date' };
  for (const [key,max] of [['sku',160],['barcode',160],['category',120],['brand',160],['description',2000],['icon',24]]) {
    if (body[key]!==null && body[key]!==undefined && String(body[key]).trim()!=='' && !optionalText(body[key],max)) return { error:'invalid_product_update',field:key };
  }
  const sku=optionalText(body.sku,160), barcode=optionalText(body.barcode,160);
  if (body.alternate_codes!==undefined && !Array.isArray(body.alternate_codes)) return { error:'invalid_product_update',field:'alternate_codes' };
  const alternate=(body.alternate_codes||[]).map((value)=>clean(value,160));
  if (alternate.length>10 || alternate.some((value)=>!value)) return { error:'invalid_product_update',field:'alternate_codes' };
  const codes=[sku,barcode,...alternate].filter(Boolean).map((value)=>value.toLowerCase());
  if (new Set(codes).size!==codes.length) return { error:'duplicate_product_code' };
  return { value:{
    operation_id:body.operation_id, product_id:body.product_id, promotion_id:body.promotion_id,
    authority_epoch:body.authority_epoch, expected_control_revision:body.expected_control_revision,
    client_contract:body.client_contract, created_at:body.created_at,
    expected_metadata_revision:body.expected_metadata_revision, name, sku, barcode, alternate_codes:alternate,
    category:optionalText(body.category,120), brand:optionalText(body.brand,160), description:optionalText(body.description,2000),
    icon:optionalText(body.icon,24), cost_cents:body.cost_cents, price_cents:body.price_cents,
    box_price_cents:hasBoxPrice?body.box_price_cents:null, units_per_box:hasBoxUnits?body.units_per_box:null,
    stock_min_quantity:body.stock_min_quantity, expiry_date:body.expiry_date || null
  }};
}

// One statement: schema readiness, authority row and idempotent replay.
async function updatePreflight(db, auth, body) {
  return db.prepare(`SELECT
      (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='canonical_product_revisions') AS ready,
      c.mode,c.active_promotion_id,c.authority_epoch,c.revision,c.minimum_client_contract,
      d.role AS device_role,d.status AS device_status,d.credential_hash
    FROM canonical_control c LEFT JOIN devices d ON d.device_id=?1 WHERE c.id=1`).bind(auth.principalId).first();
}

function authorityFrom(control, auth, body) {
  if (!control || control.mode!=='ACTIVE') return 'canonical_not_active';
  if (control.active_promotion_id!==body.promotion_id || Number(control.authority_epoch)!==body.authority_epoch ||
      Number(control.revision)!==body.expected_control_revision || control.minimum_client_contract!==body.client_contract ||
      control.device_role!=='writer' || control.device_status!=='active' || control.credential_hash!==auth.credentialHash) return 'stale_authority';
  return null;
}

// Effective codes of OTHER products: latest revision if any, else base row.
const CODE_OWNER_SQL=`WITH incoming(code) AS (
    SELECT lower(trim(CAST(value AS TEXT))) FROM json_each(?3) WHERE type='text' AND trim(CAST(value AS TEXT))<>''
  ), latest AS (
    SELECT r.* FROM canonical_product_revisions r WHERE r.promotion_id=?1
      AND r.revision=(SELECT MAX(x.revision) FROM canonical_product_revisions x WHERE x.promotion_id=r.promotion_id AND x.product_id=r.product_id)
  ), own_base(code) AS (
    SELECT lower(trim(CAST(c.value AS TEXT))) FROM products p
      JOIN json_each(json_insert(json_insert(json_insert(COALESCE(p.alternate_codes_json,'[]'),'$[#]',p.sku),'$[#]',p.barcode),'$[#]',p.legacy_alternate_code)) c
      WHERE p.promotion_id=?1 AND p.product_id=?2 AND c.type='text'
    UNION ALL
    SELECT lower(trim(CAST(c.value AS TEXT))) FROM canonical_live_products p
      JOIN json_each(json_insert(json_insert(COALESCE(p.alternate_codes_json,'[]'),'$[#]',p.sku),'$[#]',p.barcode)) c
      WHERE p.promotion_id=?1 AND p.product_id=?2 AND c.type='text'
  ), own(code) AS (
    SELECT lower(trim(CAST(c.value AS TEXT))) FROM latest l
      JOIN json_each(json_insert(json_insert(l.alternate_codes_json,'$[#]',l.sku),'$[#]',l.barcode)) c
      WHERE l.product_id=?2 AND c.type='text'
    UNION ALL
    SELECT code FROM own_base WHERE NOT EXISTS(SELECT 1 FROM latest l WHERE l.product_id=?2)
  ), owners(product_id,name,code) AS (
    SELECT p.product_id,p.name,lower(trim(c.value)) FROM products p
      JOIN json_each(json_insert(json_insert(json_insert(COALESCE(p.alternate_codes_json,'[]'),'$[#]',p.sku),'$[#]',p.barcode),'$[#]',p.legacy_alternate_code)) c
      WHERE p.promotion_id=?1 AND c.type='text' AND NOT EXISTS(SELECT 1 FROM latest l WHERE l.product_id=p.product_id)
    UNION ALL
    SELECT p.product_id,p.name,lower(trim(c.value)) FROM canonical_live_products p
      JOIN json_each(json_insert(json_insert(COALESCE(p.alternate_codes_json,'[]'),'$[#]',p.sku),'$[#]',p.barcode)) c
      WHERE p.promotion_id=?1 AND c.type='text' AND NOT EXISTS(SELECT 1 FROM latest l WHERE l.product_id=p.product_id)
    UNION ALL
    SELECT l.product_id,l.name,lower(trim(c.value)) FROM latest l
      JOIN json_each(json_insert(json_insert(l.alternate_codes_json,'$[#]',l.sku),'$[#]',l.barcode)) c WHERE c.type='text'
  )
  SELECT o.product_id,o.name,o.code FROM owners o JOIN incoming i ON i.code=o.code
    WHERE o.product_id<>?2 AND i.code NOT IN (SELECT code FROM own) LIMIT 1`;

async function productState(db, body) {
  const codes=JSON.stringify([body.sku,body.barcode,...body.alternate_codes].filter(Boolean));
  const row=await db.prepare(`SELECT t.provenance,t.tracks_inventory,
      COALESCE((SELECT MAX(r.revision) FROM canonical_product_revisions r WHERE r.promotion_id=?1 AND r.product_id=?2),0) AS metadata_revision,
      (SELECT json_object('product_id',x.product_id,'name',x.name,'code',x.code) FROM (${CODE_OWNER_SQL}) x) AS code_owner
    FROM (
      SELECT 'IMPORT' AS provenance,tracks_inventory,0 AS source_rank FROM products WHERE promotion_id=?1 AND product_id=?2
      UNION ALL SELECT 'LIVE',tracks_inventory,1 FROM canonical_live_products WHERE promotion_id=?1 AND product_id=?2
    ) t ORDER BY t.source_rank LIMIT 1`).bind(body.promotion_id,body.product_id,codes).first();
  return row;
}

export async function updateCanonicalProduct(request, env, auth, json) {
  let raw; try { raw=await request.json(); } catch { return json({error:'invalid_json'},400); }
  const checked=normalizeUpdate(raw);
  if (checked.error) return json({error:checked.error,...(checked.field?{field:checked.field}:{})},400);
  const body=checked.value, db=getDatabase(env);

  let pre;
  try { pre=await updatePreflight(db,auth,body); } catch { return json({error:'canonical_product_stage_error',stage:'preflight'},500); }
  if (!pre || Number(pre.ready)!==1) return json({error:'product_update_schema_not_ready'},503);
  const denied=authorityFrom(pre,auth,body);
  if (denied) return json({error:denied},409);

  const requestHash=await sha256Hex(stableStringify(body));
  const replay=async()=>{
    const existing=await db.prepare('SELECT request_hash,result_json FROM canonical_product_revisions WHERE operation_id=?1').bind(body.operation_id).first();
    if (!existing) return null;
    if (existing.request_hash!==requestHash) return json({error:'operation_id_conflict',operation_id:body.operation_id},409);
    return json({...JSON.parse(existing.result_json),status:'already_processed',idempotent:true},200);
  };
  const previous=await replay();
  if (previous) return previous;

  let state;
  try { state=await productState(db,body); } catch { return json({error:'canonical_product_stage_error',stage:'product'},500); }
  if (!state) return json({error:'product_not_found',product_id:body.product_id},409);
  if (Number(state.metadata_revision)!==body.expected_metadata_revision)
    return json({error:'stale_product',product_id:body.product_id,metadata_revision:Number(state.metadata_revision)},409);
  if (Number(state.tracks_inventory)!==1 && body.stock_min_quantity!==0) return json({error:'invalid_product_update',field:'stock_min_quantity'},400);
  if (state.code_owner) {
    const owner=JSON.parse(state.code_owner);
    return json({error:'product_code_conflict',code:owner.code,product_id:owner.product_id,product_name:owner.name},409);
  }

  const revision=body.expected_metadata_revision+1;
  const result={
    status:'created',command:'product.update',operation_id:body.operation_id,product_id:body.product_id,
    promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,metadata_revision:revision,idempotent:false
  };
  try {
    await db.prepare(`INSERT INTO canonical_product_revisions
      (operation_id,promotion_id,product_id,command,request_hash,result_json,revision,name,sku,barcode,alternate_codes_json,category,brand,description,icon,
       cost_cents,price_cents,box_price_cents,units_per_box,stock_min_quantity,expiry_date,authority_epoch,control_revision,client_contract,principal_id,credential_hash,created_at)
      VALUES(?1,?2,?3,'product.update',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)`)
      .bind(body.operation_id,body.promotion_id,body.product_id,requestHash,stableStringify(result),revision,body.name,body.sku,body.barcode,
        JSON.stringify(body.alternate_codes),body.category,body.brand,body.description,body.icon,body.cost_cents,body.price_cents,
        body.box_price_cents,body.units_per_box,body.stock_min_quantity,body.expiry_date,body.authority_epoch,body.expected_control_revision,
        body.client_contract,auth.principalId,auth.credentialHash,body.created_at).run();
  } catch (error) {
    try {
      const again=await replay(); if (again) return again;
      const now=await updatePreflight(db,auth,body);
      const stale=authorityFrom(now,auth,body); if (stale) return json({error:stale},409);
      const message=String(error && error.message || '');
      if (/operation_id_conflict/.test(message)) return json({error:'operation_id_conflict',operation_id:body.operation_id},409);
      const fresh=await productState(db,body);
      if (!fresh) return json({error:'product_not_found',product_id:body.product_id},409);
      if (Number(fresh.metadata_revision)!==body.expected_metadata_revision)
        return json({error:'stale_product',product_id:body.product_id,metadata_revision:Number(fresh.metadata_revision)},409);
      if (fresh.code_owner) {
        const owner=JSON.parse(fresh.code_owner);
        return json({error:'product_code_conflict',code:owner.code,product_id:owner.product_id,product_name:owner.name},409);
      }
      return json({error:'canonical_product_conflict',operation_id:body.operation_id},409);
    } catch { return json({error:'canonical_product_stage_error',stage:'recovery'},500); }
  }
  return json(result,201);
}
