(function(root){
  'use strict';

  if(!root||!root.document)return;
  var busy=false;

  function api(){return root.NuevoAmanecerCanonical;}
  function enabled(){
    var client=api();
    try{return !!(client&&typeof client.enabled==='function'&&client.enabled());}catch(_){return false;}
  }
  function clean(value){return String(value==null?'':value).trim().replace(/\s+/g,' ');}
  function notify(message,tone){
    var fn=null;try{if(typeof toast==='function')fn=toast;}catch(_){}
    if(!fn&&typeof root.toast==='function')fn=root.toast;
    if(typeof fn==='function')fn(message,tone||'error');
  }
  function closeModal(){
    var fn=null;try{if(typeof cerrarModal==='function')fn=cerrarModal;}catch(_){}
    if(!fn&&typeof root.cerrarModal==='function')fn=root.cerrarModal;
    if(typeof fn==='function')fn('mMovInv');
    else root.document.getElementById('mMovInv')?.classList.remove('open');
  }
  function renderViews(){
    ['invRender','posRender','updateDashboard'].forEach(function(name){
      var fn=root[name];if(typeof fn==='function')fn.call(root);
    });
  }
  function movementContext(){
    var productId=null,type=null;
    try{if(typeof invMovId!=='undefined'&&invMovId!=null)productId=String(invMovId);}catch(_){}
    try{if(typeof invMovT!=='undefined'&&invMovT!=null)type=String(invMovT);}catch(_){}
    return{productId:clean(productId),type:clean(type).toLowerCase()};
  }
  function userLocked(){
    try{if(typeof securityIsLocked==='function'&&securityIsLocked())return true;}catch(_){}
    try{
      if(typeof storage!=='undefined'&&typeof LOCK_KEYS!=='undefined'&&storage&&LOCK_KEYS){
        if(storage.getItem(LOCK_KEYS.master)==='true'||storage.getItem(LOCK_KEYS.readOnly)==='true')return true;
        var key=LOCK_KEYS.modules&&LOCK_KEYS.modules.productos;
        if(key&&storage.getItem(key)==='true')return true;
      }
    }catch(_){}
    return false;
  }
  function pendingRecord(){
    var client=api();
    if(!client||typeof client.pendingSnapshot!=='function')return null;
    try{return client.pendingSnapshot();}catch(_){return{command:'unknown',invalid:true};}
  }
  async function refreshCanonical(){
    var client=api();
    if(!client||typeof client.refresh!=='function')throw new Error('CANONICAL_CLIENT_UNAVAILABLE');
    return client.refresh();
  }
  // P2-2: weight/volume products can move fractional quantities (2.5 kg, 0.75 l).
  var FRACTIONAL_UNITS=/^(kilogramos?|kilos?|kgs?|gramos?|grs?|g|litros?|lts?|l|mililitros?|ml|metros?|m)$/i;
  function snapshotProduct(productId){
    var client=api();
    try{
      var snap=client&&typeof client.snapshot==='function'?client.snapshot():null;
      var list=snap&&Array.isArray(snap.products)?snap.products:[];
      for(var i=0;i<list.length;i++)if(String(list[i].product_id)===String(productId))return list[i];
    }catch(_){}
    return null;
  }
  function allowsFraction(product){return !!product&&FRACTIONAL_UNITS.test(clean(product.unit));}
  function validQuantity(quantity,product){
    if(typeof quantity!=='number'||!Number.isFinite(quantity)||quantity<=0||quantity>1e9)return false;
    if(Number.isSafeInteger(quantity))return true;
    return allowsFraction(product)&&Math.abs(Math.round(quantity*1000)-quantity*1000)<1e-6;
  }
  function quantityText(quantity){return String(Math.round(quantity*1000)/1000);}
  function selectedReason(){
    var select=root.document.getElementById('mMovMotivo');
    var value=clean(select&&select.value);
    return value.slice(0,120);
  }
  function pendingMessage(error){
    var pending=pendingRecord(),code=clean(error&&error.message);
    if(code==='INSUFFICIENT_PROJECTED_STOCK')return 'No se registró la salida: parte de ese stock ya está vendido en ventas que aún se están enviando a CANON. Espera a que se sincronicen o registra una cantidad menor.';
    if(code==='INSUFFICIENT_CANONICAL_STOCK')return 'No se registró la salida: no hay suficiente stock en CANON.';
    if(pending&&pending.command==='inventory.adjust'&&!pending.invalid){
      if(pending.last_error)return 'CANON rechazó el movimiento ('+clean(pending.last_error)+'). No se modificó el stock.';
      return 'El movimiento se envió pero CANON no confirmó la recepción ('+code+'). Pulsa Guardar nuevamente para reintentar la MISMA operación.';
    }
    return 'No se registró el movimiento CANON'+(code?': '+code:'');
  }
  async function afterCommit(receipt,replayed){
    closeModal();
    var operation=clean(receipt&&receipt.operation_id);
    try{
      await refreshCanonical();
      renderViews();
      var label=receipt&&receipt.movement_type==='ENTRADA'?'📥 Entrada':'📤 Salida';
      notify((replayed?'Se confirmó el movimiento CANON pendiente. ':label+' registrada. ')+
        'Stock: '+String(receipt&&receipt.stock_after!=null?receipt.stock_after:'—'),'success');
    }catch(error){
      notify('Movimiento CONFIRMADO en CANON (operación '+operation+'). No se pudo actualizar la vista: '+
        clean(error&&error.message)+'. NO vuelvas a guardarlo; recarga la pantalla.','success');
    }
    return true;
  }

  async function save(){
    if(!enabled()||busy)return false;
    if(userLocked()){notify('Módulo de productos bloqueado','error');return false;}

    var ctx=movementContext();
    var rawQuantity=clean(root.document.getElementById('mMovCant')?.value).replace(',','.');
    var quantity=rawQuantity===''?NaN:Number(rawQuantity);
    if(!ctx.productId||!['entrada','salida'].includes(ctx.type)){notify('No se encontró el movimiento de inventario','error');return false;}
    var target=snapshotProduct(ctx.productId);
    if(!validQuantity(quantity,target)){
      notify(Number.isFinite(quantity)&&quantity>0&&!Number.isSafeInteger(quantity)&&!allowsFraction(target)
        ?'Este producto se mueve en unidades enteras. Para decimales (ej. 2.5) el producto debe venderse por kilogramo, gramo o litro.'
        :'Ingresa una cantidad válida (hasta 3 decimales en productos por peso o volumen)','error');
      return false;
    }

    var client=api(),pending=pendingRecord();
    if(pending){
      if(pending.command!=='inventory.adjust'||pending.invalid){
        notify('Hay otra operación CANON pendiente ('+clean(pending.command)+'). Resuélvela antes de mover inventario.','error');
        return false;
      }
      if(pending.last_error&&typeof client.discardRejectedInventory==='function'){
        try{
          if(await client.discardRejectedInventory()){
            notify('El movimiento anterior fue rechazado por CANON ('+clean(pending.last_error)+'). No se modificó el stock; corrige los datos y vuelve a intentar.','error');
            return false;
          }
        }catch(_){}
      }
    }

    var button=root.document.querySelector('#mMovInv .mbtn-ok, #mMovInv .mbtn-primary');
    var label=button?.textContent||'Guardar movimiento';
    busy=true;if(button){button.disabled=true;button.textContent='Procesando…';}
    try{
      if(pending){
        var replay;
        try{replay=await client.retryPending();}catch(error){notify(pendingMessage(error),'error');return false;}
        return await afterCommit(replay,true);
      }

      try{await refreshCanonical();}
      catch(error){notify('No se registró el movimiento: CANON no disponible ('+clean(error&&error.message)+')','error');return false;}

      if(!client||typeof client.adjustInventory!=='function'){notify('No se registró el movimiento: CANONICAL_INVENTORY_UNAVAILABLE','error');return false;}

      var movementType=ctx.type==='entrada'?'ENTRADA':'SALIDA';
      var receipt;
      try{
        receipt=await client.adjustInventory({
          product_id:ctx.productId,
          movement_type:movementType,
          quantity:quantity,
          reason:(selectedReason()||(movementType==='ENTRADA'?'Entrada de inventario':'Salida de inventario'))+
            ': '+(movementType==='ENTRADA'?'+':'-')+quantityText(quantity)
        });
      }catch(error){
        var pendingAfter=pendingRecord();
        if(pendingAfter&&pendingAfter.command==='inventory.adjust'&&pendingAfter.last_error&&typeof client.discardRejectedInventory==='function'){
          try{
            if(await client.discardRejectedInventory()){
              notify('CANON rechazó el movimiento ('+clean(pendingAfter.last_error)+'). No se modificó el stock; puedes corregirlo y volver a intentar.','error');
              return false;
            }
          }catch(_){}
        }
        notify(pendingMessage(error),'error');return false;
      }
      return await afterCommit(receipt,false);
    }finally{
      busy=false;if(button){button.disabled=false;button.textContent=label;}
    }
  }

  // P0-2: OCR purchase in CANON. Every confirmed row becomes one inventory.adjust
  // ENTRADA with a deterministic operation_id (<OCR operation>:<source line>), so
  // re-applying the same document (double tap, lost ACK, partial failure) never
  // adds stock twice: committed lines are skipped from the CANON ledger and a
  // pending line is replayed with the same operation_id.
  var SAFE_OPERATION=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
  function purchaseError(code,message,extra){return Object.assign({code:code,message:message},extra||{});}
  function committedOperations(){
    var client=api(),seen=Object.create(null);
    try{
      var snap=client&&typeof client.snapshot==='function'?client.snapshot():null;
      (snap&&Array.isArray(snap.inventoryMovements)?snap.inventoryMovements:[]).forEach(function(row){
        if(row&&row.operation_id!=null)seen[String(row.operation_id)]=true;
      });
    }catch(_){}
    return seen;
  }
  async function applyPurchase(proposals,options){
    var settings=options||{},operation=clean(settings.operationId);
    var applied=[],skipped=[],errors=[];
    function result(){return{ok:errors.length===0,canonical:true,applied:applied,skipped:skipped,errors:errors};}
    if(!enabled()){errors.push(purchaseError('CANONICAL_DISABLED','CANON no está activo.'));return result();}
    if(busy){errors.push(purchaseError('APPLY_BUSY','Ya hay un movimiento de inventario en proceso.'));return result();}
    if(userLocked()){errors.push(purchaseError('MODULE_LOCKED','Módulo de productos bloqueado'));return result();}
    if(!SAFE_OPERATION.test(operation+':0')){errors.push(purchaseError('INVALID_OPERATION','La compra no tiene un identificador válido; vuelve a leer el documento.'));return result();}
    var client=api();
    if(!client||typeof client.adjustInventory!=='function'){errors.push(purchaseError('CANONICAL_INVENTORY_UNAVAILABLE','No se registró la compra: CANONICAL_INVENTORY_UNAVAILABLE'));return result();}

    var rows=[],seenLines=Object.create(null);
    (Array.isArray(proposals)?proposals:[]).forEach(function(proposal,index){
      if(!proposal||proposal.decision!=='CONFIRMED')return;
      var sourceIndex=proposal.sourceIndex!==undefined&&proposal.sourceIndex!==null?proposal.sourceIndex:index;
      var line=String(sourceIndex);
      if(seenLines[line]){skipped.push({sourceIndex:sourceIndex,productId:proposal.productId==null?null:String(proposal.productId),reason:'DUPLICATE_IN_BATCH'});return;}
      seenLines[line]=true;
      rows.push({sourceIndex:sourceIndex,productId:proposal.productId==null?'':String(proposal.productId),
        quantity:typeof proposal.quantity==='number'?proposal.quantity:Number(proposal.quantity),
        operationId:operation+':'+line});
    });
    if(!rows.length){errors.push(purchaseError('NO_CONFIRMED_ROWS','No hay filas confirmadas para aplicar.'));return result();}

    busy=true;
    try{
      var pending=pendingRecord();
      if(pending){
        var pendingOperation=clean(pending.payload&&pending.payload.operation_id);
        var ours=pending.command==='inventory.adjust'&&!pending.invalid&&pendingOperation.indexOf(operation+':')===0;
        if(!ours){
          errors.push(purchaseError('CANONICAL_PENDING','Hay otra operación CANON pendiente ('+clean(pending.command)+'). Resuélvela antes de aplicar la compra; no se aplicó ninguna fila.'));
          return result();
        }
        if(pending.last_error&&typeof client.discardRejectedInventory==='function'){
          try{await client.discardRejectedInventory();}catch(_){}
        }
        if(pendingRecord()){
          try{await client.retryPending();}
          catch(error){
            errors.push(purchaseError('CANONICAL_PENDING_RETRY',pendingMessage(error)+' No se aplicaron más filas; pulsa «Aplicar compra» de nuevo (no se duplicará).'));
            return result();
          }
        }
      }

      try{await refreshCanonical();}
      catch(error){errors.push(purchaseError('CANONICAL_UNAVAILABLE','No se aplicó la compra: CANON no disponible ('+clean(error&&error.message)+'). No se modificó el inventario.'));return result();}

      // Validate every row against the CANON snapshot before sending anything.
      var invalid=[];
      rows.forEach(function(row){
        var product=snapshotProduct(row.productId);
        if(!product)invalid.push('línea '+row.sourceIndex+': producto no encontrado en CANON');
        else if(Number(product.tracks_inventory)!==1)invalid.push('línea '+row.sourceIndex+': «'+clean(product.name)+'» no controla inventario');
        else if(!validQuantity(row.quantity,product))invalid.push('línea '+row.sourceIndex+': cantidad inválida para «'+clean(product.name)+'»'+(allowsFraction(product)?'':' (solo unidades enteras)'));
      });
      if(invalid.length){
        errors.push(purchaseError('INVALID_PURCHASE_ROWS','No se aplicó la compra. Corrige: '+invalid.join('; ')+'.'));
        return result();
      }

      for(var i=0;i<rows.length;i++){
        var row=rows[i];
        if(committedOperations()[row.operationId]){
          skipped.push({sourceIndex:row.sourceIndex,productId:row.productId,reason:'ALREADY_APPLIED',referenceId:row.operationId});
          continue;
        }
        var receipt;
        try{
          receipt=await client.adjustInventory({
            operation_id:row.operationId,
            product_id:row.productId,
            movement_type:'ENTRADA',
            quantity:row.quantity,
            reason:'Compra OCR '+operation+', línea '+row.sourceIndex+': +'+quantityText(row.quantity)
          });
        }catch(error){
          var after=pendingRecord(),code=clean(after&&after.last_error)||clean(error&&error.message);
          var discarded=false;
          if(after&&after.command==='inventory.adjust'&&after.last_error&&typeof client.discardRejectedInventory==='function'){
            try{discarded=await client.discardRejectedInventory();}catch(_){}
          }
          if(discarded&&code==='operation_id_conflict'){
            try{await refreshCanonical();}catch(_){}
            if(committedOperations()[row.operationId]){
              skipped.push({sourceIndex:row.sourceIndex,productId:row.productId,reason:'ALREADY_APPLIED',referenceId:row.operationId});
              continue;
            }
          }
          var done=applied.length?'Se aplicaron '+applied.length+' de '+rows.length+' fila(s). ':'';
          errors.push(purchaseError(discarded?'CANONICAL_REJECTED':'CANONICAL_PENDING',
            done+(discarded
              ?'CANON rechazó la línea '+row.sourceIndex+' ('+code+'); esa línea no modificó el stock. Pulsa «Aplicar compra» de nuevo: las líneas ya aplicadas no se duplicarán.'
              :pendingMessage(error)+' Pulsa «Aplicar compra» de nuevo para completar (no se duplicará).'),
            {sourceIndex:row.sourceIndex,productId:row.productId}));
          return result();
        }
        applied.push({sourceIndex:row.sourceIndex,productId:row.productId,quantity:row.quantity,
          referenceId:row.operationId,status:receipt&&receipt.status,stockAfter:receipt&&receipt.stock_after});
        if(i<rows.length-1){
          // Refresh so the next row (possibly the same product) uses the new stock_revision.
          try{await refreshCanonical();}
          catch(error){
            errors.push(purchaseError('CANONICAL_REFRESH_FAILED','Se aplicaron '+applied.length+' de '+rows.length+' fila(s), pero no se pudo actualizar CANON ('+clean(error&&error.message)+'). Pulsa «Aplicar compra» de nuevo para completar (no se duplicará).'));
            return result();
          }
        }
      }
      try{await refreshCanonical();renderViews();}catch(_){}
      return result();
    }finally{busy=false;}
  }

  root.NuevoAmanecerCanonicalInventoryBridge=Object.freeze({
    enabled:enabled,
    save:save,
    applyPurchase:applyPurchase,
    busy:function(){return busy;},
    userLocked:userLocked
  });
})(globalThis);
