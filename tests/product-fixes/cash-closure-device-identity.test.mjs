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
