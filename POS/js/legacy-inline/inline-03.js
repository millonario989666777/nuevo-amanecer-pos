
// Gastos
let gastoProc=false;
guardarGasto=async function(){
  if(gastoProc)return;
  if(isModuleLocked('gastos')){toast('El sistema está en modo solo lectura','error');return;}
  const desc=_naClean(document.getElementById('gasDesc').value),amount=_naNumber(document.getElementById('gasMonto').value);
  if(!desc||amount<=0){toast('Verifica concepto y monto','error');return;}
  const button=document.querySelector('#mGasto .mbtn-ok'),buttonText=button?.textContent||'💾 Registrar';
  gastoProc=true;
  if(button){button.disabled=true;button.textContent='Procesando…';}
  try{
    const method=document.getElementById('gasMetodo').value,date=document.getElementById('gasFecha').value||obtenerHoy(),category=document.getElementById('gasCat').value;
    const backup={gastos:_naClone(gastos),cajMovs:_naClone(cajMovs)};
    gastos.unshift({id:Date.now(),desc,monto:amount,cat:category,metodo:method,fecha:date,nota:_naClean(document.getElementById('gasNota').value)});
    if(_naSessionOpen()&&date===obtenerHoy()){
      const cashier=_naCashierSnapshot(cajEstado.cajeroId||cajEstado.cajero),now=new Date();
      cajMovs.push({id:Date.now()+1,tipo:'gas',monto:amount,efectivo:method==='efectivo'?amount:0,desc,cat:category,metodo:method,hora:nowT(),hora24:_naTime24(now),timestamp:now.toISOString(),cajero:cashier.nombre,cajeroNombre:cashier.nombre,cajeroId:cashier.id,fecha:date,sessionId:cajEstado.sessionId});
    }
    const persistResult=await saveAllData();
    if(!_naWasPersisted(persistResult)){gastos=backup.gastos;cajMovs=backup.cajMovs;await saveAllData();gasRender();toast('No se guardó el gasto porque no existe almacenamiento permanente verificado','error');return;}
    cerrarModal('mGasto');gasRender();toast(_naSessionOpen()?'Gasto registrado':'Gasto guardado fuera de una caja abierta','success');
  }finally{
    gastoProc=false;
    if(button){button.disabled=false;button.textContent=buttonText;}
  }
};

// Bloqueos: se consultan siempre desde almacenamiento, aunque configuración no esté visible.
isModuleLocked=function(moduleName,options){const canonical=typeof NuevoAmanecerCanonical!=='undefined'&&NuevoAmanecerCanonical.enabled();const canonicalWriteUi=(moduleName==='ventas'&&(options?.canonicalSaleCapture===true||options?.canonicalSaleUi===true))||(moduleName==='clientes'&&options?.canonicalCustomerUi===true)||(moduleName==='productos'&&options?.canonicalProductUi===true);if(canonical&&moduleName!=='configuracion'&&!canonicalWriteUi)return true;if(securityIsLocked())return true;const master=storage.getItem(LOCK_KEYS.master)==='true',readOnly=storage.getItem(LOCK_KEYS.readOnly)==='true';if(master||readOnly)return true;const key=LOCK_KEYS.modules[moduleName];return key?storage.getItem(key)==='true':false;};

invBadges=function(){const tracked=productos.filter(_naTracksStock),cr=appConfig.stockAlertActive?tracked.filter(p=>p.stock<=p.stockMin).length:0,pv=tracked.filter(p=>{const d=diasHasta(_naEffectiveExpiry(p));return d!==null&&d>=0&&d<=NA_EXPIRY_SOON_DAYS;}).length,ve=tracked.filter(p=>{const d=diasHasta(_naEffectiveExpiry(p));return d!==null&&d<0;}).length,totalCosto=tracked.reduce((a,p)=>a+(_naNumber(p.costo)*Math.max(0,_naNumber(p.stock))),0),totalVenta=tracked.reduce((a,p)=>a+(_naNumber(p.precio)*Math.max(0,_naNumber(p.stock))),0),ganancia=totalVenta-totalCosto;document.getElementById('invB0').textContent=productos.length;document.getElementById('invB1').textContent=appConfig.stockAlertActive?cr:'—';document.getElementById('invB2').textContent=pv;document.getElementById('invB3').textContent=ve;document.getElementById('invS0').textContent=productos.length;document.getElementById('invS1').textContent=appConfig.stockAlertActive?cr:'—';document.getElementById('invS2').textContent=pv;document.getElementById('invS3').textContent=`S/${totalCosto.toFixed(0)}`;const invS4=document.getElementById('invS4');if(invS4)invS4.textContent=`S/${totalVenta.toFixed(0)}`;const invS5=document.getElementById('invS5');if(invS5)invS5.textContent=`S/${ganancia.toFixed(0)}`;};
invRender=function(){renderCategorySelects();if(invTab==='critico'&&!appConfig.stockAlertActive)invTab='todos';_baseInvRender();if(!appConfig.stockAlertActive)document.querySelectorAll('#invBody .stock-pill.low').forEach(el=>{el.classList.remove('low');el.classList.add('ok');el.textContent=el.textContent.replace('⚠','✓');});};
function actualizarStockMinPredeterminado(value){appConfig.stockMin=Math.max(0,_naInt(value,5));saveAppState();}
async function aplicarStockMinATodos(){if(isModuleLocked('productos')){toast('Módulo de productos bloqueado','error');return;}if(!confirm(`¿Aplicar stock mínimo ${appConfig.stockMin} a todos los productos?`))return;const backup=_naClone(productos);productos.forEach(p=>p.stockMin=appConfig.stockMin);const persistResult=await saveAllData();if(!_naWasPersisted(persistResult)){productos=backup;await saveAllData();toast('No se pudo aplicar el cambio','error');return;}invRender();posRender();toast('Stock mínimo aplicado a todos','success');}

