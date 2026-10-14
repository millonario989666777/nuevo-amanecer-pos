import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon } from './canon-browser-harness.mjs';
const read=n=>readFileSync(new URL('../../infra/database/migrations/'+n,import.meta.url),'utf8');
async function setup(t){const f=await activeCanon(t);try{f.database.exec(read('0010_session_auth.sql').replace(/DROP INDEX[^;]*;/,''));}catch{}f.database.exec(read('0024_pos_roles_owner_pin.sql'));f.database.exec(read('0025_pos_reviews_pin_failures.sql'));f.addDevice('owner-phone','writer','active','owner-token');f.addDevice('emp-phone','writer','active','emp-token');f.database.prepare("INSERT INTO pos_device_roles(device_id,pos_role,created_by,created_at) VALUES('emp-phone','empleado','owner-phone','2026-10-13'),('session:emp-phone','empleado','owner-phone','2026-10-13')").run();f.database.exec("CREATE TABLE IF NOT EXISTS canonical_live_products(product_id TEXT PRIMARY KEY); INSERT OR IGNORE INTO canonical_live_products(product_id) VALUES('other')");return f;}
async function call(f,path,body,token='owner-token',method){const r=await f.fetch('http://localhost'+path,{method:method||(body?'POST':'GET'),headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json(),headers:r.headers};}
const image='data:image/jpeg;base64,/9j/'+'A'.repeat(30000),payload={product_id:'00003',codes:[' 00123 ','00123'],image};
test('upload, manifest, exact chunk reconstruction, unchanged, replacement and private cache',async t=>{const f=await setup(t);let r=await call(f,'/auth/product-images',payload);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.status,'ok');const etag=r.body.etag;assert.equal(f.sql("SELECT COUNT(*) n FROM pos_settings WHERE key LIKE 'internal:img:c:%'").n,5);r=await call(f,'/auth/product-images');assert.deepEqual(r.body.images.map(e=>[e.product_id,e.codes,e.etag]),[['00003',['00123'],etag]]);assert.equal((await call(f,'/auth/product-images?since='+r.body.version)).body.status,'unchanged');for(const query of ['product_id=00003','code=00123']){r=await call(f,'/auth/product-images/item?'+query+'&v='+etag);assert.equal(r.body.image,image);assert.equal(r.headers.get('etag'),'"'+etag+'"');assert.equal(r.headers.get('cache-control'),'private, max-age=31536000, immutable');}const revision=f.sql("SELECT revision FROM pos_settings WHERE key LIKE 'internal:img:m:%'").revision;assert.equal((await call(f,'/auth/product-images',payload)).body.status,'unchanged');assert.equal(f.sql("SELECT revision FROM pos_settings WHERE key LIKE 'internal:img:m:%'").revision,revision);r=await call(f,'/auth/product-images',{...payload,image:image+'AAAA'});assert.equal(r.body.status,'ok');assert.equal(f.sql("SELECT COUNT(*) n FROM pos_settings WHERE key LIKE ?",'internal:img:c:%:'+etag.slice(0,8)+':%').n,0);r=await call(f,'/auth/product-images',{...payload,image:image+'BBBBBBBB'});const latest=r.body.etag;assert.equal(f.sql("SELECT COUNT(*) n FROM pos_settings WHERE key LIKE 'internal:img:m:%'").n,1);assert.equal(f.sql("SELECT COUNT(*) n FROM pos_settings WHERE key LIKE 'internal:img:c:%' AND key NOT LIKE ?",'internal:img:c:%:'+latest.slice(0,8)+':%').n,0);await call(f,'/auth/product-images',{...payload,product_id:'other'});r=await call(f,'/settings');assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(!JSON.stringify(r.body).includes('internal:img:'));assert.ok(!JSON.stringify(r.body).includes('internal:imgrate:'));});
test('roles, authentication, validation, ambiguous codes and incomplete images',async t=>{const f=await setup(t);assert.equal((await call(f,'/auth/product-images',payload,'emp-token')).status,403);assert.equal((await call(f,'/auth/product-images',null,null)).status,401);assert.equal((await call(f,'/auth/product-images',{...payload,image:'data:image/jpeg;base64,AAAA'})).body.error,'invalid_image');assert.equal((await call(f,'/auth/product-images',{...payload,delete:true})).body.error,'unexpected_field');await call(f,'/auth/product-images',payload);assert.equal((await call(f,'/auth/product-images',null,'emp-token')).status,200);assert.equal((await call(f,'/auth/product-images/item?code=00123',null,'emp-token')).body.image,image);assert.equal((await call(f,'/auth/product-images/item?code=absent')).status,404);await call(f,'/auth/product-images',{...payload,product_id:'other'});assert.equal((await call(f,'/auth/product-images/item?code=00123')).body.error,'ambiguous_code');f.database.exec("DELETE FROM pos_settings WHERE key LIKE 'internal:img:c:%'");assert.equal((await call(f,'/auth/product-images/item?product_id=00003')).body.error,'image_incomplete');assert.equal((await call(f,'/auth/product-images',null,'owner-token','PUT')).status,405);});
test('missing existing settings schema returns 503',async t=>{const f=await setup(t);f.database.exec('DROP TABLE pos_settings');for(const body of [null,payload]){const r=await call(f,'/auth/product-images',body);assert.equal(r.status,503);assert.equal(r.body.error,'product_images_schema_not_ready');}});

