import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css=readFileSync('laboratorio/pos-lab/styles/pages/clientes.css','utf8');

test('client hero name is legible: app font, 800, no stroke/stretch (owner fix #707)',()=>{
  const start=css.indexOf('#pageClientes .lab-v2-client-head h2{');
  assert.notEqual(start,-1);
  const block=css.slice(start,css.indexOf('}',start)+1);
  assert.match(block,/font-family:inherit/);
  assert.match(block,/font-weight:800/);
  assert.match(block,/text-transform:uppercase/);
  assert.match(block,/letter-spacing:-\.01em/);
  assert.doesNotMatch(block,/text-stroke|scaleX|Arial Black|Impact|font-weight:1000/);
});

test('display name styling remains offline and isolated to the client hero name',()=>{
  const start=css.indexOf('#pageClientes .lab-v2-client-head h2{');
  const block=css.slice(start,css.indexOf('}',start)+1);
  assert.doesNotMatch(block,/url\(|@import|https?:\/\//);
  assert.doesNotMatch(block,/\.lab-v2-subhead h2|\.lab-v2-behavior-hero h2/);
});
