// Ops workflow canon-migrations-0021-0022.yml: mirrors canon-receipts-activation.test.mjs (0020).
// Nothing here touches production; the maintenance scripts run against local SQLite fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {activeCanon} from './canon-browser-harness.mjs';
import * as refs from '../../tools/cloudflare-prod/scripts/turso-payment-references-maintenance.mjs';
import * as revs from '../../tools/cloudflare-prod/scripts/turso-product-revisions-maintenance.mjs';
import {encryptBackup} from '../../tools/cloudflare-prod/scripts/turso-customer-contacts-maintenance.mjs';

const refsSource=readFileSync(refs.migrationPath,'utf8');
const revsSource=readFileSync(revs.migrationPath,'utf8');
const prior=['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql','0016_canonical_generic_sale_lines.sql','0017_canonical_live_customers.sql','0018_canonical_customer_credit_policy.sql','0020_canonical_customer_contacts.sql'];
const WORKFLOW='.github/workflows/canon-migrations-0021-0022.yml';
const workflow=readFileSync(WORKFLOW,'utf8');
function adapter(database){
  return {prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async all(){return {results:database.prepare(sql).all(...this.args)};}};},
    async batch(statements){return statements.map(s=>({results:database.prepare(s.sql).all(...s.args)}));}};
}
function apply(database,units){database.exec('BEGIN');for(const sql of units)database.exec(sql);database.exec('COMMIT');}

test('0022 splitter preserves full triggers; preflight is read-only; additive retry retains ledgers and exact schema',async(t)=>{
  const f=await activeCanon(t,{migrations:prior});
  const db=adapter(f.database);
  const before=f.counts();
  const units=revs.migrationUnits(revsSource);
  assert.equal(units.length,22);
  assert.ok(units.every(s=>!/BEGIN SELECT RAISE/.test(s)||/END;$/.test(s)),'every trigger keeps its END');
  const schemaBefore=f.database.prepare('SELECT COUNT(*) n FROM sqlite_master').get().n;
  const report=await revs.preflight(db,revsSource);
  assert.deepEqual({objects:report.objects,already_present:report.already_present},{objects:22,already_present:0});
  assert.ok(report.referenced_tables>=15);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM sqlite_master').get().n,schemaBefore,'preflight must not write');
  await assert.rejects(()=>revs.verify(db,revsSource),/schema mismatch/);
  apply(f.database,units);
  assert.deepEqual(f.counts(),before);
  await revs.verify(db,revsSource);
  apply(f.database,units);
  await revs.verify(db,revsSource);
  assert.equal((await revs.preflight(db,revsSource)).already_present,22);
  assert.deepEqual(f.counts(),before);
  f.database.exec('DROP TRIGGER canonical_product_revision_no_delete');
  await assert.rejects(()=>revs.verify(db,revsSource),/schema mismatch/);
  f.database.exec(units.find(s=>s.includes('CREATE TRIGGER IF NOT EXISTS canonical_product_revision_no_delete')));
  await revs.verify(db,revsSource);
});

test('0022 preflight refuses drifted objects and missing trigger targets before any write',async(t)=>{
  const f=await activeCanon(t,{migrations:prior});
  const db=adapter(f.database);
  f.database.exec("CREATE TRIGGER canonical_command_receipts_product_revision_collision BEFORE INSERT ON canonical_command_receipts BEGIN SELECT 1; END;");
  await assert.rejects(()=>revs.preflight(db,revsSource),/schema drift: canonical_command_receipts_product_revision_collision/);
  const g=await activeCanon(t,{migrations:prior.filter(m=>!m.startsWith('0020'))});
  await assert.rejects(()=>revs.preflight(adapter(g.database),revsSource),/missing trigger targets: .*canonical_customer_contacts/);
});

test('0021 then 0022 on one fixture: both verify and no existing row changes',async(t)=>{
  const f=await activeCanon(t,{migrations:prior});
  const db=adapter(f.database);
  const before=f.counts();
  const r=await refs.preflight(db);
  assert.deepEqual({d:r.duplicated_vouchers,e:r.extra_uses},{d:0,e:0});
  apply(f.database,refs.migrationUnits(refsSource));
  await refs.verify(db,refsSource);
  await revs.preflight(db,revsSource);
  apply(f.database,revs.migrationUnits(revsSource));
  await revs.verify(db,revsSource);
  await refs.verify(db,refsSource);
  assert.deepEqual(f.counts(),before);
});

test('migrations refuse altered sources and inactive authority',async(t)=>{
  assert.throws(()=>revs.migrationUnits(revsSource+'\nDELETE FROM sales;'),/hash mismatch/);
  assert.throws(()=>refs.migrationUnits(refsSource+'\nDELETE FROM sales;'),/hash mismatch/);
  const f=await activeCanon(t,{migrations:prior});
  const db=adapter(f.database);
  const batch=db.batch;
  db.batch=async statements=>{const out=await batch(statements);if(out[2]?.results?.[0]?.mode)out[2].results[0].mode='SHADOW';return out;};
  await assert.rejects(()=>revs.preflight(db,revsSource),/inactive/);
  await assert.rejects(()=>refs.preflight(db),/inactive/);
});

