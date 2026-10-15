import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activeCanon} from './canon-browser-harness.mjs';
import {response} from './a6-fixture.mjs';
const migration='0031_canonical_cash_session_cashier.sql';
const roles='0024_pos_roles_owner_pin.sql';
const headers=token=>({authorization:'Bearer '+token,'content-type':'application/json'});
function common(f,id){
  const c=f.control();
  return {operation_id:id,promotion_id:c.active_promotion_id,client_contract:'a6-gate-c-v1',authority_epoch:c.authority_epoch,expected_control_revision:c.revision,created_at:'2026-10-14T15:00:00.000Z'};
}
async function command(f,token,name,body,status=201){
  return response(await f.fetch('http://localhost/commands/'+name,{method:'POST',headers:headers(token),body:JSON.stringify(body)}),status);
}
async function history(f){
  return (await response(await f.fetch('http://localhost/read/canonical/cash-sessions',{headers:headers('owner-token')}),200)).items;
}
test('session cashier is durable, body cannot spoof it, replay preserves identity, old rows read null',async t=>{
  const f=await activeCanon(t,{migrations:[roles]});
  f.addDevice('owner','writer','active','owner-token');
  f.addDevice('employee','writer','active','employee-token');
  // addDevice maps credentials onto authenticated session principals.
  const principal=f.device('employee').device_id;
  f.database.prepare("INSERT INTO pos_device_roles(device_id,pos_role,label,created_by,created_at) VALUES(?,'empleado','Rosa','owner','2026-10-14')").run(principal);
  await command(f,'owner-token','cash.open',{...common(f,'old-open'),session_id:'old',opening_cents:100});
  await command(f,'owner-token','cash.close',{...common(f,'old-close'),session_id:'old',expected_session_revision:0,counted_cents:100});
  assert.equal((await history(f)).find(s=>s.session_id==='old').opened_by_name,null);
  f.database.exec(readFileSync('infra/database/migrations/'+migration,'utf8'));
  const open={...common(f,'new-open'),session_id:'new',opening_cents:200};
  await command(f,'employee-token','cash.open',{...open,opened_by_name:'Impostor'},400);
  await command(f,'employee-token','cash.open',open);
  await command(f,'owner-token','cash.open',open,200);
  const close={...common(f,'new-close'),session_id:'new',expected_session_revision:0,counted_cents:200};
  await command(f,'owner-token','cash.close',{...close,closed_by_name:'Impostor'},400);
  await command(f,'owner-token','cash.close',close);
  const rows=await history(f),row=rows.find(s=>s.session_id==='new'),old=rows.find(s=>s.session_id==='old');
  assert.equal(row.opened_by_user_id,principal);
  assert.equal(row.opened_by_name,'Rosa');
  assert.equal(row.closed_by_name,'Dueño');
  assert.ok(row.closed_by_user_id.startsWith('session:'));
  for(const key of ['opened_by_user_id','opened_by_name','closed_by_user_id','closed_by_name'])assert.equal(old[key],null);
  assert.equal(f.database.prepare("SELECT opened_by_name FROM canonical_cash_sessions WHERE session_id='new'").get().opened_by_name,'Rosa');
  assert.equal(f.database.prepare("SELECT closed_by_name FROM canonical_cash_closures WHERE session_id='new'").get().closed_by_name,'Dueño');
});
