import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const inline2=readFileSync('POS/js/legacy-inline/inline-02.js','utf8');
const inline12=readFileSync('POS/js/legacy-inline/inline-12.js','utf8');
const clientV2=readFileSync('POS/js/modules/client-credit-accounts-v2.js','utf8');

test('client credit index is built once per client render and exposes O(1) summaries',()=>{
  assert.match(inline2,/function _naRebuildClientCreditIndex\(\)/);
  assert.match(inline2,/function _naClientAllCreditsFast\(clientId\)/);
  assert.match(inline2,/function _naClientCreditsFast\(clientId\)/);
  assert.match(inline2,/function _naClientDebtFast\(client\)/);
  assert.match(inline2,/function _naClientStatusFast\(client\)/);
  assert.match(inline2,/statusCli=function\(c\)\{return _naClientStatusFast\(c\);\}/);
  assert.match(inline2,/cliRender=function\(\)\{[^\n]*_naRebuildClientCreditIndex\(\)/);
});

test('index preserves all-credit history separately from visible credit summaries',()=>{
  assert.match(inline2,/_naClientAllCreditsIndex=new Map\(\)/);
  assert.match(inline2,/allList\.push\(cr\)/);
  // Los anulados (anulado:true o status/estado/source_status «anul…») salen de los resúmenes visibles por el helper único.
  assert.match(inline2,/if\(_naIsCreditVoided\(cr\)\)return;/);
  assert.match(inline12,/const credits=_naClientAllCreditsFast\(client\.id\)/);
});

test('final client renderer no longer computes debt by filtering all credits for every client',()=>{
  const start=inline12.indexOf('_baseCliRender=function(){');
  assert.ok(start>=0);
  const tail=inline12.slice(start, inline12.indexOf("document.getElementById('cliList')",start));
  assert.doesNotMatch(tail,/deudaT\(/);
  assert.match(tail,/_naClientDebtFast\(client\)/);
  assert.match(tail,/_naClientDebtFast\(b\)-_naClientDebtFast\(a\)/);
});

test('Clientes V2 reuses the shared index instead of refiltering the whole ledger per card',()=>{
  const creditsStart=clientV2.indexOf('function labClientCredits(clientId)');
  const creditsEnd=clientV2.indexOf('function labNormalizeCategory',creditsStart);
  const block=clientV2.slice(creditsStart,creditsEnd);
  assert.match(block,/_naClientCreditsFast/);
  const debtStart=clientV2.indexOf('function naClientDebt(client)');
  const debtEnd=clientV2.indexOf('function naClientBusinessStatus',debtStart);
  assert.match(clientV2.slice(debtStart,debtEnd),/_naClientDebtFast/);
});
