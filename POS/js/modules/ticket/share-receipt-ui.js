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
  function contactInfoText(){return canonicalContactUi()?'Estos datos se guardan en CANON. DNI/RUC y dirección todavía no se pueden editar desde aquí.':'Estos datos se guardan en la ficha del cliente para futuras operaciones.';}
  function contactModal(){
    let overlay=document.getElementById('naCustomerContact');if(overlay)return overlay;
    overlay=node('div','modal-overlay na-receipt-overlay');overlay.id='naCustomerContact';const modal=node('section','modal na-receipt-modal');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','naContactTitle');
    const head=node('div','mhead teal'),title=node('div','mhead-title','Datos del cliente');title.id='naContactTitle';const x=node('button','btn-close-m','×');x.type='button';x.setAttribute('aria-label','Cerrar');x.onclick=()=>{if(!contactBusy)overlay.classList.remove('open');};head.append(title,x);
    const body=node('div','mbody');
    [['naContactName','Nombre del cliente','text'],['naContactPhone','WhatsApp (código de país)','tel']].forEach(([id,label,type])=>{const field=node('div','fg'),l=node('label','fl',label),input=node('input','fi');l.htmlFor=id;input.id=id;input.type=type;input.maxLength=type==='tel'?32:240;if(type==='tel')input.placeholder='+51 987 654 321';field.append(l,input);body.append(field);});
    const info=node('p','na-receipt-status',contactInfoText());info.id='naContactStatus';info.setAttribute('role','status');body.append(info);
    const buttons=node('div','mbtns'),cancel=node('button','mbtn mbtn-cancel','Cancelar'),save=node('button','mbtn mbtn-ok','Guardar cliente');cancel.type=save.type='button';save.id='naContactSave';cancel.onclick=()=>{if(!contactBusy)overlay.classList.remove('open');};save.onclick=saveContact;buttons.append(cancel,save);body.append(buttons);modal.append(head,body);overlay.append(modal);document.body.append(overlay);return overlay;
  }
  function editContact(id){if(contactBusy||!authorized())return;const client=customers().find(c=>String(c.id)===String(id));if(!client){notice('Cliente no encontrado');return;}contactId=String(id);const overlay=contactModal();document.getElementById('naContactName').value=client.nombre||client.name||'';document.getElementById('naContactPhone').value=client.tel||client.phone||'';document.getElementById('naContactStatus').textContent=contactInfoText();overlay.classList.add('open');document.getElementById('naContactName').focus();}
  async function saveContact(){
    if(contactBusy||!contactId||!authorized())return;
    const name=document.getElementById('naContactName').value.trim().replace(/\s+/g,' '),raw=document.getElementById('naContactPhone').value.trim(),phone=root.NAReceiptShare.normalizePhone(raw);
    if(!name){notice('El nombre es obligatorio');return;}if(raw&&!phone){notice('Número de WhatsApp inválido. Usa +51 y 9 dígitos para Perú.');return;}
    const targetId=contactId,button=document.getElementById('naContactSave');contactBusy=true;button.disabled=true;
    let confirmed=false;
    try{
      const canonical=root.NuevoAmanecerCanonical;
      if(canonical?.enabled?.()){
        const pending=canonical.pendingSnapshot?.();
        if(pending){
          if(pending.command!=='customer.contact.set'||String(pending.payload?.customer_id)!==targetId){notice('Termina la operación pendiente antes de editar al cliente');return;}
          if(pending.last_error&&[400,409].includes(pending.last_status)){if(await canonical.discardRejectedCustomerContact?.()){await canonical.refresh();notice('Los datos cambiaron o fueron rechazados. Revisa la ficha y vuelve a guardar.');return;}notice('No se pudo resolver la edición pendiente. Reintenta la sincronización antes de guardar.');return;}
          await canonical.retryPending();confirmed=true;
          await canonical.refresh();
          const savedName=pending.payload.name,savedPhone=pending.payload.phone||'';
          if(savedName!==name||savedPhone!==(phone?'+'+phone:'')){document.getElementById('naContactName').value=savedName;document.getElementById('naContactPhone').value=savedPhone;const message='Se confirmó la edición pendiente de este cliente. Revisa los datos recuperados antes de hacer otro cambio.';document.getElementById('naContactStatus').textContent=message;notice(message,'success');return;}
        }else{await canonical.setCustomerContact({customer_id:targetId,name,phone:phone?'+'+phone:null});confirmed=true;}
        await canonical.refresh();
      }else{
        const client=customers().find(c=>String(c.id)===targetId);if(!client)throw new Error('Cliente no encontrado');
        const previous={nombre:client.nombre,tel:client.tel};client.nombre=name;client.tel=phone?'+'+phone:'';
        try{const result=await saveAllData();if(!_naWasPersisted(result))throw new Error('No existe guardado permanente verificado');confirmed=true;}catch(error){Object.assign(client,previous);throw error;}
      }
      document.getElementById('naCustomerContact').classList.remove('open');root.cliRender?.();notice('Datos del cliente guardados','success');
    }catch(error){const message=confirmed?'Datos CONFIRMADOS. Recarga para actualizar la vista; no repitas el guardado.':'No se guardaron los datos. '+(root.NuevoAmanecerCanonical?.pendingSnapshot?.()?.last_error||error.message);document.getElementById('naContactStatus').textContent=message;notice(message,confirmed?'success':'error');}
    finally{contactBusy=false;button.disabled=false;}
  }
  function settingsHtml(){const s=root.NAReceiptShare.settings();return '<div class="cfg-panel"><div class="cfg-panel-title">Compartir comprobantes por WhatsApp</div><div class="cfg-setting-list"><div class="cfg-setting"><label class="cfg-setting-title" for="cfgReceiptFormat">Formato predeterminado</label><select id="cfgReceiptFormat" class="cfg-input" onchange="NAReceiptUI.changeSettings()"><option value="image"'+(s.format==='image'?' selected':'')+'>Imagen PNG</option><option value="text"'+(s.format==='text'?' selected':'')+'>Texto</option><option value="pdf"'+(s.format==='pdf'?' selected':'')+'>PDF</option></select></div><div class="cfg-setting"><label for="cfgReceiptAsk">Preguntar al finalizar ventas, créditos y abonos</label><input id="cfgReceiptAsk" type="checkbox"'+(s.ask?' checked':'')+' onchange="NAReceiptUI.changeSettings()"></div></div><details class="na-receipt-help"><summary>ℹ️ Cómo funciona el envío</summary><p>Texto abre el chat del número guardado. Imagen y PDF abren el menú de compartir: elige WhatsApp y el contacto. Confirma el envío en WhatsApp. Cancelar conserva la operación.</p></details></div>';}
  async function changeSettings(){const previous=root.NAReceiptShare.settings();const next={format:document.getElementById('cfgReceiptFormat').value,ask:document.getElementById('cfgReceiptAsk').checked};const configSave=root.guardarConfig;if(typeof configSave!=='function')return;root.NAReceiptShare.setSettings(next);try{if(await configSave()!==true)throw new Error('Configuración no guardada');}catch(_){root.NAReceiptShare.setSettings(previous);document.getElementById('cfgReceiptFormat').value=previous.format;document.getElementById('cfgReceiptAsk').checked=previous.ask;notice('No se guardó la preferencia de comprobantes');}}
  document.addEventListener('click',event=>{const contact=event.target.closest?.('[data-edit-contact]');if(contact)editContact(contact.getAttribute('data-edit-contact'));const credit=event.target.closest?.('[data-share-credit]'),payment=event.target.closest?.('[data-share-payment]');if(credit)root.NAReceiptShare.shareCredit(credit.getAttribute('data-share-credit'));if(payment)root.NAReceiptShare.sharePayment(payment.getAttribute('data-share-credit-id'),payment.getAttribute('data-share-payment'));});
  root.NAReceiptUI=Object.freeze({editContact,settingsHtml,changeSettings});
})(globalThis);
