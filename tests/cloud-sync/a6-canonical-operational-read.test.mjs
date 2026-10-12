import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { a6Fixture, response } from './a6-fixture.mjs';

const commerce = readFileSync('infra/database/migrations/0008_canonical_commerce.sql','utf8');
const financial = readFileSync('infra/database/migrations/0009_canonical_financial.sql','utf8');
const sessions = readFileSync('infra/database/migrations/0011_canonical_session_runtime.sql','utf8');
const source = readFileSync('tools/cloudflare-lab/src/a6-canonical.js','utf8');
const auth = token => ({ authorization:'Bearer '+token, 'content-type':'application/json' });

async function active(t){
  const f=await a6Fixture(t);
  await response(await f.freeze(),201);
  await response(await f.promote(),201);
  f.database.exec('DROP TRIGGER canonical_control_no_legacy');
  f.exec("UPDATE canonical_control SET mode='ACTIVE',revision=revision+1,authority_epoch=authority_epoch+1,minimum_client_contract='a6-gate-c-v1' WHERE id=1");
  f.database.exec(commerce); f.database.exec(financial); f.database.exec(sessions);
  f.addDevice('operational-reader-writer','writer','active','operational-token');
  return f;
}

function common(f,operationId,createdAt){
  const c=f.control();
  return {operation_id:operationId,promotion_id:c.active_promotion_id,client_contract:'a6-gate-c-v1',authority_epoch:c.authority_epoch,expected_control_revision:c.revision,created_at:createdAt};
}

test('cash-movements canonical read derives exact active session from immutable rowid watermarks',async t=>{
  const f=await active(t);
  const sessionId='operational-session-1';
  const opened=await response(await f.fetch('http://localhost/commands/cash.open',{
    method:'POST',headers:auth('operational-token'),
    body:JSON.stringify({...common(f,'open-operational','2026-09-27T15:00:00.000Z'),session_id:sessionId,opening_cents:10000})
  }),201);
  assert.equal(opened.session_id,sessionId);

  const sale={...common(f,'sale-operational','2026-09-27T15:05:00.000Z'),
    sale_id:'sale-operational-1',session_id:sessionId,payment_method:'efectivo',total_cents:300,
    payment:{cash_cents:300,digital_cents:0,credit_cents:0},
    items:[{product_id:'00003',quantity:1,unit_price_cents:300,line_total_cents:300,expected_stock_revision:0}]
  };
  await response(await f.fetch('http://localhost/commands/sale.create',{method:'POST',headers:auth('operational-token'),body:JSON.stringify(sale)}),201);

  const cash=await response(await f.fetch('http://localhost/read/canonical/cash-movements?limit=100',{headers:{authorization:'Bearer operational-token'}}),200);
  assert.equal(cash.items.length,1);
  assert.equal(cash.items[0].sale_id,sale.sale_id);
  assert.equal(cash.items[0].session_id,sessionId);
  assert.equal(cash.items[0].cash_cents,300);

  const sales=await response(await f.fetch('http://localhost/read/canonical/sales?limit=100',{headers:{authorization:'Bearer operational-token'}}),200);
  const items=await response(await f.fetch('http://localhost/read/canonical/sale-items?limit=100',{headers:{authorization:'Bearer operational-token'}}),200);
  const inventory=await response(await f.fetch('http://localhost/read/canonical/inventory-movements?limit=100',{headers:{authorization:'Bearer operational-token'}}),200);
  assert.equal(sales.items[0].sale_id,sale.sale_id);
  assert.equal(items.items[0].sale_id,sale.sale_id);
  assert.equal(inventory.items[0].sale_id,sale.sale_id);
});

test('operational session derivation is read-only SQL and does not alter ledger tables',()=>{
  assert.match(source,/AS session_id/);
  assert.match(source,/r\.rowid>s\.cash_movement_watermark/);
  assert.match(source,/r\.rowid<=s\.closing_watermark/);
  assert.doesNotMatch(source,/UPDATE cash_movements SET session_id|ALTER TABLE cash_movements/);
});

test('sale-items pages use a NUL-free tuple cursor and never repeat the last row of a page',async t=>{
  const f=await active(t);
  const products=f.database.prepare('SELECT product_id FROM products WHERE current_stock_quantity>=1 ORDER BY product_id LIMIT 6').all().map(r=>r.product_id);
  assert.equal(products.length,6);
  for(let s=0;s<3;s++){
    const lines=[products[s*2],products[s*2+1]].map(id=>({product_id:id,quantity:1,unit_price_cents:100,line_total_cents:100,expected_stock_revision:Number(f.database.prepare('SELECT stock_revision r FROM products WHERE product_id=?').get(id)?.r??0)}));
    await response(await f.fetch('http://localhost/commands/sale.create',{method:'POST',headers:auth('operational-token'),body:JSON.stringify({
      ...common(f,'tuple-sale-'+s,'2026-09-27T15:0'+s+':00.000Z'),sale_id:'tuple-sale-'+s,payment_method:'yape',total_cents:200,
      payment:{cash_cents:0,digital_cents:200,credit_cents:0},items:lines})}),201);
  }
  const seen=[];let cursor=null,pages=0;
  do{
    const page=await response(await f.fetch('http://localhost/read/canonical/sale-items?limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{headers:{authorization:'Bearer operational-token'}}),200);
    page.items.forEach(i=>seen.push(i.sale_id+'#'+i.line_number));cursor=page.next_cursor;pages++;
  }while(cursor&&pages<20);
  assert.equal(seen.length,6,seen.join(','));
  assert.equal(new Set(seen).size,6);
  assert.doesNotMatch(source,/char\(0\)/);
});
