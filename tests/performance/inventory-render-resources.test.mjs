import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT3sAAAAASUVORK5CYII=';
test('category labels scan the catalog once per render and refresh after errors and edits',()=>{
 const text=fs.readFileSync('POS/js/legacy-inline/inline-02.js','utf8'),source=text.slice(text.indexOf('const _naBaseCategories='),text.indexOf('function toggleNewCategoryField'));
 let reads=0;const ctx={appConfig:{customCategories:[{value:'custom',label:'Mi categoría'}]},productos:Array.from({length:408},()=>({get cat(){reads++;return 'custom';}})),sinTildes:s=>s,_naClean:s=>String(s||'').trim(),document:{getElementById:()=>null}};
 vm.createContext(ctx);vm.runInContext(source,ctx);
 ctx._naWithCategoryCatalog(()=>{for(let i=0;i<408;i++)assert.equal(ctx._naCategoryLabel('custom'),'Mi categoría');});assert.equal(reads,816);
 assert.throws(()=>ctx._naWithCategoryCatalog(()=>{ctx._naCategoryLabel('custom');throw Error('render failed');}));
 ctx.appConfig.customCategories=[{value:'custom',label:'Actualizada'}];assert.equal(ctx._naCategoryLabel('custom'),'Actualizada');
});
test('display URLs preserve image bytes, reuse rasters and release only detached images',async()=>{
 const text=fs.readFileSync('POS/js/legacy-inline/inline-13.js','utf8'),source=text.slice(text.indexOf('const _naAllowedProductImageHosts'),text.indexOf('function _naSafeSetProductPreview'));
 const created=[],revoked=[],visible=[];const ctx={window:{NuevoAmanecerProductImageOverlay:{}},atob,Blob,Uint8Array,document:{querySelectorAll:()=>visible},URL:class extends URL{static createObjectURL(blob){created.push(blob);return 'blob:owned/'+created.length;}static revokeObjectURL(url){revoked.push(url);}}};vm.createContext(ctx);vm.runInContext(source,ctx);const api=vm.runInContext('_naInventoryImageDisplay',ctx);
 const p={imagen:image},before=JSON.stringify(p),url=api.source(p);assert.equal(url,'blob:owned/1');assert.equal(api.source(p),url);assert.equal(created.length,1);assert.equal(created[0].type,'image/png');assert.deepEqual(Buffer.from(await created[0].arrayBuffer()),Buffer.from(image.split(',')[1],'base64'));
 visible.push({getAttribute:()=>url});api.prune();assert.deepEqual(revoked,[]);visible.length=0;api.prune();assert.deepEqual(revoked,[url]);assert.equal(api.source(p),'blob:owned/2');assert.equal(JSON.stringify(p),before);
 assert.equal(api.source({imagen:'blob:external/untrusted'}),null);assert.equal(api.source({imagen:'data:image/svg+xml;base64,PHN2Zz4='}),null);assert.equal(api.source({imagen:'javascript:alert(1)'}),null);
});
