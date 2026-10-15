import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';
import { reviseCanonicalExpense } from '../../tools/cloudflare-lab/src/a6-expenses.js';
const migration='0032_canonical_expense_revisions.sql';
function common(f,operation_id){const c=f.control();return {operation_id,expense_id:'fixture-expense',promotion_id:c.active_promotion_id,authority_epoch:c.authority_epoch,expected_control_revision:c.revision,client_contract:'a6-gate-c-v1',created_at:'2026-10-15T15:00:00Z'};}
async function setup(t, migrated=true){
 const f=await activeCanon(t,{migrations:migrated?[migration]:[]});f.addDevice('expense-owner','writer','active','expense-owner-token');
 const call=async(command,body)=>f.fetch('http://localhost/commands/'+command,{method:'POST',headers:{authorization:'Bearer expense-owner-token','content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await call('expense.create',{...common(f,'fixture-create'),amount_cents:1000,concept:'Original',category:'Otro',payment_method:'yape',expense_date:'2026-10-15',note:'Original note'})).status,201);
 return {f,call};
}
test('owner edit/void are append-only, CAS protected, effective and idempotent',async t=>{
 const {f,call}=await setup(t);const before=f.database.prepare('SELECT * FROM canonical_expenses').all();
 const read=async()=> (await (await f.fetch('http://localhost/read/canonical/expenses',{headers:{authorization:'Bearer expense-owner-token'}})).json());
 const initial=await read();
 const edit={...common(f,'fixture-edit'),expected_revision:0,concept:'Edited',category:'Servicios',note:null,expense_date:'2026-10-14'};
 let res=await call('expense.update',edit);assert.equal(res.status,201);assert.equal((await res.json()).revision,1);
 res=await call('expense.update',edit);assert.equal(res.status,200);assert.equal((await res.json()).idempotent,true);
 res=await call('expense.update',{...edit,concept:'Conflict'});assert.equal(res.status,409);assert.equal((await res.json()).error,'operation_id_conflict');
 res=await call('expense.update',{...edit,operation_id:'stale'});assert.equal(res.status,409);assert.equal((await res.json()).error,'stale_expense_revision');
 res=await call('expense.update',{...edit,operation_id:'amount',amount_cents:2000});assert.equal(res.status,400);
 const effective=await read();const rows=effective.items||effective.rows;assert.equal(rows[0].concept,'Edited');assert.equal(rows[0].note,null);assert.equal(rows[0].revision,1);assert.equal(rows[0].voided,false);
 assert.notEqual(effective.financial_revision,initial.financial_revision);
 const voidBody={...common(f,'fixture-void'),expected_revision:1};res=await call('expense.void',voidBody);assert.equal(res.status,201);
 assert.equal((await call('expense.void',voidBody)).status,200);
 const final=await read();assert.equal((final.items||final.rows)[0].voided,true);assert.equal((final.items||final.rows)[0].concept,'Edited');
 assert.deepEqual(f.database.prepare('SELECT * FROM canonical_expenses').all(),before);
 assert.equal(f.database.prepare('SELECT COUNT(*) n FROM canonical_expense_revisions').get().n,2);
});
test('missing revision schema keeps reads working and commands return 503; role is checked first',async t=>{
 const {f,call}=await setup(t,false);const body={...common(f,'no-schema'),expected_revision:0};
 const res=await call('expense.void',body);assert.equal(res.status,503);assert.equal((await res.json()).error,'expense_revisions_unavailable');
 for(const role of ['empleado','unknown',undefined]){
  const denied=await reviseCanonicalExpense('expense.void',new Request('http://localhost',{method:'POST',body:'invalid'}),{}, {posRole:role},(body,status)=>({body,status}));assert.equal(denied.status,403);
 }
 const read=await f.fetch('http://localhost/read/canonical/expenses',{headers:{authorization:'Bearer expense-owner-token'}});assert.equal(read.status,200);const payload=await read.json();assert.equal((payload.items||payload.rows)[0].revision,0);assert.equal((payload.items||payload.rows)[0].voided,false);
});
test('cash expenses cannot be voided even after their session closes',async t=>{
 const {f,call}=await setup(t);
 const base=common(f,'open');delete base.expense_id;
 assert.equal((await call('cash.open',{...base,session_id:'shift',opening_cents:10000})).status,201);
 assert.equal((await call('expense.create',{...common(f,'cash-expense'),expense_id:'cash',amount_cents:1000,concept:'Cash',category:'Otro',payment_method:'efectivo',expense_date:'2026-10-15',session_id:'shift',expected_session_revision:0})).status,201);
 for(const closed of [false,true]){
  if(closed)assert.equal((await call('cash.close',{...base,operation_id:'close',session_id:'shift',expected_session_revision:1,counted_cents:9000})).status,201);
  const res=await call('expense.void',{...common(f,'void-'+closed),expense_id:'cash',expected_revision:0});assert.equal(res.status,409);assert.equal((await res.json()).error,'cash_expense_void_requires_adjustment');
 }
});
test('real canonical client sends edit and void through durable command path',async t=>{
 const {f}=await setup(t);const d=await device(f,{token:'expense-owner-token'});
 const row=d.api.legacySnapshot().expenses[0];assert.equal(row.revision,0);
 await d.api.updateExpense({expense_id:row.expenseId,expected_revision:0,concept:'Client edit',category:'Otro',note:'',expense_date:'2026-10-15'});
 await d.api.refresh();assert.equal(d.api.legacySnapshot().expenses[0].desc,'Client edit');
 await d.api.voidExpense({expense_id:row.expenseId,expected_revision:1});await d.api.refresh();assert.equal(d.api.legacySnapshot().expenses[0].voided,true);
});

test('expense modal prefills metadata, locks money, excludes voids in reports and recovers create fields',async t=>{
 const {f}=await setup(t);
 const bridge=readFileSync('POS/js/sync/canonical-expense-bridge.js','utf8');
 const d=await device(f,{token:'expense-owner-token',scripts:[['expense-bridge',bridge]],globals:{NA_ROLES:{role:'owner',isOwner:()=>true},confirm:()=>true,gasRender(){},cajRender(){},updateDashboard(){}}});
 const row=d.api.legacySnapshot().expenses[0];
 d.context.NA_EXPENSES.edit(row);
 assert.equal(d.el('gasDesc').value,'Original');assert.equal(d.el('gasMonto').disabled,true);assert.equal(d.el('gasMetodo').disabled,true);
 d.el('gasDesc').value='Modal edit';d.el('gasNota').value='';
 assert.equal(await d.context.guardarGasto(),true);
 assert.equal(d.api.legacySnapshot().expenses[0].desc,'Modal edit');
 const payload=JSON.parse(d.fetchLog.find(r=>r.url.endsWith('/commands/expense.update')).body);
 assert.equal(payload.expected_revision,0);assert.equal('amount_cents' in payload,false);assert.equal('session_id' in payload,false);
 assert.equal(await d.context.NA_EXPENSES.void(d.api.legacySnapshot().expenses[0]),true);
 assert.equal(d.api.legacySnapshot().expenses[0].voided,true);
 d.context.abrirModalGasto();assert.equal(d.el('gasMonto').disabled,false);assert.equal(d.el('gasMetodo').disabled,false);
 const vm=await import('node:vm');
 const reportSource=readFileSync('POS/js/legacy-inline/inline-05.js','utf8');
 const start=reportSource.indexOf('function _naF8UnifiedExpenses('),end=reportSource.indexOf('\n',start);
 const context=vm.createContext({_naF8Day:v=>String(v||'').slice(0,10),gastos:[{expenseId:'void',voided:true,fecha:'2026-10-15',monto:10},{expenseId:'edit',fecha:'2026-10-14',monto:20,desc:'New'}],cajMovs:[{expenseId:'void',tipo:'gas',fecha:'2026-10-15',monto:10},{expenseId:'edit',tipo:'gas',fecha:'2026-10-15',monto:20,desc:'Old'}],_naF8DateInRange:()=>true,_naNumber:Number,_naF8ExpenseSignature:r=>r.desc});
 vm.runInContext(reportSource.slice(start,end),context);
 assert.equal(vm.runInContext('_naF8UnifiedExpenses({}).length',context),1);
});

test('concurrent edits commit one revision and snapshots expose the same effective expense',async t=>{
 const {f,call}=await setup(t);
 const body={...common(f,'concurrent-a'),expected_revision:0,concept:'Concurrent',category:'Otro',note:'',expense_date:'2026-10-15'};
 const replies=await Promise.all([call('expense.update',body),call('expense.update',{...body,operation_id:'concurrent-b'})]);
 assert.deepEqual(replies.map(r=>r.status).sort(),[201,409]);
 assert.equal(f.database.prepare('SELECT COUNT(*) n FROM canonical_expense_revisions').get().n,1);
 const res=await f.fetch('http://localhost/read/canonical/snapshot',{headers:{authorization:'Bearer expense-owner-token'}});
 assert.equal(res.status,200);const snap=await res.json();assert.equal(snap.expenses[0].concept,'Concurrent');assert.equal(snap.expenses[0].revision,1);
});
test('edits cannot move expense_date into the future or out of a closed shift; same-date edits still work',async t=>{
 const {f,call}=await setup(t);
 const future=new Date(Date.now()+3*86400e3).toISOString().slice(0,10);
 let res=await call('expense.update',{...common(f,'future'),expected_revision:0,concept:'X',category:'Otro',note:null,expense_date:future});
 assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_in_future');
 const base=common(f,'open2');delete base.expense_id;
 assert.equal((await call('cash.open',{...base,session_id:'shift2',opening_cents:10000})).status,201);
 assert.equal((await call('expense.create',{...common(f,'cash2'),expense_id:'cash2',amount_cents:500,concept:'Cash',category:'Otro',payment_method:'efectivo',expense_date:'2026-10-15',session_id:'shift2',expected_session_revision:0})).status,201);
 res=await call('expense.update',{...common(f,'open-move'),expense_id:'cash2',expected_revision:0,concept:'Cash',category:'Otro',note:null,expense_date:'2026-10-14'});
 assert.equal(res.status,201,'open shift allows date correction');
 assert.equal((await call('cash.close',{...base,operation_id:'close2',session_id:'shift2',expected_session_revision:1,counted_cents:9500})).status,201);
 res=await call('expense.update',{...common(f,'closed-move'),expense_id:'cash2',expected_revision:1,concept:'Cash',category:'Otro',note:null,expense_date:'2026-10-13'});
 assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_locked_closed_shift');
 res=await call('expense.update',{...common(f,'closed-same'),expense_id:'cash2',expected_revision:1,concept:'Cash renamed',category:'Otro',note:null,expense_date:'2026-10-14'});
 assert.equal(res.status,201,'closed shift still allows non-date edits');
});
test('revision lookups are scoped by promotion_id',()=>{
 for(const file of ['tools/cloudflare-lab/src/a6-expenses.js','tools/cloudflare-lab/src/a6-canonical.js']){
  const src=readFileSync(file,'utf8');const subs=src.match(/SELECT MAX\(revision\) FROM canonical_expense_revisions WHERE [^)]*/g)||[];
  assert.ok(subs.length>=2,file);for(const q of subs)assert.match(q,/promotion_id=/,file+': '+q);
 }
});
