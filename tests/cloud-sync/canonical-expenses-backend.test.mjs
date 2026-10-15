import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { a6Fixture, response } from './a6-fixture.mjs';

const migrations = [
  '0008_canonical_commerce.sql',
  '0009_canonical_financial.sql',
  '0011_canonical_session_runtime.sql',
  '0012_credit_accounts_v2.sql',
  '0013_canonical_expenses.sql',
  '0033_canonical_expense_server_received_at.sql',
].map(name => readFileSync(new URL('../../infra/database/migrations/' + name, import.meta.url), 'utf8'));

const auth = token => ({ authorization:'Bearer '+token, 'content-type':'application/json' });

async function active(t) {
  const f = await a6Fixture(t);
  await response(await f.freeze(),201);
  await response(await f.promote(),201);

  // Test-only transition; production activation remains separately gated.
  f.database.exec('DROP TRIGGER canonical_control_no_legacy');
  f.exec("UPDATE canonical_control SET mode='ACTIVE',revision=revision+1,authority_epoch=authority_epoch+1,minimum_client_contract='a6-gate-c-v1' WHERE id=1");
  for (const sql of migrations) f.database.exec(sql);
  f.addDevice('expense-browser','writer','active','expense-token');
  return f;
}

function common(f, operationId, expenseId, createdAt='2026-09-27T17:00:00.000Z') {
  const c=f.control();
  return {
    operation_id:operationId,
    expense_id:expenseId,
    promotion_id:c.active_promotion_id,
    client_contract:'a6-gate-c-v1',
    authority_epoch:c.authority_epoch,
    expected_control_revision:c.revision,
    created_at:createdAt,
    amount_cents:2500,
    concept:'Compra de útiles',
    category:'Útiles limpieza',
    payment_method:'efectivo',
    expense_date:'2026-09-27',
    note:'Prueba sintética'
  };
}

async function openCash(f, sessionId='expense-session') {
  const c=f.control();
  return response(await f.fetch('http://localhost/commands/cash.open',{
    method:'POST',headers:auth('expense-token'),body:JSON.stringify({
      operation_id:'open-'+sessionId,promotion_id:c.active_promotion_id,client_contract:'a6-gate-c-v1',
      authority_epoch:c.authority_epoch,expected_control_revision:c.revision,created_at:'2026-09-27T16:00:00.000Z',
      session_id:sessionId,opening_cents:10000
    })
  }),201);
}

test('expense.create preserves legacy cash semantics for cash, digital and outside-session expenses', async t => {
  const f=await active(t);
  await openCash(f);
  let state=f.sql("SELECT * FROM canonical_cash_state WHERE session_id='expense-session'");
  assert.equal(state.expected_cents,10000);
  assert.equal(state.revision,0);

  const cash={...common(f,'expense-cash-op','expense-cash'),session_id:'expense-session',expected_session_revision:0};
  const cashReceipt=await response(await f.fetch('http://localhost/commands/expense.create',{
    method:'POST',headers:auth('expense-token'),body:JSON.stringify(cash)
  }),201);
  assert.equal(cashReceipt.cash_delta_cents,-2500);
  assert.equal(cashReceipt.session_revision,1);
  assert.equal(cashReceipt.expected_cents,7500);

  state=f.sql("SELECT * FROM canonical_cash_state WHERE session_id='expense-session'");
  assert.equal(state.expected_cents,7500);
  assert.equal(state.revision,1);

  const digital={...common(f,'expense-digital-op','expense-digital'),payment_method:'transferencia',
    session_id:'expense-session',expected_session_revision:1};
  const digitalReceipt=await response(await f.fetch('http://localhost/commands/expense.create',{
    method:'POST',headers:auth('expense-token'),body:JSON.stringify(digital)
  }),201);
  assert.equal(digitalReceipt.cash_delta_cents,0);
  state=f.sql("SELECT * FROM canonical_cash_state WHERE session_id='expense-session'");
  assert.equal(state.expected_cents,7500);
  assert.equal(state.revision,2);

  const outside={...common(f,'expense-outside-op','expense-outside'),expense_date:'2026-09-26'};
  const outsideReceipt=await response(await f.fetch('http://localhost/commands/expense.create',{
    method:'POST',headers:auth('expense-token'),body:JSON.stringify(outside)
  }),201);
  assert.equal(outsideReceipt.session_id,null);
  assert.equal(outsideReceipt.cash_delta_cents,0);
  state=f.sql("SELECT * FROM canonical_cash_state WHERE session_id='expense-session'");
  assert.equal(state.expected_cents,7500);
  assert.equal(state.revision,2);

  const rows=await response(await f.fetch('http://localhost/read/canonical/expenses?limit=100',{
    headers:{authorization:'Bearer expense-token'}
  }),200);
  assert.equal(rows.items.length,3);
  assert.deepEqual(rows.items.map(x=>x.expense_id).sort(),['expense-cash','expense-digital','expense-outside']);
});

test('expense.create is idempotent, rejects payload collisions and leaves no guards', async t => {
  const f=await active(t);
  const body=common(f,'expense-replay-op','expense-replay');

  const created=await response(await f.fetch('http://localhost/commands/expense.create',{
    method:'POST',headers:auth('expense-token'),body:JSON.stringify(body)
  }),201);
  assert.equal(created.status,'created');
  assert.equal(created.idempotent,false);

  const replay=await response(await f.fetch('http://localhost/commands/expense.create',{
    method:'POST',headers:auth('expense-token'),body:JSON.stringify(body)
  }),200);
  assert.equal(replay.status,'already_processed');
  assert.equal(replay.idempotent,true);

  const conflict=await f.fetch('http://localhost/commands/expense.create',{
    method:'POST',headers:auth('expense-token'),body:JSON.stringify({...body,concept:'Otro concepto'})
  });
  assert.equal(conflict.status,409);
  assert.equal((await conflict.json()).error,'operation_id_conflict');

  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_expenses').n,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_expense_operations').n,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_write_guards').n,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_assertions').n,0);
});

test('an expense can be the first live operation and a second active browser may write it', async t => {
  const f=await active(t);
  assert.equal(f.control().first_live_operation_id,null);
  const body=common(f,'expense-first-live','expense-first-live');

  const receipt=await response(await f.fetch('http://localhost/commands/expense.create',{
    method:'POST',headers:auth('expense-token'),body:JSON.stringify(body)
  }),201);
  assert.equal(receipt.expense_id,'expense-first-live');
  assert.equal(f.control().first_live_operation_id,'expense-first-live');

  const op=f.sql("SELECT device_id FROM canonical_expense_operations WHERE operation_id='expense-first-live'");
  assert.equal(op.device_id,'session:expense-browser');
});

test('stale session revision rejects expense atomically', async t => {
  const f=await active(t);
  await openCash(f,'stale-expense-session');
  const body={...common(f,'expense-stale-op','expense-stale'),session_id:'stale-expense-session',expected_session_revision:99};
  const denied=await f.fetch('http://localhost/commands/expense.create',{
    method:'POST',headers:auth('expense-token'),body:JSON.stringify(body)
  });
  assert.equal(denied.status,409);
  assert.equal((await denied.json()).error,'stale_session');
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_expenses').n,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_expense_operations').n,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_write_guards').n,0);
});
