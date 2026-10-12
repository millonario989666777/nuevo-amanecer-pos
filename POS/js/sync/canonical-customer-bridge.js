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
  function phoneOwner(e164,exceptId){
    return currentCustomers().find(function(customer){return String(customer.customer_id)!==String(exceptId)&&!!e164&&phoneKey(customer.phone)===e164;})||null;
  }
  function customerRejection(pending){
    var code=clean(pending&&pending.last_error);
    if(code==='customer_phone_conflict'){
      var owner=phoneOwner(pending&&pending.payload&&normalizePhone(pending.payload.phone),pending&&pending.payload&&pending.payload.customer_id);
      return 'Ya existe '+(owner?'«'+clean(owner.name)+'»':'otro cliente')+' con ese teléfono.';
    }
    if(code==='customer_document_conflict')return 'Ya existe otro cliente con ese DNI / RUC.';
    if(code==='invalid_customer_document')return 'El DNI debe tener 8 dígitos y el RUC 11.';
    if(code==='invalid_customer_phone')return 'Teléfono inválido. Usa un celular de 9 dígitos o +código de país.';
    return 'CANON rechazó el cliente ('+code+').';
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
  // P1-4: same rule as NAReceiptShare.normalizePhone and the Worker: Peru mobile
  // (9 digits starting with 9, optional 51) or +country code with 9-15 digits.
  function normalizePhone(raw){
    raw=String(raw||'').trim();if(!raw||!/^[+\d\s().-]+$/.test(raw))return'';
    var n=raw.replace(/\D/g,'');if(n.indexOf('00')===0)n=n.slice(2);
    if(/^9\d{8}$/.test(n))n='51'+n;
    if(n.indexOf('51')===0)return /^519\d{8}$/.test(n)?'+'+n:'';
    return (raw.charAt(0)==='+'||raw.indexOf('00')===0)&&/^[1-9]\d{8,14}$/.test(n)?'+'+n:'';
  }
  function phoneKey(raw){
    var e164=normalizePhone(raw);if(e164)return e164;
    var digits=String(raw||'').replace(/\D/g,'');return digits.length>=6?digits:'';
  }
  function validDocument(doc){return /^(\d{8}|\d{11})$/.test(doc);}
  // P1-5: the initial credit line travels with the pending customer.create
  // (keyed by its customer_id), never with whatever the form holds later.
  var PENDING_LINE_KEY='na_canonical_customer_create_line_v1';
  function storage(){try{return root.localStorage||null;}catch(_){return null;}}
  function readPendingLine(customerId){
    try{var raw=storage()?.getItem(PENDING_LINE_KEY);if(!raw)return{found:false,cents:null};
      var rec=JSON.parse(raw);if(rec&&rec.customer_id===customerId)return{found:true,cents:Number.isSafeInteger(rec.credit_line_cents)?rec.credit_line_cents:null};
    }catch(_){}
    return{found:false,cents:null};
  }
  function writePendingLine(customerId,cents,name){
    var store=storage();if(!store||typeof store.setItem!=='function')return;
    var raw=JSON.stringify({customer_id:customerId,credit_line_cents:cents==null?null:cents,name:name});
    store.setItem(PENDING_LINE_KEY,raw);
    if(store.getItem(PENDING_LINE_KEY)!==raw)throw new Error('CUSTOMER_LINE_STORAGE_NOT_DURABLE');
  }
  function clearPendingLine(customerId){
    try{var store=storage();var raw=store?.getItem(PENDING_LINE_KEY);if(!raw)return;var rec=JSON.parse(raw);
      if(!customerId||!rec||rec.customer_id===customerId)store.removeItem(PENDING_LINE_KEY);}catch(_){}
  }
  function formValues(){
    return{name:clean(value('cNombre')),document:clean(value('cDni')),phone:clean(value('cTel')),address:clean(value('cDir')),line:clean(value('cLinea'))};
  }
  function formEmpty(form){return !form.name&&!form.document&&!form.phone&&!form.address&&!form.line;}
  function formMatchesPending(form,payload){
    return clean(payload&&payload.name).toLowerCase()===form.name.toLowerCase()&&
      clean(payload&&payload.document).toLowerCase()===form.document.toLowerCase();
  }
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
      if(!validDocument(documentId)){notify('El DNI debe tener 8 dígitos y el RUC 11 dígitos (solo números).','error');return null;}
      var duplicate=currentCustomers().find(function(customer){
        return clean(customer.document).toLowerCase()===documentId.toLowerCase();
      });
      if(duplicate){notify('Ya existe «'+clean(duplicate.name)+'» con ese DNI / RUC','error');return null;}
    }
    var e164=null;
    if(phone){
      e164=normalizePhone(phone);
      if(!e164){notify('Teléfono inválido. Usa un celular de 9 dígitos (ej. 987 654 321) o +código de país.','error');return null;}
      var samePhone=phoneOwner(e164,null);
      if(samePhone){notify('Ya existe «'+clean(samePhone.name)+'» con ese teléfono. Abre esa ficha en lugar de crear otra.','error');return null;}
    }
    return{
      customer_id:'C-'+(root.crypto&&typeof root.crypto.randomUUID==='function'?root.crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12)),
      name:name,
      document:documentId||null,
      phone:e164,
      address:address||null
    };
  }
  async function afterCommit(receipt,replayed,creditLineCents,keepForm){
    if(!keepForm){closeModal();resetForm();}
    var operation=clean(receipt&&receipt.operation_id),customerId=clean(receipt&&receipt.customer_id);
    clearPendingLine(customerId);
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
            clearPendingLine(pending.payload&&pending.payload.customer_id);
            notify('El alta anterior fue rechazada por CANON ('+clean(pending.last_error)+'). No se creó ningún cliente; corrige los datos y vuelve a guardar.','error');
            return false;
          }
        }catch(_){}
      }
    }

    var form=formValues();
    var keepForm=false,creditLineCents=null;
    if(pending){
      // Never apply the CURRENT form's line to the PREVIOUS pending customer.
      var stored=readPendingLine(pending.payload&&pending.payload.customer_id);
      var matches=formEmpty(form)||formMatchesPending(form,pending.payload);
      keepForm=!matches;
      if(stored.found)creditLineCents=stored.cents;
      else if(matches&&!formEmpty(form)){creditLineCents=readCreditLine();if(creditLineCents===undefined)return false;}
    }else{
      creditLineCents=readCreditLine();
      if(creditLineCents===undefined)return false;
    }
    var input=pending?null:buildInput();
    if(!pending&&!input)return false;
    var button=root.document.querySelector('#mCli .mbtn-ok');
    var label=button?.textContent||'💾 Guardar';
    busy=true;if(button){button.disabled=true;button.textContent='Procesando…';}
    try{
      if(pending){
        var replay;
        try{replay=await client.retryPending();}catch(error){
          notify(pendingMessage(error)+(keepForm?' Primero hay que confirmar el alta pendiente de «'+clean(pending.payload&&pending.payload.name)+'»; los datos que escribiste siguen en el formulario.':''),'error');
          return false;
        }
        var confirmed=await afterCommit(replay,true,creditLineCents,keepForm);
        if(keepForm){
          notify('Se confirmó el alta pendiente de «'+clean(pending.payload&&pending.payload.name)+'». Los datos de «'+form.name+'» siguen en el formulario: revísalos y pulsa Guardar para registrarlo.','success');
          return false;
        }
        return confirmed;
      }

      try{await refreshCanonical();}
      catch(error){notify('No se registró el cliente: CANON no disponible ('+clean(error&&error.message)+')','error');return false;}

      if(!client||typeof client.createCustomer!=='function'){
        notify('No se registró el cliente: CANONICAL_CUSTOMER_UNAVAILABLE','error');return false;
      }

      try{writePendingLine(input.customer_id,creditLineCents,input.name);}
      catch(error){notify('No se registró el cliente: no se pudo guardar en este equipo ('+clean(error&&error.message)+')','error');return false;}
      var receipt;
      try{receipt=await client.createCustomer(input);}
      catch(error){
        var pendingAfter=pendingRecord();
        if(!pendingAfter||pendingAfter.command!=='customer.create')clearPendingLine(input.customer_id);
        if(pendingAfter&&pendingAfter.command==='customer.create'&&pendingAfter.last_error&&typeof client.discardRejectedCustomer==='function'){
          try{
            if(await client.discardRejectedCustomer()){
              clearPendingLine(input.customer_id);
              notify(customerRejection(pendingAfter)+' No se creó ningún cliente; puedes corregir los datos y volver a intentar.','error');
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
