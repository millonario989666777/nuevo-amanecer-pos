import { backupSelectSql } from './backup-select.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TursoD1Adapter } from '../../cloudflare-lab/src/turso-d1-adapter.js';

export const migrationPath='infra/database/migrations/0020_canonical_customer_contacts.sql';
export const migrationHash='eeb60fc19936d76d8e90d906f3bc59e1024134991234d49a89fd6200123be013';
export function migrationUnits(source){
  if(createHash('sha256').update(source).digest('hex')!==migrationHash)throw new Error('migration 0020 hash mismatch');
  const units=source.replace(/\r\n/g,'\n').split(/;\s*\n(?=(?:\s*--[^\n]*\n)*\s*CREATE)/i).map(s=>s.trim()).filter(Boolean).map(s=>s.endsWith(';')?s:s+';');
  if(units.length!==17)throw new Error('migration 0020 statement count mismatch');
  if(units.some(s=>!/^CREATE (TABLE|TRIGGER) IF NOT EXISTS /i.test(s.replace(/^(?:--[^\n]*\n)*/,'').trim())))throw new Error('migration must contain only additive DDL');
  return units;
}
export async function healthy(db){
  const checks=await db.batch([db.prepare('PRAGMA quick_check'),db.prepare('PRAGMA foreign_key_check'),db.prepare('SELECT mode,active_promotion_id FROM canonical_control WHERE id=1')]);
  if(String(Object.values(checks[0].results[0]||{})[0]).toLowerCase()!=='ok'||checks[1].results.length)throw new Error('Turso integrity failed');
  if(checks[2].results[0]?.mode!=='ACTIVE'||!checks[2].results[0]?.active_promotion_id)throw new Error('Turso CANON inactive');
}
export async function verify(db,source){
  const names=migrationUnits(source).map(s=>s.match(/CREATE (TABLE|TRIGGER) IF NOT EXISTS (\w+)/i)).map(m=>({type:m[1].toLowerCase(),name:m[2]}));
  const results=await db.batch(names.map(n=>db.prepare('SELECT sql FROM sqlite_master WHERE type=?1 AND name=?2').bind(n.type,n.name)));
  const canonical=s=>s.replace(/--[^\n]*/g,'').replace(/\bIF NOT EXISTS\s*/gi,'').replace(/\s+/g,'').replace(/;$/,'').toLowerCase();
  const units=migrationUnits(source);
  for(let i=0;i<names.length;i++)if(canonical(results[i].results[0]?.sql||'')!==canonical(units[i]))throw new Error('schema mismatch: '+names[i].name);
  await healthy(db);
  console.log('TURSO_CONTACT_SCHEMA_PASS objects='+names.length);
}
export function encryptBackup(bytes,secret){
  if(!secret||secret.length<32)throw new Error('backup encryption secret missing or too short');
  const key=createHash('sha256').update('nuevo-amanecer-contact-backup-v1\0'+secret).digest();
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from('nuevo-amanecer-contact-backup-v1'));
  const data=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return Buffer.from(JSON.stringify({format:'nuevo-amanecer-contact-backup-encrypted-v1',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}));
}
export async function backup(db){
  await healthy(db);
  const schema=(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
  const names=schema.filter(s=>s.type==='table').map(s=>s.name);
  // One transaction produces a consistent logical snapshot without changing data.
  const rows=await db.batch(names.map(n=>db.prepare(backupSelectSql(n))));
  const tables=Object.fromEntries(names.map((n,i)=>[n,rows[i].results]));
  const bytes=Buffer.from(JSON.stringify({format:'nuevo-amanecer-turso-contacts-backup-v1',created_at:new Date().toISOString(),schema,tables}));
  const encrypted=encryptBackup(bytes,process.env.TURSO_PROD_AUTH_TOKEN);
  writeFileSync('/tmp/turso-contacts-backup.json',encrypted,{mode:0o600});
  console.log(JSON.stringify({state:'TURSO_CONTACT_BACKUP_READY',tables:names.length,size_bytes:encrypted.length,sha256:createHash('sha256').update(encrypted).digest('hex')}));
}
export async function main(){
  const db=new TursoD1Adapter({url:process.env.TURSO_PROD_DATABASE_URL,authToken:process.env.TURSO_PROD_AUTH_TOKEN});
  const source=readFileSync(migrationPath,'utf8');
  const command=process.argv[2];
  if(command==='backup')return backup(db);
  if(command==='verify')return verify(db,source);
  if(command==='migrate'){
    await healthy(db);
    // All DDL is atomic; retries create missing objects but never overwrite existing ones.
    await db.batch(migrationUnits(source).map(sql=>db.prepare(sql)));
    await verify(db,source);
    console.log('MIGRATION_0020_APPLIED_OR_ALREADY_PRESENT');
    return;
  }
  throw new Error('unknown command');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
