(function(root){
  'use strict';
  let storage=null,manifest={version:'',images:[]},memory=new Map(),queued=new Set(),queue=[],active=0,last=0,refreshing=null,timer=null,override=null;
  const api=(path,body)=>{if(!root.NA_ROLES?.api)throw Error('SIN_SESION');return root.NA_ROLES.api(path,body);};
  function database(){return new Promise((resolve,reject)=>{if(!root.indexedDB){resolve(null);return;}const r=root.indexedDB.open('nuevo-amanecer-product-images-remote-v1',1);r.onupgradeneeded=()=>{r.result.createObjectStore('meta');r.result.createObjectStore('images');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  async function persist(store,key,value){try{const db=await database();if(!db)return;try{await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');if(value===undefined)tx.objectStore(store).delete(key);else tx.objectStore(store).put(value,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}finally{db.close();}}catch{}}
  function render(){if(timer)return;timer=root.setTimeout(()=>{timer=null;for(const name of ['posRender','invRender','posUpdateCart'])if(typeof root[name]==='function')root[name]();},250);}
  function prune(){for(const [id,item] of memory)if(!manifest.images.some(m=>m.product_id===id&&m.etag===item.etag)){memory.delete(id);persist('images',id,undefined);}}
  const startup=(async()=>{try{const db=await database();if(!db)return;try{await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','images']);const m=tx.objectStore('meta').get('manifest');m.onsuccess=()=>{if(m.result)manifest=m.result;};const c=tx.objectStore('images').openCursor();c.onsuccess=()=>{const row=c.result;if(row){memory.set(row.key,row.value);row.continue();}};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}finally{db.close();}prune();render();}catch{}})();
  async function refresh(force=false){await startup;if(refreshing)return refreshing;if(!force&&last&&Date.now()-last<300000)return;last=Date.now();refreshing=(async()=>{try{const r=await api('/auth/product-images?since='+encodeURIComponent(manifest.version));storage=r.storage&&Number.isFinite(r.storage.used)&&Number(r.storage.cap)>0?{used:r.storage.used,cap:r.storage.cap}:null;if(r.status==='ok'){manifest={version:r.version,images:r.images};prune();await persist('meta','manifest',manifest);render();}}catch{}})().finally(()=>{refreshing=null;});return refreshing;}
  function pump(){while(active<3&&queue.length){const m=queue.shift();active++;(async()=>{try{const r=await api('/auth/product-images/item?product_id='+encodeURIComponent(m.product_id)+'&v='+encodeURIComponent(m.etag));if(r.etag===m.etag&&manifest.images.some(e=>e.product_id===m.product_id&&e.etag===m.etag)){const item={etag:r.etag,image:r.image};memory.set(m.product_id,item);await persist('images',m.product_id,item);render();}}catch{}finally{active--;queued.delete(m.product_id);pump();}})();}}
  function imageRecord(product){
    const id=String(product.product_id??product.id),direct=manifest.images.find(e=>e.product_id===id);
    if(direct)return direct;
    const codes=[product.sku,product.barcode,...(Array.isArray(product.codigosAlternativos)?product.codigosAlternativos:[]),product.codigoAlternativo].filter(c=>typeof c==='string').map(c=>c.trim()).filter(Boolean);
    // Code fallback stays for products whose photo was saved under another id, but a
    // barcode shared by 2+ catalog products never lends one product's photo to another.
    const catalog=typeof productos!=='undefined'&&Array.isArray(productos)?productos:[];
    const codeOf=p=>[p.sku,p.barcode,...(Array.isArray(p.codigosAlternativos)?p.codigosAlternativos:[]),p.codigoAlternativo].filter(c=>typeof c==='string').map(c=>c.trim());
    if(codes.some(c=>catalog.filter(p=>codeOf(p).includes(c)).length>1))return null;
    const found=manifest.images.filter(e=>e.codes.some(c=>codes.includes(c)));
    return found.length===1?found[0]:null;
  }
  function source(product){const m=imageRecord(product);if(!m)return null;const item=memory.get(m.product_id);if(item?.etag===m.etag)return item.image;if(!queued.has(m.product_id)){queued.add(m.product_id);queue.push(m);pump();}return null;}
  const THUMBNAIL_SIZES=Object.freeze([384,320,256]),THUMBNAIL_QUALITIES=Object.freeze([.8,.7,.6,.5]),MAX_THUMBNAIL_BYTES=40000,MAX_THUMBNAIL_CHARS=60000;
  function thumbnail(dataURL){if(override)return Promise.resolve().then(()=>override(dataURL));return new Promise((resolve,reject)=>{const img=new root.Image();img.onload=()=>{try{
    if(!img.width||!img.height)throw Error('Imagen inválida');
    const canvas=root.document.createElement('canvas');
    for(const type of ['image/webp','image/jpeg']){
      let unsupported=false;
      for(const size of THUMBNAIL_SIZES){
        const ratio=Math.min(1,size/Math.max(img.width,img.height));canvas.width=Math.max(1,Math.round(img.width*ratio));canvas.height=Math.max(1,Math.round(img.height*ratio));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        for(const quality of THUMBNAIL_QUALITIES){const image=canvas.toDataURL(type,quality);if(!image.startsWith('data:'+type+';base64,')){unsupported=true;break;}if(image.split(',')[1].length*3/4<=MAX_THUMBNAIL_BYTES&&image.length<MAX_THUMBNAIL_CHARS){resolve(image);return;}}
        if(unsupported)break;
      }
      if(!unsupported)break;
    }
    throw Error('Miniatura demasiado grande');
  }catch(e){reject(e);}};img.onerror=()=>reject(Error('No se pudo abrir una imagen'));img.src=dataURL;});}
  async function upload(entries,{onProgress}={}){const result={ok:0,unchanged:0,failed:0,errors:[]};for(let i=0;i<entries.length;i++){try{const e=entries[i],image=await thumbnail(e.image),r=await api('/auth/product-images',{product_id:e.productId,codes:e.codes,image});if(r.status==='unchanged')result.unchanged++;else result.ok++;}catch(e){result.failed++;if(result.errors.length<5)result.errors.push(e.message);if(e.message==='SIN_SESION'||e.status===401||e.status===403){result.failed+=entries.length-i-1;break;}}if(onProgress)try{onProgress(i+1,entries.length);}catch{}}await refresh(true);return result;}
  async function remove(productId){const r=await api('/auth/product-images',{product_id:productId,delete:true});await refresh(true);return r;}
  function reset(){storage=null;manifest={version:'',images:[]};memory.clear();last=0;override=null;}
  root.NuevoAmanecerImageSync=Object.freeze({storage:()=>storage,source,hasImage:product=>!!imageRecord(product),refresh,upload,remove,thumbnail,_test:{THUMBNAIL_SIZES,THUMBNAIL_QUALITIES,MAX_THUMBNAIL_BYTES,MAX_THUMBNAIL_CHARS,reset,setThumbnail:fn=>{override=fn;}}});
  if(root.document){const start=()=>root.setTimeout(()=>refresh(),1500);if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',start);else start();root.document.addEventListener('visibilitychange',()=>{if(root.document.visibilityState==='visible')refresh();});}
  if(root.addEventListener)root.addEventListener('online',()=>refresh());
})(globalThis);
