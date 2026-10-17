(function(root){
  'use strict';
  let contactId=null,contactBusy=false;
  function customers(){try{return clientes;}catch(_){return root.clientes||[];}}
  function notice(message,tone='error'){try{toast(message,tone);}catch(_){root.toast?.(message,tone);}}
  function node(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
  function canonicalContactUi(){const canonical=root.NuevoAmanecerCanonical;try{return !!(canonical&&typeof canonical.enabled==='function'&&canonical.enabled()&&typeof canonical.setCustomerContact==='function');}catch(_){return false;}}
  // CANON: name/WhatsApp edits go through the canonical customer.contact.set command (own operation_id, CAS revision),
  // so they are a canonical customer UI and must not hit the legacy-write guard. User/master/read-only locks still apply.
  function authorized(){if(typeof root.isModuleLocked==='function'&&root.isModuleLocked('clientes',{canonicalCustomerUi:canonicalContactUi()})){notice('Clientes está protegido');return false;}if(typeof root._naF10AuthorizePermission==='function'&&!root._naF10AuthorizePermission('clients','Editar datos del cliente'))return false;return true;}
  function contactInfoText(){return canonicalContactUi()?'Estos datos se guardan en CANON. DNI (8 dígitos) o RUC (11 dígitos); déjalo vacío si no tiene.':'Estos datos se guardan en la ficha del cliente para futuras operaciones.';}
  function clientDocument(c){return _naDocumentValue(c?.dni||c?.document);}
  function clientAddress(c){return String(c?.dir||c?.address||'').trim();}
  function docLabel(doc){return doc.length===11?'RUC':'DNI';}
  function contactModal(){
    let overlay=document.getElementById('naCustomerContact');if(overlay)return overlay;
    overlay=node('div','modal-overlay na-receipt-overlay');overlay.id='naCustomerContact';const modal=node('section','modal na-receipt-modal');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','naContactTitle');
    const head=node('div','mhead teal'),title=node('div','mhead-title','Datos del cliente');title.id='naContactTitle';const x=node('button','btn-close-m','×');x.type='button';x.setAttribute('aria-label','Cerrar');x.onclick=()=>{if(!contactBusy)overlay.classList.remove('open');};head.append(title,x);
    const body=node('div','mbody');
    [['naContactName','Nombre del cliente','text',240],['naContactPhone','WhatsApp (código de país)','tel',32,'+51 987 654 321'],['naContactDoc','DNI / RUC','text',11,'8 u 11 dígitos','numeric'],['naContactAddress','Dirección','text',500,'Opcional']].forEach(([id,label,type,max,placeholder,mode])=>{const field=node('div','fg'),l=node('label','fl',label),input=node('input','fi');l.htmlFor=id;input.id=id;input.type=type;input.maxLength=max;if(placeholder)input.placeholder=placeholder;if(mode)input.setAttribute('inputmode',mode);field.append(l,input);body.append(field);});
    const info=node('p','na-receipt-status',contactInfoText());info.id='naContactStatus';info.setAttribute('role','status');body.append(info);
    const buttons=node('div','mbtns'),cancel=node('button','mbtn mbtn-cancel','Cancelar'),save=node('button','mbtn mbtn-ok','Guardar cliente');cancel.type=save.type='button';save.id='naContactSave';cancel.onclick=()=>{if(!contactBusy)overlay.classList.remove('open');};save.onclick=saveContact;buttons.append(cancel,save);body.append(buttons);modal.append(head,body);overlay.append(modal);document.body.append(overlay);return overlay;
  }
  // Worker 409 names the other customer (last_conflict); fall back to the local list.
  function identityRejectedText(record){
    if(record?.last_error==='customer_identity_schema_not_ready')return 'El servidor todavía no admite editar DNI/RUC y dirección. No se guardaron los cambios; avisa al administrador.';
    const doc=String(record?.payload?.document||''),ownerId=record?.last_conflict?.customer_id,local=customers().find(c=>String(c.id)===String(ownerId)||(!ownerId&&doc&&clientDocument(c)===doc&&String(c.id)!==String(record?.payload?.customer_id)));
    const owner=record?.last_conflict?.customer_name||local?.nombre||local?.name||'otro cliente';
    return 'El '+docLabel(doc)+' '+doc+' ya pertenece a «'+owner+'». No se guardaron los cambios.';
  }
  function editContact(id){if(contactBusy||!authorized())return;const client=customers().find(c=>String(c.id)===String(id));if(!client){notice('Cliente no encontrado');return;}contactId=String(id);const overlay=contactModal();document.getElementById('naContactName').value=client.nombre||client.name||'';document.getElementById('naContactPhone').value=client.tel||client.phone||'';document.getElementById('naContactDoc').value=clientDocument(client);document.getElementById('naContactAddress').value=clientAddress(client);document.getElementById('naContactStatus').textContent=contactInfoText();overlay.classList.add('open');document.getElementById('naContactName').focus();}
  async function saveContact(){
    if(contactBusy||!contactId||!authorized())return;
    const name=document.getElementById('naContactName').value.trim().replace(/\s+/g,' '),raw=document.getElementById('naContactPhone').value.trim(),phone=root.NAReceiptShare.normalizePhone(raw);
    if(!name){notice('El nombre es obligatorio');return;}
    const doc=String(document.getElementById('naContactDoc')?.value||'').replace(/[\s.-]/g,''),address=String(document.getElementById('naContactAddress')?.value||'').trim().replace(/\s+/g,' ');
    if(doc&&!/^(\d{8}|\d{11})$/.test(doc)){notice('DNI/RUC inválido: el DNI tiene 8 dígitos y el RUC 11.');return;}
    if(address.length>500){notice('La dirección es demasiado larga (máx. 500 caracteres).');return;}
    const sameDoc=doc?customers().find(c=>String(c.id)!==String(contactId)&&clientDocument(c)===doc):null;
    if(sameDoc){notice('El '+docLabel(doc)+' '+doc+' ya pertenece a «'+(sameDoc.nombre||sameDoc.name||'otro cliente')+'». Revisa el número o edita esa ficha.');return;}
    const current=customers().find(c=>String(c.id)===String(contactId)),storedPhone=String(current?.tel||current?.phone||'').trim();
    // Only send DNI/RUC + address when they changed: name/WhatsApp edits keep working on a Worker without migration 0023.
    const identityChanged=doc!==clientDocument(current)||address!==clientAddress(current);
    // P2-6: changing only the name must not be blocked by an old landline. Legacy
    // keeps the stored text; CANON can only store a WhatsApp, so say exactly why.
    const keepStoredPhone=!!raw&&!phone&&raw===storedPhone;
    if(keepStoredPhone&&canonicalContactUi()){notice('El teléfono guardado ('+storedPhone+') no es un WhatsApp válido. Escribe un celular (+51 9…) o bórralo para guardar solo el nombre.');return;}
    if(raw&&!phone&&!keepStoredPhone){notice('Número de WhatsApp inválido. Usa +51 y 9 dígitos para Perú.');return;}
    const samePhone=phone?customers().find(c=>String(c.id)!==String(contactId)&&root.NAReceiptShare.normalizePhone(c.tel||c.phone||'')===phone):null;
    if(samePhone){notice('Ya existe «'+(samePhone.nombre||samePhone.name||'otro cliente')+'» con ese WhatsApp. Usa otro número o edita esa ficha.');return;}
    const targetId=contactId,button=document.getElementById('naContactSave');contactBusy=true;button.disabled=true;
    let confirmed=false;
    try{
      const canonical=root.NuevoAmanecerCanonical;
      if(canonical?.enabled?.()){
        const pending=canonical.pendingSnapshot?.();
        if(pending){
          if(pending.command!=='customer.contact.set'||String(pending.payload?.customer_id)!==targetId){notice('Termina la operación pendiente antes de editar al cliente');return;}
          if(pending.last_error&&([400,409].includes(pending.last_status)||pending.last_status===503&&pending.last_error==='customer_identity_schema_not_ready')){if(pending.last_error==='customer_document_conflict'||pending.last_error==='customer_identity_schema_not_ready'){const message=identityRejectedText(pending);await canonical.discardRejectedCustomerContact?.();document.getElementById('naContactStatus').textContent=message;notice(message);return;}if(await canonical.discardRejectedCustomerContact?.()){await canonical.refresh();notice('Los datos cambiaron o fueron rechazados. Revisa la ficha y vuelve a guardar.');return;}notice('No se pudo resolver la edición pendiente. Reintenta la sincronización antes de guardar.');return;}
          await canonical.retryPending();confirmed=true;
          await canonical.refresh();
          const savedName=pending.payload.name,savedPhone=pending.payload.phone||'',hasIdentity='document' in pending.payload,savedDoc=hasIdentity?pending.payload.document||'':doc,savedAddress=hasIdentity?pending.payload.address||'':address;
          if(savedName!==name||savedPhone!==(phone?'+'+phone:'')||savedDoc!==doc||savedAddress!==address){document.getElementById('naContactName').value=savedName;document.getElementById('naContactPhone').value=savedPhone;document.getElementById('naContactDoc').value=savedDoc;document.getElementById('naContactAddress').value=savedAddress;const message='Se confirmó la edición pendiente de este cliente. Revisa los datos recuperados antes de hacer otro cambio.';document.getElementById('naContactStatus').textContent=message;notice(message,'success');return;}
        }else{const input={customer_id:targetId,name,phone:phone?'+'+phone:null};if(identityChanged){input.document=doc||null;input.address=address||null;}await canonical.setCustomerContact(input);confirmed=true;}
        await canonical.refresh();
      }else{
        const client=customers().find(c=>String(c.id)===targetId);if(!client)throw new Error('Cliente no encontrado');
        const previous={nombre:client.nombre,tel:client.tel,dni:client.dni,dir:client.dir};client.nombre=name;client.tel=phone?'+'+phone:(keepStoredPhone?storedPhone:'');client.dni=doc;client.dir=address;
        try{const result=await saveAllData();if(!_naWasPersisted(result))throw new Error('No existe guardado permanente verificado');confirmed=true;}catch(error){Object.assign(client,previous);throw error;}
      }
      document.getElementById('naCustomerContact').classList.remove('open');root.cliRender?.();notice('Datos del cliente guardados','success');
    }catch(error){
      const rejected=root.NuevoAmanecerCanonical?.pendingSnapshot?.();
      if(!confirmed&&rejected?.command==='customer.contact.set'&&rejected.last_error==='customer_phone_conflict'){
        try{await root.NuevoAmanecerCanonical.discardRejectedCustomerContact?.();}catch(_){}
        const message='Ese WhatsApp ya pertenece a otro cliente. No se guardaron los cambios; usa otro número.';
        document.getElementById('naContactStatus').textContent=message;notice(message);return;
      }
      if(!confirmed&&rejected?.command==='customer.contact.set'&&['customer_document_conflict','customer_identity_schema_not_ready'].includes(rejected.last_error)){
        const message=identityRejectedText(rejected);
        try{await root.NuevoAmanecerCanonical.discardRejectedCustomerContact?.();}catch(_){}
        document.getElementById('naContactStatus').textContent=message;notice(message);return;
      }
      const message=confirmed?'Datos CONFIRMADOS. Recarga para actualizar la vista; no repitas el guardado.':'No se guardaron los datos. '+(root.NuevoAmanecerCanonical?.pendingSnapshot?.()?.last_error||error.message);document.getElementById('naContactStatus').textContent=message;notice(message,confirmed?'success':'error');}
    finally{contactBusy=false;button.disabled=false;}
  }
  function settingsHtml(){const s=root.NAReceiptShare.settings(),android=root.NAReceiptShare.isAndroid();return '<div class="cfg-panel"><div class="cfg-panel-title">Compartir comprobantes por WhatsApp</div><div class="cfg-setting-list"><div class="cfg-setting"><label class="cfg-setting-title" for="cfgReceiptFormat">Formato predeterminado</label><select id="cfgReceiptFormat" class="cfg-input" onchange="NAReceiptUI.changeSettings()"><option value="image"'+(s.format==='image'?' selected':'')+'>Imagen PNG</option><option value="text"'+(s.format==='text'?' selected':'')+'>Texto</option><option value="pdf"'+(s.format==='pdf'?' selected':'')+'>PDF</option></select></div><div class="cfg-setting"><label class="cfg-setting-title" for="cfgReceiptApp">Enviar desde (texto, solo Android)</label><select id="cfgReceiptApp" class="cfg-input"'+(android?'':' disabled')+' onchange="NAReceiptUI.changeSettings()"><option value="auto"'+(s.app==='auto'?' selected':'')+'>Automático (wa.me)</option><option value="whatsapp"'+(s.app==='whatsapp'?' selected':'')+'>WhatsApp</option><option value="business"'+(s.app==='business'?' selected':'')+'>WhatsApp Business</option></select>'+(android?'':'<small>Solo disponible en Android; aquí se usa wa.me.</small>')+'</div><div class="cfg-setting"><label for="cfgReceiptAsk">Preguntar al finalizar ventas, créditos y abonos</label><input id="cfgReceiptAsk" type="checkbox"'+(s.ask?' checked':'')+' onchange="NAReceiptUI.changeSettings()"></div></div><details class="na-receipt-help"><summary>ℹ️ Cómo funciona el envío</summary><p>Texto abre el chat del número guardado (en Android puedes elegir WhatsApp o WhatsApp Business). Imagen y PDF abren el menú de compartir: elige WhatsApp y el contacto. Confirma el envío en WhatsApp. Cancelar conserva la operación.</p></details></div>';}
  async function changeSettings(){const previous=root.NAReceiptShare.settings();const next={format:document.getElementById('cfgReceiptFormat').value,ask:document.getElementById('cfgReceiptAsk').checked,app:previous.app};const appSelect=document.getElementById('cfgReceiptApp');if(appSelect&&!appSelect.disabled)next.app=appSelect.value;const configSave=root.guardarConfig;if(typeof configSave!=='function')return;root.NAReceiptShare.setSettings(next);try{if(await configSave()!==true)throw new Error('Configuración no guardada');}catch(_){root.NAReceiptShare.setSettings(previous);document.getElementById('cfgReceiptFormat').value=previous.format;document.getElementById('cfgReceiptAsk').checked=previous.ask;if(appSelect)appSelect.value=previous.app;notice('No se guardó la preferencia de comprobantes');}}
  document.addEventListener('click',event=>{const contact=event.target.closest?.('[data-edit-contact]');if(contact)editContact(contact.getAttribute('data-edit-contact'));const credit=event.target.closest?.('[data-share-credit]'),payment=event.target.closest?.('[data-share-payment]');if(credit)root.NAReceiptShare.shareCredit(credit.getAttribute('data-share-credit'));if(payment)root.NAReceiptShare.sharePayment(payment.getAttribute('data-share-credit-id'),payment.getAttribute('data-share-payment'));});
  root.NAReceiptUI=Object.freeze({editContact,settingsHtml,changeSettings});
})(globalThis);
