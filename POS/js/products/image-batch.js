(function(root){
  'use strict';
  if(root.document?.head&&root.document.createElement&&!root.NuevoAmanecerImageSync&&!root.document.querySelector?.('script[src="js/products/image-sync.js"]')){const script=root.document.createElement('script');script.src='js/products/image-sync.js';script.defer=true;root.document.head?.append(script);}
  const zipReady=new Promise((resolve,reject)=>{
    if(root.NuevoAmanecerZipReader){resolve(root.NuevoAmanecerZipReader);return;}
    if(!root.document?.head){resolve(null);return;}
    let script=root.document.querySelector?.('script[src="js/products/zip-reader.js"]');
    if(!script){script=root.document.createElement('script');script.src='js/products/zip-reader.js';script.defer=true;root.document.head.append(script);}
    script.addEventListener('load',()=>resolve(root.NuevoAmanecerZipReader));script.addEventListener('error',()=>reject(Error('No se pudo cargar el lector ZIP')));
  });
  zipReady.catch(()=>{});
  const LIMIT=500,MAX_IMAGE=180000,MAX_TOTAL=20*1024*1024;
  const codes=p=>[p.sku,p.barcode,...(Array.isArray(p.codigosAlternativos)?p.codigosAlternativos:[]),p.codigoAlternativo].filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim());
  const identity=p=>String(p.product_id??p.id);
  const productName=p=>p.name||p.nombre||'';
  const normalizeName=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  // Normalized Levenshtein similarity, as a percentage. Names never establish a link.
  function nameSimilarity(left,right){
    const a=normalizeName(left),b=normalizeName(right);
    if(!a||!b)return 0;
    let previous=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){
      const current=[i];
      for(let j=1;j<=b.length;j++)current[j]=Math.min(current[j-1]+1,previous[j]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));
      previous=current;
    }
    return 100*(1-previous[b.length]/Math.max(a.length,b.length));
  }
  function suggestion(entry,catalog){
    const name=entry.filename?entry.filename.split(/[\\/]/).pop().replace(/\.[^.]+$/,'').replace(/(?:_1|-1| \(1\))$/,''):entry.codes.join(' ');
    let best=null,score=70,tied=false;
    for(const product of catalog){const similarity=nameSimilarity(name,productName(product));
      if(similarity>=70&&(!best||similarity>score)){best=product;score=similarity;tied=false;}
      else if(best&&similarity===score)tied=true;
    }
    return best&&!tied?{productId:identity(best),productName:productName(best),similarity:score}:null;
  }
  const catalogSignature=catalog=>JSON.stringify(catalog.map(p=>[identity(p),productName(p),codes(p)]));
  function reviewRows(rows,catalog){return rows.flatMap((row,index)=>{
    if(!['missing','ambiguous','duplicate'].includes(row.status))return [];
    return [{...row,index,suggestion:row.status==='missing'?suggestion(row.entry,catalog):null}];
  });}
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
      return {...(typeof e.filename==='string'?{filename:e.filename}:{}),codes:[...new Set(e.codes.map(c=>c.trim()))],image:e.image,...(e.targetId?{targetId:e.targetId}:{})};
    });
  }
  function filenameCode(filename,catalog){const name=filename.split(/[\\/]/).pop().replace(/\.[^.]+$/,'');return catalog.some(p=>codes(p).includes(name))?name:name.replace(/(?:_1|-1| \(1\))$/,'');}
  function summary(rows){return {linked:rows.filter(r=>r.status==='ready'||r.status==='existing'||r.status==='unchanged').length,missing:rows.filter(r=>r.status==='missing').length,ambiguous:rows.filter(r=>r.status==='ambiguous'||r.status==='duplicate').length,existing:rows.filter(r=>r.status==='existing'||r.status==='unchanged').length,unmatched:rows.filter(r=>r.status==='missing').slice(0,50).map(r=>r.entry.filename||r.entry.codes.join(', '))};}
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
      const found=matches(entry,products),p=found.length===1?found[0]:null;
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
  let reviewPreview=null,reviewed=new Set(),reviewTargets=new Set();
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
  function source(p){
    // A confirmed server photo by ID takes precedence over an older local import.
    // Una sola consulta a la foto del servidor por producto y pintado.
    let remoteTried=false;
    try{if(root.NuevoAmanecerImageSync?.hasImage?.(p)){remoteTried=true;const remote=root.NuevoAmanecerImageSync.source(p);if(remote)return remote;}}catch{}
    let local=null;try{if(loadedScope!==scope()){sourceIndex=null;hydrate().catch(()=>{});}else if(sourceDepth){if(!sourceIndex)sourceIndex=indexSources(cache,products());local=sourceIndex.get(p)||null;}else local=resolve(p,cache,products());}catch{}if(local||remoteTried)return local||null;try{return root.NuevoAmanecerImageSync?.source(p)||null;}catch{return null;}
  }

  function moduleLocked(){return typeof isModuleLocked==='function'&&isModuleLocked('productos',{canonicalProductUi:true});}
  // Misma condición de rol/bloqueo para abrir y para cerrar ante na:role (el PIN solo se pide al abrir).
  function openAllowed(){return root.NA_ROLES?.role!=='empleado'&&!moduleLocked();}
  function authorized(){return !moduleLocked()&&(typeof _naAuthorize!=='function'||_naAuthorize('importar','Cargar fotos de productos'));}
  function reviewAllowed(){return root.NA_ROLES?.role==='owner'&&root.NA_ROLES.isOwner?.()===true&&root.NA_PERMISSIONS?.canDo?.('owner','product-images.write')===true;}
  function message(text){root.document.getElementById('productImageBatchStatus').textContent=text;}
  function controls(value){busy=value;root.document.querySelectorAll('#productImageBatchModal button,#productImageBatchModal input').forEach(n=>n.disabled=value||n.dataset.reviewDisabled==='true');}
  const labels={ready:'Lista',missing:'Sin producto',ambiguous:'Código ambiguo',duplicate:'Producto repetido',existing:'Ya tiene foto',unchanged:'Sin cambios'};
  function show(rows){const tbody=root.document.getElementById('productImageBatchRows');tbody.replaceChildren();for(const row of rows){const tr=root.document.createElement('tr');for(const value of [row.entry.codes.join(', '),row.productName,labels[row.status]]){const td=root.document.createElement('td');td.textContent=value;tr.append(td);}tbody.append(tr);}const report=summary(rows);root.document.getElementById('productImageBatchStatus').style.whiteSpace='pre-line';message(`Vinculadas: ${report.linked} · Sin producto: ${report.missing} · Ambiguas: ${report.ambiguous} · Ya tenían foto: ${report.existing}`+(report.unmatched.length?'\n'+report.unmatched.join('\n'):''));reviewPreview={...preview,catalog:catalogSignature(products()),reviews:reviewRows(rows,products())};showReview();}
  function element(tag,className,text){const node=root.document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  function reviewUI(){
    const doc=root.document,modal=doc.getElementById('productImageBatchModal');
    if(!modal?.querySelector||!doc.createElement)return null;
    let section=doc.getElementById('productImageBatchReview');
    if(section)return section;
    if(!doc.getElementById('productImageReviewStyles')){const link=doc.createElement('link');link.id='productImageReviewStyles';link.rel='stylesheet';link.href='css/product-image-review.css';doc.head.append(link);}
    section=element('section');section.id='productImageBatchReview';section.hidden=true;section.setAttribute('aria-labelledby','productImageBatchReviewTitle');
    const title=element('h3','','Revisar fotos sin coincidencia');title.id='productImageBatchReviewTitle';
    const list=element('div','image-review-list');list.id='productImageBatchReviewList';
    section.append(title,element('p','','Confirma una sugerencia o busca un producto. Cada foto se guarda en el servidor solo al pulsar su botón.'),list);
    modal.querySelector('.mbody').append(section);return section;
  }
  function showReview(){
    if(!root.document)return;
    const section=reviewUI();if(!section)return;
    const list=root.document.getElementById('productImageBatchReviewList');list.replaceChildren();
    const allowed=reviewAllowed(),rows=allowed&&reviewPreview?reviewPreview.reviews.filter(row=>!reviewed.has(row.index)):[];
    section.hidden=!rows.length;if(!allowed)return;
    for(const row of rows){
      const card=element('article','image-review-card');card.dataset.reviewIndex=String(row.index);
      const image=element('img','image-review-photo');image.src=row.entry.image;image.alt='Foto por revisar';image.width=80;image.height=80;image.loading='lazy';
      const content=element('div','image-review-content'),filename=row.entry.filename||row.entry.codes.join(', ');
      content.append(element('strong','image-review-filename',filename));
      const suggested=row.suggestion,description=row.status==='ambiguous'?'código duplicado: elegir producto':row.status==='duplicate'?'Varias fotos para el mismo producto: elegir producto':suggested?`Sugerencia: ${suggested.productName} (${Math.floor(suggested.similarity)}%)`:'sin sugerencia';
      content.append(element('p','image-review-suggestion',description));
      const feedback=element('p','image-review-feedback');feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
      if(suggested){const confirm=element('button','mbtn mbtn-ok image-review-confirm','Confirmar sugerencia');confirm.type='button';confirm.addEventListener('click',()=>saveReview(row.index,suggested.productId,feedback));content.append(confirm);}
      const label=element('label','','Buscar producto por nombre o código'),search=element('input','fi image-review-search');
      search.id=`productImageReviewSearch${row.index}`;search.type='search';search.placeholder='Nombre o código';search.autocomplete='off';label.htmlFor=search.id;
      const results=element('div','image-review-results'),selection=element('p','image-review-selection'),save=element('button','mbtn mbtn-ok image-review-save','Guardar en producto elegido');
      save.type='button';save.disabled=true;save.dataset.reviewDisabled='true';let chosen=null;
      search.addEventListener('input',()=>{
        chosen=null;selection.textContent='';save.disabled=true;save.dataset.reviewDisabled='true';results.replaceChildren();
        if(!reviewAllowed())return;
        const query=normalizeName(search.value);if(!query)return;
        const found=products().filter(p=>normalizeName(productName(p)).includes(query)||codes(p).some(code=>normalizeName(code).includes(query)));
        for(const product of found.slice(0,20)){
          const option=element('button','image-review-option',`${productName(product)} · ${codes(product).join(', ')||'Sin código'} · ID ${identity(product)}`);option.type='button';
          option.addEventListener('click',()=>{if(busy||!reviewAllowed())return;chosen=identity(product);selection.textContent=`Elegido: ${productName(product)} · ID ${chosen}`;results.replaceChildren();save.dataset.reviewDisabled='false';save.disabled=false;});results.append(option);
        }
        if(!found.length)results.append(element('p','','Sin resultados'));
        else if(found.length>20)results.append(element('p','','Mostrando 20 productos. Escribe más para afinar la búsqueda.'));
      });
      save.addEventListener('click',()=>{if(chosen)saveReview(row.index,chosen,feedback);});
      content.append(label,search,results,selection,save,feedback);card.append(image,content);list.append(card);
    }
  }
  async function saveReview(index,productId,feedback){
    if(busy||!reviewAllowed()||!authorized()||!reviewPreview||reviewed.has(index))return;
    const candidate=reviewPreview;controls(true);
    try{
      if(scope()!==candidate.key)throw Error('La sesión cambió. Vuelve a seleccionar el grupo de fotos');
      const catalog=products();
      if(catalogSignature(catalog)!==candidate.catalog)throw Error('El catálogo cambió. Vuelve a seleccionar el grupo de fotos');
      const row=candidate.reviews.find(r=>r.index===index),found=catalog.filter(p=>identity(p)===productId);
      if(!row||found.length!==1)throw Error('Elige un producto vigente');
      if(reviewTargets.has(productId)||candidate.rows.some(r=>r.status==='ready'&&r.productId===productId))throw Error('Otra foto de este grupo ya está elegida para ese producto');
      const product=found[0];
      if(!root.document.getElementById('productImageBatchReplace').checked&&(product.imagen||resolve(product,cache,catalog)||root.NuevoAmanecerImageSync?.hasImage?.(product)))throw Error('El producto ya tiene foto. Activa Reemplazar fotos existentes para cambiarla');
      if(!root.NuevoAmanecerImageSync?.upload)throw Error('Espera a que cargue la sincronización de fotos');
      if(!reviewAllowed())return;
      const uploadCodes=codes(product);if(!uploadCodes.length)uploadCodes.push(...row.entry.codes);
      feedback.textContent='Guardando foto en el servidor…';
      const result=await root.NuevoAmanecerImageSync.upload([{productId,codes:[...new Set(uploadCodes)].slice(0,20),image:row.entry.image}]);
      if(result.failed||result.ok+result.unchanged!==1)throw Error(result.errors?.includes('SIN_SESION')?'Inicia sesión en la nube para guardar esta foto':'No se pudo guardar la foto. Revisa la conexión y vuelve a intentarlo');
      reviewed.add(index);reviewTargets.add(productId);
      message(`Foto guardada en el servidor para ${productName(product)}.`);showReview();render();
    }catch(e){feedback.textContent=e.message;}finally{controls(false);}
  }
  function raster(data,preserve=false){return new Promise((resolve,reject)=>{const img=new root.Image();img.onload=()=>{try{if(!img.width||!img.height||img.width*img.height>40000000)throw Error('Imagen demasiado grande');if(preserve){resolve(data);return;}const canvas=root.document.createElement('canvas'),ratio=Math.min(1,768/Math.max(img.width,img.height));canvas.width=Math.max(1,Math.round(img.width*ratio));canvas.height=Math.max(1,Math.round(img.height*ratio));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);let image=canvas.toDataURL('image/jpeg',.8);if(image.length>MAX_IMAGE)image=canvas.toDataURL('image/jpeg',.5);validate([{codes:['test'],image}]);resolve(image);}catch(e){reject(e);}};img.onerror=()=>reject(Error('No se pudo abrir una imagen'));img.src=data;});}
  async function filesSelected(event){if(busy||!authorized())return;controls(true);preview=null;reviewPreview=null;reviewed.clear();reviewTargets.clear();showReview();try{await hydrate(true);const files=[];for(const file of event.target.files){if(/\.zip$/i.test(file.name)){const reader=await zipReady;if(!reader)throw Error('Lector ZIP no disponible');files.push(...await reader.read(file));}else if(/\.json$/i.test(file.name)||(/\.(jpe?g|png|webp)$/i.test(file.name)&&!String(file.webkitRelativePath||file.name).split(/[\\/]/).some(part=>part.startsWith('.')||part==='__MACOSX')))files.push(file);if(files.length>LIMIT)throw Error('Máximo 500 archivos');}
      let entries=[];for(const file of files){if(file.size>MAX_TOTAL)throw Error('Archivo mayor de 20 MB');if(/\.json$/i.test(file.name)){const body=JSON.parse(await file.text());if(body.version!==1)throw Error('Versión de paquete de fotos no compatible');entries.push(...validate(body.entries));}else{if(file.size>15*1024*1024)throw Error('Usa fotos PNG, JPEG o WebP de hasta 15 MB');const data=await new Promise((resolve,reject)=>{const reader=new root.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;if(file instanceof root.Blob)reader.readAsDataURL(file);else file.arrayBuffer().then(buffer=>reader.readAsDataURL(new root.Blob([buffer],{type:file.type})),reject);});entries.push({codes:[filenameCode(file.name,products())],filename:file.name,image:await raster(data)});}}
      entries=validate(entries);for(const entry of entries)entry.image=await raster(entry.image,true);
      selectedEntries=entries;const replace=root.document.getElementById('productImageBatchReplace').checked,rows=plan(entries,products(),cache,replace);preview={entries,replace,rows,key:scope()};show(rows);
    }catch(e){selectedEntries=[];reviewPreview=null;showReview();message(e.message);root.document.getElementById('productImageBatchRows').replaceChildren();}finally{controls(false);}}
  async function reprocessSelected(){if(busy||!selectedEntries.length)return;controls(true);try{await hydrate(true);const replace=root.document.getElementById('productImageBatchReplace').checked,rows=plan(selectedEntries,products(),cache,replace);preview={entries:selectedEntries,replace,rows,key:scope()};show(rows);}catch(e){preview=null;message(e.message);}finally{controls(false);}}
  async function apply(){if(busy||!preview||!authorized())return;controls(true);try{const key=scope();if(key!==preview.key)throw Error('La sesión cambió. Vuelve a seleccionar el grupo de fotos');const previous=await read(key),stored=validate(previous.entries),rows=plan(preview.entries,products(),stored,preview.replace);if(JSON.stringify(rows)!==JSON.stringify(preview.rows))throw Error('El catálogo cambió. Vuelve a seleccionar el grupo de fotos');const ready=rows.filter(r=>r.status==='ready');if(!ready.length)throw Error('No hay fotos listas para guardar');const targets=new Set(ready.map(r=>r.productId));const entries=stored.filter(e=>!matches(e,products()).some(p=>targets.has(identity(p)))).concat(ready.map(r=>({...r.entry,targetId:r.productId})));validate(entries);await write(key,{entries,previous:stored},previous);cache=entries;loadedScope=key;preview=null;render();message(`${ready.length} fotos guardadas y verificadas.`);if(root.NuevoAmanecerImageSync)await uploadRows(ready.map(r=>({productId:r.productId,codes:r.entry.codes,image:r.entry.image})));}catch(e){message(e.message);}finally{controls(false);}}
  async function uploadRows(entries){if(root.NA_ROLES?.isOwner?.()===false||!authorized())return {ok:0,unchanged:0,failed:entries.length,errors:['forbidden_role']};const r=await root.NuevoAmanecerImageSync.upload(entries,{onProgress:(x,n)=>message(`Subiendo al servidor ${x}/${n}…`)});message(r.errors.includes('SIN_SESION')?'Fotos guardadas solo en este equipo (sin sesión en la nube).':`${entries.length} fotos guardadas en este equipo; servidor: ${r.ok} subidas, ${r.unchanged} sin cambios, ${r.failed} con error.`);return r;}
  async function uploadLocal(){if(busy||root.NA_ROLES?.isOwner?.()===false||!authorized())return;controls(true);try{await hydrate(true);if(!root.NuevoAmanecerImageSync)throw Error('Espera a que cargue la sincronización de fotos');const catalog=products(),entries=[];for(const entry of cache){const found=entry.targetId?catalog.filter(p=>identity(p)===entry.targetId):matches(entry,catalog);if(found.length===1)entries.push({productId:identity(found[0]),codes:entry.codes,image:entry.image});}const r=await uploadRows(entries);if(entries.length&&!r.failed){try{root.localStorage.setItem('na_product_images_uploaded_v1',scope());}catch{}root.document.getElementById('productImageBatchUpload').textContent='Volver a subir fotos de este equipo';}}catch(e){message(e.message);}finally{controls(false);}}
  function storageWarning(){const box=root.document.getElementById('productImageBatchStorage');if(!box)return;const st=root.NA_ROLES?.role==='empleado'?null:root.NuevoAmanecerImageSync?.storage?.();const pct=st?st.used/st.cap:0;box.hidden=!(pct>=.8);box.textContent=pct>=.8?`Almacenamiento de fotos al ${Math.min(100,Math.floor(pct*100))} % del límite. Borra fotos que no uses o reduce su tamaño antes de subir más.`:'';}
  function close(){const m=root.document.getElementById('productImageBatchModal');if(!m)return;m.classList.remove('open');m.style.display='none';}
  async function open(){if(!openAllowed()||!authorized())return;showReview();root.document.getElementById('productImageBatchModal').style.display='flex';root.document.getElementById('productImageBatchModal').classList.add('open');storageWarning();try{root.NuevoAmanecerImageSync?.refresh?.(true).then(storageWarning,()=>{});}catch{}try{await hydrate(true);message('Selecciona un JSON de paquete de fotos o fotos cuyo nombre sea el código del producto. Con sesión en la nube, las fotos también se suben al servidor (miniaturas).');}catch(e){message(e.message);}}
  async function exportBatch(){try{await hydrate();const blob=new root.Blob([JSON.stringify({version:1,entries:cache})],{type:'application/json'}),url=root.URL.createObjectURL(blob),a=root.document.createElement('a');a.href=url;a.download='fotos-productos.json';a.click();root.setTimeout(()=>root.URL.revokeObjectURL(url),1000);}catch(e){message(e.message);}}
  async function undo(){if(busy||!authorized())return;controls(true);try{const key=scope(),record=await read(key);if(!Array.isArray(record.previous))throw Error('No hay grupo de fotos anterior');const entries=validate(record.previous);await write(key,{entries},record);cache=entries;loadedScope=key;preview=null;reviewPreview=null;showReview();render();message('Se restauró el catálogo visual anterior');}catch(e){message(e.message);}finally{controls(false);}}
  root.NuevoAmanecerImageBatch=Object.freeze({plan,resolve,source,open,close,withSources,nameSimilarity,_test:{storageWarning,filenameCode,summary,normalizeName,suggestion,reviewRows,reviewAllowed,saveReview}});
  if(root.addEventListener)root.addEventListener('na:role',()=>{if(!reviewAllowed()){reviewPreview=null;reviewed.clear();reviewTargets.clear();showReview();}if(!openAllowed())close();});
  if(root.document)root.document.addEventListener('keydown',e=>{if(e.key==='Escape'&&root.document.getElementById('productImageBatchModal')?.classList.contains('open')&&!busy)close();});
  if(root.document)root.document.addEventListener('DOMContentLoaded',()=>{const modal=root.document.getElementById('productImageBatchModal');if(modal)modal.addEventListener('click',e=>{if(e.target===modal&&!busy)close();});const applyButton=root.document.getElementById('productImageBatchApply');if(applyButton&&!root.document.getElementById('productImageBatchUpload')){const button=root.document.createElement('button');button.id='productImageBatchUpload';button.type='button';button.className='mbtn mbtn-cancel';button.style.gridColumn='1/-1';button.textContent='Subir fotos de este equipo al servidor';try{if(root.localStorage.getItem('na_product_images_uploaded_v1')===scope())button.textContent='Volver a subir fotos de este equipo';}catch{}button.addEventListener('click',uploadLocal);applyButton.before(button);}root.document.getElementById('productImageBatchFolder')?.addEventListener('change',filesSelected);root.document.getElementById('productImageBatchFiles').addEventListener('change',filesSelected);root.document.getElementById('productImageBatchApply').addEventListener('click',apply);root.document.getElementById('productImageBatchExport').addEventListener('click',exportBatch);root.document.getElementById('productImageBatchUndo').addEventListener('click',undo);root.document.getElementById('productImageBatchReplace').addEventListener('change',()=>{if(selectedEntries.length)reprocessSelected();else{preview=null;message('Selecciona primero un grupo de fotos para actualizar la vista previa');}});hydrate().catch(()=>{});});
})(globalThis);
