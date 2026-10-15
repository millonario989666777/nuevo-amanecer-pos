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
 // Cerrar un formulario (producto, entrada/salida) conserva la posición de la lista.
 let savedY=null,lastY=window.scrollY||0;
 window.addEventListener('scroll',()=>{if(!document.querySelector('#mProd.open,#mMovInv.open'))lastY=window.scrollY||0;},{passive:true});
 function trackForm(id){const modal=document.getElementById(id);if(!modal)return;let wasOpen=modal.classList.contains('open');
  new MutationObserver(()=>{const open=modal.classList.contains('open');if(open===wasOpen)return;wasOpen=open;
   if(open){if(savedY===null&&page.classList.contains('active'))savedY=lastY;return;}
   if(document.querySelector('#mProd.open,#mMovInv.open'))return;
   const y=savedY;savedY=null;if(y===null||!page.classList.contains('active'))return;
   const restore=()=>{if(Math.abs((window.scrollY||0)-y)>1)window.scrollTo(0,y);};restore();requestAnimationFrame(()=>{restore();requestAnimationFrame(restore);});setTimeout(restore,80);
  }).observe(modal,{attributes:true,attributeFilter:['class']});}
 trackForm('mProd');trackForm('mMovInv');
})();
