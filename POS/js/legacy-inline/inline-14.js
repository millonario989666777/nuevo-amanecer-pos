
// Seguridad: tarjetas y carrito del POS usan data-* y fuentes de imagen validadas por un resolver único.
function _naSecProductVisibleInPos(product){
  return !_naTracksStock(product)||_naNumber(product.stock)>0;
}
function _naSecRenderProductImage(visual,product,safeImage,size){
  if(!safeImage){visual.textContent=product?.icon||'📦';return;}
  const image=document.createElement('img');
  image.src=safeImage;
  image.alt=String(product?.name||'Producto');
  if(size)image.style.cssText=`width:${size}px;height:${size}px;object-fit:cover;border-radius:6px`;
  image.addEventListener('error',()=>{
    image.remove();
    visual.textContent=product?.icon||'📦';
  },{once:true});
  visual.appendChild(image);
}
function _naSecProductCard(parent,product,allowNoStock){
  const box=modoMayorista&&!_naCanonSaleMode()&&product.precioCaja>0&&product.unidCaja>0,price=box?product.precioCaja:product.precio,label=box?`Caja x${product.unidCaja} · S/ ${_naNumber(price).toFixed(2)}`:`S/ ${_naNumber(price).toFixed(2)}`;
  const tracked=_naTracksStock(product),hasStock=!tracked||product.stock>0,available=hasStock||allowNoStock,stockTone=!tracked?'ok':product.stock<=0?'out':product.stock<=product.stockMin?'low':'ok';
  const stockLabel=!tracked?'Sin control':(product._canonicalPendingStock&&Number.isFinite(product._canonicalRemoteStock)?`CANON ${product._canonicalRemoteStock} (−${Number(product._canonicalPendingDelta||Math.max(0,product._canonicalRemoteStock-product.stock))} pend.)`:product.stock<0?`Faltante: ${Math.abs(product.stock)}`:product.stock===0?(allowNoStock?'Sin stock · permitido':'Sin stock'):`Stock: ${product.stock}`);
  const card=_naSecAppend(parent,'div',`product-card${!hasStock?' no-stock':''}${!hasStock&&allowNoStock?' sale-allowed':''}${box?' box-mode':''}`);
  card.setAttribute('role','button');
  card.tabIndex=available?0:-1;
  card.setAttribute('aria-disabled',available?'false':'true');
  if(available)card.dataset.productId=String(product.id);
  _naSecAppend(card,'div','p-price-badge',label);
  const visual=_naSecAppend(card,'div','p-img'),safeImage=_naProductImageSource(product);
  _naSecRenderProductImage(visual,product,safeImage);
  _naSecAppend(card,'div',`p-stock-badge ${stockTone}`,stockLabel);
  _naSecAppend(card,'div','p-name',product.name||'Producto');
}
posRender=function(){
  const search=sinTildes((document.getElementById('posSearch')?.value||'').toLowerCase()),rows=productos.filter(product=>_naSecProductVisibleInPos(product)&&(posCat==='todo'||product.cat===posCat)&&(sinTildes((product.name||'').toLowerCase()).includes(search)||sinTildes(String(product.descripcion||'').toLowerCase()).includes(search)||sinTildes((product.marca||'').toLowerCase()).includes(search)||(product.sku||'').toLowerCase().includes(search)||String(product.barcode||'').toLowerCase().includes(search)||_naProductAltCodes(product).some(code=>code.toLowerCase().includes(search))));
  const area=document.getElementById('posArea');
  if(!area)return;
  area.replaceChildren();
  if(!rows.length){
    const empty=_naSecAppend(area,'div','empty-state');
    empty.style.gridColumn='1/-1';
    _naSecAppend(empty,'div','ei','🔍');
    _naSecAppend(empty,'p','','Sin productos');
    return;
  }
  const allowNoStock=_naAllowNoStockSale();
  rows.forEach(product=>_naSecProductCard(area,product,allowNoStock));
};
function _naSecCartButton(text,action,key){
  const button=_naSecElement('button',action==='remove'?'btn-rm':'qty-btn',text);
  button.type='button';
  button.dataset.naCartAction=action;
  button.dataset.lineKey=String(key);
  return button;
}
function _naSecCartItem(parent,item){
  const box=_naUnitsPerQty(item)>1,row=_naSecAppend(parent,'div','cart-item'),visual=_naSecAppend(row,'div');
  visual.style.fontSize='19px';
  const safeImage=_naProductImageSource(item);
  _naSecRenderProductImage(visual,item,safeImage,30);
  const info=_naSecAppend(row,'div','ci-info'),name=_naSecAppend(info,'div','ci-name',item.name||'Producto');
  if(_naNumber(item._descuento)>0){
    const discount=_naSecAppend(name,'span','',`-${_naNumber(item._descuento).toFixed(1)}%`);
    discount.style.cssText='font-size:10px;color:var(--amber);margin-left:4px';
  }
  if(item.ventaLibre)_naSecAppend(name,'span','cart-item-flag free','VARIOS');
  else if(item.ventaSinStock)_naSecAppend(name,'span','cart-item-flag shortage','SIN STOCK');
  const price=_naSecAppend(info,'div','ci-price',`${fmt(item.precio)} ${box?'por caja':'c/u'} `);
  if(box)_naSecAppend(price,'span','line-mode',`Caja x${_naUnitsPerQty(item)}`);
  const quantity=_naSecAppend(row,'div','ci-qty');
  quantity.appendChild(_naSecCartButton('−','decrease',item._lineKey));
  _naSecAppend(quantity,'span','qty-num',item.qty);
  quantity.appendChild(_naSecCartButton('+','increase',item._lineKey));
  _naSecAppend(row,'div','ci-sub',fmt(_naNumber(item.precio)*_naNumber(item.qty)));
  row.appendChild(_naSecCartButton('🗑','remove',item._lineKey));
}
posUpdateCart=function(){
  const parts=_naTaxBreakdownForSaleItems(cart,!!appConfig.igvActive),count=cart.reduce((sum,item)=>sum+_naNumber(item.qty),0),units=cart.reduce((sum,item)=>sum+_naUnitsSold(item),0),badge=document.getElementById('cartBadge');
  if(badge){badge.style.display=count>0?'flex':'none';badge.textContent=String(count);badge.title=`${units} unidades físicas`;}
  [['posSubtotal',fmt(parts.subtotal)],['posIgv',fmt(parts.totalIGV)],['posTotal',fmt(parts.totalVenta)]].forEach(([id,value])=>{const element=document.getElementById(id);if(element)element.textContent=value;});
  const quick=document.getElementById('btnRapido'),pay=document.getElementById('btnPagar');
  if(quick)quick.disabled=!cart.length;
  if(pay)pay.disabled=!cart.length;
  const discountBadge=document.getElementById('btnDescInfo'),discounts=cart.map(item=>_naNumber(item._descuento)).filter(value=>value>0);
  if(discountBadge){discountBadge.style.display=discounts.length?'block':'none';if(discounts.length)discountBadge.textContent='🏷️ Descuento activo — toca aquí para quitar';}
  const items=document.getElementById('cartItems');
  if(items){
    items.replaceChildren();
    if(!cart.length)_naSecAppend(items,'div','cart-empty','El carrito está vacío');
    else cart.forEach(item=>_naSecCartItem(items,item));
  }
  saveAllData();
};
document.getElementById('posArea')?.addEventListener('click',event=>{
  const card=event.target.closest('[data-product-id]');
  if(card)posAdd(card.dataset.productId);
});
document.getElementById('posArea')?.addEventListener('keydown',event=>{
  const card=event.target.closest('[data-product-id]');
  if(card&&(event.key==='Enter'||event.key===' ')){event.preventDefault();posAdd(card.dataset.productId);}
});
document.getElementById('cartItems')?.addEventListener('click',event=>{
  const button=event.target.closest('[data-na-cart-action]');
  if(!button)return;
  const action=button.dataset.naCartAction,key=button.dataset.lineKey;
  if(action==='remove')posRm(key);
  else posQty(key,action==='increase'?1:-1);
});
