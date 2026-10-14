/* Presentation reuses the original rows, controls and handlers at every width. */
(function(){
 const page=document.getElementById('pageInventario');if(!page)return;
 page.classList.add('inv-mobile-simple');
 const actions=page.querySelector('.ocr-purchase-actions');
 const secondary=document.createElement('details');secondary.className='inv-secondary';secondary.innerHTML='<summary>Más opciones</summary>';
 Array.from(actions.querySelectorAll('button')).slice(0,2).forEach(button=>secondary.append(button));actions.append(secondary);
 const chrome=page.querySelector('.page-chrome'),bar=page.querySelector('.filter-bar'),tabs=page.querySelector('.tabs-wrap');
 const sticky=document.createElement('div');sticky.className='inv-sticky-controls';chrome.insertBefore(sticky,bar);sticky.append(bar,tabs);
 const motive=document.getElementById('mMovMotivo'),link=document.getElementById('mMovPurchaseLink');
 function sync(){link.hidden=motive.value!=='Compra a proveedor'||!document.querySelector('#mMovInv .entrada.active');}
 motive.addEventListener('change',sync);new MutationObserver(sync).observe(document.getElementById('mMovInv'),{subtree:true,attributes:true,attributeFilter:['class']});sync();
})();
