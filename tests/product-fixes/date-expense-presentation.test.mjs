import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('visible date helper renders day/month/year while preserving ISO values',()=>{
 const src=readFileSync('POS/js/legacy-inline/inline-05.js','utf8');
 const input={id:'gasFecha',value:'2026-10-15',dataset:{},setAttribute(k,v){this[k]=v;},addEventListener(){}};
 const help={textContent:''};const c=vm.createContext({document:{querySelectorAll:()=>[input],getElementById:()=>help}});
 vm.runInContext(src.slice(src.indexOf('function _naDateDisplayHelp(){'),src.lastIndexOf("document.addEventListener('DOMContentLoaded'")),c);
 c._naDateDisplayHelp();assert.equal(input.lang,'es-PE');assert.equal(help.textContent,'15/10/2026 · dd/mm/aaaa');assert.equal(input.value,'2026-10-15');
 input.value='';c._naDateDisplayHelp();assert.equal(help.textContent,'dd/mm/aaaa');
 const html=readFileSync('POS/index.html','utf8');for(const id of ['salesReportFrom','salesReportTo','gasFecha'])assert.match(html,new RegExp('<input[^>]*id="'+id+'"[^>]*lang="es-PE"'));
});
test('Gastos uses the existing money formatter for totals and cards; edit actions are neutral and teal',()=>{
 const src=readFileSync('POS/js/legacy-inline/inline-02.js','utf8');const line=src.split('\n').find(l=>l.startsWith('function gasRender'));
 assert.ok(line.includes('fmt(total)'));assert.ok(line.includes('fmt(mayor)'));assert.ok(line.includes('${fmt(g.monto)}'));assert.doesNotMatch(line,/S\/\$\{/);
 const css=readFileSync('POS/css/proximamente.css','utf8');assert.match(css,/#mGasto \.mbtn-ok\{background:#0f766e/);assert.match(css,/#mGasto \.mhead\{background:var\(--slate-light/);
});
