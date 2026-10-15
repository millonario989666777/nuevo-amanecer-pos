import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { a6Fixture } from './a6-fixture.mjs';
const read = name => readFileSync(new URL('../../infra/database/migrations/' + name, import.meta.url), 'utf8');
async function call(f, path, token, body, method = 'POST') {
  return f.fetch('http://localhost' + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) });
}
test('paired employees cannot invoke owner actions; owner expense and settings remain usable', async t => {
  const f = await a6Fixture(t);
  await f.freeze(); await f.promote();
  f.database.exec('DROP TRIGGER canonical_control_no_legacy');
  f.exec("UPDATE canonical_control SET mode='ACTIVE',revision=revision+1,authority_epoch=authority_epoch+1,minimum_client_contract='a6-gate-c-v1' WHERE id=1");
  for (const name of ['0008_canonical_commerce.sql', '0009_canonical_financial.sql', '0010_session_auth.sql', '0011_canonical_session_runtime.sql', '0012_credit_accounts_v2.sql', '0013_canonical_expenses.sql', '0024_pos_roles_owner_pin.sql']) f.database.exec(read(name).replace(/DROP INDEX[^;]*;/, ''));
  f.addDevice('owner-phone', 'writer', 'active', 'owner-token');
  const code = await (await call(f, '/auth/pairing-code', 'owner-token', { label: 'Employee' })).json();
  const paired = await (await call(f, '/auth/pair', '', { code: code.code })).json();
  assert.ok(paired.session_token);
  const c = f.control();
  const expense = { operation_id: 'permission-expense-op', expense_id: 'permission-expense', promotion_id: c.active_promotion_id, client_contract: 'a6-gate-c-v1', authority_epoch: c.authority_epoch, expected_control_revision: c.revision, created_at: '2026-09-27T17:00:00.000Z', amount_cents: 2500, concept: 'Útiles', category: 'Limpieza', payment_method: 'efectivo', expense_date: '2026-09-26', note: 'Synthetic' };
  for (const [path, body, method] of [['/commands/expense.create', expense], ['/settings', { key: 'test', value: 1 }], ['/auth/product-images', {}], ['/auth/devices', {}], ['/auth/pairing-code', {}]]) {
    const response = await call(f, path, paired.session_token, body, method);
    assert.equal(response.status, 403, path);
    if (path === '/commands/expense.create') assert.deepEqual(await response.json(), { error: 'forbidden_role', action: 'expense.create' });
  }
  assert.equal((await call(f, '/commands/expense.create', 'owner-token', expense)).status, 201);
  assert.equal((await call(f, '/settings', 'owner-token', { key: 'test', value: 1 })).status, 200);
});
