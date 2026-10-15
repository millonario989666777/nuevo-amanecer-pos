
// Auditoría de seguridad: el inventario muestra datos creados por el usuario o importados.
// Se conservan las mismas reglas de negocio, pero toda salida textual y atributo HTML se codifica.
let _naInventoryRowsObserver=null;
function _naCancelInventoryRows(){if(_naInventoryRowsObserver)_naInventoryRowsObserver.disconnect();_naInventoryRowsObserver=null;}
function _naRenderInventoryRows(container,items,renderItem){
  _naCancelInventoryRows();let next=0;
  // Etapa 2: al refrescar la misma pestaña se vuelven a pintar al menos las filas que ya se veían,
  // así la lista no se acorta y el usuario no pierde su lugar (antes 3524 px -> ~1500 px).
  const keep=container.__naInvTab===invTab?container.children.length:0;container.__naInvTab=invTab;
  const chunk=()=>{const end=Math.min(items.length,next+24);container.insertAdjacentHTML('beforeend',items.slice(next,end).map(renderItem).join(''));next=end;};
  const renderChunk=callback=>{const withPhotos=()=>window.NuevoAmanecerImageBatch?.withSources?window.NuevoAmanecerImageBatch.withSources(callback):callback();try{return _naWithCategoryCatalog(withPhotos);}finally{if(typeof _naInventoryImageDisplay!=='undefined')_naInventoryImageDisplay.prune();}};
  container.replaceChildren();
  // Search visibility badges are applied synchronously by the existing visibility wrapper.
  if(typeof IntersectionObserver!=='function'||document.getElementById('invSearch')?.value.trim()){renderChunk(()=>{container.innerHTML=items.map(renderItem).join('');});return;}
  renderChunk(()=>{chunk();while(next<Math.min(items.length,keep))chunk();});if(next===items.length)return;
  const tab=invTab,observer=new IntersectionObserver(entries=>{
    if(observer!==_naInventoryRowsObserver||invTab!==tab||!container.isConnected)return;
    if(!entries.some(entry=>entry.isIntersecting))return;observer.disconnect();
    renderChunk(chunk);
    if(next<items.length)observer.observe(container.lastElementChild);else _naCancelInventoryRows();
  },{rootMargin:'600px 0px'});
  _naInventoryRowsObserver=observer;observer.observe(container.lastElementChild);
}
_baseInvRender=function(){
  invBadges();
  const search=sinTildes((document.getElementById('invSearch')?.value||'').toLowerCase()),category=document.getElementById('invCat')?.value||'';
  const list=productos.filter(product=>{
    const matches=sinTildes((product.name||'').toLowerCase()).includes(search)||sinTildes(product.descripcion||'').includes(search)||sinTildes((product.marca||'').toLowerCase()).includes(search)||(product.sku||'').toLowerCase().includes(search)||(product.barcode||'').includes(search)||_naProductAltCodes(product).some(code=>code.toLowerCase().includes(search));
    const categoryMatches=!category||product.cat===category;
    const days=diasHasta(_naEffectiveExpiry(product));
    const tabMatches=invTab==='critico'?_naTracksStock(product)&&product.stock<=product.stockMin:invTab==='vencimiento'?_naTracksStock(product)&&days!==null&&days>=0&&days<=NA_EXPIRY_SOON_DAYS:invTab==='vencidos'?_naExpiryBucket(product)==='expired':true;
    return matches&&categoryMatches&&tabMatches;
  });
  const body=document.getElementById('invBody');if(!body)return;
  if(!list.length){body.innerHTML='<tr><td colspan="6"><div class="empty-state"><div class="ei"><i class="na-ic na-ic-search" aria-hidden="true"></i></div><p>Sin productos</p></div></td></tr>';return;}
  _naRenderInventoryRows(body,list,product=>{
    const tracked=_naTracksStock(product),stockClass=!tracked?'ok':product.stock<=0?'out':product.stock<=product.stockMin?'low':'ok';
    const stockLabel=!tracked?'Sin control':(product._canonicalPendingStock&&Number.isFinite(product._canonicalRemoteStock)?`CANON ${product._canonicalRemoteStock} (−${Number(product._canonicalPendingDelta||Math.max(0,product._canonicalRemoteStock-product.stock))} pend.)`:product.stock<0?`Faltan ${Math.abs(product.stock)}`:product.stock===0?'Sin stock':product.stock<=product.stockMin?`${product.stock}`:`${product.stock}`);
    const expiry=_naEffectiveExpiry(product);
    const id=JSON.stringify(product.id),safeImage=typeof _naInventoryImageDisplay!=='undefined'?_naInventoryImageDisplay.source(product):_naProductImageSource(product),icon=safeImage?`<img src="${_naEsc(safeImage)}" alt="${_naEsc(product.name)}" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:cover;border-radius:8px">`:_naEsc(product.icon||'📦');
    return `<tr><td><div class="prod-info"><div class="prod-icon-sm">${icon}</div><div><div class="prod-name-sm">${_naEsc(product.name)}</div><div class="prod-sku-sm">${_naEsc(product.sku)}${product.marca&&product.marca!=='Sin marca'?` · ${_naEsc(product.marca)}`:''} · ${_naEsc(_naCategoryTitle(product.unidad||'unidad'))}</div></div></div></td><td><span class="cat-pill">${_naEsc(_naCategoryLabel(product.cat))}</span></td><td><div style="font-size:12px;font-weight:800;color:var(--teal)">S/ ${_naNumber(product.precio).toFixed(2)}</div><div style="font-size:10px;color:var(--slate)">Costo: S/ ${_naNumber(product.costo).toFixed(2)}</div></td><td>${_naInventoryExpiryMarkup(expiry)}</td><td><span class="stock-pill ${stockClass}">${_naEsc(stockLabel)}</span></td><td><div class="act-btns">${tracked?`<button class="btn-act btn-ent" title="Entrada de stock" aria-label="Entrada de stock" onclick="abrirMovInv(${_naEsc(id)},&quot;entrada&quot;)"><i class="na-ic na-ic-in" aria-hidden="true"></i> <span>Entrada</span></button><button class="btn-act btn-sal" title="Salida de stock" aria-label="Salida de stock" onclick="abrirMovInv(${_naEsc(id)},&quot;salida&quot;)"><i class="na-ic na-ic-out" aria-hidden="true"></i> <span>Salida</span></button>`:'<button class="btn-act" title="Sin control de inventario"><i class="na-ic na-ic-box" aria-hidden="true"></i></button>'}<button class="btn-act btn-edt" title="Editar producto" aria-label="Editar producto" onclick="editProd(${_naEsc(id)})"><i class="na-ic na-ic-pen" aria-hidden="true"></i> Editar</button></div></td></tr>`;
  });
};

// Etapa 2 perf: debounce Inventario search so each keystroke no longer re-renders the whole table.
(function(){
  if(window.__naInvSearchDebounce)return;window.__naInvSearchDebounce=true;
  let timer=0;
  document.addEventListener('input',function(event){
    const input=event.target;if(!input||input.id!=='invSearch')return;
    event.stopPropagation();clearTimeout(timer);
    const run=function(){if(typeof invRender==='function')invRender();};
    if(!input.value.trim()){run();return;}
    timer=setTimeout(run,180);
  },true);
})();
