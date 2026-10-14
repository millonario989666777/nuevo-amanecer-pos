import { getDatabase } from './database-binding.js';
import { sha256Hex, stableStringify } from './a5-import-core.js';
import { lotsCore, lotsReady, productLots, effectStatements, receiptStatements, annulAllocations, lotError } from './stock-lots.js';

export const INVENTORY_COMMANDS = new Set(['inventory.adjust']);

const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TIMESTAMP=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TYPES=new Set(['ENTRADA','SALIDA']);

function validId(value){return typeof value==='string'&&SAFE_ID.test(value);}
function uint(value){return Number.isSafeInteger(value)&&value>=0;}
function finitePositive(value){return typeof value==='number'&&Number.isFinite(value)&&value>0;}
function cleanReason(value){
  if(typeof value!=='string')return null;
  const out=value.trim().replace(/\s+/g,' ');
  return out&&out.length<=500&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(out)?out:null;
}

function normalize(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return{error:'invalid_inventory_request'};
  const allowed=new Set(['operation_id','promotion_id','authority_epoch','expected_control_revision','client_contract','created_at','product_id','movement_type','quantity','expected_stock_revision','reason','lots','allow_expired_lots']);
  if(Object.keys(body).some((key)=>!allowed.has(key)))return{error:'invalid_inventory_request'};
  for(const key of ['operation_id','promotion_id','client_contract','product_id'])if(!validId(body[key]))return{error:'invalid_inventory_request',field:key};
  if(!uint(body.authority_epoch)||!uint(body.expected_control_revision)||!uint(body.expected_stock_revision))return{error:'invalid_inventory_request'};
  if(typeof body.created_at!=='string'||!TIMESTAMP.test(body.created_at)||!Number.isFinite(Date.parse(body.created_at)))return{error:'invalid_inventory_request',field:'created_at'};
  const type=String(body.movement_type||'').trim().toUpperCase();
  if(!TYPES.has(type)||!finitePositive(body.quantity))return{error:'invalid_inventory_request'};
  const reason=cleanReason(body.reason);
  if(!reason)return{error:'invalid_inventory_request',field:'reason'};
  const delta=type==='ENTRADA'?body.quantity:-body.quantity;
  const extra={};
  if(body.lots!==undefined){
    if(type!=='ENTRADA'||body.return_sale_operation!==undefined)return{error:'invalid_inventory_lots'};
    try{extra.lots=lotsCore.normalizeReceipts(body.lots,body.quantity);}catch{return{error:'invalid_inventory_lots'};}
  }
  if(body.allow_expired_lots!==undefined){if(typeof body.allow_expired_lots!=='boolean'||type!=='SALIDA')return{error:'invalid_inventory_lots'};extra.allow_expired_lots=body.allow_expired_lots;}
  return{value:{
    operation_id:body.operation_id,promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,
    expected_control_revision:body.expected_control_revision,client_contract:body.client_contract,
    created_at:body.created_at,product_id:body.product_id,movement_type:type,quantity:body.quantity,
    delta,expected_stock_revision:body.expected_stock_revision,reason,...extra
  }};
}

async function schemaReady(db){
  const row=await db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('canonical_inventory_operations','canonical_manual_inventory_movements')").first();
  return Number(row?.count)===2;
}

async function authorityError(db,auth,body){
  const control=await db.prepare(`SELECT c.*,d.role AS device_role,d.status AS device_status,d.credential_hash
    FROM canonical_control c LEFT JOIN devices d ON d.device_id=?1 WHERE c.id=1`).bind(auth.principalId).first();
  if(!control||control.mode!=='ACTIVE')return'canonical_not_active';
  if(control.active_promotion_id!==body.promotion_id||Number(control.authority_epoch)!==body.authority_epoch||
     Number(control.revision)!==body.expected_control_revision||control.minimum_client_contract!==body.client_contract||
     control.device_role!=='writer'||control.device_status!=='active'||control.credential_hash!==auth.credentialHash)return'stale_authority';
  return null;
}

