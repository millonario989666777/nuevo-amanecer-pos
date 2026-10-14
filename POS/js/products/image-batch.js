(function(root){
  'use strict';
  const LIMIT=500,MAX_IMAGE=180000,MAX_TOTAL=20*1024*1024;
  const codes=p=>[p.sku,p.barcode,...(Array.isArray(p.codigosAlternativos)?p.codigosAlternativos:[]),p.codigoAlternativo].filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim());
  const identity=p=>String(p.product_id??p.id);
  function validate(entries){
    if(!Array.isArray(entries)||entries.length>LIMIT)throw Error('Máximo 500 imágenes por grupo de fotos');
    let size=0;
    return entries.map(e=>{
      if(!e||!Array.isArray(e.codes)||!e.codes.length||e.codes.length>20||e.codes.some(c=>typeof c!=='string'||!c.trim()||c.length>160))throw Error('Los códigos deben ser texto, sin perder ceros iniciales');
      if(typeof e.image!=='string'||e.image.length>MAX_IMAGE||!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(e.image))throw Error('Imagen inválida o demasiado grande');
      const [header,data]=e.image.split(',');
      if((header.includes('png')&&!data.startsWith('iVBORw0KGgo'))||(header.includes('jpeg')&&!data.startsWith('/9j/'))||(header.includes('webp')&&!data.startsWith('UklGR')))throw Error('Formato de imagen inválido');
      size+=e.image.length;if(size>MAX_TOTAL)throw Error('El grupo de fotos supera 20 MB');
      if(e.targetId!==undefined&&(typeof e.targetId!=='string'||e.targetId.length>160))throw Error('Identificador de producto inválido');
      return {codes:[...new Set(e.codes.map(c=>c.trim()))],image:e.image,...(e.targetId?{targetId:e.targetId}:{})};
    });
  }
  function matches(entry,products){return products.filter(p=>codes(p).some(c=>entry.codes.includes(c)));}
  function resolve(product,entries,products){
    const found=entries.filter(e=>codes(product).some(c=>e.codes.includes(c)));
    if(found.length!==1||(found[0].targetId&&found[0].targetId!==identity(product)))return null;
    const targets=matches(found[0],products);
    return targets.length===1&&identity(targets[0])===identity(product)?found[0].image:null;
  }
  function indexSources(entries,catalog){
    const byCode=new Map(),byEntryCode=new Map(),result=new Map();
    catalog.forEach((p,index)=>{for(const code of codes(p)){if(!byCode.has(code))byCode.set(code,new Set());byCode.get(code).add(index);}});
    for(const entry of entries){for(const code of entry.codes){if(!byEntryCode.has(code))byEntryCode.set(code,new Set());byEntryCode.get(code).add(entry);}}
    const targets=new Map();
    for(const entry of entries){const ids=new Set();for(const code of entry.codes)for(const index of byCode.get(code)||[])ids.add(index);targets.set(entry,ids);}
    for(const p of catalog){const found=new Set();for(const code of codes(p))for(const entry of byEntryCode.get(code)||[])found.add(entry);
      const entry=found.size===1?[...found][0]:null,ids=entry?targets.get(entry):null;
      result.set(p,entry&&(!entry.targetId||entry.targetId===identity(p))&&ids.size===1&&identity(catalog[[...ids][0]])===identity(p)?entry.image:null);
    }
    return result;
  }
  let sourceDepth=0,sourceIndex=null;
  function withSources(callback){sourceDepth++;try{return callback();}finally{if(--sourceDepth===0)sourceIndex=null;}}
  function plan(entries,products,stored,replace=false){
    const rows=validate(entries).map(entry=>{
      const found=matches(entry,products),p=found[0];
      let status=found.length>1?'ambiguous':!p?'missing':'ready';
      if(status==='ready'){
        const previous=resolve(p,stored,products);
        if(previous===entry.image)status='unchanged';
        else if(!replace&&(previous||p.imagen))status='existing';
      }
      return {entry,productId:p?identity(p):null,productName:p?(p.name||p.nombre||''):'',status};
    });
    rows.forEach(r=>{if(r.productId&&rows.filter(x=>x.productId===r.productId).length>1)r.status='duplicate';});
    return rows;
  }
  let cache=[],loadedScope=null,pending=null,busy=false,preview=null,selectedEntries=[];
  const products=()=>typeof productos!=='undefined'?productos:[];
  function scope(){
    const c=root.NuevoAmanecerCanonical;
    if(c?.enabled()){
      // Authority metadata is small; snapshot() copies the entire business history.
      const hasMetadata=typeof c.sourceState==='function';
      const id=hasMetadata?c.sourceState()?.cache?.promotion_id:c.snapshot()?.promotion_id;
      if(!id)throw Error('Espera a que CANON termine de cargar');
      return 'canon:'+id;
    }
    return 'local';
  }
  function database(){return new Promise((resolve,reject)=>{const req=root.indexedDB.open('nuevo-amanecer-product-images-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('catalogs');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
  async function read(key){const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('catalogs'),r=tx.objectStore('catalogs').get(key);r.onsuccess=()=>resolve(r.result||{entries:[]});r.onerror=()=>reject(r.error);});}finally{db.close();}}
  async function write(key,record,expected){const db=await database();try{await new Promise((resolve,reject)=>{const tx=db.transaction('catalogs','readwrite');const store=tx.objectStore('catalogs'),r=store.get(key);r.onsuccess=()=>{if(JSON.stringify(r.result||{entries:[]})!==JSON.stringify(expected)){tx.abort();return;}store.put(record,key);};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Otro proceso cambió las fotos. Vuelve a seleccionar el grupo de fotos'));});}finally{db.close();}const verified=await read(key);if(JSON.stringify(verified)!==JSON.stringify(record))throw Error('No se pudo verificar el guardado');}
  function render(){for(const name of ['posRender','invRender','posUpdateCart'])if(typeof root[name]==='function')root[name]();}
  async function hydrate(force=false){const key=scope();if(!force&&loadedScope===key)return;if(pending)return pending;pending=(async()=>{const record=await read(key);cache=validate(record.entries);loadedScope=key;render();})().finally(()=>{pending=null;});return pending;}
  function source(p){try{if(loadedScope!==scope()){sourceIndex=null;hydrate().catch(()=>{});return null;}if(sourceDepth){if(!sourceIndex)sourceIndex=indexSources(cache,products());return sourceIndex.get(p)||null;}return resolve(p,cache,products());}catch{return null;}}
  function authorized(){return !(typeof isModuleLocked==='function'&&isModuleLocked('productos',{canonicalProductUi:true}))&&(typeof _naAuthorize!=='function'||_naAuthorize('importar','Cargar fotos de productos'));}
  function message(text){root.document.getElementById('productImageBatchStatus').textContent=text;}
  function controls(value){busy=value;root.document.querySelectorAll('#productImageBatchModal button,#productImageBatchModal input').forEach(n=>n.disabled=value);}
  const labels={ready:'Lista',missing:'Sin producto',ambiguous:'Código ambiguo',duplicate:'Producto repetido',existing:'Ya tiene foto',unchanged:'Sin cambios'};
  function show(rows){const tbody=root.document.getElementById('productImageBatchRows');tbody.replaceChildren();for(const row of rows){const tr=root.document.createElement('tr');for(const value of [row.entry.codes.join(', '),row.productName,labels[row.status]]){const td=root.document.createElement('td');td.textContent=value;tr.append(td);}tbody.append(tr);}message(`${rows.filter(r=>r.status==='ready').length} fotos listas de ${rows.length}. Solo se guardan en este dispositivo.`);}
  function raster(data,preserve=false){return new Promise((resolve,reject)=>{const img=new root.Image();img.onload=()=>{try{if(!img.width||!img.height||img.width*img.height>40000000)throw Error('Imagen demasiado grande');if(preserve){resolve(data);return;}const canvas=root.document.createElement('canvas'),ratio=Math.min(1,768/Math.max(img.width,img.height));canvas.width=Math.max(1,Math.round(img.width*ratio));canvas.height=Math.max(1,Math.round(img.height*ratio));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);let image=canvas.toDataURL('image/jpeg',.8);if(image.length>MAX_IMAGE)image=canvas.toDataURL('image/jpeg',.5);validate([{codes:['test'],image}]);resolve(image);}catch(e){reject(e);}};img.onerror=()=>reject(Error('No se pudo abrir una imagen'));img.src=data;});}
  async function filesSelected(event){controls(true);preview=null;try{await hydrate(true);const files=[...event.target.files];if(files.length>LIMIT)throw Error('Máximo 500 archivos');let entries=[];for(const file of files){if(file.size>MAX_TOTAL)throw Error('Archivo mayor de 20 MB');if(/\.json$/i.test(file.name)){const body=JSON.parse(await file.text());if(body.version!==1)throw Error('Versión de paquete de fotos no compatible');entries.push(...validate(body.entries));}else{if(!/^image\/(png|jpeg|webp)$/.test(file.type)||file.size>12*1024*1024)throw Error('Usa fotos PNG, JPEG o WebP de hasta 12 MB');const data=await new Promise((resolve,reject)=>{const reader=new root.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});entries.push({codes:[file.name.replace(/\.[^.]+$/,'')],image:await raster(data)});}}
      entries=validate(entries);for(const entry of entries)entry.image=await raster(entry.image,true);
      selectedEntries=entries;const replace=root.document.getElementById('productImageBatchReplace').checked,rows=plan(entries,products(),cache,replace);preview={entries,replace,rows,key:scope()};show(rows);
    }catch(e){selectedEntries=[];message(e.message);root.document.getElementById('productImageBatchRows').replaceChildren();}finally{controls(false);}}
  async function reprocessSelected(){if(busy||!selectedEntries.length)return;controls(true);try{await hydrate(true);const replace=root.document.getElementById('productImageBatchReplace').checked,rows=plan(selectedEntries,products(),cache,replace);preview={entries:selectedEntries,replace,rows,key:scope()};show(rows);}catch(e){preview=null;message(e.message);}finally{controls(false);}}
  async function apply(){if(busy||!preview||!authorized())return;controls(true);try{const key=scope();if(key!==preview.key)throw Error('La sesión cambió. Vuelve a seleccionar el grupo de fotos');const previous=await read(key),stored=validate(previous.entries),rows=plan(preview.entries,products(),stored,preview.replace);if(JSON.stringify(rows)!==JSON.stringify(preview.rows))throw Error('El catálogo cambió. Vuelve a seleccionar el grupo de fotos');const ready=rows.filter(r=>r.status==='ready');if(!ready.length)throw Error('No hay fotos listas para guardar');const targets=new Set(ready.map(r=>r.productId));const entries=stored.filter(e=>!matches(e,products()).some(p=>targets.has(identity(p)))).concat(ready.map(r=>({...r.entry,targetId:r.productId})));validate(entries);await write(key,{entries,previous:stored},previous);cache=entries;loadedScope=key;preview=null;render();message(`${ready.length} fotos guardadas y verificadas. Exporta el grupo de fotos para usarlo en otro dispositivo.`);}catch(e){message(e.message);}finally{controls(false);}}
  async function open(){if(!authorized())return;root.document.getElementById('productImageBatchModal').style.display='flex';root.document.getElementById('productImageBatchModal').classList.add('open');try{await hydrate(true);message('Selecciona un JSON de paquete de fotos o fotos cuyo nombre sea el código del producto. Las fotos son locales a este dispositivo.');}catch(e){message(e.message);}}
  async function exportBatch(){try{await hydrate();const blob=new root.Blob([JSON.stringify({version:1,entries:cache})],{type:'application/json'}),url=root.URL.createObjectURL(blob),a=root.document.createElement('a');a.href=url;a.download='fotos-productos.json';a.click();root.setTimeout(()=>root.URL.revokeObjectURL(url),1000);}catch(e){message(e.message);}}
  async function undo(){if(busy||!authorized())return;controls(true);try{const key=scope(),record=await read(key);if(!Array.isArray(record.previous))throw Error('No hay grupo de fotos anterior');const entries=validate(record.previous);await write(key,{entries},record);cache=entries;loadedScope=key;preview=null;render();message('Se restauró el catálogo visual anterior');}catch(e){message(e.message);}finally{controls(false);}}
  root.NuevoAmanecerImageBatch=Object.freeze({plan,resolve,source,open,withSources});
  if(root.document)root.document.addEventListener('DOMContentLoaded',()=>{root.document.getElementById('productImageBatchFiles').addEventListener('change',filesSelected);root.document.getElementById('productImageBatchApply').addEventListener('click',apply);root.document.getElementById('productImageBatchExport').addEventListener('click',exportBatch);root.document.getElementById('productImageBatchUndo').addEventListener('click',undo);root.document.getElementById('productImageBatchReplace').addEventListener('change',()=>{if(selectedEntries.length)reprocessSelected();else{preview=null;message('Selecciona primero un grupo de fotos para actualizar la vista previa');}});hydrate().catch(()=>{});});
})(globalThis);
