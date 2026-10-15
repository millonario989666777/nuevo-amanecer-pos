// One capture listener handles non-bubbling image errors in inventory HTML templates.
if(typeof document!=='undefined')document.addEventListener('error',function(event){const image=event.target;if(image?.matches?.('img[data-na-prod-img]'))image.replaceWith(document.createTextNode(image.dataset.naProdImg||'📦'));},true);
function _naInventoryImageMarkup(source,product){const mobile=document.getElementById('pageInventario')?.classList.contains('inv-mobile-simple')&&window.matchMedia('(max-width: 767px)').matches,width=mobile?42:44,height=mobile?56:44;return `<img src="${_naEsc(source)}" alt="${_naEsc(product.name||'Producto')}" data-na-prod-img="${_naEsc(product.icon||'📦')}" width="${width}" height="${height}" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:contain;border-radius:inherit">`;}

// Seguridad: solamente se aceptan imágenes rasterizadas y la vista previa usa nodos DOM.
window.NuevoAmanecerProductImageOverlay=Object.freeze({
  'TRULULU AROS 90GR':'https://trululustore.wordpress.com/wp-content/uploads/2022/11/trululu-aros-1.jpg?w=1024',
  'TRULULU FRESITAS 90GR':'https://trululustore.wordpress.com/wp-content/uploads/2022/11/trululu-fresa-1.jpg?w=1024',
  'TRULULU ORO 90GR':'https://trululustore.wordpress.com/wp-content/uploads/2022/11/trululu-oro-12b-x-90g-v3.jpg?w=1024',
  'TRULULU SABORES 90GR':'https://trululustore.wordpress.com/wp-content/uploads/2022/11/trululu-sabores-12b-x-90g-v20.jpg?w=1024',
  'TRULULU DINOS 90GR':'https://firebasestorage.stagebeta.kyte.site/v0/b/kyte-7c484.appspot.com/o/8x5kblSeRMWUzzF9K1Awa7foUQw1%2Fthumb_280_3406a3c4-734c-4b9f-a22e-b1301cbaae69.jpg?alt=media',
  'GOMITAS TRULULU SABORES 90 GR':'https://aceleralastatic.nyc3.cdn.digitaloceanspaces.com/files/uploads/1499/1671033109-35-trululu-sabores-90g-jpg.jpg',
  'GOMAS TRULULU DINOSS 90G*':'https://firebasestorage.stagebeta.kyte.site/v0/b/kyte-7c484.appspot.com/o/8x5kblSeRMWUzzF9K1Awa7foUQw1%2Fthumb_280_3406a3c4-734c-4b9f-a22e-b1301cbaae69.jpg?alt=media',
  'TRULULU CASQUITOS VITAMINA C 90GR':'https://firebasestorage.stagebeta.kyte.site/v0/b/kyte-7c484.appspot.com/o/8x5kblSeRMWUzzF9K1Awa7foUQw1%2Fthumb_280_b4aeab63-4486-49c3-93e3-eabf5e3e67dd.jpg?alt=media',
  'TRULULU PINGUINOS 80GR':'https://domun.co/default/image-tool-lambda?new-height=700&new-quality=80&new-width=700&url-image=https%3A%2F%2Fsumerlabs.com%2Fsumer-app-90b8f.appspot.com%2Fproduct_photos%252Ffd0aa6876516aef8f062203b07b2e439%252Fe003f880-ff3c-11ec-9263-67049881eeef%3Falt%3Dmedia%26token%3D9cbe4add-c612-4f9b-b3b0-899148471547',
  'TRULULU SNACKS OSOS ORO 80G':'https://caest-imagenes.s3.us-east-2.amazonaws.com/products/local/1040784_1_z.webp'
});
const _naAllowedProductImageHosts=new Set([
  'trululustore.wordpress.com',
  'firebasestorage.stagebeta.kyte.site',
  'aceleralastatic.nyc3.cdn.digitaloceanspaces.com',
  'domun.co',
  'caest-imagenes.s3.us-east-2.amazonaws.com'
]);
function _naSafeProductImageSource(value){
  const source=typeof value==='string'?value.trim():'';
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(source)?source:null;
}
function _naSafeOverlayProductImageSource(value){
  const source=typeof value==='string'?value.trim():'';
  if(!source)return null;
  try{
    const parsed=new URL(source);
    return parsed.protocol==='https:'&&_naAllowedProductImageHosts.has(parsed.hostname)?source:null;
  }catch(_error){return null;}
}
function _naProductImageSource(product){
  const imported=_naSafeProductImageSource(window.NuevoAmanecerImageBatch?.source(product));
  if(imported)return imported;
  const direct=_naSafeProductImageSource(product?.imagen);
  if(direct)return direct;
  const name=String(product?.name||product?.nombre||'');
  const mapped=window.NuevoAmanecerProductImageOverlay?.[name];
  return _naSafeOverlayProductImageSource(mapped);
}
// Display-only URLs keep raster bytes out of HTML. Export and persistence retain base64.
const _naInventoryImageDisplay=(function(){
  const urls=new Map();
  function source(product){
    const data=_naProductImageSource(product);if(!data||!data.startsWith('data:'))return data;
    if(urls.has(data))return urls.get(data);
    if(typeof URL.createObjectURL!=='function')return data;
    try{const split=data.indexOf(','),raw=atob(data.slice(split+1)),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);const url=URL.createObjectURL(new Blob([bytes],{type:data.slice(5,data.indexOf(';'))}));urls.set(data,url);return url;}catch{return data;}
  }
  function prune(){const active=new Set(Array.from(document.querySelectorAll('#invBody img'),img=>img.getAttribute('src')));for(const [data,url] of urls)if(!active.has(url)){URL.revokeObjectURL(url);urls.delete(data);}}
  return Object.freeze({source,prune});
})();
function _naSafeSetProductPreview(source,altText){
  const preview=document.getElementById('imgPreview');
  if(!preview)return;
  preview.replaceChildren();
  const safeSource=_naSafeProductImageSource(source);
  if(safeSource){
    const image=document.createElement('img');
    image.src=safeSource;
    image.alt=String(altText||'Vista previa del producto');
    image.style.cssText='width:100%;height:100%;object-fit:contain;border-radius:inherit';
    preview.appendChild(image);
  }else preview.textContent=document.getElementById('pIcon')?.value||'📦';
  const remove=document.getElementById('pRemoveImageBtn');
  if(remove)remove.hidden=!safeSource;
}
_naF12RenderVisual=function(){
  const source=_naSafeProductImageSource(imagenProducto);
  if(!source&&imagenProducto)imagenProducto=null;
  _naSafeSetProductPreview(source,document.getElementById('pNombre')?.value||'Vista previa del producto');
};
previewImagen=function(){
  _naF12SetMode('image');
  const input=document.getElementById('pImagen'),file=input?.files?.[0];
  if(!file)return;
  const allowedTypes=new Set(['image/jpeg','image/png','image/webp','image/gif']);
  if(!allowedTypes.has(file.type)){
    toast('Selecciona una imagen JPG, PNG, WebP o GIF','error');
    input.value='';
    return;
  }
  if(file.size>12_000_000){
    toast('La imagen supera 12 MB','error');
    input.value='';
    return;
  }
  const reader=new FileReader();
  reader.onerror=()=>{input.value='';toast('No se pudo leer la imagen','error');};
  reader.onload=event=>{
    const decoded=new Image();
    decoded.onerror=()=>{input.value='';toast('No se pudo leer la imagen','error');};
    decoded.onload=()=>{
      let max=480,quality=.72,data='';
      for(let attempt=0;attempt<5;attempt++){
        const scale=Math.min(1,max/Math.max(decoded.width,decoded.height)),canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(decoded.width*scale));
        canvas.height=Math.max(1,Math.round(decoded.height*scale));
        const context=canvas.getContext('2d');
        if(!context){toast('El navegador no pudo procesar la imagen','error');return;}
        context.drawImage(decoded,0,0,canvas.width,canvas.height);
        data=canvas.toDataURL('image/jpeg',quality);
        if(data.length<120000)break;
        max=Math.round(max*.82);
        quality=Math.max(.48,quality-.08);
      }
      if(!_naSafeProductImageSource(data)||data.length>=180000){
        toast('La imagen sigue siendo demasiado pesada; usa una foto más pequeña','error');
        input.value='';
        return;
      }
      imagenProducto=data;
      _naSafeSetProductPreview(imagenProducto,document.getElementById('pNombre')?.value||'Vista previa del producto');
      toast('Imagen optimizada para el almacenamiento','success');
    };
    decoded.src=String(event.target?.result||'');
  };
  reader.readAsDataURL(file);
};
