import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';
import { reviseCanonicalExpense } from '../../tools/cloudflare-lab/src/a6-expenses.js';
const migration='0032_canonical_expense_revisions.sql';
function common(f,operation_id){const c=f.control();return {operation_id,expense_id:'fixture-expense',promotion_id:c.active_promotion_id,authority_epoch:c.authority_epoch,expected_control_revision:c.revision,client_contract:'a6-gate-c-v1',created_at:'2026-10-15T15:00:00Z'};}
function serverClock(t, instant){
 const NativeDate=Date;
 let now=instant;
 t.mock.method(globalThis,'Date',class extends NativeDate { constructor(...args){super(...(args.length?args:[now]));} static now(){return NativeDate.parse(now);} });
 return value=>{now=value;};
}
async function setup(t, migrated=true){
 const clock=serverClock(t,'2026-10-15T14:00:00.000Z');
 const f=await activeCanon(t,{migrations:migrated?[migration,'0033_canonical_expense_server_received_at.sql']:['0033_canonical_expense_server_received_at.sql']});f.addDevice('expense-owner','writer','active','expense-owner-token');
 const call=async(command,body)=>f.fetch('http://localhost/commands/'+command,{method:'POST',headers:{authorization:'Bearer expense-owner-token','content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await call('expense.create',{...common(f,'fixture-create'),amount_cents:1000,concept:'Original',category:'Otro',payment_method:'yape',expense_date:'2026-10-15',note:'Original note'})).status,201);
 return {f,call,clock};
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
  const res=await call('expense.void',{...common(f,'void-'+closed),expense_id:'cash',expected_revision:0});assert.equal(res.status,409);assert.equal((await res.json()).error,closed?'expense_locked_closed_shift':'cash_expense_void_requires_adjustment');
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
test('expense_date edits: future (Lima) and outside-shift dates are rejected with 409; valid edits still work',async t=>{
 const {f,call}=await setup(t);
 const upd=(op,id,rev,date,concept='X')=>call('expense.update',{...common(f,op),expense_id:id,expected_revision:rev,concept,category:'Otro',note:null,expense_date:date});
 let res=await upd('future','fixture-expense',0,'2099-01-01');assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_in_future');
 res=await upd('ancient','fixture-expense',0,'2020-01-01');assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_out_of_range');
 const base=common(f,'open2');delete base.expense_id;
 assert.equal((await call('cash.open',{...base,session_id:'shift2',opening_cents:10000})).status,201);
 assert.equal((await call('expense.create',{...common(f,'cash2'),expense_id:'cash2',amount_cents:500,concept:'Cash',category:'Otro',payment_method:'efectivo',expense_date:'2026-10-15',session_id:'shift2',expected_session_revision:0})).status,201);
 res=await upd('before-shift','cash2',0,'2026-10-14');assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_outside_shift');
 res=await upd('future-shift','cash2',0,'2099-01-01');assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_in_future');
 res=await upd('same-open','cash2',0,'2026-10-15','Renamed');assert.equal(res.status,201);
 assert.equal((await call('cash.close',{...base,operation_id:'close2',session_id:'shift2',expected_session_revision:1,counted_cents:9500})).status,201);
 res=await upd('closed-move','cash2',1,'2026-10-13');assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_locked_closed_shift');
 res=await upd('closed-same','cash2',1,'2026-10-15','Renamed again');assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_locked_closed_shift');
});
test('revision lookups are scoped by promotion_id',()=>{
 for(const file of ['tools/cloudflare-lab/src/a6-expenses.js','tools/cloudflare-lab/src/a6-canonical.js']){
  const src=readFileSync(file,'utf8');const subs=src.match(/SELECT MAX\(revision\) FROM canonical_expense_revisions WHERE [^)]*/g)||[];
  assert.ok(subs.length>=2,file);for(const q of subs)assert.match(q,/promotion_id=/,file+': '+q);
 }
});

test('create shares server Lima date limits, closed shift/day locks, and revisions audit prior dates',async t=>{
 const {f,call}=await setup(t);
 const create=(op,date,extra={})=>call('expense.create',{...common(f,op),expense_id:op,amount_cents:100,concept:'X',category:'Otro',payment_method:'yape',expense_date:date,...extra});
 for(const [date,error] of [['2099-01-01','expense_date_in_future'],['2020-01-01','expense_date_out_of_range']]){
  const res=await create('create-'+date,date);assert.equal(res.status,409);assert.equal((await res.json()).error,error);
 }
 // Client timestamps cannot widen or narrow the server's date window.
 assert.equal((await create('old-client','2026-10-14',{created_at:'2020-01-01T12:00:00Z'})).status,201);
 const edit={...common(f,'audit-edit'),expected_revision:0,concept:'Audit',category:'Otro',note:null,expense_date:'2026-10-14'};
 let res=await call('expense.update',edit);assert.equal(res.status,201);assert.equal((await res.json()).previous_expense_date,'2026-10-15');
 res=await call('expense.update',edit);assert.equal((await res.json()).previous_expense_date,'2026-10-15');
 const second={...edit,operation_id:'audit-edit2',expected_revision:1,expense_date:'2026-10-13'};
 res=await call('expense.update',second);assert.equal((await res.json()).previous_expense_date,'2026-10-14');
 const base=common(f,'policy-open');delete base.expense_id;
 assert.equal((await call('cash.open',{...base,session_id:'policy-shift',opening_cents:10000})).status,201);
 res=await create('before-opening','2026-10-14',{session_id:'policy-shift',expected_session_revision:0});assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_outside_shift');
 assert.equal((await create('linked','2026-10-15',{session_id:'policy-shift',expected_session_revision:0})).status,201);
 assert.equal((await call('cash.close',{...base,operation_id:'policy-close',session_id:'policy-shift',expected_session_revision:1,counted_cents:10000})).status,201);
 for(const command of ['expense.update','expense.void']){
  const body={...common(f,command+'-closed'),expense_id:'linked',expected_revision:0};
  if(command==='expense.update')Object.assign(body,{concept:'Rename',category:'Otro',note:null,expense_date:'2026-10-15'});
  res=await call(command,body);assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_locked_closed_shift');
 }
 res=await create('closed-create','2026-10-15',{session_id:'policy-shift',expected_session_revision:1});assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_locked_closed_shift');
 res=await create('closed-day','2026-10-15');assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_locked_closed_day');
 res=await call('expense.update',{...second,operation_id:'closed-day-edit',expected_revision:2,expense_date:'2026-10-15'});assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_locked_closed_day');
});
test('feature routes authenticate before disclosing lock state',async t=>{
 const {f}=await setup(t);
 for(const path of ['/features/kardex','/features/gastos','/features/unknown']){
  for(const headers of [{},{authorization:'Bearer invalid'}])assert.equal((await f.fetch('http://localhost'+path,{headers})).status,401);
  const res=await f.fetch('http://localhost'+path,{headers:{authorization:'Bearer expense-owner-token'}});
  assert.equal(res.status,path.endsWith('/gastos')?404:403);
 }
});

test('shiftless locks use server receipt and server now regardless of forged client timestamps',async t=>{
 const {f,call,clock}=await setup(t);
 const create=(op,created_at,date='2026-10-15')=>call('expense.create',{...common(f,op),expense_id:op,amount_cents:100,concept:'X',category:'Otro',payment_method:'yape',expense_date:date,created_at});
 assert.equal((await create('forged-before-close','2099-01-01T00:00:00Z')).status,201);
 const row=f.sql("SELECT * FROM canonical_expenses WHERE expense_id='forged-before-close'");
 assert.equal(row.server_received_at,'2026-10-15T14:00:00.000Z');
 assert.equal(row.created_at,'2099-01-01T00:00:00Z');
 const base=common(f,'time-open');delete base.expense_id;
 assert.equal((await call('cash.open',{...base,session_id:'time-shift',opening_cents:10000})).status,201);
 clock('2026-10-15T15:00:00.000Z');
 assert.equal((await call('cash.close',{...base,operation_id:'time-close',session_id:'time-shift',expected_session_revision:0,counted_cents:10000,created_at:'2020-01-01T00:00:00Z'})).status,201);
 assert.equal(f.sql("SELECT closed_at FROM canonical_cash_closures WHERE session_id='time-shift'").closed_at,'2026-10-15T15:00:00.000Z');
 clock('2026-10-15T16:00:00.000Z');
 for(const [op,time] of [['earlier','2026-10-15T14:59:59.999Z'],['equal','2026-10-15T10:00:00-05:00'],['later','2026-10-15T15:00:00.001Z']]){
  const res=await create(op,time);assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_locked_closed_day');
 }
 for(const command of ['expense.update','expense.void']){
  const body={...common(f,command+'-forged'),expense_id:'forged-before-close',expected_revision:0,created_at:'2099-01-01T00:00:00Z'};
  if(command==='expense.update')Object.assign(body,{concept:'Changed',category:'Otro',note:null,expense_date:'2026-10-14'});
  const res=await call(command,body);assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_locked_closed_day');
 }
 assert.equal((await create('other-day','2020-01-01T00:00:00Z','2026-10-14')).status,201);
 // Changing into a closed target is blocked even when receipt followed its closure.
 const edit={...common(f,'closed-target'),expense_id:'other-day',expected_revision:0,concept:'Changed',category:'Otro',note:null,expense_date:'2026-10-15',created_at:'2099-01-01T00:00:00Z'};
 let res=await call('expense.update',edit);assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_locked_closed_day');
 assert.equal((await call('expense.void',{...common(f,'void-other'),expense_id:'other-day',expected_revision:0})).status,201);

});

test('legacy NULL server receipt falls back to base created_at',async t=>{
 const {f,call,clock}=await setup(t,false);
 const create=(op,created_at)=>call('expense.create',{...common(f,op),expense_id:op,amount_cents:100,concept:'Legacy',category:'Otro',payment_method:'yape',expense_date:'2026-10-15',created_at});
 assert.equal((await create('legacy-before','2026-10-15T14:00:00Z')).status,201);
 assert.equal((await create('legacy-after','2026-10-15T16:00:00Z')).status,201);
 f.database.exec(readFileSync('infra/database/migrations/'+migration,'utf8'));
 // Filas legadas (anteriores a 0033) quedan con server_received_at NULL.
 // Solo en la prueba: se suspenden los triggers de inmutabilidad para simular filas previas a 0033.
 const triggers=f.database.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='canonical_expenses'").all();
 for(const tr of triggers)f.database.exec('DROP TRIGGER "'+tr.name+'"');
 f.database.exec("UPDATE canonical_expenses SET server_received_at=NULL WHERE expense_id IN ('legacy-before','legacy-after')");
 for(const tr of triggers)f.database.exec(tr.sql);
 assert.equal(f.sql("SELECT server_received_at FROM canonical_expenses WHERE expense_id='legacy-before'").server_received_at,null);
 const base=common(f,'legacy-open');delete base.expense_id;
 assert.equal((await call('cash.open',{...base,session_id:'legacy-shift',opening_cents:10000})).status,201);
 clock('2026-10-15T15:00:00.000Z');
 assert.equal((await call('cash.close',{...base,operation_id:'legacy-close',session_id:'legacy-shift',expected_session_revision:0,counted_cents:10000})).status,201);
 clock('2026-10-15T17:00:00.000Z');
 let res=await call('expense.void',{...common(f,'legacy-void-before'),expense_id:'legacy-before',expected_revision:0,created_at:'2099-01-01T00:00:00Z'});
 assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_locked_closed_day');
 assert.equal((await call('expense.void',{...common(f,'legacy-void-after'),expense_id:'legacy-after',expected_revision:0,created_at:'2020-01-01T00:00:00Z'})).status,201);
});

test('shiftless void locks the latest revised date, while other days stay voidable',async t=>{
 const {f,call,clock}=await setup(t);
 clock('2026-10-14T15:00:00Z');
 assert.equal((await call('expense.create',{...common(f,'old-base'),expense_id:'old-base',amount_cents:100,concept:'Old',category:'Otro',payment_method:'yape',expense_date:'2026-10-14',created_at:'2026-10-14T15:00:00Z'})).status,201);
 assert.equal((await call('expense.update',{...common(f,'move-day'),expense_id:'old-base',expected_revision:0,concept:'Moved',category:'Otro',note:null,expense_date:'2026-10-14'})).status,201);
 const base=common(f,'void-day-open');delete base.expense_id;
 assert.equal((await call('cash.open',{...base,session_id:'void-day-shift',opening_cents:10000})).status,201);
 const NativeDate=Date;
 t.mock.method(globalThis,'Date',class extends NativeDate { constructor(...args){super(...(args.length?args:['2026-10-14T23:00:00Z']));} });
 assert.equal((await call('cash.close',{...base,operation_id:'void-day-close',session_id:'void-day-shift',expected_session_revision:0,counted_cents:10000})).status,201);
 t.mock.restoreAll();
 const res=await call('expense.void',{...common(f,'void-moved'),expense_id:'old-base',expected_revision:1});
 assert.equal(res.status,409);assert.equal((await res.json()).error,'expense_date_locked_closed_day');
 assert.equal((await call('expense.void',{...common(f,'void-other-day'),expected_revision:0})).status,201);
});

test('atomic create, update and void guards reject a closure missed by the preliminary read',async t=>{
 const {f,call}=await setup(t);
 const base=common(f,'atomic-open');delete base.expense_id;
 assert.equal((await call('cash.open',{...base,session_id:'atomic-shift',opening_cents:10000})).status,201);
 assert.equal((await call('expense.create',{...common(f,'atomic-open-day'),expense_id:'atomic-open-day',amount_cents:100,concept:'X',category:'Otro',payment_method:'yape',expense_date:'2026-10-14'})).status,201);
 const NativeDate=Date;
 t.mock.method(globalThis,'Date',class extends NativeDate { constructor(...args){super(...(args.length?args:['2026-10-15T15:00:00Z']));} });
 try { assert.equal((await call('cash.close',{...base,operation_id:'atomic-close',session_id:'atomic-shift',expected_session_revision:0,counted_cents:10000})).status,201); }
 finally { t.mock.restoreAll(); }
 serverClock(t,'2026-10-15T16:00:00.000Z');
 const prepare=f.binding.prepare.bind(f.binding);
 // Simulate a close invisible to the preflight read; SQL write guards still see it.
 t.mock.method(f.binding,'prepare',sql=>{
  const statement=prepare(sql);
  if(sql.startsWith('SELECT 1 FROM canonical_cash_closures'))statement.first=async()=>null;
  return statement;
 });
 const create={...common(f,'atomic-create'),expense_id:'atomic-create',amount_cents:100,concept:'X',category:'Otro',payment_method:'yape',expense_date:'2026-10-15',created_at:'2099-01-01T00:00:00Z'};
 const edit={...common(f,'atomic-edit'),expected_revision:0,concept:'X',category:'Otro',note:null,expense_date:'2026-10-15',created_at:'2099-01-01T00:00:00Z'};
 for(const [command,body] of [['expense.create',create],['expense.update',edit],['expense.update',{...edit,operation_id:'atomic-target-edit',expense_id:'atomic-open-day'}],['expense.void',{...common(f,'atomic-void'),expected_revision:0,created_at:'2099-01-01T00:00:00Z'}]]){
  assert.equal((await call(command,body)).status,409,command);
 }
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_expenses').n,2);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_expense_operations').n,2);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_expense_revisions').n,0);
});