// Configuración persistente
function _naCfgMetrics(){const locks=_naGetLocks(),validas=ventas.filter(v=>v.fecha===obtenerHoy()&&!v.anulada).length,activeCredits=creditos.filter(cr=>!cr.anulado&&cr.status!=='cancelado'&&cr.monto>cr.pagado).length,protectedCount=Object.values(locks.modules).filter(Boolean).length+(locks.master?1:0)+(locks.readOnly?1:0);return{locks,validas,activeCredits,protectedCount};}
function _naCfgCard(icon,label,value,sub,badge=''){return `<div class="cfg-overview-card"><div class="cfg-overview-top"><div class="cfg-overview-icon">${icon}</div>${badge?`<span class="cfg-overview-badge">${badge}</span>`:''}</div><div class="cfg-overview-label">${label}</div><div class="cfg-overview-value">${value}</div><div class="cfg-overview-sub">${sub}</div></div>`;}
function _naCfgHead(icon,title,sub,pills=''){return `<div class="cfg-screen-head"><div class="cfg-screen-head-main"><div class="cfg-screen-head-icon">${icon}</div><div><div class="cfg-screen-head-title">${title}</div><div class="cfg-screen-head-sub">${sub}</div></div></div><div class="cfg-pill-row">${pills}</div></div>`;}
function _naCfgPill(text,tone=''){return `<span class="cfg-pill ${tone}">${text}</span>`;}
function _naCfgField(label,id,value,placeholder='',type='text',full=false,hint=''){return `<div class="cfg-field ${full?'full':''}"><div class="cfg-field-label">${label}</div>${hint?`<div class="cfg-field-hint">${hint}</div>`:''}<input class="cfg-input" id="${id}" value="${_naEsc(value)}" placeholder="${_naEsc(placeholder)}" type="${type}"></div>`;}
function _naCfgSetting(icon,title,desc,right){return `<div class="cfg-setting"><div class="cfg-setting-main"><div class="cfg-setting-icon">${icon}</div><div><div class="cfg-setting-title">${title}</div><div class="cfg-setting-desc">${desc}</div></div></div><div class="cfg-setting-tail">${right}</div></div>`;}
// Presentation-only disclosures: preserve the original help nodes and controls.
function _naCfgInfoHelp(){
  const cont=document.getElementById('cfgContent');if(!cont)return;
  if(window.innerWidth>=768){
    cont.querySelectorAll('.cfg-help-toggle').forEach(button=>button.remove());
    cont.querySelectorAll('.cfg-help-text').forEach(text=>{text.classList.remove('cfg-help-text','is-open');if(text.dataset.cfgHelpGeneratedId){text.removeAttribute('id');delete text.dataset.cfgHelpGeneratedId;}});
    return;
  }
  const selectors='.cfg-screen-head-sub,.cfg-panel-sub,.cfg-setting-desc,.cfg-field-hint,.cfg-business-note,.cfg-action-desc,.cfg-overview-sub,.cfg-upload-box>.import-note,.credit-policy-field>small';
  cont.querySelectorAll(selectors).forEach((text,index)=>{
    if(text.classList.contains('cfg-help-text')||!text.textContent.trim())return;
    const title=text.previousElementSibling;
    const label=text.closest('.credit-policy-field')?.querySelector('label')||(title?.matches('.cfg-screen-head-title,.cfg-panel-title,.cfg-setting-title,.cfg-field-label,.cfg-action-title')?title:null);
    const context=label?.textContent.trim()||text.closest('.cfg-panel')?.querySelector('.cfg-panel-title')?.textContent.trim()||'Configuración';
    const button=document.createElement('button');button.type='button';button.className='cfg-help-toggle';
    button.setAttribute('aria-label','Información: '+context);button.setAttribute('aria-expanded','false');
    if(!text.id){text.id='cfgHelpText'+index;text.dataset.cfgHelpGeneratedId='true';}button.setAttribute('aria-controls',text.id);text.classList.add('cfg-help-text');
    button.innerHTML='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 11v6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="7.5" r="1" fill="currentColor"/></svg>';
    button.addEventListener('click',()=>{const open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));text.classList.toggle('is-open',open);});
    if(label)label.append(button);else text.before(button);
  });
}
window.addEventListener('resize',_naCfgInfoHelp);
// Keep accordion state only in memory, independently of saved business settings.
const _naCfgAccordionState=new Map();
function _naCfgAccordions(){
  const cont=document.getElementById('cfgContent');if(!cont)return;
  if(window.innerWidth>=768){
    cont.querySelectorAll('.cfg-accordion-panel').forEach(panel=>{
      const heading=panel.querySelector(':scope>.cfg-panel-title'),button=heading?.querySelector('.cfg-accordion-toggle'),body=panel.querySelector(':scope>.cfg-accordion-body');
      if(button){const label=button.querySelector('.cfg-accordion-label');if(label)while(label.firstChild)heading.insertBefore(label.firstChild,button);button.remove();}
      if(body){while(body.firstChild)panel.insertBefore(body.firstChild,body);body.remove();}
      heading?.classList.remove('cfg-accordion-heading');panel.classList.remove('cfg-accordion-panel');
    });
    return;
  }
  cont.querySelectorAll('.cfg-panel').forEach((panel,index)=>{
    if(panel.classList.contains('cfg-accordion-panel'))return;
    const heading=panel.querySelector(':scope>.cfg-panel-title');if(!heading)return;
    const key=currentCfgCategory+':'+heading.textContent.trim()+':'+index;
    const button=document.createElement('button'),label=document.createElement('span'),body=document.createElement('div');
    button.type='button';button.className='cfg-accordion-toggle';label.className='cfg-accordion-label';
    Array.from(heading.childNodes).filter(node=>!(node.nodeType===1&&node.classList.contains('cfg-help-toggle'))).forEach(node=>label.append(node));
    button.append(label);button.insertAdjacentHTML('beforeend','<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    body.className='cfg-accordion-body';body.id='cfgAccordionBody'+index;button.setAttribute('aria-controls',body.id);
    Array.from(panel.childNodes).filter(node=>node!==heading).forEach(node=>body.append(node));
    heading.prepend(button);heading.classList.add('cfg-accordion-heading');panel.append(body);panel.classList.add('cfg-accordion-panel');
    const setOpen=open=>{body.hidden=!open;button.setAttribute('aria-expanded',String(open));_naCfgAccordionState.set(key,open);};
    setOpen(_naCfgAccordionState.get(key)===true);
    button.addEventListener('click',()=>setOpen(body.hidden));
    heading.querySelectorAll('.cfg-help-toggle').forEach(help=>help.addEventListener('click',()=>{if(help.getAttribute('aria-expanded')==='true')setOpen(true);}));
  });
}
window.addEventListener('resize',_naCfgAccordions);
function abrirDisenadorTicket(){tkCurrentVenta={id:'V-000001',operation:'00000001',fecha:obtenerHoy(),hora:nowT(),cajero:appConfig.business?.cajero||'Frank',metodo:'efectivo',recibido:150,vuelto:11.5,anulada:false,items:[{name:'Arroz Costeño',qty:2,precio:7},{name:'Azúcar Rubia',qty:1,precio:6.5},{name:'Leche Gloria',qty:3,precio:5},{name:'Aceite Primor',qty:2,precio:9},{name:'Atún Florida',qty:5,precio:5}]};_naHydrateTicket();const editor=document.getElementById('editorPanel');if(editor)editor.style.display='block';const btn=document.getElementById('btnEditorToggle');if(btn)btn.textContent='👁 Vista previa';document.getElementById('mTicket').classList.add('open');renderTicketPreview();}
renderCfgContent=function(cat){
  const cont=document.getElementById('cfgContent');if(!cont)return;
  const b=_naGetBusiness(),m=_naCfgMetrics(),toggle=(id,key)=>`<div class="cfg-toggle ${appConfig[key]?'active':''}" id="${id}" onclick="toggleCfg('${id}')"><div class="cfg-toggle-knob"></div></div>`,lockToggle=(id,active,fn)=>`<div class="cfg-toggle ${active?'active':''}" id="${id}" onclick="${fn}"><div class="cfg-toggle-knob"></div></div>`;
  const statusText=_naLastPersistOK?'Guardado seguro':'Solo sesión';
  const overview='';
  let html='';
  if(cat==='negocio'){
    html=`${overview}${_naCfgHead('<i class="na-ic na-ic-store" aria-hidden="true"></i>','Perfil del negocio','Completa la información comercial que se mostrará en el sistema y en los comprobantes.',`${_naCfgPill('<i class="na-ic na-ic-pin" aria-hidden="true"></i> Puerto Súngaro','teal')}${_naCfgPill('<i class="na-ic na-ic-save" aria-hidden="true"></i> '+statusText,_naLastPersistOK?'ok':'warn')}`)}<div class="cfg-grid-2"><div class="cfg-panel cfg-hero-card"><div class="cfg-panel-title">🌅 Identidad comercial</div><div class="cfg-panel-sub">Una vista clara para que la configuración no se vea vacía y el sistema se sienta más profesional.</div><div class="cfg-business-hero"><div class="cfg-business-logo">🌅</div><div><div class="cfg-business-title">${_naEsc(b.nombre||'Multiservicios Nuevo Amanecer')}</div><div class="cfg-business-meta"><span><i class="na-ic na-ic-pin" aria-hidden="true"></i> ${_naEsc(b.direccion||'Puerto Súngaro, Huánuco')}</span><span><i class="na-ic na-ic-user" aria-hidden="true"></i> ${_naEsc(b.cajero||'Frank')}</span></div></div></div><div class="cfg-business-note">Estos datos se usan en la cabecera del sistema, tickets, reportes y pantallas internas. Mantenerlos completos da una imagen más sólida del negocio.</div><div class="cfg-status-list"><div class="cfg-status-card"><div class="cfg-status-value">${b.ruc?_naEsc(b.ruc):'Sin registrar'}</div><div class="cfg-status-label">RUC / DNI</div></div><div class="cfg-status-card"><div class="cfg-status-value">${b.telefono?_naEsc(b.telefono):'Sin teléfono'}</div><div class="cfg-status-label">Teléfono</div></div></div></div><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-receipt" aria-hidden="true"></i> Datos principales</div><div class="cfg-panel-sub">Edita la información del negocio con un formato más completo y ordenado.</div><div class="cfg-form-grid" style="margin-top:14px">${_naCfgField('Nombre del negocio','cfgNombre',b.nombre,'Ej. Multiservicios Nuevo Amanecer','text',true)}${_naCfgField('RUC / DNI','cfgRuc',b.ruc,'Número de documento')} ${_naCfgField('Teléfono','cfgTel',b.telefono,'Ej. 987654321')} ${_naCfgField('Dirección','cfgDir',b.direccion,'Ej. Puerto Súngaro, Huánuco','text',true)}</div></div></div><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-users" aria-hidden="true"></i> Cajeros locales</div><div class="cfg-panel-sub">Cada cajero tiene un ID estable para identificar ventas, caja, gastos y cobros.</div>${_naCashierConfigHtml()}</div>`;
  }else if(cat==='pos'){
    html=`${overview}${_naCfgHead('<i class="na-ic na-ic-cart" aria-hidden="true"></i>','Ajustes del punto de venta','Controla cómo vende el sistema: impuestos, stock, validaciones y mayorista.',`${_naCfgPill(appConfig.igvActive?'IGV activo':'IGV inactivo',appConfig.igvActive?'ok':'warn')}${_naCfgPill(appConfig.mayoristaActive?'Mayorista habilitado':'Mayorista desactivado',appConfig.mayoristaActive?'teal':'')}`)}<div class="cfg-grid-2"><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-gear" aria-hidden="true"></i> Reglas de operación</div><div class="cfg-panel-sub">Define el comportamiento del cobro y las validaciones de venta.</div><div class="cfg-setting-list">${_naCfgSetting('<i class="na-ic na-ic-trend" aria-hidden="true"></i>','Aplicar IGV (18%)','Desglosa y controla el impuesto dentro del punto de venta.',toggle('igvToggle','igvActive'))}${_naCfgSetting('<i class="na-ic na-ic-cash" aria-hidden="true"></i>','Impedir ventas bajo costo','Evita vender por debajo del costo cuando el control esté activado.',toggle('margenToggle','margenActive'))}${_naCfgSetting('<i class="na-ic na-ic-alert" aria-hidden="true"></i>','Alertas de stock crítico','Muestra productos con existencias bajas en inventario y resumen.',toggle('stockToggle','stockAlertActive'))}${_naCfgSetting('<i class="na-ic na-ic-cart" aria-hidden="true"></i>','Permitir venta mayorista',_naCanonSaleMode()?'No disponible con CANON: vende por unidades.':'Habilita el modo caja y precios por volumen.',toggle('mayoristaToggle','mayoristaActive'))}</div></div><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-box" aria-hidden="true"></i> Existencias y mínimos</div><div class="cfg-panel-sub">Ajusta el stock mínimo predeterminado y aplica el cambio a todos tus productos.</div><div class="cfg-setting-list">${_naCfgSetting('<i class="na-ic na-ic-box" aria-hidden="true"></i>','Stock mínimo predeterminado','Se usa automáticamente al crear productos nuevos.',`<input class="cfg-mini-input" id="cfgStockMin" value="${appConfig.stockMin}" type="number" min="0" onchange="actualizarStockMinPredeterminado(this.value)">`)}${_naCfgSetting('<i class="na-ic na-ic-swap" aria-hidden="true"></i>','Aplicar a todo el catálogo','Actualiza el mínimo en todos los productos existentes.',`<button class="cfg-inline-action" onclick="aplicarStockMinATodos()">Aplicar ahora</button>`)}${_naCfgSetting('<i class="na-ic na-ic-folder" aria-hidden="true"></i>','Reclasificar productos','Ordena automáticamente bebidas, helados, limpieza, cuidado, tecnología y demás categorías usando el nombre del producto.',`<button class="cfg-inline-action" onclick="reclasificarCatalogo(true)">Reclasificar catálogo</button>`)}</div><div class="cfg-business-note" style="margin-top:14px">Consejo: si manejas abarrotes o bebidas, usa un mínimo conservador para que el sistema te avise antes de quedarte sin stock.</div></div><div class="cfg-panel" style="grid-column:1/-1"><div class="cfg-panel-title"><i class="na-ic na-ic-plus" aria-hidden="true"></i> Venta sin stock y artículo VARIOS</div><div class="cfg-panel-sub">Separa un producto registrado sin existencias de una venta libre que no modifica el inventario.</div><div class="cfg-setting-list">${_naCfgSetting('<i class="na-ic na-ic-box" aria-hidden="true"></i>','Vender producto registrado sin stock',_naCanonSaleMode()?'No disponible con CANON: el servidor rechaza ventas sin stock.':'Permite confirmar la venta y deja el stock negativo para mostrar el faltante real. Desactivado por seguridad de forma predeterminada.',`<div class="cfg-toggle ${_naFreeSaleCfg().allowRegisteredNoStock?'active':''}" id="freeSaleStockToggle" onclick="freeSaleToggleSetting('allowRegisteredNoStock')"><div class="cfg-toggle-knob"></div></div>`)}${_naCfgSetting('<i class="na-ic na-ic-clip" aria-hidden="true"></i>','Permitir venta libre / VARIOS','Agrega un artículo ocasional sin crear producto ni modificar inventario. El Control maestro puede bloquearla.',`<div class="cfg-toggle ${_naFreeSaleCfg().allowGenericSale?'active':''}" id="freeSaleGenericToggle" onclick="freeSaleToggleSetting('allowGenericSale')"><div class="cfg-toggle-knob"></div></div>`)}${_naCfgSetting('<i class="na-ic na-ic-gear" aria-hidden="true"></i>','Acceso rápido','Usa F1–F12 o una secuencia de 2 a 4 letras o números, por ejemplo VS.',`<input class="cfg-mini-input" id="cfgFreeSaleShortcut" value="${_naEsc(_naFreeSaleCfg().shortcut||'F2')}" maxlength="4" onchange="freeSaleSetShortcut(this.value)">`)}${_naCfgSetting('<i class="na-ic na-ic-gear" aria-hidden="true"></i>','Probar venta libre','Abre el POS y muestra el formulario VARIOS sin registrar una venta.',`<button class="cfg-inline-action" onclick="goPage('pagePOS');setTimeout(()=>abrirVentaLibre(),80)">Abrir prueba</button>`)}</div><div class="cfg-business-note" style="margin-top:14px">Una venta libre queda identificada como VARIOS en el historial. Una venta de producto registrado sin stock sí descuenta inventario y puede dejar un valor negativo hasta que ingrese nueva mercadería.</div></div><div class="cfg-panel" style="grid-column:1/-1"><div class="cfg-panel-title">▥ Escáner de código de barras</div><div class="cfg-panel-sub">Detecta automáticamente lectores USB, Bluetooth o inalámbricos que funcionan como teclado y terminan la lectura con Enter.</div><div class="cfg-setting-list">${_naCfgSetting('<i class="na-ic na-ic-phone" aria-hidden="true"></i>','Lectura automática HID','Escucha códigos rápidos únicamente dentro del Punto de Venta y no interfiere con formularios o cobros abiertos.',`<div class="cfg-toggle ${_naScannerCfg().enabled?'active':''}" id="scannerEnabledToggle" onclick="scannerToggleSetting('enabled')"><div class="cfg-toggle-knob"></div></div>`)}${_naCfgSetting('<i class="na-ic na-ic-bell" aria-hidden="true"></i>','Sonido de confirmación','Emite un tono corto cuando la lectura es correcta o cuando el código presenta un problema.',`<div class="cfg-toggle ${_naScannerCfg().sound?'active':''}" id="scannerSoundToggle" onclick="scannerToggleSetting('sound')"><div class="cfg-toggle-knob"></div></div>`)}${_naCfgSetting('<i class="na-ic na-ic-zap" aria-hidden="true"></i>','Velocidad máxima entre teclas','Umbral para distinguir un escáner de la escritura humana. Recomendado: 65 ms.',`<input class="cfg-mini-input" id="cfgScannerInterval" value="${_naScannerCfg().maxIntervalMs}" type="number" min="20" max="150" onchange="scannerSetNumber('maxIntervalMs',this.value)">`)}${_naCfgSetting('<i class="na-ic na-ic-clip" aria-hidden="true"></i>','Longitud mínima de detección','Cantidad mínima de caracteres para considerar una entrada rápida como lectura automática.',`<input class="cfg-mini-input" id="cfgScannerMinLength" value="${_naScannerCfg().minLength}" type="number" min="1" max="32" onchange="scannerSetNumber('minLength',this.value)">`)}${_naCfgSetting('<i class="na-ic na-ic-gear" aria-hidden="true"></i>','Probar escáner','Abre el POS y deja el buscador preparado para una lectura de prueba.',`<button class="cfg-inline-action" onclick="scannerFocusTest()">Abrir prueba</button>`)}</div><div class="cfg-business-note" style="margin-top:14px">No requiere emparejamiento dentro del navegador: el lector debe estar configurado como teclado HID y enviar Enter al finalizar. La conexión física se administra desde Android, Windows o el propio escáner.</div></div></div>`;
  }else if(cat==='apariencia'){
    // Etapa 2: el panel Apariencia (85-125 %, por aparato) lo agrega config-e2.js; el bloque viejo se quitó (modo oscuro sigue en la barra superior).
    html=`${overview}`;
  }else if(cat==='ticket'){
    html=`${overview}${_naCfgHead('<i class="na-ic na-ic-receipt" aria-hidden="true"></i>','Ticket y comprobante','Configura el mensaje final, la impresión automática y abre el diseñador visual del ticket.',`${_naCfgPill(appConfig.printAuto?'Impresión automática':'Impresión manual',appConfig.printAuto?'ok':'warn')}${_naCfgPill(appConfig.ticket.ancho||'80mm','teal')}`)}<div class="cfg-grid-2"><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-receipt" aria-hidden="true"></i> Ajustes rápidos</div><div class="cfg-panel-sub">Controles básicos para tu comprobante de venta.</div><div class="cfg-setting-list">${_naCfgSetting('<i class="na-ic na-ic-receipt" aria-hidden="true"></i>','Imprimir automáticamente','Al confirmar una venta, se abrirá el ticket sin intervención manual.',toggle('printToggle','printAuto'))}<div class="cfg-setting"><div class="cfg-setting-main"><div class="cfg-setting-icon"><i class="na-ic na-ic-file" aria-hidden="true"></i></div><div><div class="cfg-setting-title">Mensaje de pie</div><div class="cfg-setting-desc">Mensaje que aparecerá al final del comprobante.</div></div></div><div class="cfg-setting-tail" style="width:min(100%,320px)"><input class="cfg-input" id="cfgMensaje" value="${_naEsc(appConfig.ticket.pie)}" style="margin-left:0;width:100%;text-align:left"></div></div></div></div><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-gear" aria-hidden="true"></i> Diseñador del ticket</div><div class="cfg-panel-sub">Abre la vista previa completa para personalizar ancho, fuente y estructura del comprobante.</div><div class="cfg-preview-card"><div style="font-size:13px;font-weight:800;color:var(--dark)">Formato actual</div><div style="font-size:11px;color:var(--slate);font-weight:700;margin-top:4px">${_naEsc(appConfig.ticket.ancho)} · ${_naEsc(appConfig.ticket.tamano==='custom'?(appConfig.ticket.previewCustomPx||11)+'px':appConfig.ticket.tamano)} · ${_naEsc(appConfig.ticket.align)}</div><div class="cfg-business-note" style="margin-top:12px">Desde el diseñador puedes ajustar el ticket y, al imprimir en Android, compartirlo con una app Bluetooth, usar USB/OTG compatible o abrir la impresión del sistema.</div><button class="cfg-inline-action" style="margin-top:14px;width:100%" onclick="abrirDisenadorTicket()"><i class="na-ic na-ic-receipt" aria-hidden="true"></i> Abrir diseñador del ticket</button></div></div></div>${globalThis.NAReceiptUI?.settingsHtml()||''}`;
  }else if(cat==='control'){
    const l=m.locks,s=_naSecurity,pinOn=s.pinEnabled,lockedModules=Object.values(l.modules).filter(Boolean).length;
    const moduleToggle=(id,key,icon,title,desc)=>_naCfgSetting(icon,title,desc,lockToggle(id,l.modules[key],`toggleModuleLock('${key}')`));
    const secToggle=(id,path,title,desc,icon)=>_naCfgSetting(icon,title,desc,_naSecurityToggle(id,Boolean(_naGetSecurityPath(path)),`securityToggleOption('${path}')`));
    html=`${_naCfgHead('<i class="na-ic na-ic-shield" aria-hidden="true"></i>','Control maestro y seguridad','Administra permisos, PIN, bloqueo automático y acciones sensibles desde un solo centro de control.',`${_naCfgPill(pinOn?'PIN activo':'Sin PIN',pinOn?'ok':'warn')}${_naCfgPill(securityIsLocked()?'Sesión bloqueada':'Sesión activa',securityIsLocked()?'red':'teal')}${_naCfgPill(`${lockedModules} módulos protegidos`,lockedModules?'warn':'ok')}`)}
    <div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-zap" aria-hidden="true"></i> Acciones rápidas</div><div class="cfg-panel-sub">Bloquea el sistema inmediatamente, configura el PIN o revisa el historial de seguridad.</div><div class="sec-actions"><button class="sec-action-btn danger" onclick="securityLockNow()"><i class="na-ic na-ic-lock" aria-hidden="true"></i> Bloquear ahora</button><button class="sec-action-btn" onclick="securityChangePin()">${pinOn?'<i class="na-ic na-ic-key" aria-hidden="true"></i> Cambiar PIN':'<i class="na-ic na-ic-key" aria-hidden="true"></i> Crear PIN'}</button><button class="sec-action-btn secondary" onclick="securityExportLog()"><i class="na-ic na-ic-download" aria-hidden="true"></i> Exportar registro</button></div><div class="sec-summary"><div class="sec-summary-card"><strong>${pinOn?'Activo':'Inactivo'}</strong><span>PIN maestro</span></div><div class="sec-summary-card"><strong>${s.autoLockMinutes?s.autoLockMinutes+' min':'Nunca'}</strong><span>Bloqueo automático</span></div><div class="sec-summary-card"><strong>${s.logs.length}</strong><span>Eventos registrados</span></div></div></div>
    <div class="cfg-grid-2"><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-lock" aria-hidden="true"></i> Acceso y sesión</div><div class="cfg-panel-sub">Protege el sistema con un PIN local y bloqueo por inactividad.</div><div class="cfg-setting-list">${_naCfgSetting('<i class="na-ic na-ic-clip" aria-hidden="true"></i>','Protección con PIN','Solicita un PIN para desbloquear y autorizar acciones sensibles.',_naSecurityToggle('secPinToggle',pinOn,'securityTogglePin()'))}${_naCfgSetting('<i class="na-ic na-ic-clock" aria-hidden="true"></i>','Bloqueo por inactividad','Bloquea automáticamente la pantalla cuando no se utiliza el sistema.',`<select class="sec-select" onchange="securitySetAutoLock(this.value)" ${pinOn?'':'disabled'}><option value="0" ${s.autoLockMinutes==0?'selected':''}>Nunca</option><option value="1" ${s.autoLockMinutes==1?'selected':''}>1 minuto</option><option value="5" ${s.autoLockMinutes==5?'selected':''}>5 minutos</option><option value="10" ${s.autoLockMinutes==10?'selected':''}>10 minutos</option><option value="15" ${s.autoLockMinutes==15?'selected':''}>15 minutos</option><option value="30" ${s.autoLockMinutes==30?'selected':''}>30 minutos</option></select>`)}${secToggle('secPinLocks','requirePin.locks','PIN para cambiar bloqueos','Evita que otra persona desactive las protecciones sin autorización.','<i class="na-ic na-ic-clip" aria-hidden="true"></i>')}${secToggle('secPinConfig','requirePin.configuracion','PIN para modificar configuración','Solicita autorización antes de cambiar ajustes del sistema.','<i class="na-ic na-ic-gear" aria-hidden="true"></i>')}${_naCfgSetting('<i class="na-ic na-ic-bell" aria-hidden="true"></i>','Avisos de confirmación','Activa o desactiva avisos visuales para acciones normales. Los reseteos seguirán pidiendo confirmación y clave.',toggle('alertsToggle','alertsEnabled'))}</div></div><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-lock" aria-hidden="true"></i> Bloqueos generales</div><div class="cfg-panel-sub">Aplica restricciones amplias para revisar el sistema sin modificar datos.</div><div class="cfg-setting-list">${_naCfgSetting('<i class="na-ic na-ic-lock" aria-hidden="true"></i>','Bloquear edición crítica','Bloquea las operaciones de edición en todos los módulos.',lockToggle('cfgMasterLock',l.master,'toggleMasterLock()'))}${_naCfgSetting('<i class="na-ic na-ic-eye" aria-hidden="true"></i>','Modo solo lectura','Permite navegar y consultar información, pero no registrar cambios.',lockToggle('cfgReadOnly',l.readOnly,'toggleReadOnly()'))}</div></div></div>
    <div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-box" aria-hidden="true"></i> Protección por módulos</div><div class="cfg-panel-sub">Selecciona exactamente qué áreas pueden modificarse.</div><div class="sec-control-grid" style="margin-top:14px">${moduleToggle('cfgLockProductos','productos','<i class="na-ic na-ic-box" aria-hidden="true"></i>','Productos e inventario','Bloquea creación, edición, importación de stock y movimientos.')}${moduleToggle('cfgLockVentas','ventas','<i class="na-ic na-ic-bars" aria-hidden="true"></i>','Ventas y POS','Impide registrar, cancelar o modificar ventas.')}${moduleToggle('cfgLockCaja','caja','<i class="na-ic na-ic-cash" aria-hidden="true"></i>','Caja del día','Bloquea apertura, movimientos y cierre de caja.')}${moduleToggle('cfgLockClientes','clientes','<i class="na-ic na-ic-users" aria-hidden="true"></i>','Clientes y créditos','Protege clientes, cuentas por cobrar y abonos.')}${moduleToggle('cfgLockGastos','gastos','<i class="na-ic na-ic-receipt" aria-hidden="true"></i>','Gastos y egresos','Impide registrar gastos o modificar egresos.')}${moduleToggle('cfgLockImportacion','importacion','<i class="na-ic na-ic-in" aria-hidden="true"></i>','Importación y respaldo','Bloquea importaciones y restauraciones de respaldo.')}${moduleToggle('cfgLockConfiguracion','configuracion','<i class="na-ic na-ic-gear" aria-hidden="true"></i>','Configuración general','Impide modificar negocio, POS, apariencia y tickets.')}</div></div>
    <div class="cfg-grid-2"><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-receipt" aria-hidden="true"></i> Acciones sensibles</div><div class="cfg-panel-sub">Define cuándo debe solicitarse el PIN maestro.</div><div class="cfg-setting-list">${secToggle('secPinAnular','requirePin.anularVenta','PIN para anular ventas','Solicita autorización antes de reponer stock y devolver dinero.','<i class="na-ic na-ic-ban" aria-hidden="true"></i>')}${secToggle('secPinCerrar','requirePin.cerrarCaja','PIN para cerrar caja','Protege el arqueo y cierre del turno.','<i class="na-ic na-ic-lock" aria-hidden="true"></i>')}${secToggle('secPinReset','requirePin.reset','PIN para resetear datos','Evita eliminaciones accidentales o no autorizadas.','<i class="na-ic na-ic-alert" aria-hidden="true"></i>')}${secToggle('secPinImport','requirePin.importar','PIN para importar o restaurar','Protege el catálogo y los respaldos completos.','<i class="na-ic na-ic-in" aria-hidden="true"></i>')}</div></div><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-tag" aria-hidden="true"></i> Reglas comerciales</div><div class="cfg-panel-sub">Controla descuentos y productos creados manualmente durante la venta.</div><div class="cfg-setting-list">${secToggle('secAllowDiscount','rules.allowDiscounts','Permitir descuentos','Habilita o bloquea el descuento global del carrito.','<i class="na-ic na-ic-cashout" aria-hidden="true"></i>')}${secToggle('secPinDiscount','requirePin.descuentos','PIN para aplicar descuentos','Solicita autorización cada vez que se aplique un descuento.','<i class="na-ic na-ic-key" aria-hidden="true"></i>')}${_naCfgSetting('<i class="na-ic na-ic-down" aria-hidden="true"></i>','Descuento máximo','Límite máximo permitido por operación.',`<input class="sec-number" type="number" min="0" max="99" value="${Number(s.rules.maxDiscount)||0}" onchange="securitySetMaxDiscount(this.value)">`)}${secToggle('secGeneric','rules.allowGenericProducts','Permitir productos genéricos','Permite vender un código no registrado ingresando nombre y precio manualmente.','<i class="na-ic na-ic-clip" aria-hidden="true"></i>')}${secToggle('secAudit','rules.auditEnabled','Registrar actividad','Guarda cambios de seguridad, bloqueos e intentos fallidos.','<i class="na-ic na-ic-receipt" aria-hidden="true"></i>')}</div></div></div>
    <div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-clock" aria-hidden="true"></i> Registro de seguridad</div><div class="cfg-panel-sub">Últimos eventos registrados en este dispositivo.</div><div class="sec-log-list">${_naSecurityLogHtml()}</div><div class="sec-actions"><button class="sec-action-btn secondary" onclick="securityExportLog()"><i class="na-ic na-ic-download" aria-hidden="true"></i> Descargar registro</button><button class="sec-action-btn danger" onclick="securityClearLog()"><i class="na-ic na-ic-trash" aria-hidden="true"></i> Limpiar registro</button></div></div>`;
  }else if(cat==='reseteo'){
    html=`${overview}${_naCfgHead('<i class="na-ic na-ic-alert" aria-hidden="true"></i>','Zona de reseteo','Usa estas acciones con cuidado. Están agrupadas visualmente para que el sistema se vea más claro y profesional.',`${_naCfgPill('Acciones destructivas','red')}`)}<div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-alert" aria-hidden="true"></i> Reinicio por módulos</div><div class="cfg-panel-sub">Borra únicamente el área que necesites sin afectar el resto del sistema.</div><div class="cfg-action-grid"><div class="cfg-action-card danger"><div class="cfg-action-title"><i class="na-ic na-ic-box" aria-hidden="true"></i> Productos</div><div class="cfg-action-desc">Elimina inventario, categorías y existencias.</div><button class="cfg-save-btn" onclick="resetModule('productos')" style="background:var(--red);padding:11px">Resetear productos</button></div><div class="cfg-action-card danger"><div class="cfg-action-title"><i class="na-ic na-ic-users" aria-hidden="true"></i> Clientes</div><div class="cfg-action-desc">Elimina clientes y créditos asociados.</div><button class="cfg-save-btn" onclick="resetModule('clientes')" style="background:var(--red);padding:11px">Resetear clientes</button></div><div class="cfg-action-card danger"><div class="cfg-action-title"><i class="na-ic na-ic-cash" aria-hidden="true"></i> Caja / Gastos</div><div class="cfg-action-desc">Borra caja del día y movimientos de gastos.</div><div style="display:grid;gap:8px"><button class="cfg-save-btn" onclick="resetModule('caja')" style="background:var(--red);padding:11px">Resetear caja</button><button class="cfg-save-btn" onclick="resetModule('gastos')" style="background:var(--red);padding:11px">Resetear gastos</button></div></div><div class="cfg-action-card danger" style="grid-column:1/-1;background:#7f1d1d;color:#fff;border-color:#7f1d1d"><div class="cfg-action-title" style="color:#fff"><i class="na-ic na-ic-alert" aria-hidden="true"></i> Reinicio total</div><div class="cfg-action-desc" style="color:rgba(255,255,255,.85)">Borra todo el sistema: productos, ventas, clientes, caja y configuración operativa.</div><button class="cfg-save-btn" onclick="resetModule('todo')" style="background:#111827;padding:12px">Resetear todo</button></div></div></div>`;
  }else if(cat==='importar'){
    html=`${overview}${_naCfgHead('<i class="na-ic na-ic-in" aria-hidden="true"></i>','Importación y respaldo','Administra el catálogo desde archivos y crea copias de seguridad del sistema completo.',`${_naCfgPill('CSV y Excel','teal')}${_naCfgPill('Respaldo JSON','ok')}`)}<div class="cfg-grid-2"><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-box" aria-hidden="true"></i> Importar productos</div><div class="cfg-panel-sub">Carga tu catálogo desde CSV, XLSX o XLS. El sistema intentará reconocer las columnas principales.</div><div class="cfg-upload-box"><input type="file" id="importFile" accept=".csv,.xlsx,.xls" onchange="clearProductImportPreview()"><div class="import-note">Primero se analiza el archivo. Ningún producto se modifica hasta que revises el resumen y confirmes la importación.</div><div class="import-action-grid"><button class="cfg-save-btn" onclick="importProducts()"><i class="na-ic na-ic-search" aria-hidden="true"></i> Analizar archivo</button><button class="cfg-save-btn" onclick="downloadProductTemplate()" style="background:var(--slate)"><i class="na-ic na-ic-file" aria-hidden="true"></i> Descargar plantilla</button><button class="cfg-save-btn" onclick="exportProductsExcel()" style="background:var(--blue)"><i class="na-ic na-ic-download" aria-hidden="true"></i> Exportar productos</button><button class="cfg-save-btn" onclick="cargarCatalogoInicial()" style="background:var(--slate)"><i class="na-ic na-ic-box" aria-hidden="true"></i> Catálogo inicial</button></div><div id="importPreview" class="import-preview"></div><div class="import-note">Columnas reconocidas: nombre, SKU, código principal, hasta 10 códigos alternativos, descripción, marca, categoría, unidad, costo, precio, precio por caja, unidades por caja, stock, stock mínimo, vencimiento, control de inventario e IGV.</div></div></div><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-save" aria-hidden="true"></i> Respaldo completo</div><div class="cfg-panel-sub">Descarga un respaldo de todo el sistema o restaura uno existente.</div><div class="cfg-upload-box"><button class="cfg-save-btn" onclick="exportarRespaldo()"><i class="na-ic na-ic-download" aria-hidden="true"></i> Descargar respaldo JSON</button><input type="file" id="backupFile" accept=".json"><button class="cfg-save-btn" onclick="importarRespaldo()" style="background:var(--blue)"><i class="na-ic na-ic-upload" aria-hidden="true"></i> Restaurar respaldo</button></div></div></div>`;
  }else if(cat==='info'){
    html=`${overview}${_naCfgHead('ℹ️','Información del sistema','Consulta un resumen del estado actual para que la sección de configuración se sienta como un panel completo.',`${_naCfgPill('v32.0 estable','teal')}${_naCfgPill(_naLastPersistOK?'Guardado activo':'Solo sesión',_naLastPersistOK?'ok':'warn')}`)}<div class="cfg-grid-2"><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-bars" aria-hidden="true"></i> Estado general</div><div class="cfg-panel-sub">Resumen operativo del sistema local.</div><div class="cfg-info-list"><div class="cfg-info-row"><span>Versión del sistema</span><span>v32.0 estable</span></div><div class="cfg-info-row"><span>Productos registrados</span><span id="cfgTotalProds">${productos.length}</span></div><div class="cfg-info-row"><span>Clientes registrados</span><span id="cfgTotalClis">${clientes.length}</span></div><div class="cfg-info-row"><span>Ventas del día</span><span id="cfgTotalVentas">${m.validas}</span></div><div class="cfg-info-row"><span>Funcionamiento</span><span><i class="na-ic na-ic-phone" aria-hidden="true"></i> Modo local</span></div><div class="cfg-info-row"><span>Guardado</span><span>${statusText}</span></div></div></div><div class="cfg-panel"><div class="cfg-panel-title"><i class="na-ic na-ic-star" aria-hidden="true"></i> Recomendaciones</div><div class="cfg-panel-sub">Buenas prácticas para que el sistema se mantenga estable.</div><div class="cfg-business-note">• Guarda cambios importantes desde el botón superior.<br>• Descarga un respaldo JSON antes de importar o resetear.<br>• Si usas muchas imágenes, respalda periódicamente para evitar pérdidas.<br>• Mantén el RUC, dirección y cajero correctamente configurados para tickets y reportes.</div></div></div>`;
  }else html='<div class="empty-state"><p>Selecciona una categoría</p></div>';
  cont.innerHTML=html;
  if(cat==='apariencia'&&document.getElementById('cfgFontSize')){document.getElementById('cfgFontSize').value=appConfig.appearance.fontSize;document.querySelectorAll('.color-dot').forEach(d=>d.classList.toggle('active',d.dataset.color===appConfig.appearance.accent));}
  const sideP=document.getElementById('cfgSideMetricProducts');if(sideP)sideP.textContent=productos.length;
  const sideC=document.getElementById('cfgSideMetricClients');if(sideC)sideC.textContent=clientes.length;
  cfgUpdateStats();
};
function toggleCfgMenu(force){const page=document.getElementById('pageConfig');if(!page)return;const shouldOpen=typeof force==='boolean'?force:!page.classList.contains('cfg-menu-open');if(window.innerWidth>960&&typeof force!=='boolean')return;page.classList.toggle('cfg-menu-open',shouldOpen);document.documentElement.classList.toggle('cfg-menu-lock',shouldOpen&&window.innerWidth<=960);}window.addEventListener('resize',()=>{const mobile=window.innerWidth<=960,configActive=document.getElementById('pageConfig')?.classList.contains('active'),moduleIds=['pageInventario','pageClientes','pageVentas','pageCaja','pageGastos'],moduleActive=moduleIds.some(id=>document.getElementById(id)?.classList.contains('active')),moduleMobile=window.innerWidth<=700&&moduleActive;document.documentElement.classList.toggle('config-page-scroll',mobile&&configActive);document.body.classList.toggle('config-page-scroll',mobile&&configActive);document.body.classList.toggle('module-mobile-scroll',moduleMobile);if(!mobile){document.getElementById('pageConfig')?.classList.remove('cfg-menu-open');document.documentElement.classList.remove('cfg-menu-lock');}});
switchCfgCategory=function(cat){_naCaptureVisibleConfig();currentCfgCategory=cat;storage.setItem('na_cfg_category',cat);document.querySelectorAll('.cfg-cat-btn').forEach(btn=>btn.classList.toggle('active',btn.dataset.cfgcat===cat));renderCfgContent(cat);if(window.innerWidth<=960){toggleCfgMenu(false);requestAnimationFrame(()=>window.scrollTo(0,0));}saveAppState();};
guardarConfig=async function(){_naCaptureVisibleConfig();_naSaveTicketSettings();_naApplyConfigUI();const result=await saveAppState();if(_naWasPersisted(result)){toast('Configuración guardada','success');return true;}toast(result?.temporary?'La configuración solo quedó guardada en esta pestaña. Activa el almacenamiento del navegador para conservarla al recargar.':'No se pudo guardar la configuración de forma permanente','error');return false;};
toggleCfg=function(id){const map={igvToggle:'igvActive',margenToggle:'margenActive',stockToggle:'stockAlertActive',printToggle:'printAuto',mayoristaToggle:'mayoristaActive',alertsToggle:'alertsEnabled'},key=map[id];if(!key)return;const next=!appConfig[key];if(key==='mayoristaActive'&&!next){const boxes=cart.filter(i=>_naUnitsPerQty(i)>1);if(boxes.length&&!confirm(`Hay ${boxes.length} caja(s) en el carrito. Se retirarán al desactivar mayorista. ¿Continuar?`))return;cart=cart.filter(i=>_naUnitsPerQty(i)===1);modoMayorista=false;}appConfig[key]=next;if(key==='stockAlertActive'&&!next&&invTab==='critico')invTab='todos';_naApplyConfigUI();renderCfgContent(currentCfgCategory);posRender();posUpdateCart();invRender();updateDashboard();saveAppState();};
applyFontSize=function(){_naCaptureVisibleConfig();_naApplyConfigUI();saveAppState();};
setAccent=function(element,color,dark){appConfig.appearance.accent=color;appConfig.appearance.accentDark=dark;document.querySelectorAll('.color-dot').forEach(d=>d.classList.remove('active'));element?.classList.add('active');_naApplyConfigUI();saveAppState();};
restoreCfgToggles=function(){const map={igvToggle:appConfig.igvActive,margenToggle:appConfig.margenActive,stockToggle:appConfig.stockAlertActive,printToggle:appConfig.printAuto,mayoristaToggle:appConfig.mayoristaActive,darkToggle:document.body.classList.contains('dark')};Object.entries(map).forEach(([id,v])=>setToggle(id,!!v));loadMasterConfig();};
toggleDark=function(){window.NA_THEME.toggle();saveAppState();toast(window.NA_THEME.isDark()?'Modo noche activado':'Modo día activado');};

toggleMasterLock=function(){if(!_naAuthorize('locks','Cambiar bloqueo de edición crítica'))return;const next=storage.getItem(LOCK_KEYS.master)!=='true';storage.setItem(LOCK_KEYS.master,next);_naAudit(next?'Bloqueo maestro activado':'Bloqueo maestro desactivado');renderCfgContent('control');saveAppState();toast(next?'🔒 Edición crítica bloqueada':'🔓 Edición crítica habilitada');};
toggleReadOnly=function(){if(!_naAuthorize('locks','Cambiar modo solo lectura'))return;const next=storage.getItem(LOCK_KEYS.readOnly)!=='true';storage.setItem(LOCK_KEYS.readOnly,next);_naAudit(next?'Modo solo lectura activado':'Modo edición activado');renderCfgContent('control');saveAppState();toast(next?'👁️ Modo solo lectura activado':'✏️ Modo edición activado');};
toggleModuleLock=function(module){const key=LOCK_KEYS.modules[module];if(!key)return;if(!_naAuthorize('locks',`Cambiar protección de ${module}`))return;const next=storage.getItem(key)!=='true';storage.setItem(key,next);_naAudit(next?'Módulo protegido':'Módulo desbloqueado',module);renderCfgContent('control');saveAppState();toast(next?`🔒 Módulo ${module} protegido`:`🔓 Módulo ${module} desbloqueado`);};
resetModule=async function(modulo){
  const blocked=modulo==='todo'?(isModuleLocked('productos')||isModuleLocked('ventas')||isModuleLocked('caja')):isModuleLocked(modulo);
  if(blocked){toast('Desbloquea el sistema antes de borrar datos','error');return;}
  const labels={productos:'productos y stock',clientes:'clientes y créditos',caja:'movimientos y apertura de caja',gastos:'gastos',todo:'TODOS los datos'};
  if(!labels[modulo]||!await _naConfirmAction(`¿Borrar ${labels[modulo]}?`,{title:'Confirmar reseteo',subtitle:'Esta operación modificará los datos guardados.',icon:'⚠️',danger:true,okText:'Borrar'}))return;
  if(modulo==='todo'&&!await _naConfirmAction('Confirma nuevamente: esta acción no se puede deshacer.',{title:'Reinicio total',subtitle:'Se eliminarán todos los módulos operativos.',icon:'🚨',danger:true,okText:'Eliminar todo'}))return;
  const backup=_naBuildSnapshot();
  if(modulo==='productos')productos=[];
    if(modulo==='clientes'){clientes=[];creditos=[];}
  if(modulo==='caja'){cajMovs=[];cajEstado={abierta:false,fondo:0,cajero:'',cajeroNombre:'',cajeroId:null,hora:'',hora24:'',fechaApertura:obtenerHoy(),cerrada:true,horaCierre:null,horaCierre24:null,sessionId:null};}
  if(modulo==='gastos')gastos=[];
  if(modulo==='todo'){productos=[];clientes=[];creditos=[];gastos=[];cajMovs=[];cashClosures=[];cajEstado={abierta:false,fondo:0,cajero:'',cajeroNombre:'',cajeroId:null,hora:'',hora24:'',fechaApertura:obtenerHoy(),cerrada:true,horaCierre:null,horaCierre24:null,sessionId:null};}
  cart=[];
  const persistResult=await saveAllData();
  if(!_naWasPersisted(persistResult)){
    _naApplySnapshot(backup);await saveAllData();toast('No se pudo guardar el reseteo','error');return;
  }
  if(modulo==='productos'||modulo==='todo')_naMarkCatalogState({seeded:false,suppressed:true});
  posUpdateCart();invRender();cliRender();ventasRender();cajRender();gasRender();cfgUpdateStats();updateDashboard();
  toast('Datos eliminados','success');
};

// Importación robusta CSV/Excel
function _naParseCSV(text){
  const source=String(text??'').replace(/^\uFEFF/,'');
  const first=(source.split(/\r?\n/,1)[0]||'');
  const counts={';':(first.match(/;/g)||[]).length,',':(first.match(/,/g)||[]).length,'\t':(first.match(/\t/g)||[]).length};
  const delimiter=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0]||',';
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<source.length;i++){
    const ch=source[i],next=source[i+1];
    if(ch==='"'){
      if(quoted&&next==='"'){field+='"';i++;}else quoted=!quoted;
    }else if(ch===delimiter&&!quoted){row.push(field);field='';}
    else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&next==='\n')i++;row.push(field);if(row.some(v=>String(v).trim()!==''))rows.push(row);row=[];field='';}
    else field+=ch;
  }
  row.push(field);if(row.some(v=>String(v).trim()!==''))rows.push(row);return rows;
}
function _naHeader(value){return sinTildes(String(value??'').toLowerCase()).replace(/[^a-z0-9]+/g,' ').trim();}
function _naStableSku(name){let h=0;for(const ch of sinTildes(name.toUpperCase()))h=(h*31+ch.charCodeAt(0))>>>0;return`IMP-${h.toString(36).toUpperCase()}`;}
function _naImportDate(value){if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);if(typeof value==='number'&&Number.isFinite(value)&&value>0){if(typeof XLSX!=='undefined'&&XLSX.SSF?.parse_date_code){const d=XLSX.SSF.parse_date_code(value);if(d)return`${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;}const d=new Date(Date.UTC(1899,11,30)+Math.round(value*86400000));if(!Number.isNaN(d.getTime()))return d.toISOString().slice(0,10);}const s=_naClean(value);let m=s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);if(m){let y=Number(m[3]);if(y<100)y+=2000;return`${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;}return/^\d{4}-\d{2}-\d{2}/.test(s)?s.slice(0,10):null;}

// NUEVO FASE 2: importación analizada antes de modificar el catálogo.
const _NA_IMPORT_MAX_BYTES=8*1024*1024,_NA_IMPORT_MAX_ROWS=20000;
let _naPendingProductImport=null,_naLastImportReport=null;
const _NA_IMPORT_ALIASES={
  name:['nombre','producto','name','nombre producto'],sku:['sku','codigo sku','codigo interno'],barcode:['codigo de barras','codigo barras','barcode','ean','ean 13'],altCodes:['codigos alternativos','codigo alternativo','codigos de barras alternativos','barcodes alternativos'],description:['descripcion','detalle','descripcion producto'],brand:['marca','brand'],cat:['categoria','category'],unit:['unidad','unidad de venta','unidad venta'],purchaseUnit:['unidad de compra','unidad compra','presentacion compra'],purchaseFactor:['unidades por presentacion','factor compra','cantidad por presentacion','contenido por compra'],cost:['costo','coste','cost'],price:['precio','precio venta','precio unitario','price'],stock:['stock','existencia','cantidad stock'],min:['stock minimo','minimo','stock min'],due:['vencimiento','fecha vencimiento','caducidad'],icon:['icono','emoji'],boxPrice:['precio caja','precio por caja','precio mayorista'],boxUnits:['unidades caja','unidades por caja','cantidad por caja'],inventory:['control inventario','control de inventario','maneja stock'],igv:['incluye igv','igv']
};
function _naImportColumnMap(headers){const map={};for(const [key,aliases] of Object.entries(_NA_IMPORT_ALIASES)){map[key]=-1;for(const alias of aliases){const index=headers.indexOf(alias);if(index>=0){map[key]=index;break;}}}return map;}
function _naImportBool(value,fallback=true){if(value===undefined||value===null||String(value).trim()==='')return fallback;if(typeof value==='boolean')return value;const normalized=sinTildes(String(value).trim().toLowerCase());if(['si','sí','true','1','activo','activa','controlado','controlada'].includes(normalized))return true;if(['no','false','0','inactivo','inactiva','sin control'].includes(normalized))return false;return fallback;}
function _naImportUnit(value){const raw=sinTildes(_naClean(value).toLowerCase());const allowed=['unidad','paquete','caja','botella','lata','bolsa','kilogramo','gramo','litro','mililitro','docena','rollo','servicio','otro'];if(allowed.includes(raw))return raw;if(raw==='und'||raw==='unid'||raw==='pieza')return'unidad';if(raw==='kg'||raw==='kilo'||raw==='kilos')return'kilogramo';if(raw==='g'||raw==='gr')return'gramo';if(raw==='l'||raw==='lt')return'litro';if(raw==='ml')return'mililitro';return'unidad';}

function _naImportPurchaseUnit(value){const raw=sinTildes(_naClean(value).toLowerCase());const allowed=['unidad','caja','paquete','sixpack','fardo','docena','bolsa','otro'];if(allowed.includes(raw))return raw;if(['und','unid','pieza'].includes(raw))return'unidad';if(['six pack','six-pack','pack 6'].includes(raw))return'sixpack';return'otro';}
function _naImportCategory(value,name){if(!String(value??'').trim())return _naClassifyProductCategory(name,'abarrotes');const raw=sinTildes(_naClean(value).toLowerCase()),categories=_naAllCategories();const exact=categories.find(c=>sinTildes(c.value.toLowerCase())===raw||sinTildes(c.label.toLowerCase())===raw);if(exact)return exact.value;return _naClassifyProductCategory(name,raw);}
function _naSplitImportCodes(value,limit=NA_MAX_ALT_BARCODES){const seen=new Set(),out=[];String(value??'').split(/[|;,\n\r]+/).forEach(part=>{const code=_naClean(part);const key=code.toLowerCase();if(code&&!seen.has(key)&&out.length<limit){seen.add(key);out.push(code);}});return out;}
function _naCatalogCodeOwner(list,code,excludeId=null){const key=_naClean(code).toLowerCase();if(!key)return null;return list.find(p=>String(p.id)!==String(excludeId)&&[p.sku,p.barcode,..._naProductAltCodes(p)].some(item=>_naClean(item).toLowerCase()===key))||null;}
function _naNextImportProductId(usedIds){let id=Date.now();while(usedIds.has(String(id)))id++;usedIds.add(String(id));return id;}
function _naBuildProductImportPlan(rows){
  if(!Array.isArray(rows)||rows.length<2)throw new Error('El archivo está vacío o no contiene filas de productos');
  if(rows.length-1>_NA_IMPORT_MAX_ROWS)throw new Error(`El archivo supera el límite de ${_NA_IMPORT_MAX_ROWS} productos`);
  const headers=rows[0].map(_naHeader),idx=_naImportColumnMap(headers);
  if(idx.name<0||idx.price<0)throw new Error('Se requieren las columnas Nombre y Precio');
  const working=_naClone(productos),usedIds=new Set(working.map(p=>String(p.id))),touchedIds=new Set(),actions=[],warnings=[];
  let added=0,updated=0,skipped=0;
  for(let r=1;r<rows.length;r++){
    const row=rows[r]||[],get=key=>idx[key]>=0?row[idx[key]]:undefined,blank=value=>value===undefined||value===null||String(value).trim()==='',name=_naClean(get('name'));
    if(!name){skipped++;warnings.push(`Fila ${r+1}: nombre vacío`);continue;}
    const price=_naNumber(get('price'),NaN);if(!Number.isFinite(price)||price<=0){skipped++;warnings.push(`Fila ${r+1}: precio inválido`);continue;}
    const sku=blank(get('sku'))?_naStableSku(name):_naClean(get('sku')),barcode=blank(get('barcode'))?'':_naClean(get('barcode'));
    let altCodes=_naSplitImportCodes(get('altCodes')).filter(code=>code.toLowerCase()!==sku.toLowerCase()&&code.toLowerCase()!==barcode.toLowerCase());
    const ownCodes=[sku,barcode,...altCodes].filter(Boolean),ownSeen=new Set();let repeated='';for(const code of ownCodes){const key=code.toLowerCase();if(ownSeen.has(key)){repeated=code;break;}ownSeen.add(key);}if(repeated){skipped++;warnings.push(`Fila ${r+1}: el código ${repeated} está repetido en la misma fila`);continue;}
    let existing=working.find(p=>_naClean(p.sku).toLowerCase()===sku.toLowerCase())||null;
    if(!existing){for(const code of [barcode,...altCodes]){if(!code)continue;existing=_naCatalogCodeOwner(working,code);if(existing)break;}}
    if(existing&&touchedIds.has(String(existing.id))){skipped++;warnings.push(`Fila ${r+1}: el producto ${existing.name} ya apareció en otra fila del mismo archivo`);continue;}
    const conflicts=ownCodes.map(code=>({code,owner:_naCatalogCodeOwner(working,code,existing?.id)})).filter(item=>item.owner);
    if(conflicts.length){skipped++;warnings.push(`Fila ${r+1}: ${conflicts[0].code} ya pertenece a ${conflicts[0].owner.name}`);continue;}
    const controlInventario=_naImportBool(get('inventory'),true),purchaseUnit=blank(get('purchaseUnit'))?'unidad':_naImportPurchaseUnit(get('purchaseUnit')),purchaseFactor=blank(get('purchaseFactor'))?1:Math.max(0.001,_naNumber(get('purchaseFactor'),1)),data={name,sku,precio:Math.max(0,price),unidadCompra:purchaseUnit,factorCompra:purchaseUnit==='unidad'?1:purchaseFactor,descripcion:blank(get('description'))?'':_naClean(get('description')),marca:blank(get('brand'))?'Sin marca':_naClean(get('brand'))||'Sin marca',cat:_naImportCategory(get('cat'),name),unidad:_naImportUnit(get('unit')),controlInventario,incluyeIGV:_naImportBool(get('igv'),true)};
    if(!blank(get('barcode')))data.barcode=barcode;
    // V2A: los códigos alternativos se resuelven por rama — update FUSIONA el histórico
    // (nunca lo reemplaza ni lo vacía) y add respeta el tope de escritura de 7 totales.
    if(!blank(get('cost')))data.costo=Math.max(0,_naNumber(get('cost')));
    if(!blank(get('stock')))data.stock=controlInventario?Math.max(0,_naInt(get('stock'))):0;
    if(!blank(get('min')))data.stockMin=controlInventario?Math.max(0,_naInt(get('min'))):0;
    if(!blank(get('due'))){const due=_naImportDate(get('due'));if(!due&&String(get('due')).trim()){warnings.push(`Fila ${r+1}: vencimiento no reconocido`);}data.venc=controlInventario?due:null;}
    if(!blank(get('icon')))data.icon=_naClean(get('icon')).slice(0,8)||'📦';
    if(!blank(get('boxPrice')))data.precioCaja=Math.max(0,_naNumber(get('boxPrice')))||null;
    if(!blank(get('boxUnits')))data.unidCaja=Math.max(0,_naInt(get('boxUnits')))||null;
    if(blank(get('purchaseUnit'))&&data.unidCaja>0){data.unidadCompra='caja';data.factorCompra=data.unidCaja;}
    if((data.precioCaja>0)!==(data.unidCaja>0)){skipped++;warnings.push(`Fila ${r+1}: precio por caja y unidades por caja deben completarse juntos`);continue;}
    const effectiveCost=data.costo!==undefined?data.costo:_naNumber(existing?.costo);
    if(appConfig.margenActive&&effectiveCost>0&&data.precio<effectiveCost){skipped++;warnings.push(`Fila ${r+1}: precio menor al costo`);continue;}
    if(appConfig.margenActive&&data.precioCaja>0&&data.precioCaja<effectiveCost*data.unidCaja){skipped++;warnings.push(`Fila ${r+1}: precio por caja menor al costo total`);continue;}
    if(existing){
      // V2A: fusión de códigos — históricos existentes primero (nunca se pierden),
      // principal anterior conservado si la fila cambia el principal, luego los importados
      // validados hasta el tope absoluto de 10. Un código nunca pertenece a dos productos.
      const prevAlts=_naProductAltCodes(existing),prevBarcode=_naClean(existing.barcode),nextBarcode=data.barcode!==undefined?_naClean(data.barcode):prevBarcode,nextKey=nextBarcode.toLowerCase();
      const seen=new Set([_naClean(existing.sku).toLowerCase()]),merged=[];
      const keep=code=>{const key=code.toLowerCase();if(code&&key!==nextKey&&!seen.has(key)){seen.add(key);merged.push(code);}};
      prevAlts.forEach(keep);
      if(prevBarcode&&prevBarcode.toLowerCase()!==nextKey)keep(prevBarcode);
      let rejectedImports=0;
      for(const code of altCodes){if(merged.length>=NA_MAX_ALT_BARCODES){rejectedImports++;continue;}keep(code);}
      if(rejectedImports)warnings.push(`Fila ${r+1}: ${rejectedImports} código(s) alternativo(s) fuera del máximo de ${NA_MAX_ALT_BARCODES} no se importaron`);
      data.codigosAlternativos=merged;data.codigoAlternativo=merged[0]||'';
      Object.assign(existing,data);touchedIds.add(String(existing.id));actions.push({type:'update',id:existing.id,data,row:r+1});updated++;
    }
    else{
      // V2A: producto nuevo — tope de escritura 1 principal + 6 alternativos = 7 códigos.
      const cappedAltCodes=altCodes.slice(0,NA_MAX_ALT_CODES_NEW);
      if(altCodes.length>NA_MAX_ALT_CODES_NEW)warnings.push(`Fila ${r+1}: un producto nuevo admite ${NA_MAX_ALT_CODES_NEW} códigos alternativos; se importaron los primeros`);
      data.codigosAlternativos=cappedAltCodes;data.codigoAlternativo=cappedAltCodes[0]||'';
      const product={id:_naNextImportProductId(usedIds),barcode:'',codigosAlternativos:[],codigoAlternativo:'',descripcion:'',marca:'Sin marca',unidad:'unidad',unidadCompra:'unidad',factorCompra:1,incluyeIGV:true,tipoImpuesto:'gravado',impuestoComplementario:'',controlInventario:true,cat:'abarrotes',icon:'📦',imagen:null,costo:0,stock:0,stockMin:_naInt(appConfig.stockMin,5),venc:null,precioCaja:null,unidCaja:null,...data};working.push(product);touchedIds.add(String(product.id));actions.push({type:'add',product,row:r+1});added++;
    }
  }
  return{headers,actions,added,updated,skipped,warnings,totalRows:rows.length-1,generatedAt:new Date().toISOString()};
}
function _naRenderProductImportPreview(plan,fileName){const box=document.getElementById('importPreview');if(!box)return;const warningHtml=plan.warnings.length?plan.warnings.slice(0,12).map(item=>`• ${_naEsc(item)}`).join('<br>'):'Sin advertencias en el análisis.';box.innerHTML=`<div class="import-preview-head"><div class="import-preview-title">Vista previa de importación</div><div class="import-preview-file">${_naEsc(fileName)}</div></div><div class="import-preview-stats"><div class="import-preview-stat"><strong>${plan.added}</strong><span>Nuevos</span></div><div class="import-preview-stat"><strong>${plan.updated}</strong><span>Actualizar</span></div><div class="import-preview-stat"><strong>${plan.skipped}</strong><span>Omitidos</span></div></div><div class="import-preview-warnings">${warningHtml}${plan.warnings.length>12?`<br>… y ${plan.warnings.length-12} advertencia(s) adicional(es).`:''}</div><div class="import-preview-actions"><button class="cfg-save-btn" onclick="confirmProductImport()">✅ Confirmar</button><button class="cfg-save-btn" style="background:var(--slate)" onclick="clearProductImportPreview()">Cancelar</button></div>`;box.classList.add('show');}
function clearProductImportPreview(){_naPendingProductImport=null;const box=document.getElementById('importPreview');if(box){box.classList.remove('show');box.innerHTML='';}}
async function _naReadProductImportFile(file){if(!file)throw new Error('Selecciona un archivo');if(file.size>_NA_IMPORT_MAX_BYTES)throw new Error('El archivo supera el límite de 8 MB');const ext=file.name.split('.').pop().toLowerCase();if(!['csv','txt','xlsx','xls'].includes(ext))throw new Error('Formato no compatible. Usa CSV, XLSX o XLS');if(ext==='csv'||ext==='txt')return _naParseCSV(await file.text());const buffer=await file.arrayBuffer();if(typeof XLSX!=='undefined'){const data=new Uint8Array(buffer),book=XLSX.read(data,{type:'array',cellDates:true}),sheet=book.Sheets[book.SheetNames[0]];return XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:''});}return await _naParseXlsxBasic(buffer);}
importProducts=async function(){try{const file=document.getElementById('importFile')?.files?.[0];if(!file)throw new Error('Selecciona un archivo');clearProductImportPreview();const rows=await _naReadProductImportFile(file),plan=_naBuildProductImportPlan(rows);_naPendingProductImport={rows,fileName:file.name,analyzedAt:Date.now()};_naLastImportReport=plan;_naRenderProductImportPreview(plan,file.name);toast(`Análisis listo: ${plan.added} nuevos, ${plan.updated} actualizaciones y ${plan.skipped} omitidos`,'success');}catch(error){console.error('[Importación] Análisis rechazado:',error?.message||error);clearProductImportPreview();toast(error?.message||'No se pudo analizar el archivo','error');}};
async function confirmProductImport(){if(isModuleLocked('productos')||isModuleLocked('importacion')){toast('La importación está bloqueada','error');return;}if(!_naPendingProductImport){toast('Primero analiza un archivo','error');return;}const backup={productos:_naClone(productos),inventoryMovements:_naClone(inventoryMovements)};try{const plan=_naBuildProductImportPlan(_naPendingProductImport.rows);if(!plan.actions.length){toast('No hay productos válidos para importar','error');return;}for(const action of plan.actions){if(action.type==='update'){const index=productos.findIndex(p=>String(p.id)===String(action.id));if(index<0)throw new Error(`El producto de la fila ${action.row} cambió después del análisis`);const previous=productos[index],next={...previous,...action.data},beforeStock=_naInt(previous.stock),targetStock=_naTracksStock(next)?_naInt(next.stock):0,{stock:_ignoredTargetStock,...persistedData}=next,staged={...persistedData,stock:beforeStock},delta=targetStock-beforeStock;
// FIX04: el producto conserva el stock previo hasta que el ledger aplica exactamente el delta al objetivo.
if(delta!==0){staged.controlInventario=true;productos[index]=staged;const outcome=applyInventoryMovement({productId:staged.id,type:'IMPORT',delta,reason:`Importación de catálogo: stock fijado en ${targetStock}`,source:'PRODUCT_IMPORT',referenceId:String(staged.id)});if(!outcome.ok)throw new Error(outcome.message||'Movimiento de inventario bloqueado');}staged.controlInventario=next.controlInventario;productos[index]=staged;}
else{const targetStock=_naTracksStock(action.product)?_naInt(action.product.stock):0,{stock:_ignoredTargetStock,...persistedData}=_naClone(action.product),created={...persistedData,stock:0};productos.push(created);if(targetStock>0){const outcome=applyInventoryMovement({productId:created.id,type:'ALTA',delta:targetStock,reason:`Importación de catálogo: alta con stock inicial ${targetStock}`,source:'PRODUCT_IMPORT',referenceId:String(created.id)});if(!outcome.ok)throw new Error(outcome.message||'Movimiento de inventario bloqueado');}}}_naNormalizeData();const persistResult=await saveAllData();if(!_naWasPersisted(persistResult))throw new Error('No se pudo verificar el guardado permanente');invRender();posRender();cfgUpdateStats();updateDashboard();_naLastImportReport=plan;clearProductImportPreview();const input=document.getElementById('importFile');if(input)input.value='';toast(`Importación completada: ${plan.added} nuevos, ${plan.updated} actualizados y ${plan.skipped} omitidos`,'success');}catch(error){productos=backup.productos;inventoryMovements=backup.inventoryMovements;await saveAllData();invRender();posRender();cfgUpdateStats();console.error('[Importación] Se restauró el catálogo anterior:',error?.message||error);toast(`Importación cancelada: ${error?.message||'no se pudo guardar'}`,'error');}}
function _naDownloadBlob(blob,fileName){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=fileName;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function _naCsvCell(value){const text=String(value??'');return/[";,\n\r]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;}
function _naProductsExportRows(){return productos.map(p=>({ID:p.id,Nombre:p.name,SKU:p.sku,'Código de barras':p.barcode||'','Códigos alternativos':_naProductAltCodes(p).join(' | '),Descripción:p.descripcion||'',Marca:p.marca||'','Categoría':_naCategoryLabel(p.cat),'Unidad de venta':p.unidad||'unidad','Unidad de compra':p.unidadCompra||(p.unidCaja?'caja':'unidad'),'Unidades por presentación':p.factorCompra||p.unidCaja||1,Costo:_naNumber(p.costo),Precio:_naNumber(p.precio),'Precio por caja':p.precioCaja||'','Unidades por caja':p.unidCaja||'',Stock:_naNumber(p.stock),'Stock mínimo':_naNumber(p.stockMin),'Fecha de vencimiento':p.venc||'','Control de inventario':p.controlInventario===false?'No':'Sí','Incluye IGV':p.incluyeIGV===false?'No':'Sí',Icono:p.icon||'📦'}));}
function _naExportRowsToCsv(rows,fileName){if(!rows.length){toast('No hay productos para exportar','error');return;}const headers=Object.keys(rows[0]),csv='\uFEFF'+[headers,...rows.map(row=>headers.map(key=>row[key]))].map(line=>line.map(_naCsvCell).join(';')).join('\r\n');_naDownloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),fileName);}
function exportProductsExcel(){const rows=_naProductsExportRows();if(!rows.length){toast('No hay productos para exportar','error');return;}const date=obtenerHoy();try{if(typeof XLSX!=='undefined'&&XLSX.utils?.json_to_sheet){const ws=XLSX.utils.json_to_sheet(rows),wb=XLSX.utils.book_new();ws['!cols']=Object.keys(rows[0]).map(key=>({wch:Math.min(42,Math.max(12,key.length+2,...rows.slice(0,200).map(row=>String(row[key]??'').length+2)))}));XLSX.utils.book_append_sheet(wb,ws,'Productos');XLSX.writeFile(wb,`productos_nuevo_amanecer_${date}.xlsx`);toast(`${rows.length} productos exportados a Excel`,'success');return;}}catch(error){console.error('[Exportación Excel]',error);} _naExportRowsToCsv(rows,`productos_nuevo_amanecer_${date}.csv`);toast(`${rows.length} productos exportados a CSV`,'success');}
function downloadProductTemplate(){const sample=[{Nombre:'Ejemplo Producto',SKU:'PROD-001','Código de barras':'775000000001','Códigos alternativos':'775000000002 | 775000000003',Descripción:'Descripción opcional',Marca:'Marca','Categoría':'Abarrotes','Unidad de venta':'unidad','Unidad de compra':'caja','Unidades por presentación':24,Costo:4.5,Precio:6,'Precio por caja':130,'Unidades por caja':24,Stock:48,'Stock mínimo':5,'Fecha de vencimiento':'2027-12-31','Control de inventario':'Sí','Incluye IGV':'Sí',Icono:'📦'}];try{if(typeof XLSX!=='undefined'){const ws=XLSX.utils.json_to_sheet(sample),wb=XLSX.utils.book_new();ws['!cols']=Object.keys(sample[0]).map(key=>({wch:Math.max(16,key.length+2)}));XLSX.utils.book_append_sheet(wb,ws,'Plantilla');XLSX.writeFile(wb,'plantilla_productos_nuevo_amanecer.xlsx');toast('Plantilla Excel descargada','success');return;}}catch(error){console.error('[Plantilla Excel]',error);} _naExportRowsToCsv(sample,'plantilla_productos_nuevo_amanecer.csv');toast('Plantilla CSV descargada','success');}
const _NA_BACKUP_MAX_BYTES=10*1024*1024;
const _NA_BACKUP_LIMITS={productos:10000,ventas:50000,clientes:20000,creditos:50000,gastos:50000,cajMovs:100000,cart:1000,items:5000,inventoryMovements:200000};
const _NA_DANGEROUS_BACKUP_KEYS=new Set(['__proto__','prototype','constructor']);
const _NA_BACKUP_KEYS={
  product:new Set(['id','name','sku','barcode','codigosAlternativos','codigoAlternativo','cat','icon','imagen','costo','precio','precioCaja','unidCaja','stock','stockMin','venc','descripcion','marca','unidad','unidadCompra','factorCompra','incluyeIGV','tipoImpuesto','impuestoComplementario','controlInventario','tienda','activo','createdAt','updatedAt','reactivadoAt','lots']),
  sale:new Set(['id','operation','fecha','hora','hora24','timestamp','cajero','cajeroNombre','cajeroId','metodo','metodoPago','estado','tipoVenta','total','subtotal','descuentoTotal','igvActive','taxBreakdown','cantidadLineas','unidadesFisicas','paymentRef','paymentBreakdown','recibido','vuelto','anulada','anuladaAt','anuladaPor','anuladaPorId','horaAnulacion','motivoAnulacion','clienteId','clienteNombre','clienteDni','creditId','contieneVentaLibre','contieneVentaSinStock','items']),
  item:new Set(['id','productoId','itemKey','sku','barcode','icon','name','nombre','qty','cantidad','precio','precioUnitario','subtotal','costo','imagen','unidad','marca','incluyeIGV','tipoImpuesto','unitsPerQty','ventaModo','modo','descuento','_descuento','_precioOriginal','_lineKey','cat','controlInventario','stock','stockMin','precioCaja','unidCaja','ventaLibre','ventaSinStock','tipoLinea','codigoIngresado','unidadesSinStock','stockAntes','cajeroRegistro']),
  client:new Set(['id','nombre','dni','ruc','tel','telefono','dir','direccion','color','totalCompras','lineaCreditoManualActiva','lineaCreditoManual','lineaCreditoManualMotivo','lineaCreditoManualAt','lineaCreditoManualPor','lineaCreditoManualPorId','createdAt','updatedAt']),
  credit:new Set(['id','cliId','clienteId','clienteNombre','clienteDni','tipo','desc','monto','pagado','saldo','vence','status','estado','fecha','hora','hora24','timestamp','ventaId','anulado','pagos','items','cajero','cajeroNombre','cajeroId','lineaCreditoAsignada','lineaCreditoDisponibleAntes','gananciaClienteAlCrear','deudaClienteAntes','scoreCreditoAlCrear','fuenteLineaCredito','criterioCredito','excepcionManualCredito','createdAt','updatedAt']),
  expense:new Set(['id','desc','monto','fecha','cat','metodo','nota','hora','timestamp','cajero','sessionId','operacion','referencia','createdAt']),
  cashMove:new Set(['id','tipo','monto','efectivo','digital','desc','cat','metodo','referencia','numeroOperacion','detallePago','hora','hora24','timestamp','cajero','cajeroNombre','cajeroId','fecha','sessionId','ventaId','creditoId','pagoId','saldoAnterior','saldoActual','horarioPago','reversal','reversalOf','createdAt']),
  cashState:new Set(['abierta','fondo','cajero','cajeroNombre','cajeroId','hora','hora24','fechaApertura','cerrada','horaCierre','horaCierre24','sessionId','contado','esperado','diferencia','timestampApertura','timestampCierre']),
  payment:new Set(['efectivo','digital','digitalMethod','reference','reversal']),
  paymentLog:new Set(['id','pagoId','creditoId','clienteId','clienteNombre','monto','montoPagado','saldoAnterior','saldoActual','fecha','hora','hora24','timestamp','diaSemana','horarioPago','metodo','operacion','numeroOperacion','referencia','cajero','cajeroNombre','cajeroId','desgloseProductos','status','reversalId','reversalAt','reversalReason']),
  creditAllocation:new Set(['itemKey','productoId','nombre','monto','subtotalCredito','saldoAnteriorProducto','saldoActualProducto']),
  inventoryMovement:new Set(['id','productId','type','before','delta','after','reason','source','referenceId','timestamp','fecha','sessionId']),
  taxBreakdown:new Set(['rate','taxActive','totalGravado','totalExonerado','totalInafecto','totalIGV','subtotal','totalVenta'])
};
function _naBackupParse(text){
  return JSON.parse(text,(key,value)=>{if(_NA_DANGEROUS_BACKUP_KEYS.has(key))throw new Error(`Propiedad peligrosa bloqueada: ${key}`);return value;});
}
function _naBackupString(value,path,max=5000,{allowEmpty=true}={}){
  if(value===null||value===undefined){if(allowEmpty)return'';throw new Error(`${path}: texto obligatorio`);}
  if(typeof value!=='string'&&typeof value!=='number')throw new Error(`${path}: tipo de texto inválido`);
  const out=String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,'').trim();
  if(!allowEmpty&&!out)throw new Error(`${path}: texto obligatorio`);
  if(out.length>max)throw new Error(`${path}: supera ${max} caracteres`);
  if(/[<>]/.test(out)||/\b(?:javascript|vbscript)\s*:/i.test(out)||/\bon[a-z]{2,}\s*=/i.test(out)||/\bsrcdoc\s*=/i.test(out)||/\bdata\s*:\s*text\/html/i.test(out))throw new Error(`${path}: contiene HTML o código no permitido`);
  return out;
}
function _naBackupNumber(value,path,{min=-1e12,max=1e12,nullable=false}={}){
  if((value===null||value===''||value===undefined)&&nullable)return null;
  const number=typeof value==='number'?value:Number(value);
  if(!Number.isFinite(number)||number<min||number>max)throw new Error(`${path}: número fuera de rango`);
  return number;
}
function _naBackupBoolean(value,path,defaultValue=false){
  if(value===undefined||value===null)return defaultValue;
  if(typeof value==='boolean')return value;
  if(value===0||value==='0'||value==='false')return false;
  if(value===1||value==='1'||value==='true')return true;
  throw new Error(`${path}: booleano inválido`);
}
function _naBackupDate(value,path,{nullable=true}={}){
  if(value===null||value===undefined||value===''){if(nullable)return null;throw new Error(`${path}: fecha obligatoria`);}
  const raw=_naBackupString(value,path,40,{allowEmpty:false}),date=new Date(raw.length===10?`${raw}T00:00:00`:raw);
  if(Number.isNaN(date.getTime()))throw new Error(`${path}: fecha inválida`);
  return raw.length===10?raw:date.toISOString();
}
function _naBackupImage(value,path){
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string'||value.length>2500000)throw new Error(`${path}: imagen inválida o demasiado grande`);
  if(/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value))return value;
  if(/^https?:\/\/[^\s<>"']{1,2000}$/i.test(value))return value;
  throw new Error(`${path}: solo se permiten imágenes PNG/JPG/WEBP/GIF o URL HTTPS`);
}
function _naBackupGeneric(value,path,depth=0){
  if(depth>8)throw new Error(`${path}: estructura demasiado profunda`);
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number')return _naBackupNumber(value,path);
  if(typeof value==='string')return _naBackupString(value,path,10000);
  if(Array.isArray(value)){
    if(value.length>50000)throw new Error(`${path}: demasiados elementos`);
    return value.map((item,index)=>_naBackupGeneric(item,`${path}[${index}]`,depth+1));
  }
  if(!_naIsPlainObject(value))throw new Error(`${path}: objeto inválido`);
  const out={};
  for(const [key,item] of Object.entries(value)){
    if(_NA_DANGEROUS_BACKUP_KEYS.has(key))throw new Error(`${path}.${key}: propiedad peligrosa`);
    if(key.length>80)throw new Error(`${path}: nombre de propiedad demasiado largo`);
    out[key]=_naBackupGeneric(item,`${path}.${key}`,depth+1);
  }
  return out;
}
function _naBackupPick(record,allowed,path,warnings){
  if(!_naIsPlainObject(record))throw new Error(`${path}: se esperaba un objeto`);
  const out={};
  for(const [key,value] of Object.entries(record)){
    if(_NA_DANGEROUS_BACKUP_KEYS.has(key))throw new Error(`${path}.${key}: propiedad peligrosa`);
    if(!allowed.has(key)){warnings.push(`${path}.${key}: propiedad desconocida omitida`);continue;}
    out[key]=value;
  }
  return out;
}
function _naBackupId(value,path){if(typeof value==='number')return _naBackupNumber(value,path,{min:-Number.MAX_SAFE_INTEGER,max:Number.MAX_SAFE_INTEGER});return _naBackupString(value,path,120,{allowEmpty:false});}
function _naSanitizeProduct(raw,index,warnings,isCart=false){
  const path=`${isCart?'cart':'productos'}[${index}]`,p=_naBackupPick(raw,isCart?_NA_BACKUP_KEYS.item:_NA_BACKUP_KEYS.product,path,warnings),out={};
  if(p.id!==undefined)out.id=_naBackupId(p.id,`${path}.id`);
  if(p.name!==undefined)out.name=_naBackupString(p.name,`${path}.name`,180,{allowEmpty:false});
  if(p.sku!==undefined)out.sku=_naBackupString(p.sku,`${path}.sku`,120);
  if(p.barcode!==undefined)out.barcode=_naBackupString(p.barcode,`${path}.barcode`,160);
  if(Array.isArray(p.codigosAlternativos)){if(p.codigosAlternativos.length>10)throw new Error(`${path}.codigosAlternativos: máximo 10`);out.codigosAlternativos=p.codigosAlternativos.map((code,i)=>_naBackupString(code,`${path}.codigosAlternativos[${i}]`,160,{allowEmpty:false}));}
  if(p.codigoAlternativo!==undefined)out.codigoAlternativo=_naBackupString(p.codigoAlternativo,`${path}.codigoAlternativo`,160);
  for(const key of ['cat','icon','descripcion','marca','unidad','unidadCompra','tipoImpuesto','impuestoComplementario','tienda','ventaModo','_lineKey','tipoLinea','codigoIngresado','cajeroRegistro'])if(p[key]!==undefined)out[key]=_naBackupString(p[key],`${path}.${key}`,key==='descripcion'?2000:180);
  if(p.imagen!==undefined)out.imagen=_naBackupImage(p.imagen,`${path}.imagen`);
  for(const key of ['costo','precio','precioCaja','stock','stockMin','qty','unitsPerQty','descuento','_descuento','_precioOriginal','unidCaja','factorCompra','unidadesSinStock','stockAntes'])if(p[key]!==undefined)out[key]=_naBackupNumber(p[key],`${path}.${key}`,{min:['stock','stockAntes'].includes(key)?-1e9:0,max:1e9,nullable:['precioCaja','_precioOriginal','stockAntes'].includes(key)});
  for(const key of ['incluyeIGV','controlInventario','activo','ventaLibre','ventaSinStock'])if(p[key]!==undefined)out[key]=_naBackupBoolean(p[key],`${path}.${key}`,true);
  if(p.venc!==undefined)out.venc=_naBackupDate(p.venc,`${path}.venc`);
  for(const key of ['createdAt','updatedAt','reactivadoAt'])if(p[key]!==undefined)out[key]=_naBackupDate(p[key],`${path}.${key}`);
  if(p.lots!==undefined){
    if(!Array.isArray(p.lots)||p.lots.length>50000)throw new Error(`${path}.lots: lista inválida`);
    const used=new Set();let total=0;
    out.lots=p.lots.map((r,i)=>{
      const where=`${path}.lots[${i}]`;
      if(!_naIsPlainObject(r)||Object.keys(r).some(k=>!['lot_id','lot_code','expiry_date','quantity','received_at','product_id'].includes(k)))throw new Error(`${where}: lote inválido`);
      const lot_id=_naBackupString(r.lot_id,`${where}.lot_id`,240,{allowEmpty:false}),lot_code=_naBackupString(r.lot_code,`${where}.lot_code`,120,{allowEmpty:false});
      if(used.has(lot_id))throw new Error(`${where}: ID duplicado`);used.add(lot_id);
      const expiry_date=_naBackupDate(r.expiry_date,`${where}.expiry_date`,{nullable:false}),received_at=_naBackupDate(r.received_at,`${where}.received_at`,{nullable:false});
      if(!/^\d{4}-\d{2}-\d{2}$/.test(expiry_date)||new Date(expiry_date).toISOString().slice(0,10)!==expiry_date||!Number.isFinite(Date.parse(received_at)))throw new Error(`${where}: fecha inválida`);
      const quantity=_naBackupNumber(r.quantity,`${where}.quantity`,{min:0,max:1e9});total+=quantity;
      return{lot_id,lot_code,expiry_date,quantity,received_at};
    });
    if(total>Number(out.stock||0)+1e-8)throw new Error('LOT_STOCK_INCOHERENT');
  }
  return out;
}
function _naSanitizeSaleItem(raw,path,warnings){
  const p=_naBackupPick(raw,_NA_BACKUP_KEYS.item,path,warnings),out={};
  if(p.id!==undefined)out.id=p.id===null?null:_naBackupId(p.id,`${path}.id`);if(p.productoId!==undefined)out.productoId=p.productoId===null?null:_naBackupId(p.productoId,`${path}.productoId`);
  for(const key of ['itemKey','sku','barcode','icon','name','nombre','unidad','marca','tipoImpuesto','ventaModo','modo','_lineKey','cat','tipoLinea','codigoIngresado','cajeroRegistro'])if(p[key]!==undefined)out[key]=_naBackupString(p[key],`${path}.${key}`,key==='name'?180:160);
  if(p.imagen!==undefined)out.imagen=_naBackupImage(p.imagen,`${path}.imagen`);
  for(const key of ['qty','cantidad','precio','precioUnitario','subtotal','costo','unitsPerQty','descuento','_descuento','_precioOriginal','stock','stockMin','precioCaja','unidCaja','unidadesSinStock','stockAntes'])if(p[key]!==undefined)out[key]=_naBackupNumber(p[key],`${path}.${key}`,{min:['stock','stockAntes'].includes(key)?-1e9:0,max:1e9,nullable:['precioCaja','_precioOriginal','stockAntes'].includes(key)});
  for(const key of ['incluyeIGV','controlInventario','ventaLibre','ventaSinStock'])if(p[key]!==undefined)out[key]=_naBackupBoolean(p[key],`${path}.${key}`,true);
  return out;
}
function _naSanitizePayment(raw,path,warnings){
  if(raw===null||raw===undefined)return null;
  const p=_naBackupPick(raw,_NA_BACKUP_KEYS.payment,path,warnings),out={};
  for(const key of ['efectivo','digital'])if(p[key]!==undefined)out[key]=_naBackupNumber(p[key],`${path}.${key}`,{min:0,max:1e12});
  for(const key of ['digitalMethod','reference'])if(p[key]!==undefined)out[key]=_naBackupString(p[key],`${path}.${key}`,160);
  if(p.reversal!==undefined)out.reversal=_naBackupBoolean(p.reversal,`${path}.reversal`);
  return out;
}
function _naSanitizeTaxBreakdown(raw,path,warnings){
  const p=_naBackupPick(raw,_NA_BACKUP_KEYS.taxBreakdown,path,warnings),out={};
  out.rate=_naBackupNumber(p.rate,`${path}.rate`,{min:0,max:1});
  out.taxActive=_naBackupBoolean(p.taxActive,`${path}.taxActive`,true);
  for(const key of ['totalGravado','totalExonerado','totalInafecto','totalIGV','subtotal','totalVenta'])out[key]=_naBackupNumber(p[key],`${path}.${key}`,{min:0,max:1e12});
  if(Math.abs(out.rate-_NA_IGV_RATE)>.000001||(!out.taxActive&&out.totalIGV>.001)||Math.abs(out.subtotal-(out.totalGravado+out.totalExonerado+out.totalInafecto))>.011||Math.abs(out.totalVenta-(out.subtotal+out.totalIGV))>.011)throw new Error(`${path}: desglose tributario incoherente`);
  return out;
}
function _naSanitizeSale(raw,index,warnings){
  const path=`ventas[${index}]`,v=_naBackupPick(raw,_NA_BACKUP_KEYS.sale,path,warnings),out={};
  if(v.id!==undefined)out.id=_naBackupId(v.id,`${path}.id`);
  if(v.operation!==undefined)out.operation=_naBackupString(v.operation,`${path}.operation`,160);
  for(const key of ['hora','hora24','cajero','cajeroNombre','cajeroId','metodo','metodoPago','estado','tipoVenta','paymentRef','clienteNombre','clienteDni','anuladaPor','anuladaPorId','horaAnulacion','motivoAnulacion'])if(v[key]!==undefined)out[key]=_naBackupString(v[key],`${path}.${key}`,key==='motivoAnulacion'?1000:180);
  for(const key of ['fecha','timestamp','anuladaAt'])if(v[key]!==undefined)out[key]=_naBackupDate(v[key],`${path}.${key}`);
  for(const key of ['recibido','vuelto','total','subtotal','descuentoTotal','cantidadLineas','unidadesFisicas'])if(v[key]!==undefined)out[key]=_naBackupNumber(v[key],`${path}.${key}`,{min:0,max:1e12});
  if(v.anulada!==undefined)out.anulada=_naBackupBoolean(v.anulada,`${path}.anulada`);
  for(const key of ['igvActive','contieneVentaLibre','contieneVentaSinStock'])if(v[key]!==undefined)out[key]=_naBackupBoolean(v[key],`${path}.${key}`);
  for(const key of ['clienteId','creditId'])if(v[key]!==undefined&&v[key]!==null)out[key]=_naBackupId(v[key],`${path}.${key}`);
  out.paymentBreakdown=_naSanitizePayment(v.paymentBreakdown,`${path}.paymentBreakdown`,warnings);
  if(v.taxBreakdown!==undefined)out.taxBreakdown=_naSanitizeTaxBreakdown(v.taxBreakdown,`${path}.taxBreakdown`,warnings);
  if(!Array.isArray(v.items)||v.items.length>_NA_BACKUP_LIMITS.items)throw new Error(`${path}.items: lista inválida o demasiado grande`);
  out.items=v.items.map((item,i)=>_naSanitizeSaleItem(item,`${path}.items[${i}]`,warnings));
  if(out.taxBreakdown){const expected=_naTaxBreakdownForSaleItems(out.items,out.taxBreakdown.taxActive),fields=['totalGravado','totalExonerado','totalInafecto','totalIGV','subtotal','totalVenta'];if(fields.some(key=>Math.abs(out.taxBreakdown[key]-expected[key])>.011)||(out.igvActive!==undefined&&out.igvActive!==out.taxBreakdown.taxActive)||(out.total!==undefined&&Math.abs(out.total-out.taxBreakdown.totalVenta)>.011))throw new Error(`${path}.taxBreakdown: no coincide con la venta congelada`);}
  return out;
}
function _naSanitizeCreditAllocation(raw,path,warnings){const p=_naBackupPick(raw,_NA_BACKUP_KEYS.creditAllocation,path,warnings),out={};if(p.productoId!==undefined&&p.productoId!==null)out.productoId=_naBackupId(p.productoId,`${path}.productoId`);for(const key of ['itemKey','nombre'])if(p[key]!==undefined)out[key]=_naBackupString(p[key],`${path}.${key}`,180);for(const key of ['monto','subtotalCredito','saldoAnteriorProducto','saldoActualProducto'])if(p[key]!==undefined)out[key]=_naBackupNumber(p[key],`${path}.${key}`,{min:0,max:1e12});return out;}
function _naSanitizeCreditPaymentLog(raw,path,warnings){const p=_naBackupPick(raw,_NA_BACKUP_KEYS.paymentLog,path,warnings),out={};for(const key of ['id','pagoId','creditoId','clienteId','cajeroId'])if(p[key]!==undefined&&p[key]!==null)out[key]=_naBackupId(p[key],`${path}.${key}`);for(const key of ['monto','montoPagado','saldoAnterior','saldoActual'])if(p[key]!==undefined)out[key]=_naBackupNumber(p[key],`${path}.${key}`,{min:0,max:1e12});for(const key of ['fecha','timestamp','reversalAt'])if(p[key]!==undefined)out[key]=_naBackupDate(p[key],`${path}.${key}`);for(const key of ['clienteNombre','hora','hora24','diaSemana','horarioPago','metodo','operacion','numeroOperacion','referencia','cajero','cajeroNombre'])if(p[key]!==undefined)out[key]=_naBackupString(p[key],`${path}.${key}`,240);if(p.status!==undefined)out.status=_naBackupString(p.status,`${path}.status`,20);if(p.reversalId!==undefined)out.reversalId=_naBackupString(p.reversalId,`${path}.reversalId`,120);if(p.reversalReason!==undefined)out.reversalReason=_naBackupString(p.reversalReason,`${path}.reversalReason`,200);if(p.desgloseProductos!==undefined){if(!Array.isArray(p.desgloseProductos)||p.desgloseProductos.length>_NA_BACKUP_LIMITS.items)throw new Error(`${path}.desgloseProductos: lista inválida`);out.desgloseProductos=p.desgloseProductos.map((row,i)=>_naSanitizeCreditAllocation(row,`${path}.desgloseProductos[${i}]`,warnings));}return out;}
function _naSanitizeSimpleRecord(raw,index,type,warnings){
  const sets={client:_NA_BACKUP_KEYS.client,credit:_NA_BACKUP_KEYS.credit,expense:_NA_BACKUP_KEYS.expense,cashMove:_NA_BACKUP_KEYS.cashMove},names={client:'clientes',credit:'creditos',expense:'gastos',cashMove:'cajMovs'},path=`${names[type]}[${index}]`,p=_naBackupPick(raw,sets[type],path,warnings),out={};
  for(const key of Object.keys(p)){
    const value=p[key],field=`${path}.${key}`;
    if(key==='id'||['cliId','clienteId','ventaId','creditoId','sessionId','reversalOf','cajeroId','pagoId'].includes(key)){if(value!==null&&value!==undefined)out[key]=_naBackupId(value,field);}
    else if(['monto','pagado','saldo','saldoAnterior','saldoActual','totalCompras','efectivo','digital','color','lineaCreditoManual','lineaCreditoAsignada','lineaCreditoDisponibleAntes','gananciaClienteAlCrear','deudaClienteAntes','scoreCreditoAlCrear'].includes(key))out[key]=_naBackupNumber(value,field,{min:0,max:1e12});
    else if(['anulado','reversal','lineaCreditoManualActiva','excepcionManualCredito'].includes(key))out[key]=_naBackupBoolean(value,field);
    else if(['fecha','vence','timestamp','lineaCreditoManualAt','createdAt','updatedAt'].includes(key))out[key]=_naBackupDate(value,field);
    else if(key==='detallePago')out[key]=_naSanitizePayment(value,field,warnings);
    else if(key==='items'){if(!Array.isArray(value)||value.length>_NA_BACKUP_LIMITS.items)throw new Error(`${field}: lista inválida`);out[key]=value.map((item,i)=>_naSanitizeSaleItem(item,`${field}[${i}]`,warnings));}
    else if(key==='pagos'){if(!Array.isArray(value)||value.length>5000)throw new Error(`${field}: lista inválida`);out[key]=value.map((pay,i)=>_naSanitizeCreditPaymentLog(pay,`${field}[${i}]`,warnings));}
    else out[key]=_naBackupString(value,field,key==='nota'||key==='desc'?2000:240);
  }
  return out;
}
function _naSanitizeCashState(raw,warnings){
  if(raw===null||raw===undefined)return _naClone(cajEstado);
  const p=_naBackupPick(raw,_NA_BACKUP_KEYS.cashState,'cajEstado',warnings),out={};
  for(const [key,value] of Object.entries(p)){
    if(['abierta','cerrada'].includes(key))out[key]=_naBackupBoolean(value,`cajEstado.${key}`);
    else if(['fondo','contado','esperado'].includes(key))out[key]=_naBackupNumber(value,`cajEstado.${key}`,{min:0,max:1e12,nullable:true});
    else if(key==='diferencia')out[key]=_naBackupNumber(value,`cajEstado.${key}`,{min:-1e12,max:1e12,nullable:true});
    else if(['fechaApertura','timestampApertura','timestampCierre'].includes(key))out[key]=_naBackupDate(value,`cajEstado.${key}`);
    else if(['sessionId','cajeroId'].includes(key)){if(value!==null&&value!==undefined)out[key]=_naBackupId(value,`cajEstado.${key}`);}
    else out[key]=_naBackupString(value,`cajEstado.${key}`,180);
  }
  return out;
}
// FIX02: cada cierre histórico se restaura byte-fiel; exige contado y esperado (núcleo del registro).
function _naSanitizeCashClosure(raw,index,warnings){
  if(!_naIsPlainObject(raw))throw new Error(`cashClosures[${index}]: objeto inválido`);
  const allowed=new Set(['id','sessionId','cajero','cajeroNombre','cajeroId','fechaApertura','hora','hora24','timestampApertura','fondo','fechaCierre','horaCierre','horaCierre24','timestampCierre','contado','esperado','diferencia']),p=_naBackupPick(raw,allowed,`cashClosures[${index}]`,warnings),out={};
  out.id=_naBackupString(p.id??`C-import-${index+1}`,`cashClosures[${index}].id`,60);
  if(p.sessionId!==undefined&&p.sessionId!==null)out.sessionId=_naBackupId(p.sessionId,`cashClosures[${index}].sessionId`);
  for(const key of ['cajero','cajeroNombre'])if(p[key]!==undefined)out[key]=_naBackupString(p[key],`cashClosures[${index}].${key}`,80);
  if(p.cajeroId!==undefined&&p.cajeroId!==null)out.cajeroId=_naBackupId(p.cajeroId,`cashClosures[${index}].cajeroId`);
  for(const key of ['fechaApertura','timestampApertura','fechaCierre','timestampCierre'])if(p[key]!==undefined)out[key]=_naBackupDate(p[key],`cashClosures[${index}].${key}`);
  for(const key of ['hora','hora24','horaCierre','horaCierre24'])if(p[key]!==undefined)out[key]=_naBackupString(p[key],`cashClosures[${index}].${key}`,20);
  if(p.fondo!==undefined)out.fondo=_naBackupNumber(p.fondo,`cashClosures[${index}].fondo`,{min:0,max:1e12,nullable:true});
  for(const key of ['contado','esperado','diferencia']){
    if(p[key]===undefined||p[key]===null||p[key]==='')throw new Error(`cashClosures[${index}].${key}: valor financiero obligatorio`);
    out[key]=_naBackupNumber(p[key],`cashClosures[${index}].${key}`,{min:key==='diferencia'?-1e12:0,max:1e12});
  }
  return out;
}
// FIX04: cada movimiento del ledger de inventario se restaura con before/delta/after congelados; delta es obligatorio.
function _naSanitizeInventoryMovement(raw,index,warnings){
  if(!_naIsPlainObject(raw))throw new Error(`inventoryMovements[${index}]: objeto inválido`);
  const allowed=_NA_BACKUP_KEYS.inventoryMovement,p=_naBackupPick(raw,allowed,`inventoryMovements[${index}]`,warnings),out={};
  out.id=_naBackupString(p.id,`inventoryMovements[${index}].id`,80,{allowEmpty:false});
  if(p.productId===undefined||p.productId===null)throw new Error(`inventoryMovements[${index}].productId: identificador obligatorio`);out.productId=_naBackupId(p.productId,`inventoryMovements[${index}].productId`);
  out.type=_naBackupString(p.type??'AJUSTE',`inventoryMovements[${index}].type`,40,{allowEmpty:false});
  out.before=_naBackupNumber(p.before,`inventoryMovements[${index}].before`,{min:-1e9,max:1e9});
  out.delta=_naBackupNumber(p.delta,`inventoryMovements[${index}].delta`,{min:-1e9,max:1e9});
  out.after=_naBackupNumber(p.after,`inventoryMovements[${index}].after`,{min:-1e9,max:1e9});
  if(Math.abs(out.after-(out.before+out.delta))>1e-6)throw new Error(`inventoryMovements[${index}]: after no coincide con before + delta`);
  out.reason=_naBackupString(p.reason,`inventoryMovements[${index}].reason`,500,{allowEmpty:false});
  out.source=_naBackupString(p.source,`inventoryMovements[${index}].source`,40,{allowEmpty:false});
  if(p.referenceId!==undefined)out.referenceId=p.referenceId===null?null:_naBackupString(p.referenceId,`inventoryMovements[${index}].referenceId`,160);
  if(p.timestamp!==undefined)out.timestamp=_naBackupDate(p.timestamp,`inventoryMovements[${index}].timestamp`);
  if(p.fecha!==undefined)out.fecha=_naBackupDate(p.fecha,`inventoryMovements[${index}].fecha`);
  if(p.sessionId!==undefined)out.sessionId=p.sessionId===null?null:_naBackupId(p.sessionId,`inventoryMovements[${index}].sessionId`);
  return out;
}
function _naValidateInventoryMovementLedger(movements){
  const ids=new Set(),previousByProduct=new Map();
  for(let index=0;index<movements.length;index++){
    const movement=movements[index],id=String(movement.id),productId=String(movement.productId);
    if(ids.has(id))throw new Error(`inventoryMovements[${index}].id: identificador duplicado`);ids.add(id);
    const previous=previousByProduct.get(productId);
    if(previous&&Math.abs(previous.after-movement.before)>1e-6)throw new Error(`inventoryMovements[${index}]: cadena incoherente para productId ${productId}`);
    previousByProduct.set(productId,movement);
  }
  return movements;
}
function _naValidateCashClosureIdentity(closures){
  const ids=new Set(),sessions=new Set();
  for(let index=0;index<closures.length;index++){
    const closure=closures[index],id=String(closure.id);
    if(ids.has(id))throw new Error(`cashClosures[${index}].id: identificador duplicado`);ids.add(id);
    if(closure.sessionId===undefined||closure.sessionId===null)continue;
    const sessionId=String(closure.sessionId);
    if(sessions.has(sessionId))throw new Error(`cashClosures[${index}].sessionId: identificador duplicado`);sessions.add(sessionId);
  }
  return closures;
}
function _naSanitizeAppConfig(raw,warnings){
  if(raw===null||raw===undefined)return _naClone(_naDefaults);
  if(!_naIsPlainObject(raw))throw new Error('appConfig: objeto inválido');
  const allowed=new Set(Object.keys(_naDefaults)),out=_naClone(_naDefaults);
  for(const [key,value] of Object.entries(raw)){
    if(_NA_DANGEROUS_BACKUP_KEYS.has(key))throw new Error(`appConfig.${key}: propiedad peligrosa`);
    if(!allowed.has(key)){warnings.push(`appConfig.${key}: propiedad desconocida omitida`);continue;}
    if(['business','appearance','scanner','freeSale','creditPolicy','purchaseSuggestion','ticket','printer'].includes(key)){
      if(!_naIsPlainObject(value))throw new Error(`appConfig.${key}: objeto inválido`);
      const nestedAllowed=new Set(Object.keys(_naDefaults[key]));
      for(const [child,childValue] of Object.entries(value)){
        if(_NA_DANGEROUS_BACKUP_KEYS.has(child))throw new Error(`appConfig.${key}.${child}: propiedad peligrosa`);
        if(!nestedAllowed.has(child)){warnings.push(`appConfig.${key}.${child}: propiedad desconocida omitida`);continue;}
        const template=_naDefaults[key][child];
        if(typeof template==='boolean')out[key][child]=_naBackupBoolean(childValue,`appConfig.${key}.${child}`,template);
        else if(typeof template==='number')out[key][child]=_naBackupNumber(childValue,`appConfig.${key}.${child}`,{min:0,max:100000});
        else out[key][child]=_naBackupString(childValue,`appConfig.${key}.${child}`,child==='pie'?1000:240);
      }
    }else if(key==='customCategories'){
      if(!Array.isArray(value)||value.length>200)throw new Error('appConfig.customCategories: lista inválida');
      out.customCategories=value.map((item,i)=>typeof item==='string'?_naBackupString(item,`appConfig.customCategories[${i}]`,100,{allowEmpty:false}):_naBackupGeneric(item,`appConfig.customCategories[${i}]`));
    }else if(key==='cashiers'){
      if(!Array.isArray(value)||value.length>50)throw new Error('appConfig.cashiers: lista inválida');
      out.cashiers=value.map((item,i)=>{if(!_naIsPlainObject(item))throw new Error(`appConfig.cashiers[${i}]: objeto inválido`);const allowedCashier=new Set(['id','nombre','activo','createdAt','updatedAt']),clean={};for(const [ck,cv] of Object.entries(item)){if(_NA_DANGEROUS_BACKUP_KEYS.has(ck))throw new Error(`appConfig.cashiers[${i}].${ck}: propiedad peligrosa`);if(!allowedCashier.has(ck)){warnings.push(`appConfig.cashiers[${i}].${ck}: propiedad desconocida omitida`);continue;}if(ck==='activo')clean.activo=_naBackupBoolean(cv,`appConfig.cashiers[${i}].activo`,true);else if(['createdAt','updatedAt'].includes(ck))clean[ck]=cv?_naBackupDate(cv,`appConfig.cashiers[${i}].${ck}`):null;else{const text=_naBackupString(cv,`appConfig.cashiers[${i}].${ck}`,ck==='nombre'?100:40,{allowEmpty:false});clean[ck]=ck==='id'?text.replace(/[^A-Za-z0-9_-]/g,'').slice(0,40):text;if(ck==='id'&&!clean[ck])throw new Error(`appConfig.cashiers[${i}].id: identificador inválido`);}}return clean;});
    }else if(key==='activeCashierId'){const text=_naBackupString(value,'appConfig.activeCashierId',40,{allowEmpty:false});out.activeCashierId=text.replace(/[^A-Za-z0-9_-]/g,'').slice(0,40);if(!out.activeCashierId)throw new Error('appConfig.activeCashierId: identificador inválido');}
    else if(typeof _naDefaults[key]==='boolean')out[key]=_naBackupBoolean(value,`appConfig.${key}`,_naDefaults[key]);
    else out[key]=_naBackupNumber(value,`appConfig.${key}`,{min:0,max:100000});
  }
  return out;
}
function _naSanitizeLocks(raw,warnings){
  const out={master:false,readOnly:false,modules:{}};
  if(raw===null||raw===undefined)return out;
  if(!_naIsPlainObject(raw))throw new Error('locks: objeto inválido');
  out.master=_naBackupBoolean(raw.master,'locks.master');out.readOnly=_naBackupBoolean(raw.readOnly,'locks.readOnly');
  if(raw.modules!==undefined){
    if(!_naIsPlainObject(raw.modules))throw new Error('locks.modules: objeto inválido');
    for(const key of Object.keys(LOCK_KEYS.modules))out.modules[key]=_naBackupBoolean(raw.modules[key],`locks.modules.${key}`);
    for(const key of Object.keys(raw.modules))if(!(key in LOCK_KEYS.modules))warnings.push(`locks.modules.${key}: módulo desconocido omitido`);
  }
  return out;
}
function _naSanitizeSecurity(raw,warnings){
  if(raw===null||raw===undefined)return _naSecMerge();
  if(!_naIsPlainObject(raw))throw new Error('security: objeto inválido');
  const out=_naSecMerge();
  if(raw.pinEnabled!==undefined)out.pinEnabled=_naBackupBoolean(raw.pinEnabled,'security.pinEnabled');
  if(raw.pinHash!==undefined)out.pinHash=_naBackupString(raw.pinHash,'security.pinHash',128);
  if(raw.autoLockMinutes!==undefined)out.autoLockMinutes=_naBackupNumber(raw.autoLockMinutes,'security.autoLockMinutes',{min:0,max:1440});
  for(const group of ['requirePin','rules']){
    if(raw[group]!==undefined){
      if(!_naIsPlainObject(raw[group]))throw new Error(`security.${group}: objeto inválido`);
      const allowed=new Set(Object.keys(SECURITY_DEFAULTS[group]));
      for(const [key,value] of Object.entries(raw[group])){
        if(!allowed.has(key)){warnings.push(`security.${group}.${key}: propiedad desconocida omitida`);continue;}
        out[group][key]=typeof SECURITY_DEFAULTS[group][key]==='boolean'?_naBackupBoolean(value,`security.${group}.${key}`):_naBackupNumber(value,`security.${group}.${key}`,{min:0,max:100});
      }
    }
  }
  if(raw.logs!==undefined){
    if(!Array.isArray(raw.logs)||raw.logs.length>1000)throw new Error('security.logs: lista inválida');
    out.logs=raw.logs.slice(0,100).map((log,i)=>{if(!_naIsPlainObject(log))throw new Error(`security.logs[${i}]: objeto inválido`);return{id:log.id!==undefined?_naBackupId(log.id,`security.logs[${i}].id`):Date.now()+i,at:_naBackupDate(log.at||new Date().toISOString(),`security.logs[${i}].at`),action:_naBackupString(log.action,`security.logs[${i}].action`,180),detail:_naBackupString(log.detail||'',`security.logs[${i}].detail`,1000)};});
  }
  return out;
}
function _naCanonicalBackup(data){
  if(!_naIsPlainObject(data))throw new Error('El respaldo debe ser un objeto JSON');
  if(data.data)return data;
  if(Array.isArray(data.productos)&&Array.isArray(data.ventas)){
    return{version:data.version||8,updatedAt:data.exportedAt||new Date().toISOString(),appConfig:data.appConfig||{},ui:{currentPage:'pageMenu',isDark:false,currentCfgCategory:'negocio'},locks:_naGetLocks(),security:data.security||null,data:{productos:data.productos,ventas:data.ventas,clientes:data.clientes||[],creditos:data.creditos||[],gastos:data.gastos||[],cajMovs:data.cajMovs||[],cajEstado:data.cajEstado||cajEstado,cashClosures:Object.prototype.hasOwnProperty.call(data,'cashClosures')?data.cashClosures:[],inventoryMovements:Object.prototype.hasOwnProperty.call(data,'inventoryMovements')?data.inventoryMovements:[]},cart:data.cart||[],draft:data.draft||null};
  }
  throw new Error('Estructura de respaldo no reconocida');
}
function _naPrepareBackupSnapshot(data){
  const source=_naCanonicalBackup(data),version=Number(source.version);
  if(![8,9].includes(version))throw new Error(`Versión de respaldo no compatible: ${source.version}`);
  if(!_naIsPlainObject(source.data))throw new Error('El respaldo no contiene la sección data');
  const warnings=[],checkList=(name,limit)=>{const list=source.data[name];if(!Array.isArray(list))throw new Error(`${name}: se esperaba una lista`);if(list.length>limit)throw new Error(`${name}: supera el máximo de ${limit} registros`);return list;};
  const productosL=checkList('productos',_NA_BACKUP_LIMITS.productos),ventasL=checkList('ventas',_NA_BACKUP_LIMITS.ventas),clientesL=checkList('clientes',_NA_BACKUP_LIMITS.clientes),creditosL=checkList('creditos',_NA_BACKUP_LIMITS.creditos),gastosL=checkList('gastos',_NA_BACKUP_LIMITS.gastos),cajMovsL=checkList('cajMovs',_NA_BACKUP_LIMITS.cajMovs);
  const hasClosures=Object.prototype.hasOwnProperty.call(source.data,'cashClosures'),closuresL=hasClosures?source.data.cashClosures:[];if(!Array.isArray(closuresL))throw new Error('cashClosures: se esperaba una lista');if(closuresL.length>_NA_BACKUP_LIMITS.cajMovs)throw new Error(`cashClosures: supera el máximo de ${_NA_BACKUP_LIMITS.cajMovs} registros`);
  const hasMovs=Object.prototype.hasOwnProperty.call(source.data,'inventoryMovements'),movsL=hasMovs?source.data.inventoryMovements:[];if(!Array.isArray(movsL))throw new Error('inventoryMovements: se esperaba una lista');if(movsL.length>_NA_BACKUP_LIMITS.inventoryMovements)throw new Error(`inventoryMovements: supera el máximo de ${_NA_BACKUP_LIMITS.inventoryMovements} registros`);
  const cartL=Array.isArray(source.cart)?source.cart:[];if(cartL.length>_NA_BACKUP_LIMITS.cart)throw new Error('cart: demasiados elementos');
  const draftL=source.draft==null?null:source.draft;if(draftL!==null&&(!Array.isArray(draftL)||draftL.length>_NA_BACKUP_LIMITS.cart))throw new Error('draft: lista inválida');
  const snapshot={
    version:9,updatedAt:_naBackupDate(source.updatedAt||new Date().toISOString(),'updatedAt',{nullable:false}),
    appConfig:_naSanitizeAppConfig(source.appConfig,warnings),
    ui:{currentPage:'pageMenu',isDark:_naBackupBoolean(source.ui?.isDark,'ui.isDark'),currentCfgCategory:_naBackupString(source.ui?.currentCfgCategory||'negocio','ui.currentCfgCategory',40)},
    locks:_naSanitizeLocks(source.locks,warnings),security:_naSanitizeSecurity(source.security,warnings),
    data:{
      productos:productosL.map((item,i)=>_naSanitizeProduct(item,i,warnings)),
      ventas:ventasL.map((item,i)=>_naSanitizeSale(item,i,warnings)),
      clientes:clientesL.map((item,i)=>_naSanitizeSimpleRecord(item,i,'client',warnings)),
      creditos:creditosL.map((item,i)=>_naSanitizeSimpleRecord(item,i,'credit',warnings)),
      gastos:gastosL.map((item,i)=>_naSanitizeSimpleRecord(item,i,'expense',warnings)),
      cajMovs:cajMovsL.map((item,i)=>_naSanitizeSimpleRecord(item,i,'cashMove',warnings)),
      cajEstado:_naSanitizeCashState(source.data.cajEstado,warnings),
      cashClosures:_naValidateCashClosureIdentity(closuresL.map((item,i)=>_naSanitizeCashClosure(item,i,warnings))),
      inventoryMovements:_naValidateInventoryMovementLedger(movsL.map((item,i)=>_naSanitizeInventoryMovement(item,i,warnings)))
    },
    cart:cartL.map((item,i)=>_naSanitizeProduct(item,i,warnings,true)),
    draft:draftL===null?null:draftL.map((item,i)=>_naSanitizeProduct(item,i,warnings,true)),
    ...(source.cloudSync!==undefined?{cloudSync:NuevoAmanecerOutbox.sanitize(source.cloudSync)}:{})
  };
  return{snapshot,warnings,counts:{productos:snapshot.data.productos.length,ventas:snapshot.data.ventas.length,clientes:snapshot.data.clientes.length,creditos:snapshot.data.creditos.length,gastos:snapshot.data.gastos.length,cajMovs:snapshot.data.cajMovs.length,cashClosures:snapshot.data.cashClosures.length,inventoryMovements:snapshot.data.inventoryMovements.length}};
}
function _naDownloadSnapshot(snapshot,prefix='nuevo_amanecer_respaldo'){
  const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`${prefix}_${obtenerHoy()}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function _naBackupSha256(payload){
  if(!globalThis.crypto?.subtle||!globalThis.TextEncoder)return null;
  const bytes=new TextEncoder().encode(JSON.stringify(payload)),digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
}
async function _naCreateCompleteBackup(snapshot=_naBuildSnapshot()){
  const payload=_naClone(snapshot),createdAt=new Date().toISOString(),hash=await _naBackupSha256(payload);
  return{format:'nuevo-amanecer-pos-backup',version:1,createdAt,payload,integrity:hash?{algorithm:'SHA-256',scope:'payload-json',value:hash}:null};
}
async function _naResolveBackupDocument(document){
  if(!_naIsPlainObject(document))throw new Error('El respaldo debe ser un objeto JSON');
  if(!Object.prototype.hasOwnProperty.call(document,'format'))return document;
  if(document.format!=='nuevo-amanecer-pos-backup')throw new Error(`Formato de respaldo no compatible: ${document.format}`);
  if(document.version!==1)throw new Error(`Versión de documento no compatible: ${document.version}`);
  if(!_naIsPlainObject(document.payload))throw new Error('El documento de respaldo no contiene un payload válido');
  if(document.integrity!==null&&document.integrity!==undefined){
    if(!_naIsPlainObject(document.integrity)||document.integrity.algorithm!=='SHA-256'||document.integrity.scope!=='payload-json')throw new Error('Configuración de integridad no compatible');
    if(typeof document.integrity.value!=='string'||!/^[a-f0-9]{64}$/.test(document.integrity.value))throw new Error('Hash de integridad inválido');
    const hash=await _naBackupSha256(document.payload);
    if(!hash)throw new Error('No es posible verificar la integridad en este navegador');
    if(hash!==document.integrity.value)throw new Error('La integridad del respaldo no coincide');
  }
  return document.payload;
}
async function exportarRespaldo(){
  try{const backup=await _naCreateCompleteBackup();_naDownloadSnapshot(backup,'nuevo_amanecer_backup_completo');toast('Respaldo completo descargado','success');return backup;}
  catch(error){console.error('[Respaldo] No se pudo crear el respaldo completo:',error?.name||'Error',error?.message||'');toast('No se pudo crear el respaldo completo','error');return null;}
}
async function importarRespaldo(){
  if(isModuleLocked('productos')||isModuleLocked('ventas')||isModuleLocked('caja')){toast('Desbloquea el sistema antes de restaurar','error');return;}
  const input=document.getElementById('backupFile'),file=input?.files?.[0];
  if(!file){toast('Selecciona un respaldo JSON','error');return;}
  if(!/\.json$/i.test(file.name)||file.size<=0||file.size>_NA_BACKUP_MAX_BYTES){toast('El archivo debe ser JSON y pesar menos de 10 MB','error');return;}
  try{
    const raw=await file.text(),parsed=_naBackupParse(raw),snapshot=await _naResolveBackupDocument(parsed),prepared=_naPrepareBackupSnapshot(snapshot),c=prepared.counts;
    const preview=`Versión: ${prepared.snapshot.version}\nFecha: ${prepared.snapshot.updatedAt}\nProductos: ${c.productos}\nVentas: ${c.ventas}\nClientes: ${c.clientes}\nCréditos: ${c.creditos}\nGastos: ${c.gastos}\nMovimientos de caja: ${c.cajMovs}\nAdvertencias: ${prepared.warnings.length}`;
    const accepted=await _naConfirmAction(preview,{title:'Vista previa del respaldo',subtitle:'Se creará una copia automática de los datos actuales antes de reemplazarlos.',icon:'💾',danger:true,okText:'Crear copia y restaurar'});
    if(!accepted)return;
    const current=_naBuildSnapshot(),currentSerialized=JSON.stringify(current);
    const preLocal=storage.writePersistent('na_pre_restore_snapshot_v1',currentSerialized),preSession=storage.writeSession('na_pre_restore_snapshot_v1_session',currentSerialized);
    if(!(preLocal.ok&&preLocal.verified)&&!(preSession.ok&&preSession.verified))throw new Error('No fue posible crear el respaldo automático previo');
    _naDownloadSnapshot(current,'nuevo_amanecer_antes_de_restaurar');
    try{
      _naApplySnapshot(prepared.snapshot);_naNormalizeData();cart=_naReconcileCart(cart).cart;
      const persistResult=await saveAllData();if(!_naWasPersisted(persistResult))throw new Error('No se pudo verificar el guardado permanente del respaldo');
    }catch(applyError){
      _naApplySnapshot(current);_naNormalizeData();await saveAllData();throw applyError;
    }
    _naMarkCatalogState({seeded:false,suppressed:Array.isArray(productos)&&productos.length===0});
    renderCategorySelects();_naApplyConfigUI();posRender();posUpdateCart();invRender();cliRender();ventasRender();cajRender();gasRender();cfgUpdateStats();updateDashboard();goMenu();
    if(input)input.value='';
    toast(prepared.warnings.length?`Respaldo restaurado con ${prepared.warnings.length} advertencia(s)`:'Respaldo restaurado y validado correctamente','success');
  }catch(error){
    console.error('[Respaldo] Restauración rechazada:',error?.name||'Error',error?.message||'');
    toast(error?.message?`Respaldo rechazado: ${error.message}`:'El respaldo no es válido o no pudo guardarse','error');
  }
}

// Reconcilia borradores con el stock real.
cargarBorrador=async function(){
  try{
    const raw=storage.getItem('na_cart_draft');
    if(!raw){toast('No hay borrador guardado','error');return;}
    const draft=JSON.parse(raw);
    if(!Array.isArray(draft)||!draft.length){toast('Borrador vacío','error');return;}
    if(cart.length&&!await _naConfirmAction('¿Reemplazar el carrito actual con el borrador?',{title:'Cargar borrador',subtitle:'El carrito actual será sustituido.',icon:'📝',okText:'Cargar'}))return;
    const previous=_naClone(cart),rebuilt=[];
    for(const old of draft){
      const prod=productos.find(p=>String(p.id)===String(old.id));
      if(!prod&&Number(old.id)>0)continue;
      const item={...old,precio:_naNumber(old.precio),qty:Math.max(1,_naNumber(old.qty,1)),unitsPerQty:Math.max(1,_naInt(old.unitsPerQty,1)),_lineKey:old._lineKey||_naLineKey(old.id,_naInt(old.unitsPerQty,1)>1?'caja':'unidad')};
      if(prod){const maxQty=Math.floor(prod.stock/_naUnitsPerQty(item));item.qty=Math.min(item.qty,maxQty);if(item.qty<1)continue;}
      rebuilt.push(item);
    }
    cart=rebuilt;posUpdateCart();
    const persistResult=await saveAllData();
    if(!_naWasPersisted(persistResult)){cart=previous;await saveAllData();posUpdateCart();toast('El borrador no se cargó porque no existe guardado permanente verificado','error');return;}
    toast('Borrador cargado y guardado','success');
  }catch(error){console.error(error);toast('Error al cargar borrador','error');}
  closeCartMenu();
};


// ===== CONTROL MAESTRO AVANZADO: aplicación real de permisos =====
const _naSecOriginalAbrirDescuento=abrirDescuento;
abrirDescuento=function(){if(!_naSecurity.rules.allowDiscounts){toast('Los descuentos están desactivados por Control maestro','error');return;}if(!_naAuthorize('descuentos','Aplicar descuento a la venta'))return;_naAudit('Descuento solicitado');return _naSecOriginalAbrirDescuento();};
const _naSecOriginalAplicarDescuento=aplicarDescuentoPorcentaje;
aplicarDescuentoPorcentaje=function(value){const max=Math.max(0,Number(_naSecurity.rules.maxDiscount)||0),requested=Math.max(0,Number(value)||0);if(requested>max){toast(`El descuento máximo permitido es ${max}%`,'error');value=max;}_naAudit('Descuento aplicado',`${Number(value)||0}%`);return _naSecOriginalAplicarDescuento(value);};
const _naSecOriginalAnularV=anularV;
anularV=async function(id){if(window.NuevoAmanecerCanonical?.enabled?.()&&window.NA_ANNUL)return await window.NA_ANNUL.annul(id);if(!_naAuthorize('anularVenta',`Anular la venta ${id}`))return;_naAudit('Anulación autorizada',id);return await _naSecOriginalAnularV(id);};
const _naSecOriginalCerrarCaja=cerrarCaja;
cerrarCaja=function(){if(cajCloseProc)return;if(!_naAuthorize('cerrarCaja','Cerrar caja del día'))return;_naAudit('Cierre de caja autorizado');return _naSecOriginalCerrarCaja();};
const _naSecOriginalResetModule=resetModule;
resetModule=async function(modulo){if(!_naAuthorize('reset',`Resetear ${modulo}`))return;_naAudit('Reseteo autorizado',modulo);return await _naSecOriginalResetModule(modulo);};
const _naSecOriginalImportProducts=importProducts;
importProducts=function(){if(isModuleLocked('importacion')){toast('Importaciones bloqueadas por Control maestro','error');return;}if(!_naAuthorize('importar','Importar productos'))return;_naAudit('Importación de productos autorizada');return _naSecOriginalImportProducts();};
const _naSecOriginalImportBackup=importarRespaldo;
importarRespaldo=async function(){if(isModuleLocked('importacion')){toast('Restauración bloqueada por Control maestro','error');return;}if(!_naAuthorize('importar','Restaurar respaldo completo'))return;_naAudit('Restauración de respaldo autorizada');return await _naSecOriginalImportBackup();};
const _naSecOriginalGuardarConfig=guardarConfig;
guardarConfig=function(){if(isModuleLocked('configuracion')){toast('Configuración general protegida','error');return;}if(!_naAuthorize('configuracion','Guardar configuración del sistema'))return;_naAudit('Configuración guardada',currentCfgCategory);return _naSecOriginalGuardarConfig();};
const _naSecOriginalToggleCfg=toggleCfg;
toggleCfg=function(id){if(isModuleLocked('configuracion')){toast('Configuración general protegida','error');return;}if(!_naAuthorize('configuracion','Modificar configuración'))return;return _naSecOriginalToggleCfg(id);};
const _naSecOriginalApplyFont=applyFontSize;
applyFontSize=function(){if(isModuleLocked('configuracion')){toast('Configuración general protegida','error');renderCfgContent(currentCfgCategory);return;}if(!_naAuthorize('configuracion','Cambiar tamaño de fuente')){renderCfgContent(currentCfgCategory);return;}return _naSecOriginalApplyFont();};
const _naSecOriginalSetAccent=setAccent;
setAccent=function(element,color,dark){if(isModuleLocked('configuracion')){toast('Configuración general protegida','error');renderCfgContent(currentCfgCategory);return;}if(!_naAuthorize('configuracion','Cambiar color del sistema')){renderCfgContent(currentCfgCategory);return;}return _naSecOriginalSetAccent(element,color,dark);};
const _naSecOriginalPosAddBySku=posAddBySku;
posAddBySku=function(code){const raw=String(code||'').trim(),found=productos.some(p=>_naProductMatchesCode(p,raw));if(!found&&!_naGenericSaleAllowed()){toast('La venta libre está desactivada o bloqueada por Control maestro','error');return;}return _naSecOriginalPosAddBySku(code);};
const _naSecOriginalAbrirCli=abrirModalCli;
abrirModalCli=function(){const canonicalBridge=globalThis.NuevoAmanecerCanonicalCustomerBridge;const canonicalCustomerUi=!!(canonicalBridge&&typeof canonicalBridge.enabled==='function'&&canonicalBridge.enabled());if(isModuleLocked('clientes',{canonicalCustomerUi})){toast('Clientes y créditos están protegidos','error');return;}return _naSecOriginalAbrirCli();};
const _naSecOriginalAbrirGasto=abrirModalGasto;
abrirModalGasto=function(){if(isModuleLocked('gastos')){toast('Gastos y egresos están protegidos','error');return;}return _naSecOriginalAbrirGasto();};


// Ajustes de inicialización y autoguardado.



window.addEventListener('resize',_naApplyConfigUI);
let _naVersionUpdatePending=false;
function _naSetHeaderConnectionState(state,label){
  const status=document.getElementById('localStatus');
  if(!status)return;
  const requested=state==='connected'||state==='disconnected'||state==='update'?state:'disconnected';
  const effective=requested!=='disconnected'&&_naVersionUpdatePending?'update':requested;
  const fallback=effective==='connected'?'Conectado':effective==='update'?'Nueva versión pendiente':'Desconectado';
  const text=String(label||fallback);
  status.dataset.state=effective;
  status.setAttribute('aria-label',text);
  status.setAttribute('title',text);
  const hidden=status.querySelector('.g-status-label');
  if(hidden)hidden.textContent=text;
}
window.addEventListener('na:version-update-pending',()=>{
  _naVersionUpdatePending=true;
  _naSetHeaderConnectionState(navigator.onLine===false?'disconnected':'connected',navigator.onLine===false?'Desconectado':'Nueva versión pendiente');
});
let _naCanonicalTransportConnected=false;
window.addEventListener('na:canonical-connected',()=>{
  _naCanonicalTransportConnected=true;
  _naSetHeaderConnectionState('update','Sincronizando CANON…');
});
let _naCanonicalLoadError=null;
function _naEmptyCanonicalCashState(){return{abierta:false,fondo:0,cajero:'',cajeroNombre:'',cajeroId:null,hora:'',hora24:'',fechaApertura:'',cerrada:false,horaCierre:null,horaCierre24:null,sessionId:null,contado:null,esperado:null,diferencia:null,canonical:true};}
var _naCanonicalViewApplied=false;
function _naClearCanonicalOperationalView(){_naCanonicalViewApplied=false;ventas=[];gastos=[];cajMovs=[];inventoryMovements=[];cajEstado=_naEmptyCanonicalCashState();}
function _naClearCanonicalLegacyView(){_naCanonicalViewApplied=false;
  productos=[];clientes=[];creditos=[];_naClearCanonicalOperationalView();
}
// Etapa 1.4 (auditoría 2026-10-12): el estado de caja del equipo se reconstruye
// SIEMPRE con las cajas del servidor (cash-sessions) en cada actualización, aunque
// el resto de la vista se reutilice. Así no queda una caja vieja tras un cierre y
// apertura en otro equipo, un cierre con respuesta perdida o una reconexión.
function _naRebuildCanonicalCashState(){
  try{
    const adapter=window.NuevoAmanecerCanonicalUIAdapter,snap=NuevoAmanecerCanonical.snapshot();
    if(adapter&&typeof adapter.cashState==='function'&&snap&&Array.isArray(snap.cashSessions))cajEstado=adapter.cashState(snap.cashSessions);
  }catch(_){}
}
function _naApplyCanonicalLegacyView(canonical){
  if(!canonical||!Array.isArray(canonical.products)||!Array.isArray(canonical.customers)||!Array.isArray(canonical.credits)||!Array.isArray(canonical.sales)||!Array.isArray(canonical.expenses)||!Array.isArray(canonical.cashMovements)||!Array.isArray(canonical.inventoryMovements)||!canonical.cashState)throw new Error('CANONICAL_OPERATIONAL_SNAPSHOT_INVALID');
  productos=canonical.products;clientes=canonical.customers;creditos=canonical.credits;ventas=canonical.sales;gastos=canonical.expenses;cajMovs=canonical.cashMovements;inventoryMovements=canonical.inventoryMovements;cajEstado=canonical.cashState;
}
const _naLocalCliRender=cliRender;
cliRender=function(){
  if(typeof NuevoAmanecerCanonical!=='undefined'&&NuevoAmanecerCanonical.enabled()&&_naCanonicalLoadError){
    const badge=document.getElementById('cliAuthorityBadge');if(badge){badge.hidden=false;badge.textContent='Canónico no disponible';badge.style.cssText='padding:5px 9px;border-radius:999px;background:#fee2e2;color:#991b1b;font-size:11px;font-weight:800'}
    ['cliB0','cliB1','cliB2','cliB3','cliS0','cliS1','cliS2','cliS3'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='--';});
    const wrap=document.getElementById('cliList');if(wrap){wrap.replaceChildren();const msg=document.createElement('div');msg.className='empty-state';msg.textContent='Canónico no disponible. Comprueba tu conexión y vuelve a intentar.';const retry=document.createElement('button');retry.type='button';retry.textContent='Reintentar conexión';retry.style.cssText='display:block;margin:12px auto;padding:10px 16px;min-height:44px;border:0;border-radius:8px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer';retry.addEventListener('click',async()=>{retry.disabled=true;retry.textContent='Conectando…';try{await NuevoAmanecerCanonical.startPOS();const canonical=NuevoAmanecerCanonical.legacySnapshot();_naApplyCanonicalLegacyView(canonical);_naCanonicalLoadError=null;renderCategorySelects();_naSchedulePageRender(_naActivePageId());}catch(error){_naCanonicalLoadError=error;_naClearCanonicalLegacyView();renderCategorySelects();_naSchedulePageRender(_naActivePageId());}});msg.append(document.createElement('br'),retry);wrap.append(msg);}return;
  }
  _naLocalCliRender();
  if(typeof NuevoAmanecerCanonical!=='undefined'&&NuevoAmanecerCanonical.enabled()&&!_naCanonicalLoadError){const today=obtenerHoy();cobradoHoy=creditos.reduce((sum,cr)=>sum+(Array.isArray(cr.pagos)?cr.pagos.filter(pay=>pay.canonicalDateKnown&&pay.fecha===today&&pay.status!=='REVERTED').reduce((paid,pay)=>paid+Number(pay.monto||0),0):0),0);const paidToday=document.getElementById('cliS3');if(paidToday)paidToday.textContent=`S/${cobradoHoy.toFixed(2)}`;{const _naPaidLbl=document.getElementById('cliS3')?.parentElement?.querySelector('.ss-lbl');if(_naPaidLbl)_naPaidLbl.textContent='Cobrado hoy (todos los medios)';}}
  try{window.dispatchEvent(new CustomEvent('na:clients-rendered'));}catch(_){}
};
window.addEventListener('offline',()=>{_naCanonicalTransportConnected=false;if(typeof NuevoAmanecerCanonical!=='undefined'&&NuevoAmanecerCanonical.enabled()){const state=NuevoAmanecerCanonical.sourceState(),badge=document.getElementById('cliAuthorityBadge');_naSetHeaderConnectionState('disconnected','Desconectado');/* Etapa 1.6 (auditoría 2026-10-12, Bot 3 P1-1): una réplica ya validada (remote/revalidated) se trata igual que la caché: la lista de clientes queda visible en solo lectura; solo sin datos se muestra "Canónico no disponible". */if(state.source!=='none'&&_naCanonicalViewApplied){if(badge){badge.hidden=false;badge.textContent='Sin conexión · datos guardados';}_naSchedulePageRender(_naActivePageId());}else{_naCanonicalLoadError=new Error('AUTHORITY_UNAVAILABLE');_naSchedulePageRender(_naActivePageId());}}});
window.addEventListener('na:canonical-updated',()=>{
  if(typeof NuevoAmanecerCanonical==='undefined'||!NuevoAmanecerCanonical.enabled())return;
  const state=NuevoAmanecerCanonical.sourceState(),saveStatus=document.getElementById('saveStatus'),badge=document.getElementById('cliAuthorityBadge');
  if(state.source==='none'){
    _naCanonicalTransportConnected=false;
    _naCanonicalLoadError=new Error(state.validation==='offline'?'AUTHORITY_UNAVAILABLE':'CANONICAL_LOAD_FAILED');
    _naClearCanonicalLegacyView();
    renderCategorySelects();_naSchedulePageRender(_naActivePageId());
    _naSetHeaderConnectionState('disconnected',state.validation==='offline'?'Sin conexión · CANON no disponible':'Canónico no disponible · reintenta');
    if(saveStatus)saveStatus.textContent='Autoridad canónica no validada';
    if(badge){badge.hidden=false;badge.textContent='Canónico no disponible';}
    return;
  }
  try{
    // Cached rows re-confirmed by the authority (only read-only -> ACTIVE changed): keep the view already built.
    const reuse=state.unchanged===true&&_naCanonicalViewApplied&&!_naCanonicalLoadError;
    const canonical=reuse?null:NuevoAmanecerCanonical.legacySnapshot();
    if(!reuse){_naApplyCanonicalLegacyView(canonical);_naCanonicalViewApplied=true;renderCategorySelects();}
    else _naRebuildCanonicalCashState();
    _naCanonicalLoadError=null;_naSchedulePageRender(_naActivePageId());
    const connectionReady=state.validation==='current',connectionSyncing=state.validation==='validating';
    _naSetHeaderConnectionState(connectionReady?'connected':connectionSyncing?'update':'disconnected',connectionReady?'Conectado':connectionSyncing?'Sincronizando CANON…':'Desconectado');
    if(saveStatus){if(window.NA_ICON_TEXT)NA_ICON_TEXT(saveStatus,'cloud','Guardado en la nube');else saveStatus.textContent='☁️ Guardado en la nube';}
    if(badge){badge.hidden=false;badge.textContent=state.validation==='offline'?'Cache canónico · sin conexión':'Canónico · '+String(reuse?clientes.length:canonical.customers.length)+' clientes';}
  }catch(error){
    _naCanonicalTransportConnected=false;
    _naCanonicalLoadError=error;_naClearCanonicalLegacyView();
    renderCategorySelects();_naSchedulePageRender(_naActivePageId());
    _naSetHeaderConnectionState('disconnected','Canónico no disponible · reintenta');
    if(saveStatus)saveStatus.textContent='Autoridad canónica no validada';
  }
});
window.addEventListener('storage',event=>{if(typeof NuevoAmanecerCanonical!=='undefined'&&NuevoAmanecerCanonical.enabled()&&(!event.key||event.key==='na_canonical_binding'||event.key==='na_cloud_sync_credentials')){_naCanonicalTransportConnected=false;_naCanonicalLoadError=new Error('STALE_AUTHORITY_BINDING');_naSchedulePageRender(_naActivePageId());_naSetHeaderConnectionState('disconnected','Desconectado');}});
document.addEventListener('DOMContentLoaded',async()=>{
  // Start the canonical status/credit-accounts reads now; startPOS consumes them under the usual fences.
  try{if(typeof NuevoAmanecerCanonical!=='undefined'&&NuevoAmanecerCanonical.enabled()&&typeof NuevoAmanecerCanonical.warm==='function')NuevoAmanecerCanonical.warm();}catch(_){}
  document.getElementById('fechaHoy').textContent=new Date().toLocaleDateString('es-PE',{weekday:'long',day:'numeric',month:'long',year:'numeric'});document.getElementById('backBtn').style.display='none';
  await loadAllData();
  const canonicalEnabled=typeof NuevoAmanecerCanonical!=='undefined'&&NuevoAmanecerCanonical.enabled();
  if(canonicalEnabled){productos=[];clientes=[];creditos=[];}
  if(canonicalEnabled){_naClearCanonicalOperationalView();}
  loadAppState();loadMasterConfig();_naInitSecurity();_naNormalizeData();renderCategorySelects();_naApplyConfigUI();_naInitFreeSaleShortcut();_naInitBarcodeScanner();creditos.forEach(_naSyncCreditStatus);posUpdateCart(canonicalEnabled?false:true);_naSchedulePageRender(_naActivePageId());
  const cliBadge=document.getElementById('cliAuthorityBadge');if(canonicalEnabled&&cliBadge){cliBadge.hidden=false;cliBadge.textContent='Canónico · conectando';cliBadge.style.cssText='padding:5px 9px;border-radius:999px;background:#e0f2fe;color:#075985;font-size:11px;font-weight:800';}
  const saveStatus=document.getElementById('saveStatus');if(canonicalEnabled){_naSetHeaderConnectionState('update','Sincronizando CANON…');if(saveStatus)saveStatus.textContent='Conectando…';}
  document.querySelectorAll('.module-card').forEach(card=>{card.setAttribute('role','button');card.setAttribute('tabindex','0');card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();card.click();}});});
  if(!canonicalEnabled)await saveAllData();
  if(canonicalEnabled){
    if(typeof NuevoAmanecerCanonicalSaleOutbox!=='undefined')NuevoAmanecerCanonicalSaleOutbox.start();
    NuevoAmanecerCanonical.startPOS().catch(error=>{
      _naCanonicalTransportConnected=false;
      _naCanonicalLoadError=error;_naClearCanonicalLegacyView();
      renderCategorySelects();_naSchedulePageRender(_naActivePageId());
      _naSetHeaderConnectionState('disconnected',navigator.onLine===false?'Sin conexión · CANON no disponible':'Canónico no disponible · reintenta');
      if(saveStatus)saveStatus.textContent='Autoridad canónica no validada';
      if(cliBadge){cliBadge.hidden=false;cliBadge.textContent='Canónico no disponible';cliBadge.style.cssText='padding:5px 9px;border-radius:999px;background:#fee2e2;color:#991b1b;font-size:11px;font-weight:800';}
    });
  }
  if(typeof NuevoAmanecerOutbox!=='undefined'&&!canonicalEnabled)NuevoAmanecerOutbox.start(_naQueueCloudSyncPersist);
});

