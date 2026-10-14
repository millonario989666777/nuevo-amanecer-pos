(function(root){
  'use strict';
  var doc=root.document,core=root.NA_STOCK_LOTS,denialMessage='';
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
      var local=!canonical()?.enabled()&&typeof root._naPinValid==='function'&&root._naGetSecurityPath('pinEnabled')&&root._naGetSecurityPath('pinHash');
      if(!root.NA_ROLES||(!remote&&!local)){notice('Antes de vender lotes vencidos, configura el PIN del administrador en Configuración › Usuarios y PIN.');return null;}
      try{
        var plan=core.plan(stock,rows,quantity,day,true);
        var title='Autorizar lotes vencidos',detail=(product.name||product.product_id)+': requiere '+plan.expired_quantity+' '+(product.unit||'unidad')+' de lotes VENCIDOS. Ingresa el PIN para autorizar esta venta.';
        var consent=remote?remote.approve('expired_lot_sale',null,title,detail).then(function(id){return id?{approval_id:id}:null;}):root.NA_ROLES.askPin(title,detail,function(pin){return root._naPinValid(pin)?{ok:true,value:true}:{msg:'PIN incorrecto.'};});
        return consent.catch(function(){notice('No se pudo autorizar la venta de lotes vencidos.');return null;});
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
  function install(){
    installMovement();
  }
  root.NA_STOCK_LOTS_UI=Object.freeze({get denialMessage(){return denialMessage;},readMovementLots:readMovementLots,confirmConsumption:confirmConsumption,currentProducts:currentProducts});
  if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',install);else install();
})(window);