test('backups are authenticated encrypted before upload and reject absent keys',async()=>{
  const {createHash,createDecipheriv}=await import('node:crypto');
  const secret='test-only-secret-'.repeat(4), plain=Buffer.from('{"reference":"private voucher"}');
  const out=encryptBackup(plain,secret);
  assert.ok(!out.toString().includes('private voucher'));
  assert.throws(()=>encryptBackup(plain,''),/secret/);
  const packet=JSON.parse(out);
  const key=createHash('sha256').update('nuevo-amanecer-contact-backup-v1\0'+secret).digest();
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(packet.iv,'base64'));
  decipher.setAAD(Buffer.from('nuevo-amanecer-contact-backup-v1'));
  decipher.setAuthTag(Buffer.from(packet.tag,'base64'));
  assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(packet.data,'base64')),decipher.final()]),plain);
  assert.equal(revs.backupPath,'/tmp/turso-migrations-0021-0022-backup.json');
});

test('full logical backup covers schema and every table, encrypted with the existing Turso credential',async(t)=>{
  const {createHash,createDecipheriv}=await import('node:crypto');
  const f=await activeCanon(t,{migrations:prior});
  const saved=process.env.TURSO_PROD_AUTH_TOKEN, secret='fixture-only-token-'.repeat(3);
  process.env.TURSO_PROD_AUTH_TOKEN=secret;
  t.after(()=>{if(saved===undefined)delete process.env.TURSO_PROD_AUTH_TOKEN;else process.env.TURSO_PROD_AUTH_TOKEN=saved;});
  await revs.backup(adapter(f.database));
  const packet=JSON.parse(readFileSync(revs.backupPath,'utf8'));
  const key=createHash('sha256').update('nuevo-amanecer-contact-backup-v1\0'+secret).digest();
  const d=createDecipheriv('aes-256-gcm',key,Buffer.from(packet.iv,'base64'));
  d.setAAD(Buffer.from('nuevo-amanecer-contact-backup-v1'));d.setAuthTag(Buffer.from(packet.tag,'base64'));
  const plain=JSON.parse(Buffer.concat([d.update(Buffer.from(packet.data,'base64')),d.final()]));
  assert.equal(plain.format,'nuevo-amanecer-turso-migrations-0021-0022-backup-v1');
  const tables=f.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name).sort();
  assert.deepEqual(Object.keys(plain.tables).sort(),tables);
  assert.equal(plain.tables.products.length,f.database.prepare('SELECT COUNT(*) n FROM products').get().n);
  assert.ok(plain.schema.some(s=>s.type==='trigger'));
});

test('workflow order: contracts, read-only preflights, verified R2 backup, then 0021, then 0022; no deploys',()=>{
  const steps=workflow.split('\n').filter(l=>/^      - name: /.test(l)).map(l=>l.replace(/^      - name: /,'').trim());
  const at=name=>{const i=steps.findIndex(s=>s.startsWith(name));assert.ok(i>=0,'missing step '+name);return i;};
  const order=['Require existing deployment credentials','Checkout exact authorized HEAD','Validate authorized scope','Verify migration contracts',
    'Read-only preflight 0021','Read-only preflight 0022','Create consistent encrypted logical Turso backup','Store and verify backup in private remote R2',
    'Apply additive migration 0021','Apply additive migration 0022','Verify schema and production health'];
  const idx=order.map(at);
  assert.deepEqual([...idx].sort((a,b)=>a-b),idx,'steps out of order');
  assert.match(workflow,/paths:\n\s+- "ops\/canon-migrations-0021-0022\.json"/);
  assert.match(workflow,/group: nuevo-amanecer-production-change\n\s+cancel-in-progress: false/);
  assert.match(workflow,/R2_BUCKET: nuevo-amanecer-prod-v2-backups/);
  assert.match(workflow,/r2 object put[^\n]+--remote/);
  assert.match(workflow,/r2 object get[^\n]+--remote/);
  assert.match(workflow,/test "\$\(sha256sum \/tmp\/turso-migrations-0021-0022-backup\.json/);
  assert.match(workflow,/t\.action!=='apply-canon-migrations-0021-0022'/);
  assert.match(workflow,/t\.destructive!==false/);
  assert.match(workflow,/\['0021','0022'\]/);
  assert.match(workflow,/::add-mask::\$TURSO_PROD_AUTH_TOKEN/);
  assert.doesNotMatch(workflow,/workflow_dispatch/);
  assert.doesNotMatch(workflow,/wrangler deploy(?! --dry-run)/,'this workflow must not deploy Worker or POS');
  assert.doesNotMatch(workflow,/wrangler d1 /,'Turso is the authority; D1 must not be touched');
  assert.doesNotMatch(workflow,/set -x/);
  assert.equal(existsSync('ops/canon-migrations-0021-0022.json'),false,'trigger file is created only on owner authorization');
});

test('workflow refresh preserves ancestry needed to validate approved feature commit',async(t)=>{
  const {mkdtempSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {execFileSync,spawnSync}=await import('node:child_process');
  const root=mkdtempSync(join(tmpdir(),'migrations-history-'));
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
