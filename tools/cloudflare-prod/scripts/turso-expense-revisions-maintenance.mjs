import { backupSelectSql } from './backup-select.mjs';
// Maintenance for migration 0032 (immutable expense revisions).
// Run only by the owner-authorized ops workflow canon-migration-0032.yml.
// Commands: preflight (read-only) | backup | migrate | verify.
// Append-only table and index; retries add only missing objects.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TursoD1Adapter } from '../../cloudflare-lab/src/turso-d1-adapter.js';
import { healthy, encryptBackup } from './turso-customer-contacts-maintenance.mjs';

export const migrationPath='infra/database/migrations/0032_canonical_expense_revisions.sql';
export const migrationHash='5ecb682921e868ee799d27b01650b5aaaee922fcdae90fcb30bbaa67a850a087';
export const backupPath='/tmp/turso-migration-0032-backup.json';
const objects=[['table','canonical_expense_revisions'],['index','idx_canonical_expense_revisions_promotion']];
export function migrationUnits(source){
  if(createHash('sha256').update(source).digest('hex')!==migrationHash)throw new Error('migration 0032 hash mismatch');
  const units=source.split(';').map(s=>s.trim()).filter(Boolean);
  if(units.length!==2||!units[0].startsWith('CREATE TABLE IF NOT EXISTS ')||!units[1].startsWith('CREATE INDEX IF NOT EXISTS '))throw new Error('migration must contain only additive DDL');
  return units.map(s=>s+';');
}
async function inspect(db,source,required=false){
  const units=migrationUnits(source);
  const base=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_expenses'").all()).results;
  if(!base.length)throw new Error('missing referenced tables: canonical_expenses');
  const present=[];
  for(let i=0;i<objects.length;i++){
    const [type,name]=objects[i];
    const row=(await db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?1').bind(name).all()).results[0];
    const normalize=s=>s.replace(/IF NOT EXISTS /ig,'').replace(/\s+/g,'').replace(/;$/,'').toLowerCase();
    if(row&&(row.type!==type||normalize(row.sql)!==normalize(units[i])))throw new Error('schema drift: '+name);
    if(required&&!row)throw new Error('schema mismatch: '+name);
    present.push(!!row);
  }
  return present;
}
export async function preflight(db,source){
  await healthy(db);
  const present=await inspect(db,source);
  const report={state:'EXPENSE_REVISIONS_PREFLIGHT',objects:2,already_present:present.filter(Boolean).length};
  console.log(JSON.stringify(report));return report;
}
export async function verify(db,source){
  await inspect(db,source,true);await healthy(db);
  console.log('TURSO_EXPENSE_REVISIONS_SCHEMA_PASS objects=2');
}
export async function migrate(db,source){
  await preflight(db,source);
  const present=await inspect(db,source);
  const missing=migrationUnits(source).filter((s,i)=>!present[i]);
  if(missing.length)await db.batch(missing.map(sql=>db.prepare(sql)));
  await verify(db,source);
}
// Full consistent logical backup (schema + every table, one read transaction), encrypted
// before it leaves the runner. Taken before 0032 is applied.
export async function backup(db){
  await healthy(db);
  const schema=(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
  const names=schema.filter(s=>s.type==='table').map(s=>s.name);
  const rows=await db.batch(names.map(n=>db.prepare(backupSelectSql(n))));
  const tables=Object.fromEntries(names.map((n,i)=>[n,rows[i].results]));
  const bytes=Buffer.from(JSON.stringify({format:'nuevo-amanecer-turso-migration-0032-backup-v1',created_at:new Date().toISOString(),schema,tables}));
  const encrypted=encryptBackup(bytes,process.env.TURSO_PROD_AUTH_TOKEN);
  writeFileSync(backupPath,encrypted,{mode:0o600});
  console.log(JSON.stringify({state:'TURSO_MIGRATION_0032_BACKUP_READY',tables:names.length,size_bytes:encrypted.length,sha256:createHash('sha256').update(encrypted).digest('hex')}));
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
