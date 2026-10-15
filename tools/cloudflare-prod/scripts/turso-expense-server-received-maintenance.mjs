import { backupSelectSql } from './backup-select.mjs';
// Maintenance for migration 0033 (expense server receipt timestamp).
// Run only by the owner-authorized ops workflow canon-migration-0033.yml.
// Commands: preflight (read-only) | backup | migrate | verify.
// Nullable additive column; retries skip the existing column.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TursoD1Adapter } from '../../cloudflare-lab/src/turso-d1-adapter.js';
import { healthy, encryptBackup } from './turso-customer-contacts-maintenance.mjs';

export const migrationPath='infra/database/migrations/0033_canonical_expense_server_received_at.sql';
export const migrationHash='9a09355738e0fad4ff9bf11697f19aeac4fa69574492c1469d31316b0ba73a11';
export const backupPath='/tmp/turso-migration-0033-backup.json';
export function migrationUnits(source){
  if(createHash('sha256').update(source).digest('hex')!==migrationHash)throw new Error('migration 0033 hash mismatch');
  if(source.trim()!=='ALTER TABLE canonical_expenses ADD COLUMN server_received_at TEXT;')throw new Error('migration must contain only additive DDL');
  return [source.trim()];
}
async function inspect(db,source,required=false){
  migrationUnits(source);
  const columns=(await db.prepare('PRAGMA table_info(canonical_expenses)').all()).results;
  if(!columns.length)throw new Error('missing referenced tables: canonical_expenses');
  const column=columns.find(row=>row.name==='server_received_at');
  if(column&&(column.type.toUpperCase()!=='TEXT'||Number(column.notnull)!==0||column.dflt_value!==null||Number(column.pk)!==0))throw new Error('schema drift: server_received_at');
  if(required&&!column)throw new Error('schema mismatch: server_received_at');
  return [!!column];
}
export async function preflight(db,source){
  await healthy(db);
  const present=await inspect(db,source);
  const report={state:'EXPENSE_SERVER_RECEIVED_PREFLIGHT',objects:1,already_present:present.filter(Boolean).length};
  console.log(JSON.stringify(report));return report;
}
export async function verify(db,source){
  await inspect(db,source,true);await healthy(db);
  console.log('TURSO_EXPENSE_SERVER_RECEIVED_SCHEMA_PASS objects=1');
}
export async function migrate(db,source){
  await preflight(db,source);
  const present=await inspect(db,source);
  const missing=migrationUnits(source).filter((s,i)=>!present[i]);
  if(missing.length)await db.batch(missing.map(sql=>db.prepare(sql)));
  await verify(db,source);
}
// Full consistent logical backup (schema + every table, one read transaction), encrypted
// before it leaves the runner. Taken before 0033 is applied.
export async function backup(db){
  await healthy(db);
  const schema=(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
  const names=schema.filter(s=>s.type==='table').map(s=>s.name);
  const rows=await db.batch(names.map(n=>db.prepare(backupSelectSql(n))));
  const tables=Object.fromEntries(names.map((n,i)=>[n,rows[i].results]));
  const bytes=Buffer.from(JSON.stringify({format:'nuevo-amanecer-turso-migration-0033-backup-v1',created_at:new Date().toISOString(),schema,tables}));
  const encrypted=encryptBackup(bytes,process.env.TURSO_PROD_AUTH_TOKEN);
  writeFileSync(backupPath,encrypted,{mode:0o600});
  console.log(JSON.stringify({state:'TURSO_MIGRATION_0033_BACKUP_READY',tables:names.length,size_bytes:encrypted.length,sha256:createHash('sha256').update(encrypted).digest('hex')}));
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