async function operationConflict(db,operationId){
  const row=await db.prepare(`SELECT operation_id FROM (
    SELECT operation_id FROM sales WHERE operation_id=?1
    UNION ALL SELECT operation_id FROM canonical_financial_operations WHERE operation_id=?1
    UNION ALL SELECT operation_id FROM canonical_expense_operations WHERE operation_id=?1
    UNION ALL SELECT operation_id FROM canonical_product_operations WHERE operation_id=?1
    UNION ALL SELECT operation_id FROM canonical_credit_accounts WHERE operation_id=?1
  ) LIMIT 1`).bind(operationId).first();
  return !!row;
}

async function findProduct(db,body){
  let row=await db.prepare(`SELECT product_id,current_stock_quantity,stock_revision,tracks_inventory,'IMPORT' AS provenance
    FROM products WHERE promotion_id=?1 AND product_id=?2`).bind(body.promotion_id,body.product_id).first();
  if(!row)row=await db.prepare(`SELECT product_id,current_stock_quantity,stock_revision,tracks_inventory,'LIVE' AS provenance
    FROM canonical_live_products WHERE promotion_id=?1 AND product_id=?2`).bind(body.promotion_id,body.product_id).first();
  return row;
}

export async function adjustCanonicalInventory(request,env,auth,json,internalReturn=null){
  let raw;try{raw=await request.json();}catch{return json({error:'invalid_json'},400);}
  const checked=normalize(raw);
  if(checked.error)return json({error:checked.error,...(checked.field?{field:checked.field}:{})},400);
  const body=checked.value,db=getDatabase(env);
  // Only the annulment orchestrator can request original allocations. No public
  // inventory payload can forge a return or add another reversal line.
  if(internalReturn){if(body.movement_type!=='ENTRADA'||body.lots!==undefined)return json({error:'invalid_lot_return'},400);body.return_sale_operation=internalReturn.operation_id;}

  if(!await schemaReady(db))return json({error:'inventory_schema_not_ready'},503);
  const denied=await authorityError(db,auth,body);
  if(denied)return json({error:denied},409);

  const requestHash=await sha256Hex(stableStringify(body));
  const existing=await db.prepare('SELECT request_hash,result_json FROM canonical_inventory_operations WHERE operation_id=?1').bind(body.operation_id).first();
  if(existing){
    const stale=await authorityError(db,auth,body);if(stale)return json({error:stale},409);
    if(existing.request_hash!==requestHash)return json({error:'operation_id_conflict',operation_id:body.operation_id},409);
    return json({...JSON.parse(existing.result_json),status:'already_processed',idempotent:true},200);
  }
  if(await operationConflict(db,body.operation_id))return json({error:'operation_id_conflict',operation_id:body.operation_id},409);

  const product=await findProduct(db,body);
  if(!product)return json({error:'product_not_found',product_id:body.product_id},404);
  if(Number(product.tracks_inventory)!==1)return json({error:'product_inventory_disabled',product_id:body.product_id},409);
  if(Number(product.stock_revision)!==body.expected_stock_revision)return json({error:'stale_stock',product_id:body.product_id},409);

  const before=Number(product.current_stock_quantity);
  if(!Number.isFinite(before)||before<0)return json({error:'invalid_stock_state',product_id:body.product_id},409);
  const after=before+body.delta;
  if(!Number.isFinite(after)||after<0)return json({error:'insufficient_stock',product_id:body.product_id,current_stock_quantity:before},409);

  const lotSchema=await lotsReady(db);
  if(!lotSchema&&(body.lots?.length||body.return_sale_operation||body.allow_expired_lots))return json({error:'lots_schema_not_ready'},503);
  let rows=[],allocations=[];
  if(lotSchema){
    rows=await productLots(db,body.promotion_id,body.product_id);
    try{
      // Validate coherence also on entry; an input cannot silently repair corruption.
      if(rows.length)lotsCore.plan(before,rows,Math.max(1e-9,before),'9999-12-31',true);
      if(body.return_sale_operation)allocations=await annulAllocations(db,body);
      else if(body.movement_type==='SALIDA')allocations=lotsCore.plan(before,rows,body.quantity,lotsCore.businessDate(body.created_at),body.allow_expired_lots).allocations;
    }catch(error){return json({error:body.return_sale_operation?'invalid_lot_return':lotError(error)},409);}
  }

  const movementId=crypto.randomUUID();
  const result={
    status:'created',command:'inventory.adjust',operation_id:body.operation_id,movement_id:movementId,
    promotion_id:body.promotion_id,authority_epoch:body.authority_epoch,product_id:body.product_id,
    product_provenance:product.provenance,movement_type:body.movement_type,quantity:body.quantity,delta:body.delta,
    stock_before:before,stock_after:after,stock_revision_before:body.expected_stock_revision,
    stock_revision_after:body.expected_stock_revision+1,idempotent:false
  };
  const token='inventory:'+crypto.randomUUID();
  const productTable=product.provenance==='LIVE'?'canonical_live_products':'products';

  const statements=[
    db.prepare(`INSERT INTO canonical_inventory_operations
      (operation_id,command,request_hash,result_json,promotion_id,product_id,movement_type,quantity,delta,expected_stock_revision,reason,authority_epoch,control_revision,client_contract,principal_id,credential_hash,created_at)
      VALUES(?1,'inventory.adjust',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`)
      .bind(body.operation_id,requestHash,stableStringify(result),body.promotion_id,body.product_id,body.movement_type,body.quantity,body.delta,body.expected_stock_revision,body.reason,body.authority_epoch,body.expected_control_revision,body.client_contract,auth.principalId,auth.credentialHash,body.created_at),
    db.prepare('INSERT INTO canonical_assertions(assertion_id,ok) VALUES(?1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)').bind(token+':operation'),
    db.prepare(`UPDATE ${productTable} SET current_stock_quantity=current_stock_quantity+?1,stock_revision=stock_revision+1
      WHERE promotion_id=?2 AND product_id=?3 AND stock_revision=?4 AND tracks_inventory=1 AND current_stock_quantity+?1>=0`)
      .bind(body.delta,body.promotion_id,body.product_id,body.expected_stock_revision),
    db.prepare(`INSERT INTO canonical_manual_inventory_movements
      (movement_id,operation_id,promotion_id,product_id,product_provenance,movement_type,quantity,delta,stock_before,stock_after,stock_revision_before,stock_revision_after,reason,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14 WHERE changes()=1`)
      .bind(movementId,body.operation_id,body.promotion_id,body.product_id,product.provenance,body.movement_type,body.quantity,body.delta,before,after,body.expected_stock_revision,body.expected_stock_revision+1,body.reason,body.created_at),
    db.prepare('INSERT INTO canonical_assertions(assertion_id,ok) VALUES(?1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)').bind(token+':movement'),
    db.prepare('DELETE FROM canonical_assertions WHERE assertion_id IN (?1,?2)').bind(token+':operation',token+':movement')
  ];
  if(lotSchema){
    // Cleanup remains last: asserts participate in the stock/movement transaction.
    statements.splice(statements.length-1,0,
      ...(body.return_sale_operation?effectStatements(db,body,allocations,1,rows,token):
        body.movement_type==='SALIDA'?effectStatements(db,body,allocations,-1,rows,token):receiptStatements(db,body)),
      db.prepare('DELETE FROM canonical_assertions WHERE assertion_id LIKE ?1').bind(token+':lot:%'));
  }

  try{await db.batch(statements);}
  catch{
    const replay=await db.prepare('SELECT request_hash,result_json FROM canonical_inventory_operations WHERE operation_id=?1').bind(body.operation_id).first();
    const stale=await authorityError(db,auth,body);if(stale)return json({error:stale},409);
    if(replay?.request_hash===requestHash)return json({...JSON.parse(replay.result_json),status:'already_processed',idempotent:true},200);
    if(replay)return json({error:'operation_id_conflict',operation_id:body.operation_id},409);
    const current=await findProduct(db,body);
    if(current&&Number(current.stock_revision)!==body.expected_stock_revision)return json({error:'stale_stock',product_id:body.product_id},409);
    return json({error:'canonical_inventory_conflict',operation_id:body.operation_id},409);
  }
  return json(result,201);
}
