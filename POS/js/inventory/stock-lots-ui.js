(function(root){
  'use strict';
  var doc=root.document,core=root.NA_STOCK_LOTS,filter=30,dialog=null,confirmOpen=false,denialMessage='';
  if(!doc||!core)return;
  function el(tag,text,cls){var n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
  function button(text,fn){var b=el('button',text);b.type='button';b.onclick=fn;return b;}
  function canonical(){return root.NuevoAmanecerCanonical;}
  function currentProducts(){
    var api=canonical(),base;
    try{if(!api||typeof api.enabled!=='function'||!api.enabled()||typeof api.snapshot!=='function')return[];base=api.snapshot()||{};}catch(_){return[];}
    var outbox=root.NuevoAmanecerCanonicalSaleOutbox,projector=root.NuevoAmanecerCanonicalSaleProjection;
    // The sale view also retains ACK receipts until the remote read catches up
    // (including already_processed after a lost ACK). Share that complete projection.
    var view=root.NuevoAmanecerCanonicalSaleView,projected;
    try{
      projected=view&&typeof view.rebuild==='function'?view.rebuild():null;
      if(projected&&Array.isArray(projected.products))return projected.products.map(function(p){if(p.projected_stock!==undefined)p.current_stock_quantity=p.projected_stock;return p;});
    }catch(_){}
    try{
      if(outbox&&typeof outbox.snapshot==='function'&&projector&&typeof projector.project==='function'){
        projected=projector.project(base,outbox.snapshot());
        if(projected&&Array.isArray(projected.products))return projected.products.map(function(p){if(p.projected_stock!==undefined)p.current_stock_quantity=p.projected_stock;return p;});
      }
    }catch(_){}
    return Array.isArray(base.products)?base.products:[];
  }
  function notice(message){denialMessage=message;try{if(typeof root.toast==='function')root.toast(message,'error');}catch(_){}}
  function trap(wrap,box,close){
    wrap.addEventListener('keydown',function(e){
      if(e.key==='Escape'){e.preventDefault();close();return;}
      if(e.key==='Tab'){
        var controls=box.querySelectorAll('input:not(:disabled),button:not(:disabled),select'),first=controls[0],last=controls[controls.length-1];
        if(e.shiftKey&&doc.activeElement===first){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&doc.activeElement===last){e.preventDefault();first.focus();}
      }
    });
  }
  function expiredModal(message,remote){
    if(confirmOpen)return null;
    confirmOpen=true;
    return new Promise(function(resolve){
      var source=doc.activeElement,wrap=el('div',undefined,'na-lots-overlay'),box=el('section',undefined,'na-lots-dialog'),settled=false;
      box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby','naLotConfirmTitle');box.setAttribute('aria-describedby','naLotConfirmDetail');
      var title=el('h2','Autorizar lotes vencidos');title.id='naLotConfirmTitle';box.appendChild(title);
      var detail=el('p',message);detail.id='naLotConfirmDetail';box.appendChild(detail);
      var label=el('label','PIN del administrador'),pin=el('input');pin.type='password';pin.inputMode='numeric';pin.maxLength=8;pin.autocomplete='off';label.appendChild(pin);box.appendChild(label);
      var error=el('p');error.setAttribute('role','alert');box.appendChild(error);
      function close(value){if(settled)return;settled=true;pin.value='';wrap.remove();confirmOpen=false;if(source&&source.focus)source.focus();resolve(value===true?true:null);}
      var actions=el('div',undefined,'na-lot-report-controls'),cancel=button('Cancelar',function(){close(null);}),checking=false;
      var allow=button('Autorizar venta',async function(){
        if(checking||settled)return;
        var value=pin.value.trim();if(!/^\d{4,8}$/.test(value)){error.textContent='El PIN debe tener de 4 a 8 dígitos.';return;}
        checking=true;allow.disabled=true;
        try{
          if(remote){
            // Reuse the existing unbound commercial PIN approval; never persist the PIN.
            var approval=await remote.api('/auth/owner-approval',{pin:value,action:'discount'});
            if(!approval||!approval.approval_id)throw new Error('No se pudo validar el PIN.');
          }else if(!root._naPinValid(value))throw new Error('PIN incorrecto.');
          close(true);
        }catch(e){error.textContent=remote&&typeof remote.message==='function'?remote.message(e):e.message;pin.value='';if(!settled)pin.focus();}
        finally{checking=false;allow.disabled=false;}
      });
      actions.appendChild(cancel);actions.appendChild(allow);box.appendChild(actions);wrap.appendChild(box);doc.body.appendChild(wrap);
      trap(wrap,box,function(){close(null);});wrap.addEventListener('click',function(e){if(e.target===wrap)close(null);});cancel.focus();
    }).catch(function(){confirmOpen=false;notice('No se pudo autorizar la venta de lotes vencidos.');return null;});
  }
  function confirmConsumption(product,quantity,timestamp){
    denialMessage='';
    var rows,stock,day;
    try{
      rows=core.lots(product);if(!rows.length)return false;
      stock=product.projected_stock!==undefined?product.projected_stock:product.current_stock_quantity;
      day=core.businessDate(timestamp);core.plan(stock,rows,quantity,day);return false;
    }catch(error){
      // Other prevalidation errors still reach the authoritative server.
      if(!error||error.message!=='EXPIRED_LOTS_CONFIRMATION_REQUIRED')return false;
      if(typeof root._naGetSecurityPath!=='function'||root._naGetSecurityPath('rules.allowExpiredLots')!==true){
        notice('Venta bloqueada: hay lotes vencidos. Revisa Configuración › Permitir vender lotes vencidos.');return null;
      }
      var remote=root.NA_ROLES&&root.NA_ROLES.pinSet?root.NA_ROLES:null;
      var local=typeof root._naPinValid==='function'&&root._naGetSecurityPath('pinEnabled')&&root._naGetSecurityPath('pinHash');
      if(!remote&&!local){notice('Antes de vender lotes vencidos, configura el PIN del administrador en Configuración › Usuarios y PIN.');return null;}
      try{
        var plan=core.plan(stock,rows,quantity,day,true);
        return expiredModal((product.name||product.product_id)+': requiere '+plan.expired_quantity+' '+(product.unit||'unidad')+' de lotes VENCIDOS. Ingresa el PIN para autorizar esta venta.',remote);
      }catch(_){notice('No se pudo autorizar la venta de lotes vencidos.');return null;}
    }
  }
  function labeledInput(row,label,type,cls){
    var wrap=el('label',label),input=el('input');input.type=type;input.className=cls;
    if(type==='number'){input.min='0';input.step='any';input.inputMode='decimal';}else if(type==='text')input.maxLength=120;
    wrap.appendChild(input);row.appendChild(wrap);return input;
  }
  function addReceiptRow(list){
    var row=el('div',undefined,'na-lot-input-row');
    labeledInput(row,'Código de lote','text','na-lot-code');labeledInput(row,'Vencimiento','date','na-lot-expiry');labeledInput(row,'Cantidad física','number','na-lot-qty');
    var remove=button('Quitar',function(){row.remove();});remove.setAttribute('aria-label','Quitar lote');row.appendChild(remove);list.appendChild(row);
  }
  function readMovementLots(product){
    var enabled=doc.getElementById('naMovementLotsEnabled');if(!enabled||!enabled.checked)return undefined;
    var list=doc.getElementById('naMovementLotsRows'),rows=[];
    Array.prototype.forEach.call(list.querySelectorAll('.na-lot-input-row'),function(row){
      rows.push({lot_code:row.querySelector('.na-lot-code').value,expiry_date:row.querySelector('.na-lot-expiry').value,quantity:Number(row.querySelector('.na-lot-qty').value)});
    });
    if(!rows.length)throw new Error('Agrega al menos un lote');
    try{return core.validateReceiptEntry(product,rows,Number(String(doc.getElementById('mMovCant').value).replace(',','.')));}
    catch(e){throw new Error(e.message==='EXPIRED_LOT_RECEIPT'?'No puedes ingresar un lote con vencimiento pasado.':e.message==='DUPLICATE_LOT_CODE'?'El código de lote ya existe para este producto.':e.message);}
  }
  function movementType(type,reset){
    var group=doc.getElementById('naMovementLots');if(!group)return;
    group.hidden=type!=='entrada'||!canonical()?.enabled();
    if(reset){doc.getElementById('naMovementLotsEnabled').checked=false;doc.getElementById('naMovementLotsEditor').hidden=true;doc.getElementById('naMovementLotsRows').replaceChildren();}
  }
  function installMovement(){
    var body=doc.querySelector('#mMovInv .mbody');if(!body||doc.getElementById('naMovementLots'))return;
    var group=el('fieldset',undefined,'na-lots-receipt');group.id='naMovementLots';group.hidden=true;
    group.appendChild(el('legend','Lotes (opcional)'));
    var label=el('label','Indicar lotes de este ingreso'),check=el('input');check.type='checkbox';check.id='naMovementLotsEnabled';label.prepend(check);group.appendChild(label);
    var editor=el('div');editor.id='naMovementLotsEditor';editor.hidden=true;
    var list=el('div');list.id='naMovementLotsRows';editor.appendChild(list);
    editor.appendChild(button('+ Agregar lote',function(){addReceiptRow(list);}));
    editor.appendChild(el('p','La cantidad de lotes puede ser menor al ingreso; el resto queda sin lote. Usa la misma unidad física que Cantidad.'));
    group.appendChild(editor);check.onchange=function(){editor.hidden=!check.checked;if(check.checked&&!list.children.length)addReceiptRow(list);};
    var actions=body.querySelector('.mbtns');body.insertBefore(group,actions);
    var open=root.abrirMovInv,set=root.setMovType;
    if(typeof open==='function')root.abrirMovInv=function(id,type){var out=open.apply(this,arguments);movementType(type,true);return out;};
    if(typeof set==='function')root.setMovType=function(btn,type){var out=set.apply(this,arguments);movementType(type,true);return out;};
  }
  function renderReport(){
    if(!dialog)return;
    var list=dialog.querySelector('.na-lot-report-list');list.replaceChildren();
    var products=currentProducts(),rows=core.report(products,filter),day=core.businessDate();
    products.forEach(function(p){
      var stock=Number(p.projected_stock!==undefined?p.projected_stock:p.current_stock_quantity),quantity;
      try{quantity=core.round(stock-core.lots(p).reduce(function(sum,r){return sum+Number(r.quantity);},0));}catch(_){return;}
      if(quantity>0)rows.push({product_id:p.product_id,name:p.name||p.product_id,lot_code:'Sin lote',expiry_date:null,quantity:quantity,unit:p.unit||'unidad',days:null});
    });
    dialog.querySelector('.na-lot-report-date').textContent='Fecha de consulta: '+core.displayDate(day)+' · '+new Set(rows.map(function(r){return r.product_id;})).size+' producto(s) · '+rows.filter(function(r){return r.expiry_date;}).length+' lote(s)';
    if(!rows.length){list.appendChild(el('p','No hay lotes con saldo en este filtro.'));return;}
    rows.forEach(function(row){
      var card=el('article',undefined,'na-lot-report-row');card.appendChild(el('strong',row.name));
      card.appendChild(el('span','Lote: '+row.lot_code));card.appendChild(el('span',row.expiry_date?'Vence: '+core.displayDate(row.expiry_date):'sin vencimiento registrado'));
      card.appendChild(el('span','Saldo: '+row.quantity+' '+row.unit));card.appendChild(el('span',row.days===null?'Sin fecha':row.days<0?'Vencido hace '+(-row.days)+(-row.days===1?' día':' días'):row.days===0?'Vence hoy':'En '+row.days+(row.days===1?' día':' días')));list.appendChild(card);
    });
  }
  function openReport(){
    if(dialog){dialog.querySelector('select').focus();return;}
    var wrap=el('div',undefined,'na-lots-overlay'),box=el('section',undefined,'na-lots-dialog');
    box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby','naLotReportTitle');
    var title=el('h2','Productos a vencer');title.id='naLotReportTitle';box.appendChild(title);
    var controls=el('div',undefined,'na-lot-report-controls'),label=el('label','Filtrar por vencimiento'),select=el('select');
    [[30,'Próximos 30 días'],[60,'Próximos 60 días'],[90,'Próximos 90 días'],['expired','Vencidos']].forEach(function(o){var option=el('option',o[1]);option.value=String(o[0]);select.appendChild(option);});
    select.value=String(filter);select.onchange=function(){filter=select.value==='expired'?'expired':Number(select.value);renderReport();};label.appendChild(select);controls.appendChild(label);
    var source=doc.activeElement;
    function close(){wrap.remove();dialog=null;if(source&&source.focus)source.focus();}
    controls.appendChild(button('Cerrar',close));box.appendChild(controls);
    box.appendChild(el('p',undefined,'na-lot-report-date'));var list=el('div',undefined,'na-lot-report-list');list.setAttribute('aria-live','polite');box.appendChild(list);
    box.appendChild(el('p','Incluye lotes con saldo. El contador agrupa productos vencidos o a vencer en 30 días. El stock sin lote se muestra sin vencimiento registrado en todos los filtros.'));
    wrap.appendChild(box);doc.body.appendChild(wrap);dialog=box;
    wrap.addEventListener('click',function(e){if(e.target===wrap)close();});
    trap(wrap,box,close);
    renderReport();select.focus();
  }
  function update(){
    var api=canonical(),active=api&&api.enabled();
    var products=active?currentProducts():[],rows=core.report(products,30).concat(core.report(products,'expired'));
    var count=new Set(rows.map(function(r){return r.product_id;})).size;
    Array.prototype.forEach.call(doc.querySelectorAll('.na-lot-report-button'),function(b){b.hidden=!active;b.textContent='Productos a vencer ('+count+')';b.setAttribute('aria-label','Productos vencidos o a vencer en 30 días: '+count);});
    if(dialog)renderReport();
  }
  function install(){
    installMovement();
    ['#pageInventario .ocr-purchase-actions','#ventasReportControls','#pageMenu .menu-desktop-sidebar','.na-mobile-drawer-nav'].forEach(function(selector){var host=doc.querySelector(selector);if(host&&!host.querySelector('.na-lot-report-button')){var b=button('Productos a vencer (0)',openReport);b.className='top-btn-nuevo na-lot-report-button';if(selector==='.na-mobile-drawer-nav')b.onclick=function(){if(root.NA_MENU_NAVIGATION)root.NA_MENU_NAVIGATION.closeMobileDrawer();openReport();};host.appendChild(b);}});
    update();
  }
  root.NA_STOCK_LOTS_UI=Object.freeze({get denialMessage(){return denialMessage;},openReport:openReport,readMovementLots:readMovementLots,confirmConsumption:confirmConsumption,currentProducts:currentProducts,update:update});
  ['na:canonical-updated','na:canonical-sale-projection'].forEach(function(name){root.addEventListener(name,function(){try{update();}catch(_){}});});
  root.addEventListener('resize',install);
  root.addEventListener('focus',function(){try{update();}catch(_){}});
  doc.addEventListener('visibilitychange',function(){if(!doc.hidden)update();});
  if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',install);else install();
})(window);
