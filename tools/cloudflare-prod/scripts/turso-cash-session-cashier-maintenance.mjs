import { backupSelectSql } from './backup-select.mjs';
// Maintenance for migration 0031 (canonical cashier attribution).
// Run only by the owner-authorized ops workflow canon-migration-0031.yml.
// Commands: preflight (read-only) | backup | migrate | verify.
// Four nullable columns; retries inspect the schema and add only missing columns.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TursoD1Adapter } from '../../cloudflare-lab/src/turso-d1-adapter.js';
import { healthy, encryptBackup } from './turso-customer-contacts-maintenance.mjs';

export const migrationPath='infra/database/migrations/0031_canonical_cash_session_cashier.sql';
export const migrationHash='96ec48ca889e204e426a4229296849741cd86bfff8262e78e223ff52e8f3b5ee';
export const backupPath='/tmp/turso-migration-0031-backup.json';
const columns=[
  ['canonical_cash_sessions','opened_by_user_id'],
  ['canonical_cash_sessions','opened_by_name'],
  ['canonical_cash_closures','closed_by_user_id'],
  ['canonical_cash_closures','closed_by_name'],
];
export function migrationUnits(source){
  if(createHash('sha256').update(source).digest('hex')!==migrationHash)throw new Error('migration 0031 hash mismatch');
  const units=source.split(';').map(s=>s.trim()).filter(Boolean);
  if(units.length!==4||units.some((s,i)=>s!==`ALTER TABLE ${columns[i][0]} ADD COLUMN ${columns[i][1]} TEXT`))throw new Error('migration must contain only additive DDL');
  return units.map(s=>s+';');
}
async function inspect(db,source,required=false){
  migrationUnits(source);
  const tables=new Map();
  for(const table of new Set(columns.map(c=>c[0]))){
    const rows=(await db.prepare('SELECT name,type,"notnull",dflt_value FROM pragma_table_info(?1)').bind(table).all()).results;
    if(!rows.length)throw new Error('missing referenced tables: '+table);
    tables.set(table,rows);
  }
  return columns.map(([table,name])=>{
    const row=tables.get(table).find(r=>r.name===name);
    if(row&&(String(row.type).toUpperCase()!=='TEXT'||Number(row.notnull)!==0||row.dflt_value!==null))throw new Error('schema drift: '+table+'.'+name);
    if(required&&!row)throw new Error('schema mismatch: '+table+'.'+name);
    return !!row;
  });
}
export async function preflight(db,source){
  await healthy(db);
  const present=await inspect(db,source);
  const report={state:'CASH_SESSION_CASHIER_PREFLIGHT',objects:4,already_present:present.filter(Boolean).length};
  console.log(JSON.stringify(report));return report;
}
export async function verify(db,source){
  await inspect(db,source,true);await healthy(db);
  console.log('TURSO_CASH_SESSION_CASHIER_SCHEMA_PASS columns=4');
}
export async function migrate(db,source){
  await preflight(db,source);
  const present=await inspect(db,source);
  const missing=migrationUnits(source).filter((s,i)=>!present[i]);
  if(missing.length)await db.batch(missing.map(sql=>db.prepare(sql)));
  await verify(db,source);
}
// Full consistent logical backup (schema + every table, one read transaction), encrypted
// before it leaves the runner. Taken before 0031 is applied.
export async function backup(db){
  await healthy(db);
  const schema=(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
  const names=schema.filter(s=>s.type==='table').map(s=>s.name);
  const rows=await db.batch(names.map(n=>db.prepare(backupSelectSql(n))));
  const tables=Object.fromEntries(names.map((n,i)=>[n,rows[i].results]));
  const bytes=Buffer.from(JSON.stringify({format:'nuevo-amanecer-turso-migration-0031-backup-v1',created_at:new Date().toISOString(),schema,tables}));
  const encrypted=encryptBackup(bytes,process.env.TURSO_PROD_AUTH_TOKEN);
  writeFileSync(backupPath,encrypted,{mode:0o600});
  console.log(JSON.stringify({state:'TURSO_MIGRATION_0031_BACKUP_READY',tables:names.length,size_bytes:encrypted.length,sha256:createHash('sha256').update(encrypted).digest('hex')}));
}
export async function main(){
  const db=new TursoD1Adapter({url:process.env.TURSO_PROD_DATABASE_URL,authToken:process.env.TURSO_PROD_AUTH_TOKEN});
  const source=readFileSync(migrationPath,'utf8');
  const command=process.argv[2];
  if(command==='preflight')return preflight(db,source);
  if(command==='backup')return backup(db);
  if(command==='verify')return verify(db,source);
  if(command==='migrate')return migrate(db,source);
  throw new Error('unknown command');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
