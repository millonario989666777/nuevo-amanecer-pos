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
    if(typeof fn==='function')fn('mCli');
    else root.document.getElementById('mCli')?.classList.remove('open');
  }
  function renderViews(){
    ['cliRender','posRender','updateDashboard'].forEach(function(name){
      var fn=root[name];
      if(typeof fn==='function')try{fn.call(root);}catch(_){}
    });
  }
  function userLocked(){
    try{if(typeof securityIsLocked==='function'&&securityIsLocked())return true;}catch(_){}
    try{
      if(typeof storage!=='undefined'&&typeof LOCK_KEYS!=='undefined'&&storage&&LOCK_KEYS){
        if(storage.getItem(LOCK_KEYS.master)==='true'||storage.getItem(LOCK_KEYS.readOnly)==='true')return true;
        var key=LOCK_KEYS.modules&&LOCK_KEYS.modules.clientes;
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
  function pendingMessage(error){
    var pending=pendingRecord(),code=clean(error&&error.message);
    if(pending&&pending.command==='customer.create'&&!pending.invalid){
      if(pending.last_error)return 'CANON rechazó el cliente ('+clean(pending.last_error)+'). No se creó ningún cliente.';
      return 'El cliente se envió pero CANON no confirmó la recepción ('+code+'). Pulsa Guardar nuevamente para reintentar la MISMA operación.';
    }
    return 'No se registró el cliente CANON'+(code?': '+code:'');
  }
  function value(id){return root.document.getElementById(id)?.value;}
  var FORM_FIELDS=['cNombre','cDni','cTel','cDir','cLinea'];
  function resetForm(){
    FORM_FIELDS.forEach(function(id){var input=root.document.getElementById(id);if(input)input.value='';});
  }
  // Optional initial credit line. Empty = keep the automatic line (no extra command).
  // Returns undefined when invalid (already notified), null when empty, or integer cents.
  function readCreditLine(){
    var raw=clean(value('cLinea')).replace(',','.');
    if(!raw)return null;
    if(!/^\d+(\.\d{1,2})?$/.test(raw)){notify('Línea de crédito inválida. Usa un monto como 150 o 150.50','error');return undefined;}
    var cents=Math.round(Number(raw)*100);
    if(!Number.isSafeInteger(cents)||cents<0||cents>100000000){notify('La línea de crédito máxima permitida es S/ 1,000,000','error');return undefined;}
    return cents;
  }
  function cashier(){
    try{
      var ref=(typeof cajEstado!=='undefined'&&cajEstado&&cajEstado.cajeroId)||(typeof appConfig!=='undefined'&&appConfig&&appConfig.activeCashierId)||null;
      var snap=typeof root._naCashierSnapshot==='function'?root._naCashierSnapshot(ref):null;
      return snap&&typeof snap==='object'?snap:{};
    }catch(_){return{};}
  }
  // Second, separate canonical command (customer.credit-policy.set, own operation_id) through the
  // same bridge used by Línea de crédito → Ajustar. Runs only after customer.create is CONFIRMED.
  async function applyInitialCreditLine(customerId,cents){
    if(cents==null||!customerId)return true;
    var policy=root.NuevoAmanecerCanonicalCustomerCreditPolicyBridge;
    var ok=false;
    if(policy&&typeof policy.saveManual==='function'){
      var who=cashier();
      try{ok=await policy.saveManual({customer_id:customerId,manual_limit_cents:cents,reason:'Línea inicial al registrar cliente',
        administrator_id:who.id||null,administrator_name:who.nombre||'Propietario'})===true;}catch(_){ok=false;}
    }
    if(!ok)notify('Cliente registrado, pero la línea de crédito NO se guardó. Ajústala en Línea de crédito → Ajustar.','error');
    return ok;
  }
  function currentCustomers(){
    var client=api();
    try{
      var snapshot=client&&typeof client.snapshot==='function'?client.snapshot():null;
      return Array.isArray(snapshot?.customers)?snapshot.customers:[];
    }catch(_){return[];}
  }
  function buildInput(){
    var name=clean(value('cNombre')),documentId=clean(value('cDni')),phone=clean(value('cTel')),address=clean(value('cDir'));
    if(!name){notify('El nombre es obligatorio','error');return null;}
    if(name.length>240||documentId.length>32||phone.length>64||address.length>500){
      notify('Uno de los datos del cliente es demasiado largo','error');return null;
    }
    if(documentId){
      var duplicate=currentCustomers().find(function(customer){
        return clean(customer.document).toLowerCase()===documentId.toLowerCase();
      });
      if(duplicate){notify('Ya existe un cliente con ese DNI / RUC','error');return null;}
    }
    return{
      name:name,
      document:documentId||null,
      phone:phone||null,
      address:address||null
    };
  }
  async function afterCommit(receipt,replayed,creditLineCents){
    closeModal();
    resetForm();
    var operation=clean(receipt&&receipt.operation_id),customerId=clean(receipt&&receipt.customer_id);
    try{
      await refreshCanonical();
      renderViews();
      notify(replayed
        ? 'Se confirmó el cliente CANON pendiente'+(customerId?' ('+customerId+')':'')+'. No se creó un duplicado.'
        : 'Cliente registrado en CANON'+(customerId?' ('+customerId+')':''),'success');
      await applyInitialCreditLine(customerId,creditLineCents);
    }catch(error){
      notify('Cliente CONFIRMADO en CANON (operación '+operation+'). No se pudo actualizar la vista: '+
        clean(error&&error.message)+'. NO vuelvas a guardarlo; recarga la pantalla para verlo.'+
        (creditLineCents!=null?' La línea de crédito no se aplicó: ajústala luego en Línea de crédito.':''),'success');
    }
    return true;
  }

  async function save(){
    if(!enabled()||busy)return false;
    if(userLocked()){notify('Módulo de clientes bloqueado','error');return false;}

    var client=api(),pending=pendingRecord();
    if(pending){
      if(pending.command!=='customer.create'||pending.invalid){
        notify('Hay otra operación CANON pendiente ('+clean(pending.command)+'). Resuélvela antes de guardar un cliente.','error');
        return false;
      }
      if(pending.last_error&&typeof client.discardRejectedCustomer==='function'){
        try{
          if(await client.discardRejectedCustomer()){
            notify('El alta anterior fue rechazada por CANON ('+clean(pending.last_error)+'). No se creó ningún cliente; corrige los datos y vuelve a guardar.','error');
            return false;
          }
        }catch(_){}
      }
    }

    var creditLineCents=readCreditLine();
    if(creditLineCents===undefined)return false;
    var input=pending?null:buildInput();
    if(!pending&&!input)return false;
    var button=root.document.querySelector('#mCli .mbtn-ok');
    var label=button?.textContent||'💾 Guardar';
    busy=true;if(button){button.disabled=true;button.textContent='Procesando…';}
    try{
      if(pending){
        var replay;
        try{replay=await client.retryPending();}catch(error){notify(pendingMessage(error),'error');return false;}
        return await afterCommit(replay,true,creditLineCents);
      }

      try{await refreshCanonical();}
      catch(error){notify('No se registró el cliente: CANON no disponible ('+clean(error&&error.message)+')','error');return false;}

      if(!client||typeof client.createCustomer!=='function'){
        notify('No se registró el cliente: CANONICAL_CUSTOMER_UNAVAILABLE','error');return false;
      }

      var receipt;
      try{receipt=await client.createCustomer(input);}
      catch(error){
        var pendingAfter=pendingRecord();
        if(pendingAfter&&pendingAfter.command==='customer.create'&&pendingAfter.last_error&&typeof client.discardRejectedCustomer==='function'){
          try{
            if(await client.discardRejectedCustomer()){
              notify('CANON rechazó el cliente ('+clean(pendingAfter.last_error)+'). No se creó ningún cliente; puedes corregir los datos y volver a intentar.','error');
              return false;
            }
          }catch(_){}
        }
        notify(pendingMessage(error),'error');return false;
      }
      return await afterCommit(receipt,false,creditLineCents);
    }finally{
      busy=false;if(button){button.disabled=false;button.textContent=label;}
    }
  }

  // Closing the form (✕ / Cancelar) must not leave the previous customer's data hidden in the DOM.
  if(typeof root.document.addEventListener==='function'){
    root.document.addEventListener('click',function(event){
      var target=event&&event.target;
      if(target&&typeof target.closest==='function'&&target.closest('#mCli .btn-close-m, #mCli .mbtn-cancel'))resetForm();
    });
  }

  root.NuevoAmanecerCanonicalCustomerBridge=Object.freeze({
    enabled:enabled,
    save:save,
    busy:function(){return busy;},
    userLocked:userLocked
  });
})(globalThis);
