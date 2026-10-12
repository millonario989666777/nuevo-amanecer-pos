import { getDatabase } from './database-binding.js';
import { sha256Hex,stableStringify } from './a5-import-core.js';
import { phoneConflict,validCustomerDocument } from './a6-customers.js';
const validId=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);
const uint=v=>Number.isSafeInteger(v)&&v>=0;
// Effective DNI/RUC owner (latest identity edit, else imported/live base row).
async function documentOwner(db,promotionId,document,exceptCustomerId){
  return await db.prepare(`SELECT customer_id,name FROM canonical_customer_effective_identity
    WHERE promotion_id=?1 AND customer_id<>?3 AND lower(trim(COALESCE(document,'')))=?2 LIMIT 1`).bind(promotionId,document,exceptCustomerId).first()||null;
}
async function authority(db,auth,b){const c=await db.prepare(`SELECT c.*,d.role,d.status,d.credential_hash FROM canonical_control c JOIN devices d ON d.device_id=?1 WHERE c.id=1`).bind(auth.principalId).first();return !!c&&c.mode==='ACTIVE'&&c.active_promotion_id===b.promotion_id&&Number(c.authority_epoch)===b.authority_epoch&&Number(c.revision)===b.expected_control_revision&&c.minimum_client_contract===b.client_contract&&c.role==='writer'&&c.status==='active'&&c.credential_hash===auth.credentialHash;}
export async function setCanonicalCustomerContact(request,env,auth,json){
  let b;try{b=await request.json();}catch{return json({error:'invalid_json'},400);}
  const allowed=['operation_id','promotion_id','customer_id','authority_epoch','expected_control_revision','client_contract','created_at','name','phone','expected_contact_revision','document','address'];
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!allowed.includes(k))||!['operation_id','promotion_id','customer_id','client_contract'].every(k=>validId(b[k]))||!['authority_epoch','expected_control_revision','expected_contact_revision'].every(k=>uint(b[k]))||typeof b.name!=='string'||!b.name.trim()||b.name.length>240||/[\x00-\x1f\x7f]/.test(b.name)||!(b.phone===null||typeof b.phone==='string'&&/^\+[1-9]\d{8,14}$/.test(b.phone))||typeof b.created_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(b.created_at)||!Number.isFinite(Date.parse(b.created_at)))return json({error:'invalid_customer_contact'},400);
  // Optional identity (DNI/RUC + address): both keys travel together; null clears.
  const identity=('document' in b)||('address' in b);
  if(identity&&(!('document' in b)||!('address' in b)||!(b.document===null||typeof b.document==='string'&&validCustomerDocument(b.document))||!(b.address===null||typeof b.address==='string'&&b.address.trim().length>0&&b.address.length<=500&&!/[\x00-\x1f\x7f]/.test(b.address))))return json({error:'invalid_customer_identity'},400);
  b={...b,name:b.name.trim().replace(/\s+/g,' ')};
  if(identity&&b.address!==null)b.address=b.address.trim().replace(/\s+/g,' ');
  const db=getDatabase(env);
  const ready=await db.prepare("SELECT COUNT(*) n,(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='canonical_customer_identities') identity FROM sqlite_master WHERE type='table' AND name='canonical_customer_contacts'").first();
  if(Number(ready?.n)!==1)return json({error:'customer_contact_schema_not_ready'},503);
  if(identity&&Number(ready?.identity)!==1)return json({error:'customer_identity_schema_not_ready'},503);
  if(!await authority(db,auth,b))return json({error:'stale_authority'},409);
  const hash=await sha256Hex(stableStringify(b));
  const previous=await db.prepare('SELECT request_hash,result_json FROM canonical_customer_contacts WHERE operation_id=?1').bind(b.operation_id).first();
  if(previous)return previous.request_hash===hash?json({...JSON.parse(previous.result_json),status:'already_processed',idempotent:true}):json({error:'operation_id_conflict'},409);
  const customer=await db.prepare('SELECT customer_id FROM canonical_customer_registry WHERE promotion_id=?1 AND customer_id=?2').bind(b.promotion_id,b.customer_id).first();
  if(!customer)return json({error:'customer_not_found'},409);
  // P1-4: a WhatsApp number belongs to one customer (effective phones, self excluded).
  const owner=b.phone?await phoneConflict(db,b.promotion_id,b.phone,b.customer_id,true):null;
  if(owner)return json({error:'customer_phone_conflict',customer_id:owner.customer_id,customer_name:owner.name},409);
  // DNI/RUC belongs to one customer (effective documents, self excluded).
  const docOwner=identity&&b.document?await documentOwner(db,b.promotion_id,b.document,b.customer_id):null;
  if(docOwner)return json({error:'customer_document_conflict',customer_id:docOwner.customer_id,customer_name:docOwner.name},409);
  const rev=await db.prepare('SELECT COALESCE(MAX(revision),0) revision FROM canonical_customer_contacts WHERE promotion_id=?1 AND customer_id=?2').bind(b.promotion_id,b.customer_id).first();
  if(Number(rev.revision)!==b.expected_contact_revision)return json({error:'stale_contact'},409);
  const result={status:'created',command:'customer.contact.set',operation_id:b.operation_id,customer_id:b.customer_id,promotion_id:b.promotion_id,authority_epoch:b.authority_epoch,contact_revision:b.expected_contact_revision+1,idempotent:false};
  try{
    const contact=db.prepare(`INSERT INTO canonical_customer_contacts(operation_id,promotion_id,customer_id,command,request_hash,result_json,name,phone,revision,authority_epoch,control_revision,client_contract,principal_id,credential_hash,created_at) VALUES(?1,?2,?3,'customer.contact.set',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`).bind(b.operation_id,b.promotion_id,b.customer_id,hash,stableStringify(result),b.name,b.phone,result.contact_revision,b.authority_epoch,b.expected_control_revision,b.client_contract,auth.principalId,auth.credentialHash,b.created_at);
    // Identity rides in the same atomic batch (same operation_id and revision).
    if(identity)await db.batch([contact,db.prepare(`INSERT INTO canonical_customer_identities(operation_id,promotion_id,customer_id,revision,document,address,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)`).bind(b.operation_id,b.promotion_id,b.customer_id,result.contact_revision,b.document,b.address,b.created_at)]);
    else await contact.run();
  }catch{
    if(!await authority(db,auth,b))return json({error:'stale_authority'},409);
    const replay=await db.prepare('SELECT request_hash,result_json FROM canonical_customer_contacts WHERE operation_id=?1').bind(b.operation_id).first();
    if(replay)return replay.request_hash===hash?json({...JSON.parse(replay.result_json),status:'already_processed',idempotent:true}):json({error:'operation_id_conflict'},409);
    const current=await db.prepare('SELECT COALESCE(MAX(revision),0) revision FROM canonical_customer_contacts WHERE promotion_id=?1 AND customer_id=?2').bind(b.promotion_id,b.customer_id).first();
    if(Number(current.revision)!==b.expected_contact_revision)return json({error:'stale_contact'},409);
    const raced=identity&&b.document?await documentOwner(db,b.promotion_id,b.document,b.customer_id):null;
    if(raced)return json({error:'customer_document_conflict',customer_id:raced.customer_id,customer_name:raced.name},409);
    return json({error:'customer_contact_conflict'},409);
  }
  return json(result,201);
}
