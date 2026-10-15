import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activeCanon} from './canon-browser-harness.mjs';
import * as migration from '../../tools/cloudflare-prod/scripts/turso-expense-revisions-maintenance.mjs';
const source=readFileSync(migration.migrationPath,'utf8');
function adapter(database){return {prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async all(){return {results:database.prepare(sql).all(...this.args)};}};},async batch(statements){database.exec('BEGIN');try{const results=statements.map(s=>({results:database.prepare(s.sql).all(...s.args)}));database.exec('COMMIT');return results;}catch(error){database.exec('ROLLBACK');throw error;}}};}
test('0032 is purely additive, idempotent and preserves all prior rows, views and triggers',async t=>{
 const f=await activeCanon(t),db=adapter(f.database);
 const schema=f.database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
 const tables=schema.filter(r=>r.type==='table').map(r=>r.name);
 const before=tables.map(name=>f.database.prepare('SELECT * FROM "'+name+'"').all());
 assert.doesNotMatch(source,/\b(ALTER|DROP|UPDATE|DELETE|INSERT|REPLACE)\b/i);
 assert.equal((await migration.preflight(db,source)).already_present,0);
 await assert.rejects(()=>migration.verify(db,source),/schema mismatch/);
 await migration.migrate(db,source);await migration.migrate(db,source);
 assert.deepEqual(tables.map(name=>f.database.prepare('SELECT * FROM "'+name+'"').all()),before);
 for(const object of schema)assert.deepEqual(f.database.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(object.name),object);
 assert.equal((await migration.preflight(db,source)).already_present,2);
 assert.throws(()=>migration.migrationUnits(source+'DELETE FROM sales;'),/hash mismatch/);
});
test('0032 maintenance rejects drift and completes a partial migration',async t=>{
 const f=await activeCanon(t),db=adapter(f.database);
 f.database.exec(migration.migrationUnits(source)[0]);await migration.migrate(db,source);
 f.database.exec('DROP INDEX idx_canonical_expense_revisions_promotion; CREATE INDEX idx_canonical_expense_revisions_promotion ON canonical_expense_revisions(expense_id);');
 await assert.rejects(()=>migration.preflight(db,source),/schema drift/);
});
test('0032 workflow verifies contracts and encrypted remote backup before applying; placeholder is inert',()=>{
 const workflow=readFileSync('.github/workflows/canon-migration-0032.yml','utf8');
 const trigger=JSON.parse(readFileSync('ops/canon-migration-0032.json','utf8'));
 assert.equal(trigger.feature_commit,'0'.repeat(40));assert.equal(trigger.attempt,1);assert.deepEqual(trigger.migrations,['0032']);
 assert.ok(workflow.indexOf('Verify migration contracts')<workflow.indexOf('Read-only preflight'));
 assert.ok(workflow.indexOf('Store and verify backup')<workflow.indexOf('Apply additive migration'));
 assert.match(workflow,/sha256sum \/tmp\/turso-migration-0032-backup/);
 assert.match(workflow,/merge-base.*--is-ancestor/);assert.doesNotMatch(workflow,/wrangler deploy(?! --dry-run)/);
});
