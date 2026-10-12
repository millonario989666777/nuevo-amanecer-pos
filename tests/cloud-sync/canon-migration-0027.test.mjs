// Ops workflow canon-migration-0027.yml: mirrors canon-migration-0026.test.mjs.
// Nothing here touches production; the maintenance script runs against local SQLite fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {activeCanon} from './canon-browser-harness.mjs';
import * as roles from '../../tools/cloudflare-prod/scripts/turso-pos-notes-maintenance.mjs';
import {encryptBackup} from '../../tools/cloudflare-prod/scripts/turso-customer-contacts-maintenance.mjs';

const source=readFileSync(roles.migrationPath,'utf8');
const prior=['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql','0016_canonical_generic_sale_lines.sql','0017_canonical_live_customers.sql','0018_canonical_customer_credit_policy.sql','0020_canonical_customer_contacts.sql','0023_canonical_customer_identity.sql','0024_pos_roles_owner_pin.sql','0025_pos_reviews_pin_failures.sql','0026_pos_sale_annulments.sql'];
const WORKFLOW='.github/workflows/canon-migration-0027.yml';
const TRIGGER='ops/canon-migration-0027.json';
// The workflow file is added separately (it needs a token with the GitHub `workflow` scope).
const workflow=existsSync(WORKFLOW)?readFileSync(WORKFLOW,'utf8'):null;
function adapter(database){
  return {prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async all(){return {results:database.prepare(sql).all(...this.args)};}};},
    async batch(statements){return statements.map(s=>({results:database.prepare(s.sql).all(...s.args)}));}};
}
function apply(database,units){database.exec('BEGIN');for(const sql of units)database.exec(sql);database.exec('COMMIT');}

test('0027 is one additive table; preflight is read-only; retry retains rows and exact schema',async(t)=>{
  const f=await activeCanon(t,{migrations:prior});
  const db=adapter(f.database);
  const before=f.counts();
  const units=roles.migrationUnits(source);
  assert.equal(units.length,1);
  assert.ok(units.every(s=>/^(?:--[^\n]*\n)*CREATE TABLE IF NOT EXISTS pos_/.test(s)));
  assert.doesNotMatch(source,/\b(ALTER|DROP|DELETE|UPDATE|INSERT)\b/i);
  const schemaBefore=f.database.prepare('SELECT COUNT(*) n FROM sqlite_master').get().n;
  const report=await roles.preflight(db,source);
  assert.deepEqual({objects:report.objects,already_present:report.already_present},{objects:1,already_present:0});
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM sqlite_master').get().n,schemaBefore,'preflight must not write');
  await assert.rejects(()=>roles.verify(db,source),/schema mismatch/);
  apply(f.database,units);
  assert.deepEqual(f.counts(),before);
  await roles.verify(db,source);
  apply(f.database,units);
  await roles.verify(db,source);
  assert.equal((await roles.preflight(db,source)).already_present,1);
  f.database.exec('DROP TABLE pos_sale_notes');
  await assert.rejects(()=>roles.verify(db,source),/schema mismatch: pos_sale_notes/);
});

test('0027 preflight refuses drifted objects before any write',async(t)=>{
  const f=await activeCanon(t,{migrations:prior});
  f.database.exec("CREATE TABLE pos_sale_notes(sale_id TEXT PRIMARY KEY)");
  await assert.rejects(()=>roles.preflight(adapter(f.database),source),/schema drift: pos_sale_notes/);
});

test('migration refuses altered source and inactive authority',async(t)=>{
  assert.throws(()=>roles.migrationUnits(source+'\nDELETE FROM sales;'),/hash mismatch/);
  const f=await activeCanon(t,{migrations:prior});
  const db=adapter(f.database);
  const batch=db.batch;
  db.batch=async statements=>{const out=await batch(statements);if(out[2]?.results?.[0]?.mode)out[2].results[0].mode='SHADOW';return out;};
  await assert.rejects(()=>roles.preflight(db,source),/inactive/);
});

test('backups are authenticated encrypted before upload and reject absent keys',async()=>{
  const {createHash,createDecipheriv}=await import('node:crypto');
  const secret='test-only-secret-'.repeat(4), plain=Buffer.from('{"document":"private dni"}');
  const out=encryptBackup(plain,secret);
  assert.ok(!out.toString().includes('private dni'));
  assert.throws(()=>encryptBackup(plain,''),/secret/);
  const packet=JSON.parse(out);
  const key=createHash('sha256').update('nuevo-amanecer-contact-backup-v1\0'+secret).digest();
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(packet.iv,'base64'));
  decipher.setAAD(Buffer.from('nuevo-amanecer-contact-backup-v1'));
  decipher.setAuthTag(Buffer.from(packet.tag,'base64'));
  assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(packet.data,'base64')),decipher.final()]),plain);
  assert.equal(roles.backupPath,'/tmp/turso-migration-0027-backup.json');
});