test('explicit delete forms are owner only and remove all chunks',async t=>{
 const f=await setup(t);
 for(const method of ['POST','DELETE']){
  await call(f,'/auth/product-images',payload);
  const path='/auth/product-images'+(method==='DELETE'?'?product_id=00003':'');
  const body=method==='POST'?{product_id:'00003',delete:true}:null;
  const denied=await call(f,path,body,'emp-token',method);
  assert.equal(denied.status,403);assert.equal(denied.body.error,'forbidden_role');
  const r=await call(f,path,body,'owner-token',method);
  assert.equal(r.body.status,'deleted');assert.equal(r.body.product_id,'00003');
  assert.equal(f.sql("SELECT COUNT(*) n FROM pos_settings WHERE key LIKE 'internal:img:%'").n,0);
  assert.equal((await call(f,path,body,'owner-token',method)).body.status,'not_found');
 }
});
test('missing products are rejected and orphan manifests are hidden then swept',async t=>{
 const f=await setup(t);
 assert.equal((await call(f,'/auth/product-images',{...payload,product_id:'absent'})).body.error,'product_not_found');
 await call(f,'/auth/product-images',payload);
 f.database.exec('PRAGMA foreign_keys=OFF');
 for(const row of f.database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='products'").all())f.database.exec('DROP TRIGGER "'+row.name.replaceAll('"','""')+'"');
 f.database.exec("DELETE FROM products WHERE product_id='00003'");
 assert.equal((await call(f,'/auth/product-images')).body.images.length,0);
 await call(f,'/auth/product-images',{product_id:'absent',delete:true});
 assert.equal(f.sql("SELECT COUNT(*) n FROM pos_settings WHERE key LIKE 'internal:img:%'").n,0);
});
test('size, product count, storage and rolling per-device write limits',async t=>{
 const f=await setup(t);
 assert.equal((await call(f,'/auth/product-images',{...payload,image:'data:image/jpeg;base64,/9j/'+'A'.repeat(60000)})).body.error,'invalid_image');
 await call(f,'/auth/product-images',payload);
 const key=f.sql("SELECT key FROM pos_settings WHERE key LIKE 'internal:imgrate:%'").key;
 const setRate=(w,n)=>f.database.prepare('UPDATE pos_settings SET value_json=? WHERE key=?').run(JSON.stringify({w,n}),key);
 setRate(new Date().toISOString(),600);
 assert.equal((await call(f,'/auth/product-images',payload)).body.status,'unchanged');
 let r=await call(f,'/auth/product-images',{...payload,image:image+'AAAA'});
 assert.equal(r.status,429);assert.equal(r.body.error,'image_rate_limited');assert.ok(r.body.retry_after_seconds>0);
 setRate(new Date(Date.now()-3600001).toISOString(),600);
 assert.equal((await call(f,'/auth/product-images',{...payload,image:image+'AAAA'})).body.status,'ok');
 assert.equal(JSON.parse(f.sql('SELECT value_json FROM pos_settings WHERE key=?',key).value_json).n,1);
 const insert=f.database.prepare("INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?,?,1,'now','test')");
 for(let i=0;i<5001;i++)insert.run('internal:img:c:foreign:etag:'+i,JSON.stringify('A'.repeat(7998)));
 assert.equal((await call(f,'/auth/product-images',{...payload,image:image+'BBBB'})).body.error,'image_storage_full');
 f.database.exec("DELETE FROM pos_settings WHERE key LIKE 'internal:img:c:foreign:%'");
 for(let i=0;i<1999;i++){
   const id='limit-'+i;
   f.database.prepare('INSERT INTO canonical_live_products(product_id) VALUES(?)').run(id);
   insert.run('internal:img:m:'+id,JSON.stringify({p:id,c:['x'],e:'e',n:1,u:'now'}));
 }
 assert.equal((await call(f,'/auth/product-images',{...payload,product_id:'other'})).body.error,'image_limit');
});

test('rate override counts accepted uploads and deletes, unchanged consumes no quota',async t=>{
 const f=await setup(t);f.env.PRODUCT_IMAGE_RATE_LIMIT=2;
 assert.equal((await call(f,'/auth/product-images',payload)).body.status,'ok');
 assert.equal((await call(f,'/auth/product-images',payload)).body.status,'unchanged');
 assert.equal((await call(f,'/auth/product-images',{product_id:'00003',delete:true})).body.status,'deleted');
 assert.equal((await call(f,'/auth/product-images',payload)).status,429);
});
test('missing catalog tables count as no products',async t=>{
 const f=await setup(t);f.database.exec('PRAGMA foreign_keys=OFF; DROP TABLE products; DROP TABLE canonical_live_products');
 const r=await call(f,'/auth/product-images',payload);
 assert.equal(r.status,404);assert.equal(r.body.error,'product_not_found');
});
