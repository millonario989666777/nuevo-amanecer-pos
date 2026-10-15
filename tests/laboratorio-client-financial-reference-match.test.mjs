import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css=readFileSync('laboratorio/pos-lab/styles/pages/clientes.css','utf8');

test('reference match keeps mobile hero in two columns without a center divider',()=>{
  const reference=css.slice(css.lastIndexOf('REFERENCE MATCH 004'));
  assert.match(reference,/@media\(max-width:430px\)[\s\S]*grid-template-columns:minmax\(0,1\.08fr\) minmax\(0,\.92fr\)/);
  assert.match(reference,/#pageClientes \.lab-v2-head-money\{[\s\S]*border-left:0/);
  assert.match(reference,/border-top:0/);
  assert.doesNotMatch(reference,/border-left:1px solid rgba\(15,118,110,\.24\)/);
});

test('client name is legible with ink color and no stroke/stretch, without external fonts',()=>{
  const reference=css.slice(css.lastIndexOf('REFERENCE MATCH 004'));
  const start=reference.indexOf('#pageClientes .lab-v2-client-head h2{');
  assert.notEqual(start,-1);
  const block=reference.slice(start,reference.indexOf('}',start)+1);
  assert.match(block,/font-family:inherit/);
  assert.match(block,/font-weight:800/);
  assert.match(block,/color:var\(--ink,#172033\)/);
  assert.doesNotMatch(block,/text-stroke|scaleX|Impact|Arial Black|font-weight:1000/);
  assert.doesNotMatch(block,/url\(|@import|https?:\/\//);
});

test('visual order places DNI before behavior badge without changing DOM',()=>{
  assert.match(css,/\.lab-v2-client-identity\{[\s\S]*grid-template-rows:auto auto auto auto/);
  assert.match(css,/\.lab-v2-name-line\{\s*display:contents/);
  assert.match(css,/\.lab-v2-client-head p\{[\s\S]*grid-row:3/);
  assert.match(css,/\.lab-v2-client-head \.lab-v2-risk\{[\s\S]*grid-row:4/);
});

test('navigation cards have stronger hierarchy without fixed-width overflow traps',()=>{
  assert.match(css,/\.lab-v2-row\{[\s\S]*min-height:74px[\s\S]*border-radius:18px/);
  assert.match(css,/\.lab-v2-module-icon,[\s\S]*width:46px/);
  assert.doesNotMatch(css.slice(css.lastIndexOf('REFERENCE MATCH 004')),/min-width:\s*[1-9]\d{2,}px/);
});
