
// Nucleo V10 inactivo: infraestructura de concurrencia para integracion en fases posteriores.
const _NA_V10_DB_VERSION=2;
const _NA_V10_STATE_STORE='state';
const _NA_V10_OPERATIONS_STORE='operations';
const _NA_V10_CHECKPOINTS_STORE='checkpoints';
const _NA_V10_SNAPSHOT_KEY='snapshot_v10';
const _NA_V10_LOCK_NAME='nuevo-amanecer:financial-write:v10';
const _NA_V10_CHANNEL_NAME='nuevo-amanecer:persistence:v10';
const _NA_V10_PHASE_A_VERSION='persistence-v10-phase-a-2026-08-13-2';
const _NA_V10_STATUSES=Object.freeze({PENDING:'PENDING',COMMITTED:'COMMITTED',ROLLED_BACK:'ROLLED_BACK',CONFLICT:'CONFLICT'});
const _NA_V10_RESULTS=Object.freeze({SUCCESS:'SUCCESS',ALREADY_COMMITTED:'ALREADY_COMMITTED',CONFLICT:'CONFLICT',PERSISTENCE_ERROR:'PERSISTENCE_ERROR'});

let _naV10DbPromise=null,_naV10TabId=null,_naV10Channel=null,_naV10LastBroadcast=null;
const _naV10EvidenceTimes=new Map();
let _naV10Runtime={dbName:_NA_DB_NAME,localMirrorKey:'na_snapshot_v10',localSignalKey:'na_snapshot_v10_signal',sessionOutboxKey:'na_v10_outbox',lockName:_NA_V10_LOCK_NAME,channelName:_NA_V10_CHANNEL_NAME,broadcastEnabled:true};

