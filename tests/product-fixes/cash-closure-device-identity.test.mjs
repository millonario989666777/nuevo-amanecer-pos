import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const src=readFileSync('POS/js/legacy-inline/inline-03.js','utf8');
const start=src.indexOf('function _naValidateCashClosureIdentity('),end=src.indexOf('function _naSanitizeAppConfig',start);
function validate(rows){const c=vm.createContext({rows});vm.runInContext(src.slice(start,end),c);return c._naValidateCashClosureIdentity(rows);}
test('closure identity is device plus session; true duplicates are removed',()=>{
 const a={id:'C-A-123',deviceId:'A',sessionId:123},b={id:'C-B-123',deviceId:'B',sessionId:123};
 assert.deepEqual(validate([a,b,{...a,id:'C-other-123'}]),[a,b]);
});
test('device tags work without deviceId and historical closure ids remain valid',()=>{
 const rows=[{id:'C-A-123',sessionId:123},{id:'C-B-123',sessionId:123},{id:'C-123',sessionId:123}];
 assert.deepEqual(validate([...rows,{...rows[0]}]),rows);
});

test('same device/session with conflicting financial or identity fields is rejected',()=>{
 const row={id:'C-A-123',deviceId:'A',sessionId:123,contado:100,esperado:90,diferencia:10,timestampCierre:1234,cajero:'Owner'};
 for(const field of ['contado','esperado','diferencia','timestampCierre','cajero']){
  for(const id of [row.id,'alternate'])assert.throws(()=>validate([row,{...row,id,[field]:field==='cajero'?'Other':999}]),/mismo (?:id|aparato y sesión) con datos distintos/);
 }
 assert.throws(()=>validate([row,{...row,contado:1}]),/mismo id con datos distintos \(id C-A-123\)/);
 const reordered=Object.fromEntries(Object.entries({...row,id:'alternate'}).reverse());
 assert.deepEqual(validate([row,reordered]),[row]);
});

test('restore session conflict identifies the conflicting id and session',()=>{
 const row={id:'C-A-123',deviceId:'A',sessionId:123,contado:100};
 assert.throws(()=>validate([row,{...row,id:'conflicting',contado:99}]),/datos distintos \(id conflicting, sesión 123\)/);
});
