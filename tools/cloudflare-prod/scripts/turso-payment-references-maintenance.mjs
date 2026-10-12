// Owner-run maintenance for migration 0021 (P1-1: one voucher number per promotion).
// NOT run by CI or by any agent. Commands: preflight (read-only) | backup | migrate | verify.
// The migration is additive: one new append-only table, two immutability triggers and an
// INSERT OR IGNORE backfill from existing PAYMENT events. No existing row is changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TursoD1Adapter } from '../../cloudflare-lab/src/turso-d1-adapter.js';
import { healthy, encryptBackup } from './turso-customer-contacts-maintenance.mjs';

export const migrationPath='infra/database/migrations/0021_canonical_payment_references.sql';
export const migrationHash='09a4674f0c91c0acd334448e3500b1d75d976f26eaff8c4b4159ec55404f97eb';
const NORM="lower(replace(replace(replace(replace(trim(e.reference),' ',''),char(9),''),char(10),''),char(13),''))";
export function migrationUnits(source){
  if(createHash('sha256').update(source).digest('hex')!==migrationHash)throw new Error('migration 0021 hash mismatch');
  const units=source.replace(/\r\n/g,'\n').split(/;\s*\n(?=(?:\s*--[^\n]*\n)*\s*(?:CREATE|INSERT))/i).map(s=>s.trim()).filter(Boolean).map(s=>s.endsWith(';')?s:s+';');
  const bare=units.map(s=>s.replace(/^(?:--[^\n]*\n)*/,'').trim());
  if(units.length!==4)throw new Error('migration 0021 statement count mismatch');
  if(!bare.slice(0,3).every(s=>/^CREATE (TABLE|TRIGGER) IF NOT EXISTS /i.test(s))||!/^INSERT OR IGNORE INTO canonical_payment_references\(/i.test(bare[3]))
    throw new Error('migration must contain only additive DDL and the OR IGNORE backfill');
  return units;
}
// Read-only: how many digital vouchers are already reused in production (they stay as they are).
export async function preflight(db){
  await healthy(db);
  const [dups]=await db.batch([db.prepare(`SELECT ${NORM} AS reference_norm,COUNT(*) AS uses,SUM(-e.credit_delta_cents) AS cents
    FROM canonical_financial_events e WHERE e.event_type='PAYMENT' AND e.payment_method IN ('yape','plin','transferencia')
      AND e.reference IS NOT NULL AND length(trim(e.reference))>0
      AND NOT EXISTS(SELECT 1 FROM canonical_financial_events c WHERE c.compensates_operation_id=e.operation_id)
    GROUP BY e.promotion_id,${NORM} HAVING COUNT(*)>1 ORDER BY uses DESC`)]);
  const report={state:'PAYMENT_REFERENCES_PREFLIGHT',duplicated_vouchers:dups.results.length,
    extra_uses:dups.results.reduce((n,r)=>n+Number(r.uses)-1,0)};
  console.log(JSON.stringify(report));
  return {...report,rows:dups.results};
}
export async function verify(db,source){
  migrationUnits(source);
  const results=await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='canonical_payment_references'"),
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('payment_reference_no_update','payment_reference_no_delete')"),
  ]);
  if(Number(results[0].results[0]?.n)!==1||Number(results[1].results[0]?.n)!==2)throw new Error('schema mismatch: canonical_payment_references');
  const [missing]=await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM canonical_financial_events e WHERE e.event_type='PAYMENT' AND e.payment_method IN ('yape','plin','transferencia')
      AND e.reference IS NOT NULL AND length(trim(e.reference))>0
      AND NOT EXISTS(SELECT 1 FROM canonical_financial_events c WHERE c.compensates_operation_id=e.operation_id)
      AND NOT EXISTS(SELECT 1 FROM canonical_payment_references r WHERE r.promotion_id=e.promotion_id AND r.reference_norm=${NORM})`),
  ]);
  if(Number(missing.results[0]?.n)!==0)throw new Error('backfill incomplete');
  await healthy(db);
  console.log('TURSO_PAYMENT_REFERENCES_PASS');
}
export async function backup(db){
  await healthy(db);
  const names=['canonical_financial_events','canonical_financial_operations','canonical_control'];
  const rows=await db.batch(names.map(n=>db.prepare('SELECT * FROM "'+n+'"')));
  const bytes=Buffer.from(JSON.stringify({format:'nuevo-amanecer-turso-payment-references-backup-v1',created_at:new Date().toISOString(),tables:Object.fromEntries(names.map((n,i)=>[n,rows[i].results]))}));
  const encrypted=encryptBackup(bytes,process.env.TURSO_PROD_AUTH_TOKEN);
  writeFileSync('/tmp/turso-payment-references-backup.json',encrypted,{mode:0o600});
  console.log(JSON.stringify({state:'TURSO_PAYMENT_REFERENCES_BACKUP_READY',size_bytes:encrypted.length,sha256:createHash('sha256').update(encrypted).digest('hex')}));
}
export async function main(){
  const db=new TursoD1Adapter({url:process.env.TURSO_PROD_DATABASE_URL,authToken:process.env.TURSO_PROD_AUTH_TOKEN});
  const source=readFileSync(migrationPath,'utf8');
  const command=process.argv[2];
  if(command==='preflight')return preflight(db);
  if(command==='backup')return backup(db);
  if(command==='verify')return verify(db,source);
  if(command==='migrate'){
    await healthy(db);
    // One atomic batch; a retry never overwrites (IF NOT EXISTS / OR IGNORE).
    await db.batch(migrationUnits(source).map(sql=>db.prepare(sql)));
    await verify(db,source);
    console.log('MIGRATION_0021_APPLIED_OR_ALREADY_PRESENT');
    return;
  }
  throw new Error('unknown command');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