const _naV10Clone=value=>{try{return structuredClone(value);}catch(error){return value===undefined?undefined:JSON.parse(JSON.stringify(value));}};
const _naV10Now=()=>new Date().toISOString();
function _naNewUuid(){
  if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();
  if(!globalThis.crypto?.getRandomValues)throw new Error('No existe una fuente criptografica para generar UUID');
  const bytes=new Uint8Array(16);globalThis.crypto.getRandomValues(bytes);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
  return`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const _naNewOperationId=()=>`op_${_naNewUuid()}`;
const _naNewCommitId=()=>`commit_${_naNewUuid()}`;
function _naGetTabId(){if(!_naV10TabId)_naV10TabId=`tab_${_naNewUuid()}`;return _naV10TabId;}
function _naV10Error(code,message,cause=null){const error=new Error(message);error.code=code;if(cause)error.cause=cause;return error;}
function _naV10Result(status,extra={}){return{status,...extra};}
function _naV10ConfigureRuntime(options={}){
  if(_naV10DbPromise)throw _naV10Error('V10_ALREADY_OPEN','No se puede cambiar el namespace V10 despues de abrir IndexedDB');
  if(_naV10Channel){try{_naV10Channel.close();}catch(error){}_naV10Channel=null;}
  const allowed=['dbName','localMirrorKey','localSignalKey','sessionOutboxKey','lockName','channelName','broadcastEnabled'];
  for(const key of allowed)if(Object.prototype.hasOwnProperty.call(options,key))_naV10Runtime[key]=options[key];
  return _naV10Clone(_naV10Runtime);
}
async function _naV10PrepareUpgrade(){
  if(typeof _naDbPromise!=='undefined'&&_naDbPromise){try{const legacyDb=await _naDbPromise;legacyDb?.close();}catch(error){}_naDbPromise=null;}
  return true;
}
function _naV10OpenDB(){
  if(_naV10DbPromise)return _naV10DbPromise;
  const attempt=new Promise((resolve,reject)=>{
    if(!globalThis.indexedDB){reject(_naV10Error('IDB_UNAVAILABLE','IndexedDB no esta disponible'));return;}
    let settled=false,request;
    const finish=(method,value)=>{if(settled)return;settled=true;method(value);};
    try{request=indexedDB.open(_naV10Runtime.dbName,_NA_V10_DB_VERSION);}catch(error){finish(reject,_naV10Error('IDB_OPEN_FAILED','No se pudo solicitar IndexedDB V10',error));return;}
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(_NA_V10_STATE_STORE))db.createObjectStore(_NA_V10_STATE_STORE);
      if(!db.objectStoreNames.contains(_NA_V10_OPERATIONS_STORE))db.createObjectStore(_NA_V10_OPERATIONS_STORE,{keyPath:'operationId'});
      if(!db.objectStoreNames.contains(_NA_V10_CHECKPOINTS_STORE))db.createObjectStore(_NA_V10_CHECKPOINTS_STORE,{keyPath:'key'});
    };
    request.onblocked=()=>finish(reject,_naV10Error('UPGRADE_BLOCKED','La actualizacion de persistencia esta bloqueada. Cierra o recarga las otras pestañas de Nuevo Amanecer.'));
    request.onerror=()=>finish(reject,_naV10Error('IDB_OPEN_FAILED','No se pudo abrir IndexedDB V10',request.error));
    request.onsuccess=()=>{
      if(settled){request.result.close();return;}
      const db=request.result;db.onversionchange=()=>{db.close();if(_naV10DbPromise)_naV10DbPromise=null;};finish(resolve,db);
    };
  });
  _naV10DbPromise=attempt.catch(error=>{_naV10DbPromise=null;throw error;});
  return _naV10DbPromise;
}
async function _naV10CloseDB(){
  if(!_naV10DbPromise)return;
  try{const db=await _naV10DbPromise;db?.close();}catch(error){}
  _naV10DbPromise=null;
}
function _naV10Request(request){return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error||new Error('IndexedDB request failed'));});}
async function _naV10ReadStateValue(key){const db=await _naV10OpenDB(),tx=db.transaction(_NA_V10_STATE_STORE,'readonly');return _naV10Request(tx.objectStore(_NA_V10_STATE_STORE).get(key));}
async function _naV10ReadCanonical(){const snapshot=await _naV10ReadStateValue(_NA_V10_SNAPSHOT_KEY);return snapshot?_naV10Clone(snapshot):null;}
async function _naV10GetOperation(operationId){const db=await _naV10OpenDB(),tx=db.transaction(_NA_V10_OPERATIONS_STORE,'readonly'),record=await _naV10Request(tx.objectStore(_NA_V10_OPERATIONS_STORE).get(operationId));return record?_naV10Clone(record):null;}
async function _naV10GetCheckpoint(key){const db=await _naV10OpenDB(),tx=db.transaction(_NA_V10_CHECKPOINTS_STORE,'readonly'),record=await _naV10Request(tx.objectStore(_NA_V10_CHECKPOINTS_STORE).get(key));return record?_naV10Clone(record):null;}

function _naV10ValidSnapshot(snapshot){
  if(!snapshot||snapshot.version!==10||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||typeof snapshot.commitId!=='string'||!snapshot.commitId||typeof snapshot.lastOperationId!=='string'||!snapshot.lastOperationId||typeof snapshot.writerId!=='string'||!snapshot.writerId||!snapshot.committedAt||!snapshot.data||typeof snapshot.data!=='object')return false;
  if(!_naV10ValidateSnapshotJsonSafe(snapshot).ok)return false;
  if(snapshot.revision===0)return snapshot.parentRevision===null;
  return Number.isSafeInteger(snapshot.parentRevision)&&snapshot.parentRevision===snapshot.revision-1;
}
function _naV10CompareSnapshots(left,right){
  if(!_naV10ValidSnapshot(left)||!_naV10ValidSnapshot(right))return{ok:false,conflict:true,reason:'INVALID_SNAPSHOT'};
  if(left.revision===right.revision&&left.commitId!==right.commitId)return{ok:false,conflict:true,reason:'REVISION_COMMIT_MISMATCH',revision:left.revision,leftCommitId:left.commitId,rightCommitId:right.commitId};
  return{ok:true,conflict:false,newer:left.revision===right.revision?'SAME':left.revision>right.revision?'LEFT':'RIGHT'};
}
function _naV10StableValue(value){
  if(Array.isArray(value))return value.map(_naV10StableValue);
  if(value&&typeof value==='object'){const out={};Object.keys(value).sort().forEach(key=>{out[key]=_naV10StableValue(value[key]);});return out;}
  return value;
}
function _naV10IdempotencyKey(payload){if(!_naV10IsJsonSafe(payload??null,new Set()))throw _naV10Error('NON_JSON_SAFE_IDEMPOTENCY_PAYLOAD','El payload de idempotencia no es JSON-safe');return JSON.stringify(_naV10StableValue(payload??null));}
async function _naV10PayloadHash(payload){
  const text=_naV10IdempotencyKey(payload);
  if(globalThis.crypto?.subtle&&globalThis.TextEncoder){const bytes=new TextEncoder().encode(text),digest=await crypto.subtle.digest('SHA-256',bytes);return'sha256:'+Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');}
  let hash=2166136261;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}return`fnv1a:${(hash>>>0).toString(16).padStart(8,'0')}`;
}
function _naV10EvidenceDetectedAt(kind,raw){const key=kind+'\n'+String(raw??'');if(!_naV10EvidenceTimes.has(key))_naV10EvidenceTimes.set(key,_naV10Now());return _naV10EvidenceTimes.get(key);}
function _naV10ReadOutbox(){
  let raw;
  try{raw=sessionStorage.getItem(_naV10Runtime.sessionOutboxKey);}catch(error){return{state:'READ_ERROR',entries:null,rawValue:null,detectedAt:_naV10EvidenceDetectedAt('OUTBOX_READ_ERROR',error?.message||String(error)),error:{name:error?.name||'StorageError',message:error?.message||String(error)}};}
  if(raw===null)return{state:'EMPTY',entries:{},rawValue:null,detectedAt:null,error:null};
  let parsed;
  try{parsed=JSON.parse(raw);}catch(error){return{state:'CORRUPT',entries:null,rawValue:raw,detectedAt:_naV10EvidenceDetectedAt('OUTBOX_CORRUPT',raw),error:{name:error?.name||'SyntaxError',message:error?.message||String(error)}};}
  if(!_naV10IsPlainObject(parsed))return{state:'CORRUPT',entries:null,rawValue:raw,detectedAt:_naV10EvidenceDetectedAt('OUTBOX_CORRUPT',raw),error:{code:'OUTBOX_NOT_PLAIN_OBJECT',message:'El outbox no es un objeto plano'}};
  for(const [operationId,record] of Object.entries(parsed)){
    const validation=_naV10ValidateJournalRecordStrict(record,'OUTBOX_READ');
    if(!validation.valid||operationId!==record.operationId)return{state:'CORRUPT',entries:null,rawValue:raw,detectedAt:_naV10EvidenceDetectedAt('OUTBOX_CORRUPT',raw),error:{code:'OUTBOX_ENTRY_INVALID',message:validation.reason||'La clave no coincide con operationId',operationId}};
  }
  return{state:'VALID',entries:_naV10Clone(parsed),rawValue:raw,detectedAt:null,error:null};
}
function _naV10StorageWarning(code,error,extra={}){return{code,message:error?.message||String(error),name:error?.name||'StorageError',...extra};}
function _naV10WriteOutboxRecord(record){
  const validation=_naV10ValidateJournalRecordStrict(record,'OUTBOX_WRITE');
  if(!validation.valid)return{ok:false,preserved:true,state:'INVALID_RECORD',evidence:_naV10JournalEvidence(record,validation,'OUTBOX_WRITE'),warning:{code:'OUTBOX_RECORD_INVALID',message:validation.reason,operationId:record?.operationId||null}};
  const read=_naV10ReadOutbox();
  if(read.state==='CORRUPT'||read.state==='READ_ERROR')return{ok:false,preserved:true,state:read.state,evidence:read,warning:{code:'OUTBOX_EVIDENCE_UNAVAILABLE',message:'El outbox existente no puede sobrescribirse',operationId:record.operationId}};
  try{const entries=read.state==='VALID'?read.entries:{};entries[record.operationId]=_naV10Clone(record);sessionStorage.setItem(_naV10Runtime.sessionOutboxKey,JSON.stringify(entries));return{ok:true,state:'VALID'};}catch(error){return{ok:false,preserved:true,state:'WRITE_ERROR',warning:_naV10StorageWarning('OUTBOX_WRITE_FAILED',error,{operationId:record.operationId})};}
}
const _naV10OutboxDeletion=(()=>{
function removeVerified(operationId){
  const read=_naV10ReadOutbox();
  if(read.state==='CORRUPT'||read.state==='READ_ERROR')return{ok:false,preserved:true,state:read.state,evidence:read,warning:{code:'OUTBOX_EVIDENCE_UNAVAILABLE',message:'El outbox corrupto o ilegible se conserva intacto',operationId}};
  if(read.state==='EMPTY')return{ok:true,state:'EMPTY',idempotent:true};
  try{const entries=read.entries;if(!Object.prototype.hasOwnProperty.call(entries,operationId))return{ok:true,state:'VALID',idempotent:true};delete entries[operationId];if(Object.keys(entries).length)sessionStorage.setItem(_naV10Runtime.sessionOutboxKey,JSON.stringify(entries));else sessionStorage.removeItem(_naV10Runtime.sessionOutboxKey);return{ok:true,state:Object.keys(entries).length?'VALID':'EMPTY'};}catch(error){return{ok:false,preserved:true,state:'WRITE_ERROR',warning:_naV10StorageWarning('OUTBOX_REMOVE_FAILED',error,{operationId})};}
}
async function verifyAndRemove(operationId){
  const resolved=await _naV10ResolveOperation(operationId);
  if(resolved.status!==_NA_V10_STATUSES.COMMITTED)return{ok:false,preserved:true,state:'PROOF_REQUIRED',verification:resolved,warning:{code:'OUTBOX_DELETE_PROOF_REQUIRED',message:'La evidencia durable actual no demuestra el commit; el outbox se conserva',operationId}};
  const removal=removeVerified(operationId);return{...removal,verified:true,revision:resolved.revision,commitId:resolved.commitId,verification:resolved};
}
return Object.freeze({verifyAndRemove});
})();
function _naV10WriteMirror(snapshot){
  try{
    if(!_naV10ValidSnapshot(snapshot))return{ok:false,conflict:true,reason:'INVALID_SNAPSHOT',warning:{code:'MIRROR_INVALID_SNAPSHOT',message:'El mirror rechazo un snapshot invalido'}};
    let current=null;try{current=JSON.parse(localStorage.getItem(_naV10Runtime.localMirrorKey)||'null');}catch(error){}
    if(_naV10ValidSnapshot(current)){
      const comparison=_naV10CompareSnapshots(current,snapshot);
      if(comparison.conflict){localStorage.setItem(`${_naV10Runtime.localMirrorKey}_conflict_${snapshot.commitId}`,JSON.stringify(snapshot));return{ok:false,conflict:true,reason:comparison.reason,warning:{code:'MIRROR_IDENTITY_CONFLICT',message:comparison.reason}};}
      if(current.revision>snapshot.revision)return{ok:false,conflict:true,reason:'MIRROR_AHEAD',mirrorRevision:current.revision,warning:{code:'MIRROR_AHEAD',message:'El mirror local contiene una revision superior'}};
      if(current.revision===snapshot.revision&&current.commitId===snapshot.commitId)return{ok:true,idempotent:true};
    }
    localStorage.setItem(_naV10Runtime.localMirrorKey,JSON.stringify(snapshot));
    localStorage.setItem(_naV10Runtime.localSignalKey,JSON.stringify({revision:snapshot.revision,commitId:snapshot.commitId,operationId:snapshot.lastOperationId,writerId:snapshot.writerId,committedAt:snapshot.committedAt}));
    return{ok:true,idempotent:false};
  }catch(error){return{ok:false,warning:_naV10StorageWarning('MIRROR_WRITE_FAILED',error,{revision:snapshot?.revision??null,commitId:snapshot?.commitId||null})};}
}
function _naV10GetChannel(){
  if(!_naV10Runtime.broadcastEnabled||typeof BroadcastChannel!=='function')return null;
  if(_naV10Channel)return _naV10Channel;
  _naV10Channel=new BroadcastChannel(_naV10Runtime.channelName);_naV10Channel.onmessage=event=>{_naV10LastBroadcast=_naV10Clone(event.data);window.dispatchEvent(new CustomEvent('na:v10-commit',{detail:_naV10Clone(event.data)}));};return _naV10Channel;
}
function _naV10PublishCommit(snapshot){
  const message={revision:snapshot.revision,commitId:snapshot.commitId,operationId:snapshot.lastOperationId,writerId:snapshot.writerId};
  try{const channel=_naV10GetChannel();if(!channel)return{ok:false,skipped:true,message};channel.postMessage(message);return{ok:true,skipped:false,message};}catch(error){return{ok:false,skipped:false,error:{name:error.name||'BroadcastError',message:error.message||String(error)}};}
}
async function _naV10WithExclusiveLock(work){
  if(navigator.locks?.request)return navigator.locks.request(_naV10Runtime.lockName,{mode:'exclusive'},work);
  return work();
}
function _naV10Attempt(kind,baseRevision,rebaseOf=null){const now=_naV10Now();return{attemptId:`attempt_${_naNewUuid()}`,kind,baseRevision,status:_NA_V10_STATUSES.PENDING,rebaseOf:rebaseOf||null,tabId:_naGetTabId(),createdAt:now,updatedAt:now,reason:null,currentRevision:null,error:null};}
function _naV10SaleIdempotencyPayload(payload){
  if(!payload||typeof payload!=='object')return _naV10Clone(payload??null);
  const excluded=new Set(['operationId','logicalOperationId','attemptId','rebaseOf','expectedRevision','timestamp','_built']);
  const stable={};Object.keys(payload).forEach(key=>{if(!excluded.has(key))stable[key]=_naV10Clone(payload[key]);});return stable;
}
function _naV10NormalizeOperationRecord(source){
  return source?_naV10Clone(source):null;
}
function _naV10UpdateAttempt(record,attemptId,patch){record.attemptHistory=(record.attemptHistory||[]).map(item=>item.attemptId===attemptId?{...item,..._naV10Clone(patch),updatedAt:patch.updatedAt||_naV10Now()}:item);return record;}
function _naV10SpecIdentityPayload(spec){const raw=Object.prototype.hasOwnProperty.call(spec,'idempotencyPayload')?spec.idempotencyPayload:(spec.payload??null);if(!_naV10IsJsonSafe(raw,new Set()))throw _naV10Error('NON_JSON_SAFE_IDEMPOTENCY_PAYLOAD','El payload de idempotencia no es JSON-safe');return _naV10Clone(raw);}
function _naV10BuildJournalRecord(spec,operationId,identity){const now=_naV10Now(),attempt=_naV10Attempt('INITIAL',spec.expectedRevision);return{operationId,logicalOperationId:operationId,type:String(spec.type||'UNKNOWN').slice(0,80),status:_NA_V10_STATUSES.PENDING,journalSchemaVersion:2,baseRevision:spec.expectedRevision,committedRevision:null,commitId:null,checkpointKey:null,tabId:_naGetTabId(),createdAt:now,updatedAt:now,attempts:1,activeAttemptId:attempt.attemptId,attemptHistory:[attempt],payload:_naV10Clone(spec.payload??null),idempotencyPayload:_naV10Clone(identity.payload),idempotencyKey:identity.key,idempotencyHash:identity.hash,payloadHash:identity.hash,entityIds:_naV10Clone(spec.entityIds||[]),reason:null,mismatchEvidence:[],typeMismatchEvidence:[]};}
function _naV10ActiveAttempt(record){return(record?.attemptHistory||[]).find(attempt=>attempt?.attemptId===record?.activeAttemptId)||null;}
function _naV10SameContextValue(left,right){return _naV10IdempotencyKey(left??null)===_naV10IdempotencyKey(right??null);}
function _naV10RequestContextConflict(record,active,spec){
  if(record.status!==_NA_V10_STATUSES.COMMITTED&&record.baseRevision!==spec.expectedRevision)return'REBASE_REQUIRED';
  if(Object.prototype.hasOwnProperty.call(spec,'rebaseOf')&&(spec.rebaseOf||null)!==(active?.rebaseOf||null))return'REBASE_CONTEXT_MISMATCH';
  if(!_naV10SameContextValue(record.entityIds||[],spec.entityIds||[]))return'OPERATION_CONTEXT_MISMATCH';
  return null;
}
function _naV10AttachStorageWarning(warnings,result){if(result&&!result.ok&&result.warning)warnings.push(_naV10Clone(result.warning));return result;}
function _naV10ValidateJournalRecordStrict(record,context){
  if(!_naV10IsPlainObject(record))return{valid:false,reason:'RECORD_NOT_PLAIN_OBJECT',context};
  if(!_naV10IsJsonSafe(record,new Set()))return{valid:false,reason:'JOURNAL_NOT_JSON_SAFE',context};
  if(record.journalSchemaVersion!==2)return{valid:false,reason:'LEGACY_OR_UNKNOWN_JOURNAL',context,rawSchemaVersion:record.journalSchemaVersion??null};
  if(typeof record.operationId!=='string'||!record.operationId.trim())return{valid:false,reason:'INVALID_OPERATION_ID',context};
  if(typeof record.logicalOperationId!=='string'||record.logicalOperationId!==record.operationId)return{valid:false,reason:'INVALID_LOGICAL_OPERATION_ID',context};
  if(typeof record.type!=='string'||!record.type.trim()||record.type==='UNKNOWN')return{valid:false,reason:'INVALID_TYPE',context};
  const status=record.status,topStatuses=Object.values(_NA_V10_STATUSES);
  if(typeof status!=='string'||!topStatuses.includes(status))return{valid:false,reason:'UNKNOWN_OR_INVALID_STATUS',context,rawStatus:status??null};
  if(!Array.isArray(record.attemptHistory)||record.attemptHistory.length===0)return{valid:false,reason:'ATTEMPT_HISTORY_EMPTY_OR_INVALID',context};
  if(typeof record.activeAttemptId!=='string'||!record.activeAttemptId.trim())return{valid:false,reason:'ACTIVE_ATTEMPT_REQUIRED',context};
  if(!Number.isSafeInteger(record.attempts)||record.attempts!==record.attemptHistory.length)return{valid:false,reason:'ATTEMPT_COUNT_MISMATCH',context};
  if(!_naV10IsJsonSafe(record.payload,new Set())||!_naV10IsJsonSafe(record.idempotencyPayload,new Set()))return{valid:false,reason:'JOURNAL_PAYLOAD_NOT_JSON_SAFE',context};
  if(typeof record.idempotencyKey!=='string'||!record.idempotencyKey)return{valid:false,reason:'INVALID_IDEMPOTENCY_KEY',context};
  if(!Array.isArray(record.entityIds)||!Array.isArray(record.mismatchEvidence)||!Array.isArray(record.typeMismatchEvidence))return{valid:false,reason:'INVALID_JOURNAL_EVIDENCE_ARRAYS',context};
  const validKinds=new Set(['INITIAL','RETRY','TYPE_MISMATCH','PAYLOAD_MISMATCH','REBASE','INITIALIZE','MIGRATION']);
  const validAttemptStatuses=new Set([...topStatuses,_NA_V10_RESULTS.PERSISTENCE_ERROR,_NA_V10_RESULTS.SUCCESS,_NA_V10_RESULTS.ALREADY_COMMITTED]);
  const ids=new Set();
  for(let index=0;index<record.attemptHistory.length;index++){
    const attempt=record.attemptHistory[index];
    if(!_naV10IsPlainObject(attempt))return{valid:false,reason:'ATTEMPT_NOT_PLAIN_OBJECT',context,attemptIndex:index};
    if(typeof attempt.attemptId!=='string'||!attempt.attemptId.trim())return{valid:false,reason:'ATTEMPT_WITHOUT_ID',context,attemptIndex:index};
    if(ids.has(attempt.attemptId))return{valid:false,reason:'DUPLICATE_ATTEMPT_IDS',context,attemptIndex:index};
    ids.add(attempt.attemptId);
    if(!validKinds.has(attempt.kind))return{valid:false,reason:'INVALID_ATTEMPT_KIND',context,attemptIndex:index,rawKind:attempt.kind??null};
    if(!validAttemptStatuses.has(attempt.status))return{valid:false,reason:'INVALID_ATTEMPT_STATUS',context,attemptIndex:index,rawStatus:attempt.status??null};
    const nullBaseAllowed=attempt.kind==='INITIALIZE'||attempt.kind==='MIGRATION';
    if(!(Number.isSafeInteger(attempt.baseRevision)&&attempt.baseRevision>=0)&&!(nullBaseAllowed&&attempt.baseRevision===null))return{valid:false,reason:'INVALID_ATTEMPT_BASE_REVISION',context,attemptIndex:index};
    if(typeof attempt.tabId!=='string'||!attempt.tabId)return{valid:false,reason:'INVALID_ATTEMPT_OWNER',context,attemptIndex:index};
    if(typeof attempt.createdAt!=='string'||typeof attempt.updatedAt!=='string')return{valid:false,reason:'INVALID_ATTEMPT_TIMESTAMPS',context,attemptIndex:index};
    if(attempt.rebaseOf!==null&&attempt.rebaseOf!==undefined){if(typeof attempt.rebaseOf!=='string'||!ids.has(attempt.rebaseOf))return{valid:false,reason:'INVALID_REBASE_ANCESTRY',context,attemptIndex:index};}
    if(attempt.currentRevision!==null&&attempt.currentRevision!==undefined&&(!Number.isSafeInteger(attempt.currentRevision)||attempt.currentRevision<0))return{valid:false,reason:'INVALID_ATTEMPT_CURRENT_REVISION',context,attemptIndex:index};
  }
  const activeMatches=record.attemptHistory.filter(attempt=>attempt.attemptId===record.activeAttemptId);
  if(activeMatches.length!==1)return{valid:false,reason:'ACTIVE_ATTEMPT_NOT_UNIQUE_IN_HISTORY',context};
  const active=activeMatches[0];
  const nullBaseAllowed=active.kind==='INITIALIZE'||active.kind==='MIGRATION';
  if(!(Number.isSafeInteger(record.baseRevision)&&record.baseRevision>=0)&&!(nullBaseAllowed&&record.baseRevision===null))return{valid:false,reason:'INVALID_JOURNAL_BASE_REVISION',context};
  if(record.baseRevision!==active.baseRevision)return{valid:false,reason:'ACTIVE_BASE_REVISION_MISMATCH',context,recordBaseRevision:record.baseRevision,activeBaseRevision:active.baseRevision};
  if(typeof record.tabId!=='string'||!record.tabId)return{valid:false,reason:'INVALID_JOURNAL_OWNER',context};
  if(record.tabId!==active.tabId)return{valid:false,reason:'ACTIVE_ATTEMPT_OWNER_MISMATCH',context,recordTabId:record.tabId,activeTabId:active.tabId};
  if(status===_NA_V10_STATUSES.PENDING&&active.status!==_NA_V10_STATUSES.PENDING&&active.status!==_NA_V10_RESULTS.PERSISTENCE_ERROR)return{valid:false,reason:'PENDING_ACTIVE_ATTEMPT_CONTRADICTION',context};
  if(status===_NA_V10_STATUSES.CONFLICT){if(active.status!==_NA_V10_STATUSES.CONFLICT)return{valid:false,reason:'CONFLICT_ACTIVE_ATTEMPT_CONTRADICTION',context};if(typeof record.reason!=='string'||!record.reason||active.reason!==record.reason)return{valid:false,reason:'INVALID_CONFLICT_REASON',context};}
  if(status===_NA_V10_STATUSES.ROLLED_BACK){if(active.status!==_NA_V10_STATUSES.ROLLED_BACK)return{valid:false,reason:'ROLLBACK_ACTIVE_ATTEMPT_CONTRADICTION',context};if(typeof record.reason!=='string'||!record.reason)return{valid:false,reason:'INVALID_ROLLBACK_REASON',context};}
  if(status===_NA_V10_STATUSES.COMMITTED){
    if(!Number.isSafeInteger(record.committedRevision)||record.committedRevision<0)return{valid:false,reason:'INVALID_COMMITTED_REVISION',context};
    if(typeof record.commitId!=='string'||!record.commitId)return{valid:false,reason:'MISSING_COMMIT_ID',context};
    if(record.checkpointKey!==`${record.committedRevision}:${record.commitId}`)return{valid:false,reason:'INVALID_CHECKPOINT_KEY',context};
    if(active.status!==_NA_V10_STATUSES.COMMITTED||active.currentRevision!==record.committedRevision||active.commitId!==record.commitId||active.checkpointKey!==record.checkpointKey)return{valid:false,reason:'COMMITTED_ACTIVE_ATTEMPT_CONTRADICTION',context};
  }
  return{valid:true,context};
}
function _naV10JournalEvidence(raw,validation,context){const rawJournal=_naV10Clone(raw),fingerprint=`${raw?.operationId||'NO_OPERATION'}|${validation?.reason||'JOURNAL_INVALID'}|${String(raw?.updatedAt??raw?.createdAt??'NO_TIME')}`;return{code:'JOURNAL_VALIDATION_FAILED',reason:validation?.reason||'JOURNAL_INVALID',context,detectedAt:_naV10EvidenceDetectedAt('JOURNAL_CORRUPT',fingerprint),rawJournal,rawAttemptHistory:_naV10Clone(raw?.attemptHistory),validation:_naV10Clone(validation||null)};}
async function _naV10EnsurePending(spec,operationId){
  if(!_naV10IsJsonSafe(spec.payload??null,new Set())||!_naV10IsJsonSafe(spec.entityIds||[],new Set()))return{status:_NA_V10_RESULTS.PERSISTENCE_ERROR,operationId,requestStatus:_NA_V10_RESULTS.PERSISTENCE_ERROR,requestReason:'NON_JSON_SAFE_OPERATION_INPUT',recoverable:true,evidence:{code:'NON_JSON_SAFE_OPERATION_INPUT',detectedAt:_naV10Now()}};
  const identityPayload=_naV10SpecIdentityPayload(spec),identity={payload:identityPayload,key:_naV10IdempotencyKey(identityPayload),hash:await _naV10PayloadHash(identityPayload)},candidate=_naV10BuildJournalRecord(spec,operationId,identity);
  const candidateValidation=_naV10ValidateJournalRecordStrict(candidate,'ENSURE_NEW');
  if(!candidateValidation.valid)return{status:_NA_V10_RESULTS.PERSISTENCE_ERROR,operationId,requestStatus:_NA_V10_RESULTS.PERSISTENCE_ERROR,requestReason:candidateValidation.reason,recoverable:true,evidence:_naV10JournalEvidence(candidate,candidateValidation,'ENSURE_NEW')};
  const db=await _naV10OpenDB();
  const result=await new Promise((resolve,reject)=>{
    const tx=db.transaction(_NA_V10_OPERATIONS_STORE,'readwrite'),store=tx.objectStore(_NA_V10_OPERATIONS_STORE),request=store.get(operationId);let outcome=null;
    request.onerror=()=>{try{tx.abort();}catch(error){}};
    request.onsuccess=()=>{
      const putValidated=(record,context)=>{const validation=_naV10ValidateJournalRecordStrict(record,context);if(!validation.valid){outcome={status:_NA_V10_RESULTS.PERSISTENCE_ERROR,operationId,logicalOperationId:record?.logicalOperationId||operationId,requestStatus:_NA_V10_RESULTS.PERSISTENCE_ERROR,requestReason:validation.reason,recoverable:true,evidence:_naV10JournalEvidence(record,validation,context)};return false;}store.put(record);return true;};
      const raw=request.result;
      if(raw){const preValidation=_naV10ValidateJournalRecordStrict(raw,'ENSURE_EXISTING');if(!preValidation.valid){outcome={status:_NA_V10_RESULTS.PERSISTENCE_ERROR,operationId,logicalOperationId:typeof raw.logicalOperationId==='string'?raw.logicalOperationId:operationId,requestStatus:_NA_V10_RESULTS.PERSISTENCE_ERROR,requestReason:preValidation.reason,recoverable:true,__validationFailed:true,evidence:_naV10JournalEvidence(raw,preValidation,'ENSURE_EXISTING')};return;}}
      const existing=raw?_naV10Clone(raw):null;
      if(existing){
        const requestedType=String(spec.type||'UNKNOWN').slice(0,80);
        if(spec.attemptId&&spec.attemptId!==existing.activeAttemptId){outcome={..._naV10Clone(existing),requestStatus:_NA_V10_RESULTS.CONFLICT,requestReason:'STALE_ATTEMPT',requestAttemptId:spec.attemptId};return;}
        if(existing.type!==requestedType){
          const mismatchAttempt=_naV10Attempt('TYPE_MISMATCH',spec.expectedRevision),now=_naV10Now(),evidence={attemptId:mismatchAttempt.attemptId,at:now,reason:'OPERATION_ID_TYPE_MISMATCH',existingType:existing.type,requestedType,tabId:_naGetTabId()};
          mismatchAttempt.status=_NA_V10_STATUSES.CONFLICT;mismatchAttempt.reason=evidence.reason;mismatchAttempt.currentRevision=spec.expectedRevision;mismatchAttempt.updatedAt=now;existing.attemptHistory.push(mismatchAttempt);existing.attempts+=1;existing.typeMismatchEvidence.push(evidence);
          if(existing.status!==_NA_V10_STATUSES.COMMITTED){existing.status=_NA_V10_STATUSES.CONFLICT;existing.reason=evidence.reason;existing.baseRevision=mismatchAttempt.baseRevision;existing.tabId=mismatchAttempt.tabId;existing.activeAttemptId=mismatchAttempt.attemptId;existing.updatedAt=now;}
          if(!putValidated(existing,'ENSURE_TYPE_MISMATCH'))return;outcome={..._naV10Clone(existing),requestStatus:_NA_V10_RESULTS.CONFLICT,requestReason:evidence.reason,requestAttemptId:mismatchAttempt.attemptId};return;
        }
        if(existing.idempotencyKey!==identity.key){
          const mismatchAttempt=_naV10Attempt('PAYLOAD_MISMATCH',spec.expectedRevision),now=_naV10Now(),evidence={attemptId:mismatchAttempt.attemptId,at:now,reason:'OPERATION_ID_PAYLOAD_MISMATCH',requestedHash:identity.hash,requestedPayload:_naV10Clone(identity.payload),tabId:_naGetTabId()};
          mismatchAttempt.status=_NA_V10_STATUSES.CONFLICT;mismatchAttempt.reason=evidence.reason;mismatchAttempt.currentRevision=spec.expectedRevision;mismatchAttempt.updatedAt=now;existing.attemptHistory.push(mismatchAttempt);existing.attempts+=1;existing.mismatchEvidence.push(evidence);
          if(existing.status!==_NA_V10_STATUSES.COMMITTED){existing.status=_NA_V10_STATUSES.CONFLICT;existing.reason=evidence.reason;existing.baseRevision=mismatchAttempt.baseRevision;existing.tabId=mismatchAttempt.tabId;existing.activeAttemptId=mismatchAttempt.attemptId;existing.updatedAt=now;}
          if(!putValidated(existing,'ENSURE_PAYLOAD_MISMATCH'))return;outcome={..._naV10Clone(existing),requestStatus:_NA_V10_RESULTS.CONFLICT,requestReason:evidence.reason,requestAttemptId:mismatchAttempt.attemptId};return;
        }
        const active=_naV10ActiveAttempt(existing);
        const contextConflict=_naV10RequestContextConflict(existing,active,spec);if(contextConflict){outcome={..._naV10Clone(existing),requestStatus:_NA_V10_RESULTS.CONFLICT,requestReason:contextConflict,requestAttemptId:spec.attemptId||null};return;}
        if(existing.status===_NA_V10_STATUSES.COMMITTED){outcome={..._naV10Clone(existing),requestStatus:_NA_V10_RESULTS.ALREADY_COMMITTED,requestAttemptId:existing.activeAttemptId};return;}
        if(existing.status===_NA_V10_STATUSES.CONFLICT||existing.status===_NA_V10_STATUSES.ROLLED_BACK){outcome={..._naV10Clone(existing),requestStatus:_NA_V10_RESULTS.CONFLICT,requestReason:existing.reason||existing.status};return;}
        if(spec.attemptId){outcome=existing;return;}
        if(active?.status===_NA_V10_STATUSES.PENDING){outcome={..._naV10Clone(existing),requestReusedActiveAttempt:true};return;}
        if(active?.status!==_NA_V10_RESULTS.PERSISTENCE_ERROR){outcome={..._naV10Clone(existing),requestStatus:_NA_V10_RESULTS.CONFLICT,requestReason:'STALE_ATTEMPT'};return;}
        const retry=_naV10Attempt('RETRY',existing.baseRevision,existing.activeAttemptId);existing.attemptHistory.push(retry);existing.attempts+=1;existing.activeAttemptId=retry.attemptId;existing.tabId=retry.tabId;existing.updatedAt=retry.updatedAt;existing.reason=null;if(!putValidated(existing,'ENSURE_RETRY'))return;outcome=existing;return;
      }
      if(spec.attemptId){outcome={...candidate,requestStatus:_NA_V10_RESULTS.CONFLICT,requestReason:'PREPARED_ATTEMPT_MISSING'};return;}
      if(!putValidated(candidate,'ENSURE_INSERT'))return;outcome=candidate;
    };
    tx.oncomplete=()=>resolve(_naV10Clone(outcome));tx.onabort=()=>reject(_naV10Error('PENDING_WRITE_FAILED','No se pudo conservar la intencion PENDING',tx.error));tx.onerror=()=>{};
  });
  if(result?.status===_NA_V10_STATUSES.PENDING&&!result.requestStatus)result.outbox=_naV10WriteOutboxRecord(result);
  return result;
}
function _naV10ConflictJournal(record,reason,currentRevision){const now=_naV10Now();record.status=_NA_V10_STATUSES.CONFLICT;record.reason=reason;record.updatedAt=now;record.currentRevision=currentRevision;_naV10UpdateAttempt(record,record.activeAttemptId,{status:_NA_V10_STATUSES.CONFLICT,reason,currentRevision,updatedAt:now});return record;}
async function _naV10AnnotatePersistenceError(operationId,attemptId,error){
  try{const db=await _naV10OpenDB();return await new Promise(resolve=>{const tx=db.transaction(_NA_V10_OPERATIONS_STORE,'readwrite'),store=tx.objectStore(_NA_V10_OPERATIONS_STORE),request=store.get(operationId);let result={ok:false,reason:'NOT_FOUND'};request.onsuccess=()=>{const raw=request.result;if(!raw)return;const validation=_naV10ValidateJournalRecordStrict(raw,'ANNOTATE_ERROR');if(!validation.valid){result={ok:false,reason:'JOURNAL_VALIDATION_FAILED',recoverable:true,evidence:_naV10JournalEvidence(raw,validation,'ANNOTATE_ERROR')};return;}const record=_naV10Clone(raw);if(record.status===_NA_V10_STATUSES.COMMITTED){result={ok:false,reason:'COMMITTED_IS_IMMUTABLE',record};return;}if(record.activeAttemptId!==attemptId){result={ok:false,reason:'ATTEMPT_SUPERSEDED',record};return;}const now=_naV10Now();_naV10UpdateAttempt(record,attemptId,{status:_NA_V10_RESULTS.PERSISTENCE_ERROR,reason:error?.code||'CAS_ABORTED',error:_naV10Clone(error||null),updatedAt:now});record.status=_NA_V10_STATUSES.PENDING;record.reason=error?.code||'CAS_ABORTED';record.updatedAt=now;const after=_naV10ValidateJournalRecordStrict(record,'ANNOTATE_ERROR_RESULT');if(!after.valid){result={ok:false,reason:'RESULT_VALIDATION_FAILED',recoverable:true,evidence:_naV10JournalEvidence(raw,after,'ANNOTATE_ERROR_RESULT')};return;}store.put(record);result={ok:true,record:_naV10Clone(record)};};request.onerror=()=>{try{tx.abort();}catch(abortError){}};tx.oncomplete=()=>resolve(result);tx.onabort=()=>resolve({ok:false,reason:'ANNOTATION_FAILED'});tx.onerror=()=>{};});}catch(annotationError){return{ok:false,reason:'ANNOTATION_FAILED',error:{message:annotationError.message||String(annotationError)}};}
}
async function _naV10CasCommit(spec,operationId){
  const db=await _naV10OpenDB();
  const result=await new Promise(resolve=>{
    let provisional=null,abortError=null;
    const tx=db.transaction([_NA_V10_STATE_STORE,_NA_V10_OPERATIONS_STORE,_NA_V10_CHECKPOINTS_STORE],'readwrite'),stateStore=tx.objectStore(_NA_V10_STATE_STORE),operationStore=tx.objectStore(_NA_V10_OPERATIONS_STORE),checkpointStore=tx.objectStore(_NA_V10_CHECKPOINTS_STORE),stateRequest=stateStore.get(_NA_V10_SNAPSHOT_KEY),operationRequest=operationStore.get(operationId);
    let stateReady=false,operationReady=false,current=null,record=null;
    const abortWith=error=>{abortError={code:error.code||error.name||'CAS_FAILED',message:error.message||String(error)};try{tx.abort();}catch(abortProblem){}};
    const proceed=()=>{
      if(!stateReady||!operationReady)return;
      try{
        const putValidatedJournal=(journal,context)=>{const validation=_naV10ValidateJournalRecordStrict(journal,context);if(!validation.valid)throw _naV10Error('JOURNAL_MUTATION_INVALID',validation.reason);operationStore.put(journal);};
        if(!_naV10ValidSnapshot(current))throw _naV10Error('CANONICAL_MISSING_OR_INVALID','No existe un snapshot V10 canonico JSON-safe valido');
        if(!record)throw _naV10Error('PENDING_MISSING','No existe la intencion PENDING');
        const casValidation=_naV10ValidateJournalRecordStrict(record,'CAS');
        if(!casValidation.valid){provisional=_naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,recoverable:true,error:{code:casValidation.reason==='LEGACY_OR_UNKNOWN_JOURNAL'?'LEGACY_OR_UNKNOWN_JOURNAL':'JOURNAL_VALIDATION_FAILED',message:casValidation.reason},operation:_naV10Clone(record),evidence:_naV10JournalEvidence(record,casValidation,'CAS')});return;}
        record=_naV10Clone(record);
        if(record.status!==_NA_V10_STATUSES.PENDING&&record.status!==_NA_V10_STATUSES.COMMITTED){provisional=_naV10Result(_NA_V10_RESULTS.CONFLICT,{operationId,revision:current.revision,reason:record.reason||record.status,operation:_naV10Clone(record),snapshot:_naV10Clone(current)});return;}
        const requestedType=String(spec.type||'UNKNOWN').slice(0,80);
        if(record.type!==requestedType){const attempt=_naV10Attempt('TYPE_MISMATCH',current.revision),now=_naV10Now(),evidence={attemptId:attempt.attemptId,at:now,reason:'OPERATION_ID_TYPE_MISMATCH',existingType:record.type,requestedType,tabId:_naGetTabId()};attempt.status=_NA_V10_STATUSES.CONFLICT;attempt.reason=evidence.reason;attempt.currentRevision=current.revision;attempt.updatedAt=now;record.attemptHistory.push(attempt);record.attempts+=1;record.typeMismatchEvidence.push(evidence);if(record.status!==_NA_V10_STATUSES.COMMITTED){record.status=_NA_V10_STATUSES.CONFLICT;record.reason=evidence.reason;record.baseRevision=attempt.baseRevision;record.tabId=attempt.tabId;record.activeAttemptId=attempt.attemptId;record.currentRevision=current.revision;record.updatedAt=now;}putValidatedJournal(record,'CAS_TYPE_MISMATCH');provisional=_naV10Result(_NA_V10_RESULTS.CONFLICT,{operationId,revision:current.revision,reason:evidence.reason,operation:_naV10Clone(record),snapshot:_naV10Clone(current)});return;}
        if(record.status===_NA_V10_STATUSES.COMMITTED){provisional={__verifyCommitted:true,operationId,operation:_naV10Clone(record),snapshot:_naV10Clone(current)};return;}
        if(record.status===_NA_V10_STATUSES.CONFLICT||record.status===_NA_V10_STATUSES.ROLLED_BACK){provisional=_naV10Result(_NA_V10_RESULTS.CONFLICT,{operationId,revision:current.revision,reason:record.reason||record.status,operation:_naV10Clone(record),snapshot:_naV10Clone(current)});return;}
        if(!spec.attemptId||record.activeAttemptId!==spec.attemptId){provisional=_naV10Result(_NA_V10_RESULTS.CONFLICT,{operationId,revision:current.revision,reason:'STALE_ATTEMPT',operation:_naV10Clone(record),snapshot:_naV10Clone(current)});return;}
        if(current.revision!==record.baseRevision){record=_naV10ConflictJournal(record,'REVISION_MISMATCH',current.revision);putValidatedJournal(record,'CAS_REVISION_CONFLICT');provisional=_naV10Result(_NA_V10_RESULTS.CONFLICT,{operationId,expectedRevision:record.baseRevision,currentRevision:current.revision,reason:record.reason,operation:_naV10Clone(record),snapshot:_naV10Clone(current)});return;}
        const ctx={operationId,logicalOperationId:record.logicalOperationId,attemptId:record.activeAttemptId,currentRevision:current.revision,tabId:_naGetTabId(),payload:_naV10Clone(record.payload),idempotencyPayload:_naV10Clone(record.idempotencyPayload)};
        if(typeof spec.revalidate==='function'){
          const validation=spec.revalidate(_naV10Clone(current),ctx);if(validation&&typeof validation.then==='function')throw _naV10Error('ASYNC_REDUCER','revalidate debe ser sincrono dentro de la transaccion');
          const valid=validation===undefined||validation===true||validation?.ok===true;
          if(!valid){const reason=typeof validation==='string'?validation:validation?.reason||'REVALIDATION_FAILED';record=_naV10ConflictJournal(record,reason,current.revision);putValidatedJournal(record,'CAS_REVALIDATION_CONFLICT');provisional=_naV10Result(_NA_V10_RESULTS.CONFLICT,{operationId,currentRevision:current.revision,reason,operation:_naV10Clone(record),snapshot:_naV10Clone(current)});return;}
        }
        const draft=_naV10Clone(current),produced=typeof spec.mutate==='function'?spec.mutate(draft,ctx):draft.data;
        if(produced&&typeof produced.then==='function')throw _naV10Error('ASYNC_REDUCER','mutate debe ser sincrono dentro de la transaccion');
        const nextData=produced===undefined?draft.data:produced,nextRevision=current.revision+1,commitId=_naNewCommitId(),committedAt=_naV10Now();
        if(!_naV10IsJsonSafe(nextData,new Set()))throw _naV10Error('NON_JSON_SAFE_SNAPSHOT','El reducer produjo datos no JSON-safe');
        if(!Number.isSafeInteger(nextRevision))throw _naV10Error('REVISION_OVERFLOW','La revision excedio el rango seguro');
        const next={version:10,revision:nextRevision,parentRevision:current.revision,parentCommitId:current.commitId||null,commitId,lastOperationId:operationId,committedAt,writerId:_naGetTabId(),data:_naV10Clone(nextData)};
        if(!_naV10ValidSnapshot(next))throw _naV10Error('INVALID_NEXT_SNAPSHOT','El reducer produjo un snapshot invalido');
        const checkpointKey=`${nextRevision}:${commitId}`;record={...record,status:_NA_V10_STATUSES.COMMITTED,committedRevision:nextRevision,commitId,checkpointKey,updatedAt:committedAt,reason:null,entityIds:_naV10Clone(spec.entityIds||record.entityIds||[])};_naV10UpdateAttempt(record,record.activeAttemptId,{status:_NA_V10_STATUSES.COMMITTED,currentRevision:nextRevision,commitId,checkpointKey,updatedAt:committedAt,reason:null});
        const committedValidation=_naV10ValidateJournalRecordStrict(record,'CAS_COMMIT');if(!committedValidation.valid)throw _naV10Error('JOURNAL_COMMIT_INVALID',committedValidation.reason);
        const checkpoint={key:checkpointKey,revision:nextRevision,commitId,operationId,logicalOperationId:record.logicalOperationId,attemptId:record.activeAttemptId,createdAt:committedAt,snapshot:_naV10Clone(next)};if(!_naV10IsJsonSafe(checkpoint,new Set()))throw _naV10Error('CHECKPOINT_NOT_JSON_SAFE','El checkpoint no es JSON-safe');stateStore.put(next,_NA_V10_SNAPSHOT_KEY);putValidatedJournal(record,'CAS_COMMIT_WRITE');checkpointStore.put(checkpoint);
        provisional=_naV10Result(_NA_V10_RESULTS.SUCCESS,{operationId,logicalOperationId:record.logicalOperationId,attemptId:record.activeAttemptId,revision:nextRevision,commitId,operation:_naV10Clone(record),snapshot:_naV10Clone(next)});
      }catch(error){abortWith(error);}
    };
    stateRequest.onsuccess=()=>{current=stateRequest.result;stateReady=true;proceed();};operationRequest.onsuccess=()=>{record=operationRequest.result;operationReady=true;proceed();};
    stateRequest.onerror=()=>abortWith(stateRequest.error||new Error('No se pudo leer el snapshot canonico'));operationRequest.onerror=()=>abortWith(operationRequest.error||new Error('No se pudo leer el journal'));
    tx.oncomplete=()=>resolve(provisional||_naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,error:{code:'EMPTY_CAS_RESULT',message:'La transaccion termino sin resultado'}}));
    tx.onabort=()=>resolve(_naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,attemptId:spec.attemptId||null,error:abortError||{code:tx.error?.name||'CAS_ABORTED',message:tx.error?.message||'La transaccion CAS fue cancelada'}}));tx.onerror=()=>{};
  });
  if(result?.__verifyCommitted){
    const resolved=await _naV10ResolveOperation(operationId);
    if(resolved.status===_NA_V10_STATUSES.COMMITTED)return _naV10Result(_NA_V10_RESULTS.ALREADY_COMMITTED,{operationId,logicalOperationId:resolved.logicalOperationId||result.operation?.logicalOperationId||operationId,revision:resolved.revision,commitId:resolved.commitId,operation:resolved.operation,snapshot:resolved.snapshot});
    return _naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,logicalOperationId:result.operation?.logicalOperationId||operationId,recoverable:true,error:resolved.error||{code:'COMMIT_EVIDENCE_INCONSISTENT',message:'El journal COMMITTED no tiene evidencia durable directa verificable'},operation:resolved.operation||result.operation,evidence:resolved});
  }
  return result;
}
async function _naRunCriticalOperation(spec={}){
  const operationId=spec.operationId||_naNewOperationId();
  if(!Number.isSafeInteger(spec.expectedRevision)||spec.expectedRevision<0)return _naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,error:{code:'INVALID_EXPECTED_REVISION',message:'expectedRevision debe ser un entero no negativo'}});
  const warnings=[];
  try{
    const pending=await _naV10EnsurePending(spec,operationId);
    _naV10AttachStorageWarning(warnings,pending.outbox);
    if(pending.requestStatus===_NA_V10_RESULTS.PERSISTENCE_ERROR){return _naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,logicalOperationId:pending.logicalOperationId||operationId,attemptId:pending.requestAttemptId||null,error:pending.error||{code:'ENSURE_PENDING_FAILED',message:pending.requestReason||'No se pudo preparar la intencion PENDING'},operation:pending,warnings});}
    if(pending.__validationFailed){return _naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,logicalOperationId:pending.logicalOperationId||operationId,attemptId:pending.requestAttemptId||null,error:{code:'JOURNAL_VALIDATION_FAILED',message:pending.requestReason||'El registro del journal no paso la validacion estricta'},operation:pending,warnings});}
    if(pending.requestStatus===_NA_V10_RESULTS.CONFLICT||pending.status===_NA_V10_STATUSES.CONFLICT||pending.status===_NA_V10_STATUSES.ROLLED_BACK)return _naV10Result(_NA_V10_RESULTS.CONFLICT,{operationId,logicalOperationId:pending.logicalOperationId||operationId,attemptId:pending.requestAttemptId||null,reason:pending.requestReason||pending.reason||pending.status,operation:pending,warnings});
    if(pending.requestStatus===_NA_V10_RESULTS.ALREADY_COMMITTED||pending.status===_NA_V10_STATUSES.COMMITTED){const finalized=await _naV10OutboxDeletion.verifyAndRemove(operationId),resolved=finalized.verification;if(!finalized.verified||resolved?.status!==_NA_V10_STATUSES.COMMITTED)return _naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,logicalOperationId:pending.logicalOperationId||operationId,attemptId:pending.requestAttemptId||null,error:resolved?.error||{code:'COMMIT_EVIDENCE_INCONSISTENT',message:'No se pudo verificar evidencia durable del commit'},operation:resolved?.operation||pending,evidence:resolved||finalized,warnings});_naV10AttachStorageWarning(warnings,finalized);return _naV10Result(_NA_V10_RESULTS.ALREADY_COMMITTED,{operationId,logicalOperationId:pending.logicalOperationId||operationId,attemptId:pending.requestAttemptId||null,revision:resolved.revision,commitId:resolved.commitId,operation:resolved.operation,snapshot:resolved.snapshot,outbox:finalized,warnings});}
    const executionSpec={...spec,expectedRevision:pending.baseRevision,attemptId:pending.activeAttemptId};
    const result=await _naV10WithExclusiveLock(()=>_naV10CasCommit(executionSpec,operationId));
    if(result.status===_NA_V10_RESULTS.CONFLICT&&result.reason==='STALE_ATTEMPT'){
      const finalized=await _naV10OutboxDeletion.verifyAndRemove(operationId),resolved=finalized.verification,requestedType=String(spec.type||'UNKNOWN').slice(0,80),explicitAttempt=Object.prototype.hasOwnProperty.call(spec,'attemptId')&&!!spec.attemptId;
      let requestedKey=null,resolvedPayloadKey=null;try{requestedKey=_naV10IdempotencyKey(_naV10SpecIdentityPayload(spec));resolvedPayloadKey=_naV10IdempotencyKey(resolved?.operation?.idempotencyPayload??null);}catch(identityError){}
      const committed=resolved?.status===_NA_V10_STATUSES.COMMITTED&&resolved.operation?.operationId===operationId&&resolved.operation?.logicalOperationId===operationId&&resolved.operation?.type===requestedType&&resolved.operation?.idempotencyKey===requestedKey&&resolvedPayloadKey===requestedKey&&resolved.operation?.baseRevision===pending.baseRevision&&result.operation?.baseRevision===resolved.operation.baseRevision&&result.operation?.activeAttemptId===resolved.operation.activeAttemptId&&resolved.attemptId===resolved.operation.activeAttemptId&&typeof resolved.commitId==='string'&&resolved.commitId&&Number.isSafeInteger(resolved.revision);
      if(!explicitAttempt&&committed){_naV10AttachStorageWarning(warnings,finalized);return _naV10Result(_NA_V10_RESULTS.ALREADY_COMMITTED,{operationId,logicalOperationId:resolved.logicalOperationId||operationId,attemptId:resolved.attemptId,revision:resolved.revision,commitId:resolved.commitId,operation:resolved.operation,snapshot:resolved.snapshot,outbox:finalized,reconciliation:{attempted:true,status:_NA_V10_STATUSES.COMMITTED,evidence:resolved},warnings});}
      result.reconciliation={attempted:true,status:resolved?.status||'UNKNOWN',evidence:resolved,outbox:finalized};
    }
    if(result.status===_NA_V10_RESULTS.PERSISTENCE_ERROR){result.recovery=await _naV10AnnotatePersistenceError(operationId,pending.activeAttemptId,result.error);result.warnings=warnings;return result;}
    if(result.status===_NA_V10_RESULTS.SUCCESS){result.mirror=_naV10WriteMirror(result.snapshot);_naV10AttachStorageWarning(warnings,result.mirror);result.broadcast=_naV10PublishCommit(result.snapshot);result.outbox=await _naV10OutboxDeletion.verifyAndRemove(operationId);_naV10AttachStorageWarning(warnings,result.outbox);}
    result.warnings=warnings;
    return result;
  }catch(error){return _naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,error:{code:error.code||error.name||'PERSISTENCE_ERROR',message:error.message||String(error)}});}
}
async function _naV10MarkOperationRolledBack(operationId,reason='CANCELLED'){
  try{const db=await _naV10OpenDB();return await new Promise(resolve=>{const tx=db.transaction(_NA_V10_OPERATIONS_STORE,'readwrite'),store=tx.objectStore(_NA_V10_OPERATIONS_STORE),request=store.get(operationId);let result=null;request.onsuccess=()=>{const raw=request.result;if(!raw){result={ok:false,reason:'NOT_FOUND'};return;}const validation=_naV10ValidateJournalRecordStrict(raw,'ROLLBACK');if(!validation.valid){result={ok:false,reason:'JOURNAL_VALIDATION_FAILED',recoverable:true,evidence:_naV10JournalEvidence(raw,validation,'ROLLBACK')};return;}const record=_naV10Clone(raw);if(record.status===_NA_V10_STATUSES.COMMITTED){result={ok:false,reason:'COMMITTED_IS_IMMUTABLE',record};return;}const now=_naV10Now();record.status=_NA_V10_STATUSES.ROLLED_BACK;record.reason=reason;record.updatedAt=now;_naV10UpdateAttempt(record,record.activeAttemptId,{status:_NA_V10_STATUSES.ROLLED_BACK,reason,updatedAt:now});const after=_naV10ValidateJournalRecordStrict(record,'ROLLBACK_RESULT');if(!after.valid){result={ok:false,reason:'RESULT_VALIDATION_FAILED',recoverable:true,evidence:_naV10JournalEvidence(raw,after,'ROLLBACK_RESULT')};return;}store.put(record);result={ok:true,record:_naV10Clone(record),warnings:[],outboxPreserved:true};};request.onerror=()=>{try{tx.abort();}catch(error){}};tx.oncomplete=()=>resolve(result);tx.onabort=()=>resolve({ok:false,reason:'PERSISTENCE_ERROR'});tx.onerror=()=>{};});}catch(error){return{ok:false,reason:'PERSISTENCE_ERROR',error:{message:error.message||String(error)}};}
}

function _naV10StableSnapshotHash(snapshot){
  if(!_naV10ValidateSnapshotJsonSafe(snapshot).ok)return null;
  return JSON.stringify(_naV10StableValue(snapshot.data));
}
function _naV10IsPlainObject(value){if(!value||Object.prototype.toString.call(value)!=='[object Object]')return false;const proto=Object.getPrototypeOf(value);return proto===Object.prototype||proto===null;}
function _naV10IsJsonSafe(value,seen=new Set()){
  if(value===null||value===true||value===false)return true;
  const t=typeof value;
  if(t==='number')return Number.isFinite(value);
  if(t==='string')return true;
  if(t==='bigint'||t==='function'||t==='symbol'||t==='undefined')return false;
  if(value instanceof Date)return false;
  if(Array.isArray(value)){
    if(seen.has(value))return false;
    seen.add(value);
    const keys=Reflect.ownKeys(value),expected=new Set(['length',...Array.from({length:value.length},(_,index)=>String(index))]);
    if(keys.length!==expected.size||keys.some(key=>typeof key!=='string'||!expected.has(key))){seen.delete(value);return false;}
    for(let i=0;i<value.length;i++){const descriptor=Object.getOwnPropertyDescriptor(value,String(i));if(!descriptor?.enumerable||!Object.prototype.hasOwnProperty.call(descriptor,'value')||!_naV10IsJsonSafe(descriptor.value,seen)){seen.delete(value);return false;}}
    seen.delete(value);
    return true;
  }
  if(t==='object'){
    if(!_naV10IsPlainObject(value))return false;
    if(seen.has(value))return false;
    seen.add(value);
    for(const key of Reflect.ownKeys(value)){
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(typeof key!=='string'||!descriptor?.enumerable||!Object.prototype.hasOwnProperty.call(descriptor,'value')||!_naV10IsJsonSafe(descriptor.value,seen)){seen.delete(value);return false;}
    }
    seen.delete(value);
    return true;
  }
  return false;
}
function _naV10ValidateSnapshotJsonSafe(snapshot){
  if(!_naV10IsPlainObject(snapshot)||!Object.prototype.hasOwnProperty.call(snapshot,'data'))return{ok:false,reason:'MISSING_OR_INVALID_SNAPSHOT'};
  const issues=[];
  if(!_naV10IsJsonSafe(snapshot,new Set()))issues.push('NON_JSON_SAFE_SNAPSHOT');
  if(!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0)issues.push('INVALID_REVISION');
  if(typeof snapshot.commitId!=='string'||!snapshot.commitId)issues.push('INVALID_COMMIT_ID');
  if(typeof snapshot.lastOperationId!=='string'||!snapshot.lastOperationId)issues.push('INVALID_LAST_OPERATION_ID');
  return issues.length?{ok:false,issues}:{ok:true};
}

function _naV10OutboxEvidence(operationId){const read=_naV10ReadOutbox();return{state:read.state,entry:read.state==='VALID'?_naV10Clone(read.entries[operationId]||null):null,rawValue:read.rawValue,detectedAt:read.detectedAt,error:_naV10Clone(read.error||null)};}
async function _naV10ResolveOperation(operationId){
  try{
    const db=await _naV10OpenDB();return await new Promise(resolve=>{
      const tx=db.transaction([_NA_V10_STATE_STORE,_NA_V10_OPERATIONS_STORE,_NA_V10_CHECKPOINTS_STORE],'readonly'),operationRequest=tx.objectStore(_NA_V10_OPERATIONS_STORE).get(operationId),checkpointsRequest=tx.objectStore(_NA_V10_CHECKPOINTS_STORE).getAll(),stateRequest=tx.objectStore(_NA_V10_STATE_STORE).get(_NA_V10_SNAPSHOT_KEY);let rawOperation=null,checkpoints=[],canonical=null,failed=false;
      operationRequest.onsuccess=()=>{rawOperation=operationRequest.result||null;};checkpointsRequest.onsuccess=()=>{checkpoints=checkpointsRequest.result||[];};stateRequest.onsuccess=()=>{canonical=stateRequest.result||null;};
      const fail=()=>{failed=true;try{tx.abort();}catch(error){}};operationRequest.onerror=fail;checkpointsRequest.onerror=fail;stateRequest.onerror=fail;
      tx.oncomplete=()=>{
        const sessionOutbox=_naV10OutboxEvidence(operationId);
        if(!rawOperation){resolve({status:'NOT_FOUND',operationId,recoverable:sessionOutbox.state!=='EMPTY',sessionOutbox});return;}
        const validation=_naV10ValidateJournalRecordStrict(rawOperation,'RESOLVE');
        if(!validation.valid){const code=validation.reason==='LEGACY_OR_UNKNOWN_JOURNAL'?'LEGACY_OR_UNKNOWN_JOURNAL':'JOURNAL_VALIDATION_FAILED';resolve({status:_NA_V10_RESULTS.PERSISTENCE_ERROR,operationId,recoverable:true,error:{code,message:validation.reason},evidence:_naV10JournalEvidence(rawOperation,validation,'RESOLVE'),rawJournal:_naV10Clone(rawOperation),sessionOutbox});return;}
        const operation=_naV10Clone(rawOperation),operationCheckpoints=checkpoints.filter(item=>item?.operationId===operationId),checkpoint=operation.status===_NA_V10_STATUSES.COMMITTED?(checkpoints.find(item=>item?.key===operation.checkpointKey)||null):null;
        if(operation.status===_NA_V10_STATUSES.COMMITTED){
          const evidence={operation:_naV10Clone(operation),rawJournal:_naV10Clone(rawOperation),checkpoint:_naV10Clone(checkpoint),candidateCheckpoints:_naV10Clone(operationCheckpoints),canonical:_naV10Clone(canonical),sessionOutbox};
          if(!_naV10ValidSnapshot(canonical)){resolve({status:_NA_V10_RESULTS.PERSISTENCE_ERROR,operationId,logicalOperationId:operation.logicalOperationId,recoverable:true,error:{code:'COMMIT_EVIDENCE_INCONSISTENT',message:'El snapshot canonico falta, es invalido o no es JSON-safe',issues:['CANONICAL_MISSING_OR_INVALID']},...evidence});return;}
          if(canonical.revision<operation.committedRevision){resolve({status:_NA_V10_RESULTS.PERSISTENCE_ERROR,operationId,logicalOperationId:operation.logicalOperationId,recoverable:true,error:{code:'CANONICAL_BEHIND_COMMIT',message:'El canonico esta detras de la revision comprometida'},...evidence});return;}
          if(canonical.revision>operation.committedRevision){resolve({status:_NA_V10_RESULTS.PERSISTENCE_ERROR,operationId,logicalOperationId:operation.logicalOperationId,recoverable:true,error:{code:'HISTORICAL_COMMIT_UNVERIFIED',message:'Fase A no infiere commits historicos mediante ancestry'},...evidence});return;}
          const snapshot=checkpoint?.snapshot||null,issues=[];
          if(!_naV10IsPlainObject(checkpoint))issues.push('CHECKPOINT_MISSING_OR_INVALID');
          if(checkpoint?.key!==operation.checkpointKey)issues.push('CHECKPOINT_KEY_MISMATCH');
          if(checkpoint?.operationId!==operationId)issues.push('CHECKPOINT_OPERATION_MISMATCH');
          if(checkpoint?.logicalOperationId!==operation.logicalOperationId)issues.push('CHECKPOINT_LOGICAL_OPERATION_MISMATCH');
          if(checkpoint?.attemptId!==operation.activeAttemptId)issues.push('CHECKPOINT_ATTEMPT_MISMATCH');
          if(checkpoint?.revision!==operation.committedRevision)issues.push('CHECKPOINT_REVISION_MISMATCH');
          if(checkpoint?.commitId!==operation.commitId)issues.push('CHECKPOINT_COMMIT_MISMATCH');
          if(!_naV10IsJsonSafe(checkpoint,new Set()))issues.push('CHECKPOINT_NOT_JSON_SAFE');
          if(!_naV10ValidSnapshot(snapshot))issues.push('INVALID_CHECKPOINT_SNAPSHOT');
          if(canonical.commitId!==operation.commitId)issues.push('CANONICAL_COMMIT_MISMATCH');
          if(canonical.lastOperationId!==operationId)issues.push('CANONICAL_LAST_OPERATION_MISMATCH');
          if(snapshot&&snapshot.revision!==operation.committedRevision)issues.push('SNAPSHOT_REVISION_MISMATCH');
          if(snapshot&&snapshot.commitId!==operation.commitId)issues.push('SNAPSHOT_COMMIT_MISMATCH');
          if(snapshot&&snapshot.lastOperationId!==operationId)issues.push('SNAPSHOT_OPERATION_MISMATCH');
          if(_naV10ValidSnapshot(snapshot)&&_naV10StableSnapshotHash(snapshot)!==_naV10StableSnapshotHash(canonical))issues.push('CHECKPOINT_CANONICAL_DATA_DIVERGENCE');
          if(issues.length){resolve({status:_NA_V10_RESULTS.PERSISTENCE_ERROR,operationId,logicalOperationId:operation.logicalOperationId,recoverable:true,error:{code:'COMMIT_EVIDENCE_INCONSISTENT',message:'La evidencia durable directa del commit es inconsistente',issues},snapshot:_naV10Clone(snapshot),...evidence});return;}
          resolve({status:_NA_V10_STATUSES.COMMITTED,operationId,logicalOperationId:operation.logicalOperationId,attemptId:operation.activeAttemptId,commitId:operation.commitId,revision:operation.committedRevision,recoverable:false,operation,checkpoint:_naV10Clone(checkpoint),snapshot:_naV10Clone(snapshot),sessionOutbox});return;
        }
        resolve({status:operation.status,operationId,logicalOperationId:operation.logicalOperationId,attemptId:operation.activeAttemptId,commitId:null,revision:_naV10ValidSnapshot(canonical)?canonical.revision:null,recoverable:operation.status===_NA_V10_STATUSES.PENDING||operation.status===_NA_V10_STATUSES.CONFLICT,operation,checkpoint:null,snapshot:null,sessionOutbox});
      };
      tx.onabort=()=>resolve({status:_NA_V10_RESULTS.PERSISTENCE_ERROR,operationId,recoverable:true,error:{code:'RESOLVE_FAILED',message:tx.error?.message||'No se pudo resolver la operacion'},failed});tx.onerror=()=>{};
    });
  }catch(error){return{status:_NA_V10_RESULTS.PERSISTENCE_ERROR,operationId,recoverable:true,error:{code:error.code||error.name||'RESOLVE_FAILED',message:error.message||String(error)}};}
}

async function _naV10ListRecoverableOperations(){
  const db=await _naV10OpenDB(),tx=db.transaction(_NA_V10_OPERATIONS_STORE,'readonly'),records=await _naV10Request(tx.objectStore(_NA_V10_OPERATIONS_STORE).getAll()),recoverable=[];
  for(const raw of records||[]){const validation=_naV10ValidateJournalRecordStrict(raw,'RECOVERY_LIST');if(!validation.valid){recoverable.push({operationId:typeof raw?.operationId==='string'?raw.operationId:null,logicalOperationId:typeof raw?.logicalOperationId==='string'?raw.logicalOperationId:null,status:_NA_V10_RESULTS.PERSISTENCE_ERROR,reason:validation.reason,recoverable:true,evidence:_naV10JournalEvidence(raw,validation,'RECOVERY_LIST'),rawJournal:_naV10Clone(raw)});continue;}if(raw.status===_NA_V10_STATUSES.PENDING||raw.status===_NA_V10_STATUSES.CONFLICT)recoverable.push({operationId:raw.operationId,logicalOperationId:raw.logicalOperationId,status:raw.status,reason:raw.reason||null,activeAttemptId:raw.activeAttemptId,baseRevision:raw.baseRevision,currentRevision:raw.currentRevision??null,payload:_naV10Clone(raw.payload),idempotencyPayload:_naV10Clone(raw.idempotencyPayload),attemptHistory:_naV10Clone(raw.attemptHistory)});}
  return recoverable;
}

async function _naV10PrepareRebase(operationId,idempotencyPayload){
  try{
    const hasPayload=arguments.length>1;if(hasPayload&&!_naV10IsJsonSafe(idempotencyPayload,new Set()))return _naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,recoverable:true,error:{code:'NON_JSON_SAFE_IDEMPOTENCY_PAYLOAD',message:'El payload solicitado para rebase no es JSON-safe'}});
    const identityPayload=hasPayload?_naV10Clone(idempotencyPayload):null,identity=hasPayload?{key:_naV10IdempotencyKey(identityPayload),hash:await _naV10PayloadHash(identityPayload)}:null;
    const db=await _naV10OpenDB(),result=await new Promise(resolve=>{
      const tx=db.transaction([_NA_V10_STATE_STORE,_NA_V10_OPERATIONS_STORE],'readwrite'),stateStore=tx.objectStore(_NA_V10_STATE_STORE),operationStore=tx.objectStore(_NA_V10_OPERATIONS_STORE),stateRequest=stateStore.get(_NA_V10_SNAPSHOT_KEY),operationRequest=operationStore.get(operationId);let current=null,record=null,stateReady=false,operationReady=false,provisional=null,abortError=null;
      const abortWith=error=>{abortError={code:error.code||error.name||'REBASE_FAILED',message:error.message||String(error)};try{tx.abort();}catch(problem){}};
      const proceed=()=>{if(!stateReady||!operationReady)return;try{
        if(!_naV10ValidSnapshot(current))throw _naV10Error('CANONICAL_MISSING','No existe snapshot canonico JSON-safe para rebase');if(!record)throw _naV10Error('OPERATION_NOT_FOUND','No existe la operacion solicitada');
        const rebaseValidation=_naV10ValidateJournalRecordStrict(record,'REBASE');
        if(!rebaseValidation.valid){const code=rebaseValidation.reason==='LEGACY_OR_UNKNOWN_JOURNAL'?'LEGACY_OR_UNKNOWN_JOURNAL':'JOURNAL_VALIDATION_FAILED';provisional=_naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,recoverable:true,error:{code,message:rebaseValidation.reason},evidence:_naV10JournalEvidence(record,rebaseValidation,'REBASE'),rawJournal:_naV10Clone(record)});return;}
        record=_naV10Clone(record);
        if(hasPayload&&record.idempotencyKey!==identity.key){const attempt=_naV10Attempt('PAYLOAD_MISMATCH',current.revision),now=_naV10Now(),evidence={attemptId:attempt.attemptId,at:now,reason:'OPERATION_ID_PAYLOAD_MISMATCH',requestedHash:identity.hash,requestedPayload:_naV10Clone(identityPayload),tabId:_naGetTabId()};attempt.status=_NA_V10_STATUSES.CONFLICT;attempt.reason=evidence.reason;attempt.currentRevision=current.revision;attempt.updatedAt=now;record.attemptHistory.push(attempt);record.attempts+=1;record.mismatchEvidence.push(evidence);record.status=_NA_V10_STATUSES.CONFLICT;record.reason=evidence.reason;record.baseRevision=attempt.baseRevision;record.tabId=attempt.tabId;record.activeAttemptId=attempt.attemptId;record.currentRevision=current.revision;record.updatedAt=now;const mismatchValidation=_naV10ValidateJournalRecordStrict(record,'REBASE_PAYLOAD_MISMATCH');if(!mismatchValidation.valid)throw _naV10Error('REBASE_RESULT_INVALID',mismatchValidation.reason);operationStore.put(record);provisional=_naV10Result(_NA_V10_RESULTS.CONFLICT,{operationId,reason:evidence.reason,operation:_naV10Clone(record)});return;}
        if(record.status!==_NA_V10_STATUSES.CONFLICT||record.reason!=='REVISION_MISMATCH'){provisional=_naV10Result(_NA_V10_RESULTS.CONFLICT,{operationId,reason:'REBASE_NOT_ALLOWED',operation:_naV10Clone(record)});return;}
        const rebaseOf=record.activeAttemptId,attempt=_naV10Attempt('REBASE',current.revision,rebaseOf);record.status=_NA_V10_STATUSES.PENDING;record.reason=null;record.baseRevision=current.revision;record.currentRevision=current.revision;record.tabId=attempt.tabId;record.activeAttemptId=attempt.attemptId;record.attemptHistory.push(attempt);record.attempts+=1;record.updatedAt=attempt.updatedAt;const resultValidation=_naV10ValidateJournalRecordStrict(record,'REBASE_RESULT');if(!resultValidation.valid)throw _naV10Error('REBASE_RESULT_INVALID',resultValidation.reason);operationStore.put(record);
        provisional={status:_NA_V10_STATUSES.PENDING,operationId,logicalOperationId:record.logicalOperationId,attemptId:attempt.attemptId,rebaseOf,expectedRevision:current.revision,payload:_naV10Clone(record.payload),idempotencyPayload:_naV10Clone(record.idempotencyPayload),payloadHash:record.idempotencyHash,operation:_naV10Clone(record)};
      }catch(error){abortWith(error);}};
      stateRequest.onsuccess=()=>{current=stateRequest.result;stateReady=true;proceed();};operationRequest.onsuccess=()=>{record=operationRequest.result;operationReady=true;proceed();};stateRequest.onerror=()=>abortWith(stateRequest.error||new Error('No se pudo leer snapshot'));operationRequest.onerror=()=>abortWith(operationRequest.error||new Error('No se pudo leer journal'));
      tx.oncomplete=()=>resolve(provisional||_naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,error:{code:'EMPTY_REBASE_RESULT',message:'El rebase termino sin resultado'}}));tx.onabort=()=>resolve(_naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,error:abortError||{code:tx.error?.name||'REBASE_ABORTED',message:tx.error?.message||'El rebase fue cancelado'}}));tx.onerror=()=>{};
    });
    if(result.status===_NA_V10_STATUSES.PENDING){result.outbox=_naV10WriteOutboxRecord(result.operation);result.warnings=[];_naV10AttachStorageWarning(result.warnings,result.outbox);}return result;
  }catch(error){return _naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,error:{code:error.code||error.name||'REBASE_FAILED',message:error.message||String(error)}});}
}

function _naV10LegacyData(snapshot){return{appConfig:_naV10Clone(snapshot.appConfig||{}),ui:_naV10Clone(snapshot.ui||{}),locks:_naV10Clone(snapshot.locks||{}),security:_naV10Clone(snapshot.security||{}),productos:_naV10Clone(snapshot.data?.productos||[]),ventas:_naV10Clone(snapshot.data?.ventas||[]),clientes:_naV10Clone(snapshot.data?.clientes||[]),creditos:_naV10Clone(snapshot.data?.creditos||[]),gastos:_naV10Clone(snapshot.data?.gastos||[]),cajMovs:_naV10Clone(snapshot.data?.cajMovs||[]),cajEstado:_naV10Clone(snapshot.data?.cajEstado||{}),cart:_naV10Clone(snapshot.cart||[]),draft:_naV10Clone(snapshot.draft||null)};}
async function _naV10ReadLegacySnapshot(){
  const idb=await _naV10ReadStateValue(_NA_SNAPSHOT_KEY),local=_naReadLocalSnapshot(),session=_naReadSessionSnapshot(),candidates=[idb,local,session].filter(_naValidSnapshot).sort((left,right)=>String(right.updatedAt||'').localeCompare(String(left.updatedAt||'')));
  return candidates[0]?_naV10Clone(candidates[0]):_naLegacySnapshot();
}
async function _naV10InitializeCanonical(data,options={}){
  const operationId=options.operationId||_naNewOperationId(),commitId=options.commitId||_naNewCommitId(),committedAt=_naV10Now(),type=String(options.type||'INITIALIZE').slice(0,80),rawIdentityPayload=options.payload??null;
  if(!_naV10IsJsonSafe(data,new Set())||!_naV10IsJsonSafe(rawIdentityPayload,new Set())||(options.legacySnapshot!==undefined&&!_naV10IsJsonSafe(options.legacySnapshot,new Set())))return _naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,recoverable:true,error:{code:'NON_JSON_SAFE_INITIAL_STATE',message:'La inicializacion contiene valores no JSON-safe'}});
  const identityPayload=_naV10Clone(rawIdentityPayload),identityHash=options.payloadHash||await _naV10PayloadHash(identityPayload),db=await _naV10OpenDB();
  return new Promise(resolve=>{
    const tx=db.transaction([_NA_V10_STATE_STORE,_NA_V10_OPERATIONS_STORE,_NA_V10_CHECKPOINTS_STORE],'readwrite'),stateStore=tx.objectStore(_NA_V10_STATE_STORE),operationStore=tx.objectStore(_NA_V10_OPERATIONS_STORE),checkpointStore=tx.objectStore(_NA_V10_CHECKPOINTS_STORE),request=stateStore.get(_NA_V10_SNAPSHOT_KEY);let outcome=null,abortError=null;
    request.onsuccess=()=>{
      try{
        const existing=request.result;if(existing){if(!_naV10ValidSnapshot(existing)){outcome=_naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,recoverable:true,error:{code:'CANONICAL_MISSING_OR_INVALID',message:'El canonico existente no es verificable ni JSON-safe'},canonical:_naV10Clone(existing)});return;}outcome=_naV10Result(_NA_V10_RESULTS.ALREADY_COMMITTED,{operationId:existing.lastOperationId,revision:existing.revision,commitId:existing.commitId,snapshot:_naV10Clone(existing)});return;}
        const attempt=_naV10Attempt(type==='MIGRATION'?'MIGRATION':'INITIALIZE',null),checkpointKey=`0:${commitId}`;attempt.status=_NA_V10_STATUSES.COMMITTED;attempt.currentRevision=0;attempt.commitId=commitId;attempt.checkpointKey=checkpointKey;attempt.updatedAt=committedAt;
        const snapshot={version:10,revision:0,parentRevision:null,parentCommitId:null,commitId,lastOperationId:operationId,committedAt,writerId:_naGetTabId(),data:_naV10Clone(data)},record={operationId,logicalOperationId:operationId,type,status:_NA_V10_STATUSES.COMMITTED,journalSchemaVersion:2,baseRevision:null,committedRevision:0,commitId,checkpointKey,tabId:_naGetTabId(),createdAt:committedAt,updatedAt:committedAt,attempts:1,activeAttemptId:attempt.attemptId,attemptHistory:[attempt],payload:_naV10Clone(identityPayload),idempotencyPayload:_naV10Clone(identityPayload),idempotencyKey:_naV10IdempotencyKey(identityPayload),idempotencyHash:identityHash,payloadHash:identityHash,entityIds:[],reason:null,mismatchEvidence:[],typeMismatchEvidence:[]},checkpoint={key:checkpointKey,revision:0,commitId,operationId,logicalOperationId:operationId,attemptId:attempt.attemptId,createdAt:committedAt,snapshot:_naV10Clone(snapshot)};
        const journalValidation=_naV10ValidateJournalRecordStrict(record,'INITIALIZE');if(!_naV10ValidSnapshot(snapshot)||!journalValidation.valid||!_naV10IsJsonSafe(checkpoint,new Set()))throw _naV10Error('INITIAL_STATE_INVALID',journalValidation.reason||'Snapshot/checkpoint inicial invalido');
        stateStore.put(snapshot,_NA_V10_SNAPSHOT_KEY);operationStore.put(record);checkpointStore.put(checkpoint);
        if(options.legacySnapshot){const legacyCheckpoint={key:`legacy-v9:${commitId}`,revision:null,commitId,operationId,createdAt:committedAt,kind:'LEGACY_V9',snapshot:_naV10Clone(options.legacySnapshot)};if(!_naV10IsJsonSafe(legacyCheckpoint,new Set()))throw _naV10Error('LEGACY_CHECKPOINT_NOT_JSON_SAFE','El checkpoint V9 no es JSON-safe');checkpointStore.put(legacyCheckpoint);}
        outcome=_naV10Result(_NA_V10_RESULTS.SUCCESS,{operationId,revision:0,commitId,operation:_naV10Clone(record),snapshot:_naV10Clone(snapshot)});
      }catch(error){abortError={code:error.code||error.name||'INITIALIZE_FAILED',message:error.message||String(error)};try{tx.abort();}catch(abortProblem){}}
    };
    request.onerror=()=>{abortError={code:request.error?.name||'INITIALIZE_FAILED',message:request.error?.message||'No se pudo leer el canonico'};try{tx.abort();}catch(error){}};tx.oncomplete=()=>{if(outcome?.status===_NA_V10_RESULTS.SUCCESS&&outcome.snapshot){outcome.warnings=[];outcome.mirror=_naV10WriteMirror(outcome.snapshot);_naV10AttachStorageWarning(outcome.warnings,outcome.mirror);outcome.broadcast=_naV10PublishCommit(outcome.snapshot);}resolve(outcome);};tx.onabort=()=>resolve(_naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{operationId,recoverable:true,error:abortError||{code:'INITIALIZE_FAILED',message:tx.error?.message||'No se pudo crear snapshot V10'}}));tx.onerror=()=>{};
  });
}
async function _naV10CreateInitialSnapshot(data,options={}){return _naV10InitializeCanonical(data,{...options,type:options.type||'INITIALIZE'});}
async function _naV10MigrateFromV9(options={}){
  const existing=await _naV10ReadCanonical();if(existing)return _naV10Result(_NA_V10_RESULTS.ALREADY_COMMITTED,{operationId:existing.lastOperationId,revision:existing.revision,commitId:existing.commitId,snapshot:existing});
  const legacy=options.legacySnapshot?_naV10Clone(options.legacySnapshot):await _naV10ReadLegacySnapshot();if(!_naValidSnapshot(legacy))return _naV10Result(_NA_V10_RESULTS.PERSISTENCE_ERROR,{error:{code:'INVALID_LEGACY_SNAPSHOT',message:'No existe un snapshot V9 valido para migrar'}});
  const payload={sourceVersion:legacy.version,sourceUpdatedAt:legacy.updatedAt||null},payloadHash=await _naV10PayloadHash(payload);
  return _naV10InitializeCanonical(_naV10LegacyData(legacy),{operationId:options.operationId||_naNewOperationId(),type:'MIGRATION',payload,payloadHash,legacySnapshot:legacy});
}
function _naV10BuildUiState(source={}){return{version:1,savedAt:_naV10Now(),writerId:_naGetTabId(),ui:_naV10Clone(source.ui||{}),appConfig:_naV10Clone(source.appConfig||{})};}
function _naV10UiStateHasFinancialData(state){return['productos','ventas','clientes','creditos','gastos','cajMovs','cajEstado','cart','draft'].some(key=>Object.prototype.hasOwnProperty.call(state||{},key));}
function _naV10Diagnostics(){return{version:_NA_V10_PHASE_A_VERSION,runtime:_naV10Clone(_naV10Runtime),tabId:_naGetTabId(),dbOpened:!!_naV10DbPromise,channelOpened:!!_naV10Channel,lastBroadcast:_naV10Clone(_naV10LastBroadcast),stores:{state:_NA_V10_STATE_STORE,operations:_NA_V10_OPERATIONS_STORE,checkpoints:_NA_V10_CHECKPOINTS_STORE},snapshotKey:_NA_V10_SNAPSHOT_KEY,recoveryApis:{resolve:typeof _naV10ResolveOperation==='function',list:typeof _naV10ListRecoverableOperations==='function',rebase:typeof _naV10PrepareRebase==='function'}};}

/* ═══════════════════════════════════════════════════════════════════════════
   MOTOR DE VENTA V10 — sin reemplazar confirmarVenta todavía
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Política de crédito canónica V10 (espejo puro de _naEvaluateClientCredit V9, sin DOM ni estado global) ── */
const _NA_V10_CREDIT_POLICY_DEFAULTS={enabled:true,minPurchases:1000,minProfit:400,initialLine:5,punctualRate:10,lateRate:5};
const _NA_V10_PAYMENT_METHODS=['efectivo','yape','plin','transferencia','mixto','credito'];
function _naV10CreditPolicyFrom(data){
  const raw=(data&&data.appConfig&&data.appConfig.creditPolicy)||{},cfg={..._NA_V10_CREDIT_POLICY_DEFAULTS,...raw};
  cfg.enabled=cfg.enabled!==false;
  cfg.minPurchases=Math.max(0,Math.min(100000,_naNumber(cfg.minPurchases,1000)));
  cfg.minProfit=Math.max(0,Math.min(100000,_naNumber(cfg.minProfit,400)));
  cfg.initialLine=Math.max(0,Math.min(100000,_naNumber(cfg.initialLine,5)));
  cfg.punctualRate=Math.max(0,Math.min(100,_naNumber(cfg.punctualRate,10)));
  cfg.lateRate=Math.max(0,Math.min(100,_naNumber(cfg.lateRate,5)));
  return cfg;
}
function _naV10RoundMoney(value){return Number(Math.max(0,_naNumber(value)).toFixed(2));}
function _naV10Today(){const ahora=new Date(),local=new Date(ahora.getTime()-(ahora.getTimezoneOffset()*60000));return local.toISOString().split('T')[0];}
function _naV10DaysUntil(value,today){if(!value)return null;const d=new Date(String(value).slice(0,10)+'T00:00:00');if(Number.isNaN(d.getTime()))return null;const hoy=new Date(String(today)+'T00:00:00');if(Number.isNaN(hoy.getTime()))return null;return Math.round((d-hoy)/86400000);}
function _naV10ItemsTotal(items){return Number((Array.isArray(items)?items:[]).reduce((a,it)=>a+_naNumber(it?.price??it?.precio)*_naNumber(it?.qty??it?.cantidad),0).toFixed(2));}
function _naV10SaleTotal(sale){return Number((Array.isArray(sale?.items)?sale.items:[]).reduce((a,i)=>a+_naNumber(i.precio??i.precioUnitario)*_naNumber(i.qty??i.cantidad),0).toFixed(2));}
function _naV10NormalizedCredit(raw){
  const cr=_naV10Clone(raw)||{};
  cr.monto=Math.max(0,_naNumber(cr.monto));cr.pagado=Math.min(cr.monto,Math.max(0,_naNumber(cr.pagado)));
  if((typeof _naIsCreditVoided==='function'?_naIsCreditVoided(cr):(cr.anulado)))cr.status='anulado'; // copia (_naV10Clone): normaliza solo la copia
  else if(cr.pagado>=cr.monto&&cr.monto>0)cr.status='cancelado';
  else{const d=_naV10DaysUntil(cr.vence,_naV10Today());cr.status=d!==null&&d<0?'vencido':'vigente';}
  return cr;
}
function _naV10CreditOutstanding(cr){return Math.max(0,Number((_naNumber(cr?.monto)-_naNumber(cr?.pagado)).toFixed(2)));}
function _naV10SaleCreditRecord(sale,creditos){const list=Array.isArray(creditos)?creditos:[];return list.find(cr=>String(cr.id)===String(sale?.creditId))||list.find(cr=>String(cr.ventaId)===String(sale?.id))||null;}
function _naV10SaleItemProfit(item,productos){
  const qty=Math.max(0,_naNumber(item?.qty??item?.cantidad)),units=Math.max(1,_naInt(item?.unitsPerQty,1));
  const revenue=Math.max(0,_naNumber(item?.subtotal,_naNumber(item?.precio??item?.precioUnitario)*qty));
  let unitCost=Number(item?.costo);
  if(!Number.isFinite(unitCost)){const prod=(Array.isArray(productos)?productos:[]).find(p=>String(p.id)===String(item?.productoId??item?.id));unitCost=Math.max(0,_naNumber(prod?.costo));}
  return revenue-Math.max(0,unitCost)*qty*units;
}
function _naV10SaleRealizationFactor(sale,creditos){
  const method=String(sale?.metodo||sale?.metodoPago||'').toLowerCase();
  if(method!=='credito'&&!sale?.creditId)return 1;
  const cr=_naV10SaleCreditRecord(sale,creditos);
  if(!cr)return 0;
  const amount=Math.max(0,_naNumber(cr.monto));
  return amount>0?Math.max(0,Math.min(1,_naNumber(cr.pagado)/amount)):0;
}
function _naV10CreditCompletionDate(cr){
  let cumulative=0;const amount=Math.max(0,_naNumber(cr?.monto)),payments=(Array.isArray(cr?.pagos)?cr.pagos:[]).slice().sort((a,b)=>new Date(a.timestamp||`${a.fecha||''}T${a.hora24||a.hora||'00:00:00'}`)-new Date(b.timestamp||`${b.fecha||''}T${b.hora24||b.hora||'00:00:00'}`));
  for(const pay of payments){cumulative+=Math.max(0,_naNumber(pay.monto??pay.montoPagado));if(cumulative+0.001>=amount){const d=new Date(pay.timestamp||`${pay.fecha||''}T${pay.hora24||pay.hora||'23:59:59'}`);if(Number.isFinite(d.getTime()))return d;}}
  const fallback=new Date(cr?.updatedAt||'');
  return Number.isFinite(fallback.getTime())&&_naV10CreditOutstanding(cr)<=.001?fallback:null;
}
function _naV10CreditHistoryMetrics(data,clientId){
  const list=(Array.isArray(data?.creditos)?data.creditos:[]).filter(raw=>String(raw?.cliId??raw?.clienteId)===String(clientId)&&!(typeof _naIsCreditVoided==='function'?_naIsCreditVoided(raw):(raw.anulado||raw.status==='anulado')));
  let punctual=0,late=0,unknown=0,completed=0,partial=0,overdueActive=0,debt=0;
  for(const raw of list){
    const cr=_naV10NormalizedCredit(raw),pending=_naV10CreditOutstanding(cr);debt+=pending;
    if(pending<=.001){completed++;const completedAt=_naV10CreditCompletionDate(cr),due=cr.vence?new Date(`${String(cr.vence).slice(0,10)}T23:59:59`):null;if(completedAt&&due&&Number.isFinite(due.getTime())){if(completedAt<=due)punctual++;else late++;}else unknown++;}
    else{if(_naNumber(cr.pagado)>0)partial++;const d=_naV10DaysUntil(cr.vence,_naV10Today());if(d!==null&&d<0){late++;overdueActive++;}}
  }
  let behavior='sin_historial';
  if(punctual||late){if(late===0&&punctual>0)behavior='puntual';else if(late>punctual)behavior='impuntual';else behavior='irregular';}
  else if(partial>0)behavior='en_proceso';
  return{total:list.length,punctual,late,unknown,completed,partial,overdueActive,debt:_naV10RoundMoney(debt),behavior};
}
function _naV10EvaluateClientCredit(data,clientId){
  const clientes=Array.isArray(data?.clientes)?data.clientes:[],ventas=Array.isArray(data?.ventas)?data.ventas:[],creditos=Array.isArray(data?.creditos)?data.creditos:[],productos=Array.isArray(data?.productos)?data.productos:[];
  const client=clientes.find(c=>String(c.id)===String(clientId)),cfg=_naV10CreditPolicyFrom(data);
  if(!client)return{exists:false,enabled:cfg.enabled,eligible:false,assignedLine:0,available:0};
  const sales=ventas.filter(v=>!v.anulada&&String(v.clienteId??'')===String(client.id));
  let purchases=0,grossProfit=0,realizedProfit=0,itemCount=0;
  for(const sale of sales){const total=Math.max(0,_naNumber(_naV10SaleTotal(sale)));purchases+=total;const profit=(Array.isArray(sale.items)?sale.items:[]).reduce((sum,item)=>sum+_naV10SaleItemProfit(item,productos),0);grossProfit+=profit;realizedProfit+=profit*_naV10SaleRealizationFactor(sale,creditos);itemCount+=(Array.isArray(sale.items)?sale.items:[]).reduce((sum,item)=>sum+Math.max(0,_naNumber(item.qty??item.cantidad)),0);}
  purchases=_naV10RoundMoney(purchases);grossProfit=_naV10RoundMoney(grossProfit);realizedProfit=_naV10RoundMoney(realizedProfit);
  const history=_naV10CreditHistoryMetrics(data,client.id),byPurchases=purchases+0.001>=cfg.minPurchases,byProfit=realizedProfit+0.001>=cfg.minProfit,autoEligible=byPurchases||byProfit;
  let autoLine=0,rate=0;
  if(autoEligible&&realizedProfit>0){if(history.completed===0&&history.late===0)autoLine=Math.min(cfg.initialLine,realizedProfit);else{rate=history.behavior==='puntual'?cfg.punctualRate:cfg.lateRate;autoLine=realizedProfit*rate/100;const minimum=Math.min(cfg.initialLine,realizedProfit);autoLine=Math.max(minimum,autoLine);autoLine=Math.min(autoLine,realizedProfit);}}
  autoLine=_naV10RoundMoney(autoLine);
  const manualActive=client.lineaCreditoManualActiva===true,manualLine=_naV10RoundMoney(client.lineaCreditoManual),assignedLine=manualActive?manualLine:autoLine,eligible=cfg.enabled&&(manualActive?assignedLine>0:autoEligible&&assignedLine>0),available=cfg.enabled?_naV10RoundMoney(Math.max(0,assignedLine-history.debt)):0;
  let score=0;
  score+=Math.min(30,cfg.minPurchases>0?purchases/cfg.minPurchases*30:30);
  score+=Math.min(30,cfg.minProfit>0?realizedProfit/cfg.minProfit*30:30);
  score+=Math.min(15,sales.length*3);
  if(history.behavior==='puntual')score+=25;else if(history.behavior==='irregular')score+=12;else if(history.behavior==='en_proceso')score+=8;else if(history.behavior==='sin_historial')score+=5;
  score=Math.max(0,Math.min(100,Math.round(score)));
  const criterion=manualActive?'manual':byPurchases&&byProfit?'compras_y_ganancia':byPurchases?'compras':byProfit?'ganancia':'no_cumple',source=manualActive?'manual':'automatica',manualAboveProfit=manualActive&&manualLine>realizedProfit+0.001;
  return{exists:true,client,cfg,enabled:cfg.enabled,sales,purchases,grossProfit,realizedProfit,transactions:sales.length,itemCount,averageTicket:sales.length?_naV10RoundMoney(purchases/sales.length):0,history,byPurchases,byProfit,autoEligible,eligible,automaticLine:autoLine,manualActive,manualLine,assignedLine:_naV10RoundMoney(assignedLine),available,criterion,source,score,rate,manualAboveProfit};
}
function _naV10ResolveSessionCashier(cajEstado){
  const id=cajEstado&&cajEstado.cajeroId?String(cajEstado.cajeroId):'';
  if(!id)return{ok:false,reason:'CAJERO_AUSENTE'};
  return{ok:true,cashierId:id,cashierName:String(cajEstado.cajeroNombre||cajEstado.cajero||''),sessionId:cajEstado.sessionId?String(cajEstado.sessionId):''};
}

function _naV10BuildSaleIntent(intent){
  const operationId=intent.operationId||_naNewOperationId();
  const mixed=(intent.paymentMethod==='mixto'&&intent.mixedData&&typeof intent.mixedData==='object')?{cash:_naNumber(intent.mixedData.cash),digital:_naNumber(intent.mixedData.digital),digitalMethod:String(intent.mixedData.digitalMethod||'')}:null;
  return{operationId,items:_naV10Clone(intent.items||[]),paymentMethod:intent.paymentMethod||'efectivo',paymentRef:String(intent.paymentRef||''),clientId:intent.clientId||null,creditDue:intent.creditDue||null,cashierId:intent.cashierId||null,sessionId:intent.sessionId||null,received:intent.received===undefined||intent.received===null?null:Math.max(0,_naNumber(intent.received)),mixedData:mixed,timestamp:_naV10Now(),_built:true};
}

// Unidades físicas canónicas: qty × unitsPerQty. La propiedad real del intent V10 es boxUnits;
// unitsPerQty es el nombre equivalente usado en registros de venta (compatibilidad V9). Un solo concepto.
function _naV10ItemUnitsPerQty(item){return Math.max(1,_naInt(item?.boxUnits,item?.unitsPerQty||1));}
function _naV10ItemPhysicalUnits(item){return Math.max(0,_naNumber(item?.qty,1))*_naV10ItemUnitsPerQty(item);}

function _naV10RevalidateSale(canonical,intent){
  const d=canonical?.data;if(!d)return{ok:false,reason:'CANONICAL_MISSING'};
  const productos=d.productos||[],ventas=d.ventas||[],cajEstado=d.cajEstado||{};
  if(!cajEstado.abierta||cajEstado.cerrada)return{ok:false,reason:'CAJA_CERRADA'};
  if(!cajEstado.sessionId)return{ok:false,reason:'CAJA_SIN_SESION'};
  const identity=_naV10ResolveSessionCashier(cajEstado);
  if(!identity.ok)return{ok:false,reason:identity.reason};
  if(intent.cashierId&&String(intent.cashierId)!==identity.cashierId)return{ok:false,reason:'CAJERO_DIFERENTE'};
  if(intent.sessionId&&String(intent.sessionId)!==identity.sessionId)return{ok:false,reason:'SESION_DIFERENTE'};
  const metodo=String(intent.paymentMethod||'efectivo');
  if(_NA_V10_PAYMENT_METHODS.indexOf(metodo)<0)return{ok:false,reason:'METODO_PAGO_INVALIDO',metodo};
  const total=_naV10ItemsTotal(intent.items);
  const allowNoStock=!!(d.appConfig&&d.appConfig.freeSale&&d.appConfig.freeSale.allowRegisteredNoStock===true);
  const required={};
  for(let i=0;i<intent.items.length;i++){
    const it=intent.items[i],prod=productos.find(p=>String(p.id)===String(it.productId));
    if(!prod)return{ok:false,reason:'PRODUCTO_NO_EXISTE',productId:it.productId};
    if(prod.controlInventario!==false)required[String(prod.id)]=(required[String(prod.id)]||0)+_naV10ItemPhysicalUnits(it);
  }
  for(const productId in required){
    const prod=productos.find(p=>String(p.id)===String(productId)),req=required[productId];
    if(req>prod.stock&&!allowNoStock)return{ok:false,reason:'STOCK_INSUFICIENTE',productId:prod.id,disponible:prod.stock,requerido:req};
  }
  const ref=String(intent.paymentRef||'').trim();
  if(metodo==='efectivo'||metodo==='credito'){
    if(ref)return{ok:false,reason:'REFERENCIA_NO_APLICA',metodo};
    if(metodo==='efectivo'&&intent.received!==null&&intent.received+0.0001<total)return{ok:false,reason:'EFECTIVO_INSUFICIENTE',recibido:intent.received,requerido:total};
  }else if(metodo==='mixto'){
    const mix=intent.mixedData;
    if(!mix||typeof mix!=='object')return{ok:false,reason:'MIXTO_INVALIDO',detalle:'mixto requiere mixedData con cash, digital y digitalMethod'};
    if(!(mix.cash>0))return{ok:false,reason:'MIXTO_INVALIDO',detalle:'el componente efectivo debe ser mayor que cero'};
    if(!(mix.digital>0))return{ok:false,reason:'MIXTO_INVALIDO',detalle:'el componente digital debe ser mayor que cero'};
    if(mix.cash>=total)return{ok:false,reason:'MIXTO_INVALIDO',detalle:'el componente efectivo debe ser menor al total'};
    if(['yape','plin','transferencia'].indexOf(mix.digitalMethod)<0)return{ok:false,reason:'MIXTO_INVALIDO',detalle:'digitalMethod debe ser yape, plin o transferencia'};
    if(Math.abs(mix.cash+mix.digital-total)>0.005)return{ok:false,reason:'MIXTO_INCONSISTENTE',efectivo:mix.cash,digital:mix.digital,total};
    if(ref.length<4)return{ok:false,reason:'REFERENCIA_INVALIDA',paymentRef:intent.paymentRef,longitud:ref.length};
    if(ventas.some(v=>!v.anulada&&v.paymentRef===ref))return{ok:false,reason:'REFERENCIA_DUPLICADA',paymentRef:ref};
  }else{
    if(ref.length<4)return{ok:false,reason:'REFERENCIA_INVALIDA',paymentRef:intent.paymentRef,longitud:ref.length};
    if(ventas.some(v=>!v.anulada&&v.paymentRef===ref))return{ok:false,reason:'REFERENCIA_DUPLICADA',paymentRef:ref};
  }
  if(intent.clientId){
    const c=(d.clientes||[]).find(x=>String(x.id)===String(intent.clientId));
    if(!c)return{ok:false,reason:'CLIENTE_NO_EXISTE',clientId:intent.clientId};
  }
  if(metodo==='credito'){
    const cfg=_naV10CreditPolicyFrom(d);
    if(cfg.enabled===false)return{ok:false,reason:'CREDITO_DESACTIVADO'};
    if(!intent.clientId)return{ok:false,reason:'CREDITO_CLIENTE_AUSENTE'};
    if(!intent.creditDue)return{ok:false,reason:'CREDITO_SIN_VENCIMIENTO'};
    const evaluation=_naV10EvaluateClientCredit(d,intent.clientId);
    if(!evaluation.exists)return{ok:false,reason:'CLIENTE_NO_EXISTE',clientId:intent.clientId};
    if(!evaluation.eligible)return{ok:false,reason:'CREDITO_NO_ELEGIBLE',disponible:evaluation.available,linea:evaluation.assignedLine,criterio:evaluation.criterion};
    if(total>evaluation.available+0.001)return{ok:false,reason:'LINEA_CREDITO_INSUFICIENTE',disponible:evaluation.available,requerido:total};
  }
  return{ok:true};
}

function _naV10ApplySale(draft,intent,ctx){
  const d=draft.data||(draft.data={});
  d.productos=d.productos||[];d.ventas=d.ventas||[];d.clientes=d.clientes||[];d.creditos=d.creditos||[];d.cajMovs=d.cajMovs||[];
  const identity=_naV10ResolveSessionCashier(d.cajEstado||{});
  if(!identity.ok)throw _naV10Error(identity.reason||'CAJERO_AUSENTE','La sesion de caja no tiene cajero valido para atribuir la venta');
  const sessionId=identity.sessionId;
  const ids=d.ventas.map(v=>parseInt(String(v.id).replace('V-',''))||0),newId='V-'+String(Math.max(...ids,0)+1).padStart(6,'0'),fecha=d.cajEstado?.fechaApertura||new Date().toISOString().slice(0,10),now=new Date().toISOString(),hora=new Date().toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}),hora24=new Date().toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const ventaUid=ctx.operationId+'_sale_'+_naNewUuid().slice(0,12),cashMoveId=ctx.operationId+'_cash_'+_naNewUuid().slice(0,12);
  const total=_naV10ItemsTotal(intent.items);
  const saleItems=intent.items.map(it=>{
    const qty=Math.max(1,it.qty||1),price=Math.max(0,it.price||0),prod=d.productos.find(p=>String(p.id)===String(it.productId));
    return{id:it.productId,productoId:it.productId,sku:prod?.sku||it.sku||'',qty,cantidad:qty,precio:price,precioUnitario:price,subtotal:Number((price*qty).toFixed(2)),name:prod?.name||it.name||'',nombre:prod?.name||it.name||'',icon:prod?.icon||'📦',unidad:'unidad',unitsPerQty:_naV10ItemUnitsPerQty(it),ventaModo:_naV10ItemUnitsPerQty(it)>1?'caja':'unidad',ventaLibre:false,ventaSinStock:false,costo:prod?.costo||0,descuento:0,_precioOriginal:null,incluyeIGV:true,tipoImpuesto:'gravado'};
  });
  const metodo=intent.paymentMethod||'efectivo',estado=metodo==='credito'?'credito':'completada';
  const paymentBreakdown=metodo==='mixto'&&intent.mixedData?{efectivo:_naNumber(intent.mixedData.cash),digital:_naNumber(intent.mixedData.digital),digitalMethod:String(intent.mixedData.digitalMethod),reference:String(intent.paymentRef||'')}:null;
  let creditId=null;
  if(metodo==='credito'&&intent.clientId){
    creditId=ctx.operationId+'_credit_'+_naNewUuid().slice(0,12);
    const client=d.clientes.find(c=>String(c.id)===String(intent.clientId));
    const evaluation=_naV10EvaluateClientCredit(d,intent.clientId);
    d.creditos.push({id:creditId,cliId:intent.clientId,clienteId:intent.clientId,clienteNombre:client?.nombre||'',clienteDni:client?.dni||'',tipo:'venta_credito',desc:'Venta '+newId,monto:total,pagado:0,saldo:total,vence:intent.creditDue||fecha,status:_naV10DaysUntil(intent.creditDue,_naV10Today())<0?'vencido':'vigente',fecha,hora,hora24,timestamp:now,ventaId:newId,anulado:false,pagos:[],items:saleItems.map((it,i)=>({itemKey:it.productoId+':'+i,nombre:it.name,cantidad:it.qty,precioUnitario:it.precio,subtotal:it.subtotal,modo:it.ventaModo||'minorista'})),cajero:identity.cashierName,cajeroNombre:identity.cashierName,cajeroId:identity.cashierId,lineaCreditoAsignada:evaluation.assignedLine,lineaCreditoDisponibleAntes:evaluation.available,gananciaClienteAlCrear:evaluation.realizedProfit,deudaClienteAntes:evaluation.history.debt,scoreCreditoAlCrear:evaluation.score,fuenteLineaCredito:evaluation.source,criterioCredito:evaluation.criterion,excepcionManualCredito:evaluation.manualActive});
  }
  if(intent.clientId){
    const cl=d.clientes.find(c=>String(c.id)===String(intent.clientId));
    if(cl)cl.totalCompras=(cl.totalCompras||0)+total;
  }
  const recibido=metodo==='efectivo'?(intent.received!==null&&intent.received!==undefined?_naNumber(intent.received):total):metodo==='mixto'?paymentBreakdown.efectivo:total;
  const vuelto=metodo==='efectivo'?Math.max(0,Number((recibido-total).toFixed(2))):0;
  d.ventas.unshift({id:newId,ventaUid,operation:ctx.operationId,fecha,hora,hora24,timestamp:now,cajero:identity.cashierName,cajeroNombre:identity.cashierName,cajeroId:identity.cashierId,total,subtotal:total,descuentoTotal:0,metodo,metodoPago:metodo,estado,tipoVenta:'minorista',cantidadLineas:saleItems.length,unidadesFisicas:saleItems.reduce((a,x)=>a+(x.unitsPerQty||1)*x.qty,0),paymentRef:String(intent.paymentRef||''),paymentBreakdown,recibido,vuelto,anulada:false,clienteId:intent.clientId||null,clienteNombre:intent.clientId?(d.clientes.find(c=>String(c.id)===String(intent.clientId))?.nombre||''):null,clienteDni:null,creditId,contieneVentaLibre:false,contieneVentaSinStock:false,items:saleItems});
  d.cajMovs.push({id:cashMoveId,cashMoveId,tipo:'ing',monto:total,efectivo:metodo==='efectivo'?total:metodo==='mixto'?paymentBreakdown.efectivo:0,detallePago:paymentBreakdown,desc:'Venta POS '+newId,cat:metodo==='credito'?'Venta a crédito':metodo==='mixto'?'Venta mixta':'Venta retail',metodo,referencia:String(intent.paymentRef||''),hora,hora24,timestamp:now,cajero:identity.cashierName,cajeroNombre:identity.cashierName,cajeroId:identity.cashierId,fecha,sessionId,ventaId:newId});
  for(let i=0;i<intent.items.length;i++){
    const it=intent.items[i],prod=d.productos.find(p=>String(p.id)===String(it.productId));
    if(prod&&prod.controlInventario!==false)prod.stock=(prod.stock||0)-_naV10ItemPhysicalUnits(it);
  }
  return d;
}

async function _naV10ConfirmSaleIntent(intent){
  if(!intent._built)intent=_naV10BuildSaleIntent(intent);
  const canonical=await _naV10ReadCanonical();
  if(!canonical)return{status:_NA_V10_RESULTS.PERSISTENCE_ERROR,error:{code:'NO_CANONICAL',message:'No existe snapshot V10 canonico. Ejecuta la migracion o inicializacion primero.'}};
  const spec={operationId:intent.operationId,type:'SALE',expectedRevision:canonical.revision,payload:_naV10Clone(intent),idempotencyPayload:_naV10SaleIdempotencyPayload(intent),entityIds:[],revalidate:function(c,ctx){return _naV10RevalidateSale(c,ctx.payload);},mutate:function(draft,ctx){return _naV10ApplySale(draft,ctx.payload,ctx);}};
  return _naRunCriticalOperation(spec);
}