test('full logical backup covers schema and every table, encrypted with the existing Turso credential',async(t)=>{
  const {createHash,createDecipheriv}=await import('node:crypto');
  const f=await activeCanon(t,{migrations:prior});
  const saved=process.env.TURSO_PROD_AUTH_TOKEN, secret='fixture-only-token-'.repeat(3);
  process.env.TURSO_PROD_AUTH_TOKEN=secret;
  t.after(()=>{if(saved===undefined)delete process.env.TURSO_PROD_AUTH_TOKEN;else process.env.TURSO_PROD_AUTH_TOKEN=saved;});
  await roles.backup(adapter(f.database));
  const packet=JSON.parse(readFileSync(roles.backupPath,'utf8'));
  const key=createHash('sha256').update('nuevo-amanecer-contact-backup-v1\0'+secret).digest();
  const d=createDecipheriv('aes-256-gcm',key,Buffer.from(packet.iv,'base64'));
  d.setAAD(Buffer.from('nuevo-amanecer-contact-backup-v1'));d.setAuthTag(Buffer.from(packet.tag,'base64'));
  const plain=JSON.parse(Buffer.concat([d.update(Buffer.from(packet.data,'base64')),d.final()]));
  assert.equal(plain.format,'nuevo-amanecer-turso-migration-0027-backup-v1');
  const tables=f.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name).sort();
  assert.deepEqual(Object.keys(plain.tables).sort(),tables);
  assert.equal(plain.tables.customers.length,f.database.prepare('SELECT COUNT(*) n FROM customers').get().n);
  assert.ok(plain.schema.some(s=>s.type==='trigger'));
});

test('workflow order: contracts, read-only preflight, verified R2 backup, then 0027; no deploys',{skip:!workflow},()=>{
  const steps=workflow.split('\n').filter(l=>/^      - name: /.test(l)).map(l=>l.replace(/^      - name: /,'').trim());
  const at=name=>{const i=steps.findIndex(s=>s.startsWith(name));assert.ok(i>=0,'missing step '+name);return i;};
  const order=['Require existing deployment credentials','Checkout exact authorized HEAD','Validate authorized scope','Verify migration contracts',
    'Read-only preflight 0027','Create consistent encrypted logical Turso backup','Store and verify backup in private remote R2',
    'Apply additive migration 0027','Verify schema and production health'];
  const idx=order.map(at);
  assert.deepEqual([...idx].sort((a,b)=>a-b),idx,'steps out of order');
  assert.match(workflow,/paths:\n\s+- "ops\/canon-migration-0027\.json"/);
  assert.match(workflow,/group: nuevo-amanecer-production-change\n\s+cancel-in-progress: false/);
  assert.match(workflow,/R2_BUCKET: nuevo-amanecer-prod-v2-backups/);
  assert.match(workflow,/r2 object put[^\n]+--remote/);
  assert.match(workflow,/r2 object get[^\n]+--remote/);
  assert.match(workflow,/test "\$\(sha256sum \/tmp\/turso-migration-0027-backup\.json/);
  assert.match(workflow,/t\.action!=='apply-canon-migration-0027'/);
  assert.match(workflow,/t\.destructive!==false/);
  assert.match(workflow,/\['0027'\]/);
  assert.match(workflow,/::add-mask::\$TURSO_PROD_AUTH_TOKEN/);
  assert.doesNotMatch(workflow,/workflow_dispatch/);
  assert.doesNotMatch(workflow,/wrangler deploy(?! --dry-run)/,'this workflow must not deploy Worker or POS');
  assert.doesNotMatch(workflow,/wrangler d1 /,'Turso is the authority; D1 must not be touched');
  assert.doesNotMatch(workflow,/set -x/);
});

test('trigger file is optional; when present it carries exactly the authorized scope',()=>{
  if(!existsSync(TRIGGER))return;
  const t=JSON.parse(readFileSync(TRIGGER,'utf8'));
  assert.equal(t.action,'apply-canon-migration-0027');
  assert.equal(t.authorized,true);assert.equal(t.authorized_by,'owner');assert.equal(t.provider,'turso');assert.equal(t.destructive,false);
  assert.deepEqual(t.migrations,['0027']);
  assert.match(t.feature_commit,/^[a-f0-9]{40}$/);
});

test('workflow refresh preserves ancestry needed to validate approved feature commit',{skip:!workflow},async(t)=>{
  const {mkdtempSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {execFileSync,spawnSync}=await import('node:child_process');
  const root=mkdtempSync(join(tmpdir(),'migration-0027-history-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const origin=join(root,'origin'),clone=join(root,'clone');
  const git=(cwd,...args)=>execFileSync('git',args,{cwd,stdio:['ignore','pipe','pipe']}).toString().trim();
  git(root,'init','--initial-branch=feature/v1.3-mobile-cloud',origin);
  git(origin,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','approved feature');
  const feature=git(origin,'rev-parse','HEAD');
  git(origin,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','migration trigger');
  git(root,'clone','file://'+origin,clone);
  const fetch=workflow.split('\n').find(line=>line.trim().startsWith('git fetch origin ')).trim().split(/\s+/).slice(1);
  git(clone,...fetch);
  const out=spawnSync('git',['merge-base','--is-ancestor',feature,'HEAD'],{cwd:clone});
  assert.equal(out.status,0,'refresh must retain feature ancestry');
});
