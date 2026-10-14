import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const SHORT_VIEWPORT_MEDIA='@media(min-width:1100px) and (max-height:700px)';
const SHORT_VIEWPORT_COMMENT='/* Short desktop screens keep the approved tall-layout proportions by compacting only the current-sale footer. */\n';

export function frozenRules(source, scope='') {
 const rows=[]; source=source.replace(/\/\*[\s\S]*?\*\//g,''); let cursor=0;
 while(cursor<source.length){
  const start=source.indexOf('{',cursor);if(start<0)break;
  const selector=source.slice(cursor,start).trim();let depth=1,end=start+1;
  for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;if(source[end]==='}')depth--;}
  const body=source.slice(start+1,end-1);cursor=end;
  if(selector===SHORT_VIEWPORT_MEDIA)continue;
  if(selector.startsWith('@media'))rows.push(...frozenRules(body,scope+selector+'/'));
  else if(!/^#pagePOS (?:#cartDrawer )?\.(?:cart-(?!fab\b)|ci-|qty-|btn-rm\b|total-|btn-cobro\b)/.test(selector))rows.push(scope+selector+'{'+body+'}');
 }
 return rows;
}
const hash=value=>createHash('sha256').update(value).digest('hex');

function stripShortViewportMedia(source){
 const marker=SHORT_VIEWPORT_MEDIA+'{';
 const start=source.indexOf(marker);
 if(start<0)return source;
 let depth=1,end=start+marker.length;
 for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;if(source[end]==='}')depth--;}
 const withoutMedia=source.slice(0,start)+source.slice(end);
 return withoutMedia.replace(SHORT_VIEWPORT_COMMENT,'');
}

test('all CSS outside Venta actual and the reference decorator remain frozen',()=>{
 // Baseline: CANON 9278e2ce95df9ce01deec220a16e858551ad4e33.
 assert.equal(hash(frozenRules(readFileSync('POS/css/canon-pos-reference-ui.css','utf8')).join('\n')), '23d82354eed75dce6b59a345785eb81f9cae5f34b90db8c333e484a0a6604ac1');
 assert.equal(hash(readFileSync('POS/js/canon-pos-reference-ui.js','utf8').replace(/\r\n/g,'\n')), '113771411f7106e82d21ab023bb87f5e85a817aa5492b6f93fefeeddfd7831d4');
});

test('approved upper panel stays frozen during the footer adjustment',()=>{
 const source=stripShortViewportMedia(readFileSync('POS/css/canon-pos-reference-ui.css','utf8').replace(/\r\n/g,'\n'));
 // Semantic freeze of the PR #410 upper cart: header, item list and line controls are unchanged.
 assert.match(source, /#pagePOS \.cart-head\{min-height:60px;padding:9px 14px/);
 assert.match(source, /#pagePOS \.cart-head-title\{font-size:24px[^}]*text-transform:uppercase/);
 assert.match(source, /#pagePOS \.cart-items\{[^}]*padding:7px 9px/);
 assert.match(source, /#pagePOS \.cart-item\{[^}]*grid-template-columns:40px minmax\(0,1fr\) auto 24px[^}]*min-height:62px/);
 assert.match(source, /#pagePOS \.cart-item>div:first-child\{width:40px;height:40px/);
 assert.match(source, /#pagePOS \.qty-btn\{width:26px;height:26px/);
 assert.match(source, /#pagePOS \.qty-num\{width:18px;font-size:12px/);
 assert.match(source, /#pagePOS \.ci-sub\{font-size:15px/);
 assert.match(source, /#pagePOS \.btn-rm\{width:24px;height:26px/);
});

test('short-height exception is isolated to its dedicated media block',()=>{
 const source=readFileSync('POS/css/canon-pos-reference-ui.css','utf8').replace(/\r\n/g,'\n');
 assert.ok(source.includes(SHORT_VIEWPORT_MEDIA+'{'));
 const stripped=stripShortViewportMedia(source);
 assert.ok(!stripped.includes(SHORT_VIEWPORT_MEDIA+'{'));
 assert.ok(!stripped.includes(SHORT_VIEWPORT_COMMENT.trim()));
});
