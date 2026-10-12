
// Auditoría de seguridad: el inventario muestra datos creados por el usuario o importados.
// Se conservan las mismas reglas de negocio, pero toda salida textual y atributo HTML se codifica.
let _naInventoryRowsObserver=null;
function _naCancelInventoryRows(){if(_naInventoryRowsObserver)_naInventoryRowsObserver.disconnect();_naInventoryRowsObserver=null;}
function _naRenderInventoryRows(container,items,renderItem){
  _naCancelInventoryRows();let next=0;
  const chunk=()=>{const end=Math.min(items.length,next+24);container.insertAdjacentHTML('beforeend',items.slice(next,end).map(renderItem).join(''));next=end;};
  const renderChunk=callback=>{const withPhotos=()=>window.NuevoAmanecerImageBatch?.withSources?window.NuevoAmanecerImageBatch.withSources(callback):callback();try{return _naWithCategoryCatalog(withPhotos);}finally{if(typeof _naInventoryImageDisplay!=='undefined')_naInventoryImageDisplay.prune();}};
  container.replaceChildren();
  // Search visibility badges are applied synchronously by the existing visibility wrapper.
  if(typeof IntersectionObserver!=='function'||document.getElementById('invSearch')?.value.trim()){renderChunk(()=>{container.innerHTML=items.map(renderItem).join('');});return;}
  renderChunk(chunk);if(next===items.length)return;
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
    const days=diasHasta(product.venc);
    const tabMatches=invTab==='critico'?_naTracksStock(product)&&product.stock<=product.stockMin:invTab==='vencimiento'?days!==null&&days>=0&&days<=30:invTab==='vencidos'?days!==null&&days<0:true;
    return matches&&categoryMatches&&tabMatches;
  });
  const body=document.getElementById('invBody');if(!body)return;
  if(!list.length){body.innerHTML='<tr><td colspan="6"><div class="empty-state"><div class="ei">🔍</div><p>Sin productos</p></div></td></tr>';return;}
  _naRenderInventoryRows(body,list,product=>{
    const tracked=_naTracksStock(product),stockClass=!tracked?'ok':product.stock<=0?'out':product.stock<=product.stockMin?'low':'ok';
    const stockLabel=!tracked?'∞ Sin control':(product._canonicalPendingStock&&Number.isFinite(product._canonicalRemoteStock)?`CANON ${product._canonicalRemoteStock} (−${Number(product._canonicalPendingDelta||Math.max(0,product._canonicalRemoteStock-product.stock))} pend.)`:product.stock<0?`✕ Faltan ${Math.abs(product.stock)}`:product.stock===0?'✕ Sin stock':product.stock<=product.stockMin?`⚠ ${product.stock}`:`✓ ${product.stock}`);
    const days=diasHasta(product.venc),expiryClass=!product.venc?'na':days<0?'vencido':days<=30?'pronto':'ok',expiryLabel=!product.venc?'—':days<0?'Vencido':days===0?'Hoy':days<=30?`${days}d`:product.venc;
    const id=JSON.stringify(product.id),safeImage=typeof _naInventoryImageDisplay!=='undefined'?_naInventoryImageDisplay.source(product):_naProductImageSource(product),icon=safeImage?`<img src="${_naEsc(safeImage)}" alt="${_naEsc(product.name)}" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:cover;border-radius:8px">`:_naEsc(product.icon||'📦');
    return `<tr><td><div class="prod-info"><div class="prod-icon-sm">${icon}</div><div><div class="prod-name-sm">${_naEsc(product.name)}</div><div class="prod-sku-sm">${_naEsc(product.sku)}${product.marca&&product.marca!=='Sin marca'?` · ${_naEsc(product.marca)}`:''} · ${_naEsc(_naCategoryTitle(product.unidad||'unidad'))}</div></div></div></td><td><span class="cat-pill">${_naEsc(_naCategoryLabel(product.cat))}</span></td><td><div style="font-size:12px;font-weight:800;color:var(--teal)">S/ ${_naNumber(product.precio).toFixed(2)}</div><div style="font-size:10px;color:var(--slate)">Costo: S/ ${_naNumber(product.costo).toFixed(2)}</div></td><td><span class="venc-pill ${expiryClass}">${_naEsc(expiryLabel)}</span></td><td><span class="stock-pill ${stockClass}">${_naEsc(stockLabel)}</span></td><td><div class="act-btns">${tracked?`<button class="btn-act btn-ent" onclick="abrirMovInv(${_naEsc(id)},&quot;entrada&quot;)">📥</button><button class="btn-act btn-sal" onclick="abrirMovInv(${_naEsc(id)},&quot;salida&quot;)">📤</button>`:'<button class="btn-act" title="Sin control de inventario">∞</button>'}<button class="btn-act btn-edt" onclick="editProd(${_naEsc(id)})">✏️</button></div></td></tr>`;
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
