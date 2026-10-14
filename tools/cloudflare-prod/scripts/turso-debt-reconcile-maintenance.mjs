import { backupSelectSql } from './backup-select.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TursoD1Adapter } from '../../cloudflare-lab/src/turso-d1-adapter.js';

const URL=process.env.TURSO_PROD_DATABASE_URL||'';
const TOKEN=process.env.TURSO_PROD_AUTH_TOKEN||'';
const command=process.argv[2]||'verify';
const db=new TursoD1Adapter({url:URL,authToken:TOKEN});

function sqlUnits(source){
  return source
    .replace(/\r\n/g,'\n')
    .split(/;\s*\n(?=(?:\s*--[^\n]*\n)*\s*(?:CREATE|DROP))/i)
    .map((part,index,array)=>{
      const trimmed=part.trim();
      if(!trimmed)return '';
      return trimmed.endsWith(';')||index===array.length-1?trimmed:trimmed+';';
    })
    .filter(Boolean);
}
async function first(sql,...params){
  return params.length?db.prepare(sql).bind(...params).first():db.prepare(sql).first();
}
async function all(sql,...params){
  const out=params.length?await db.prepare(sql).bind(...params).all():await db.prepare(sql).all();
  return out.results||[];
}
async function schemaCount(){
  const row=await first("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('canonical_reconciliation_credits','canonical_credit_baseline_adjustments')");
  return Number(row?.n||0);
}
async function assertHealthy(){
  const quick=await all('PRAGMA quick_check');
  const value=String(Object.values(quick[0]||{})[0]||'').toLowerCase();
  if(value!=='ok')throw new Error('Turso quick_check failed');
  const fk=await all('PRAGMA foreign_key_check');
  if(fk.length)throw new Error('Turso foreign_key_check failed');
  const control=await first('SELECT mode,active_promotion_id,revision,authority_epoch FROM canonical_control WHERE id=1');
  if(!control||control.mode!=='ACTIVE'||!control.active_promotion_id)throw new Error('Turso CANON is not ACTIVE');
  return control;
}
async function backup(){
  const control=await assertHealthy();
  const names=(await all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map(row=>String(row.name));
  const wanted=[
    'canonical_control','customers','canonical_live_customers','canonical_customer_registry','canonical_customer_operations',
    'credits','live_credits','credit_payments','canonical_financial_events','canonical_financial_operations',
    'canonical_reconciliation_credits','canonical_credit_baseline_adjustments'
  ].filter(name=>names.includes(name));
  const tables={};
  for(const name of wanted)tables[name]=await all(backupSelectSql(name));
  const payload={
    format:'nuevo-amanecer-turso-debt-reconcile-backup-v1',
    created_at:new Date().toISOString(),
    provider:'turso',
    control,
    tables
  };
  const bytes=Buffer.from(JSON.stringify(payload));
  const sha256=createHash('sha256').update(bytes).digest('hex');
  writeFileSync('/tmp/turso-debt-reconcile-backup.json',bytes);
  writeFileSync('/tmp/turso-debt-reconcile-backup.sha256',sha256+'\n');
  console.log(JSON.stringify({state:'TURSO_DEBT_BACKUP_READY',tables:wanted.length,size_bytes:bytes.length,sha256}));
}
async function migrate(){
  await assertHealthy();
  const before=await schemaCount();
  if(![0,2].includes(before))throw new Error('partial reconciliation schema');
  if(before===2){
    console.log(JSON.stringify({state:'MIGRATION_0019_ALREADY_PRESENT'}));
    return;
  }
  const source=readFileSync('infra/database/migrations/0019_canonical_debt_reconciliation.sql','utf8');
  const units=sqlUnits(source);
  if(units.length<8)throw new Error('migration 0019 split produced too few statements');
  await db.batch(units.map(sql=>db.prepare(sql)));
  console.log(JSON.stringify({state:'MIGRATION_0019_APPLIED',statements:units.length}));
}
async function verify(){
  const control=await assertHealthy();
  const count=await schemaCount();
  if(count!==2)throw new Error('reconciliation schema not ready');
  const row=await first("SELECT "+
    "(SELECT COUNT(*) FROM sqlite_master WHERE type='view' AND name='canonical_credit_balances') balance_view,"+
    "(SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='financial_event_credit_safe') credit_guard");
  if(Number(row?.balance_view)!==1||Number(row?.credit_guard)!==1)throw new Error('migration 0019 incomplete');
  console.log(JSON.stringify({state:'TURSO_DEBT_SCHEMA_PASS',promotion_id:control.active_promotion_id}));
}
if(command==='backup')await backup();
else if(command==='migrate')await migrate();
else if(command==='verify')await verify();
else throw new Error('unknown command');
