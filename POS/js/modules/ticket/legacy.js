// ===== TICKET =====
let tkCurrentVenta=null;
function _naTicketTaxBreakdown(v){if(typeof _naTaxBreakdownForSale==='function')return _naTaxBreakdownForSale(v);const legacy=desglosarIGV(totalV(v),!!appConfig.igvActive);return{taxActive:!!appConfig.igvActive,subtotal:legacy.subtotal,totalIGV:legacy.igv,totalVenta:legacy.total??totalV(v)};}
function toggleEditor(){const p=document.getElementById('editorPanel'),btn=document.getElementById('btnEditorToggle');const open=p.style.display==='none';p.style.display=open?'block':'none';btn.textContent=open?'👁 Vista previa':'✏️ Diseñar';}
function _naTicketSelectedMm(){const sel=document.getElementById('tkAncho')?.value||appConfig.ticket.ancho||'80mm';if(sel==='custom')return Math.max(20,Math.min(120,Number(document.getElementById('tkCustomMm')?.value||appConfig.ticket.customMm||60)));return Math.max(20,parseFloat(sel)||80);}
function _naTicketChars(mm){if(mm<=30)return 12;if(mm<=40)return 18;if(mm<=50)return 24;if(mm<=58)return 29;if(mm<=80)return 42;return Math.max(12,Math.min(64,Math.floor(mm*.52)));}
function ticketWidthChanged(){const custom=document.getElementById('tkAncho')?.value==='custom',wrap=document.getElementById('tkCustomWidthWrap');if(wrap)wrap.style.display=custom?'block':'none';renderTicketPreview();}
function ticketPreviewSizeChanged(){const custom=document.getElementById('tkTamano')?.value==='custom',wrap=document.getElementById('tkCustomPreviewWrap');if(wrap)wrap.style.display=custom?'block':'none';renderTicketPreview();}
function _naTicketPreviewSize(){const selected=document.getElementById('tkTamano')?.value||'11px';if(selected!=='custom')return selected;const px=Math.max(7,Math.min(24,Number(document.getElementById('tkCustomPreviewPx')?.value||11)));return `${px}px`; }
function _naTicketAscii(value){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[¡]/g,'!').replace(/[¿]/g,'?').replace(/[^\x20-\x7E]/g,'').replace(/\s+/g,' ').trim();}
function _naTkPadRight(value,len){const s=_naTicketAscii(value);return s.slice(0,len)+' '.repeat(Math.max(0,len-s.length));}
function _naTkPadLeft(value,len){const s=_naTicketAscii(value);return ' '.repeat(Math.max(0,len-s.length))+s.slice(-len);}
function _naTkCenter(value,width){const s=_naTicketAscii(value).slice(0,width),left=Math.max(0,Math.floor((width-s.length)/2));return ' '.repeat(left)+s;}
function _naTkPair(left,right,width){left=_naTicketAscii(left);right=_naTicketAscii(right);if(right.length>=width)return right.slice(-width);const maxLeft=Math.max(1,width-right.length-1);left=left.slice(0,maxLeft);return left+' '.repeat(Math.max(1,width-left.length-right.length))+right;}
function _naTkAlignLine(value,width,align='left'){const s=_naTicketAscii(value).slice(0,width);if(align==='center')return _naTkCenter(s,width);if(align==='right')return _naTkPadLeft(s,width);return s;}
function _naTkField(label,value,width,align='left'){label=_naTicketAscii(label);value=_naTicketAscii(value);if(align==='split')return _naTkPair(label+' :',value,width);const combined=`${label}: ${value}`;const wrapped=_naTkWrap(combined,width);return wrapped.map(line=>_naTkAlignLine(line,width,align));}
function _naTkWrap(value,width){const words=_naTicketAscii(value).split(/\s+/).filter(Boolean),lines=[];let line='';for(let word of words){while(word.length>width){if(line){lines.push(line);line='';}lines.push(word.slice(0,width));word=word.slice(width);}if(!word)continue;if(!line)line=word;else if((line+' '+word).length<=width)line+=' '+word;else{lines.push(line);line=word;}}if(line)lines.push(line);return lines.length?lines:[''];}
function _naTkFormatDate(value){const s=String(value||'');const m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[3]}/${m[2]}/${m[1]}`:s;}
function _naTkMoney(value,showCurrency=true){const n=Number(value||0).toFixed(2);return showCurrency?`S/ ${n}`:n;}
function _naTkPayment(value){return({efectivo:'EFECTIVO',yape:'YAPE',plin:'PLIN',transferencia:'TRANSFERENCIA',credito:'CREDITO',mixto:'PAGO MIXTO'})[value]||String(value||'').toUpperCase()||'EFECTIVO';}
function _naTkOperation(v){return v?.paymentRef?String(v.paymentRef):'';}
function _naTkLabels(width,mode){const compact=mode==='compact'||(mode==='auto'&&width<30);const medium=mode==='auto'&&width>=30&&width<40;if(compact)return{ticket:'Tk',operation:'Op',date:'Fec',time:'Hora',cashier:'Caj',qty:'Ct',desc:'Desc',amount:'Monto',articles:'Arts',total:'TOTAL',payment:'Pago',received:'Rec',change:'Vto'};if(medium)return{ticket:'Ticket',operation:'Oper.',date:'Fecha',time:'Hora',cashier:'Cajero',qty:'Cant',desc:'Descripcion',amount:'Importe',articles:'Articulos',total:'TOTAL A PAGAR',payment:'Pago',received:'Recibido',change:'Vuelto'};return{ticket:'Ticket N°',operation:'Operacion',date:'Fecha',time:'Hora',cashier:'Cajero',qty:'Cant',desc:'Descripcion',amount:'Importe',articles:'Total de articulos',total:'TOTAL A PAGAR',payment:'Forma de pago',received:'Recibido',change:'Vuelto'};}
function _naBuildThermalTicket(v,fromDom=true){
  const cfg=appConfig.ticket||{},mm=fromDom?_naTicketSelectedMm():(cfg.ancho==='custom'?Number(cfg.customMm||60):parseFloat(cfg.ancho)||80),width=_naTicketChars(mm),mode=(fromDom?document.getElementById('tkLayout')?.value:cfg.layoutMode)||'auto',labels=_naTkLabels(width,mode),headerAlign=(fromDom?document.getElementById('tkAlign')?.value:cfg.align)||'center',infoAlign=(fromDom?document.getElementById('tkInfoAlign')?.value:cfg.infoAlign)||'left',paymentAlign=(fromDom?document.getElementById('tkPaymentAlign')?.value:cfg.paymentAlign)||'split',footerAlign=(fromDom?document.getElementById('tkFooterAlign')?.value:cfg.footerAlign)||'center';
  const get=(id,fallback='')=>fromDom?(document.getElementById(id)?.value??fallback):fallback,check=(id,fallback=true)=>fromDom?(document.getElementById(id)?.checked??fallback):fallback;
  const b=_naGetBusiness(),name=get('tkNegocio',(b.nombre||'NUEVO AMANECER').toUpperCase()),ruc=get('tkRuc',b.ruc?`RUC/DNI: ${b.ruc}`:''),address=get('tkDireccion',b.direccion||''),phone=get('tkTelefono',b.telefono?`Tel: ${b.telefono}`:''),pie=get('tkPie',cfg.pie||'GRACIAS POR SU COMPRA');
  const showHeader=check('tkShowLogo',cfg.showLogo!==false),showNum=check('tkShowNum',cfg.showNum!==false),showOperation=check('tkShowOperation',cfg.showOperation!==false),showIGV=check('tkShowIGV',(()=>{try{const v=localStorage.getItem('na_show_igv_line');return v===null?(cfg.showIGV!==false):v!=='0';}catch(_){return cfg.showIGV!==false;}})()),showCurrency=check('tkShowCurrency',cfg.showCurrency!==false),showUnit=check('tkShowUnitPrice',cfg.showUnitPrice!==false),showPayment=check('tkShowPayment',cfg.showPayment!==false),showReceived=check('tkShowReceived',cfg.showReceived!==false),showSep=check('tkShowSep',cfg.showSep!==false);
  const lines=[],eq='='.repeat(width),dash='-'.repeat(width),sep=showSep?dash:'';
  if(showHeader)lines.push(eq);
  for(const line of _naTkWrap(name.toUpperCase(),width))lines.push(_naTkAlignLine(line,width,headerAlign));
  if(ruc)for(const line of _naTkWrap(ruc,width))lines.push(_naTkAlignLine(line,width,headerAlign));
  if(showHeader)lines.push(eq);
  if(address)for(const line of _naTkWrap(address,width))lines.push(_naTkAlignLine(line,width,headerAlign));
  if(phone)for(const line of _naTkWrap(phone,width))lines.push(_naTkAlignLine(line,width,headerAlign));
  lines.push('');
  const pushField=(label,value,align=infoAlign)=>{const formatted=_naTkField(label,value,width,align);if(Array.isArray(formatted))lines.push(...formatted);else lines.push(formatted);};
  if(showNum)pushField(labels.ticket,v?.id||'');
  if(showOperation){const op=_naTkOperation(v);if(op)pushField(labels.operation,op);}
  pushField(labels.date,_naTkFormatDate(v?.fecha||obtenerHoy()));
  pushField(labels.time,v?.hora||nowT());
  pushField(labels.cashier,(globalThis.NA_RECORD_CASHIER?.get?.([v?.sale_id,v?.id,v?.operation_id,v?.operation])?.nombre)||v?.cajeroNombre||v?.cajero||b.cajero||'');
  lines.push('');if(showSep)lines.push(dash);
  const total=totalV(v||{items:[]}),items=v?.items||[];
  if(width>=24){
    const qtyW=width>=38?4:3,amtW=Math.min(width>=38?(showCurrency?10:8):(showCurrency?8:7),Math.max(6,Math.floor(width*.31))),descW=width-qtyW-amtW-2;
    lines.push(_naTkPadRight(labels.qty,qtyW)+' '+_naTkPadRight(labels.desc,descW)+' '+_naTkPadLeft(labels.amount,amtW));if(showSep)lines.push(dash);
    for(const item of items){const amount=_naTkMoney(Number(item.qty||0)*Number(item.precio||0),showCurrency),descLines=_naTkWrap(item.name||'Producto',Math.max(3,descW));descLines.forEach((d,index)=>{lines.push(_naTkPadRight(index===0?String(item.qty):'',qtyW)+' '+_naTkPadRight(d,descW)+' '+_naTkPadLeft(index===0?amount:'',amtW));});if(showUnit&&width>=26)lines.push(_naTkPair('','P.U. '+_naTkMoney(item.precio,showCurrency),width));}
  }else{
    for(const item of items){const prefix=`${item.qty}x `,descWidth=Math.max(5,width-prefix.length);const descLines=_naTkWrap(item.name||'Producto',descWidth);descLines.forEach((d,index)=>lines.push((index===0?prefix:' '.repeat(prefix.length))+d));lines.push(_naTkPadLeft(_naTkMoney(Number(item.qty||0)*Number(item.precio||0),showCurrency),width));if(showUnit)lines.push(_naTkPadLeft('P.U. '+_naTkMoney(item.precio,showCurrency),width));}
  }
  if(showSep)lines.push(dash);
  const articles=items.reduce((sum,i)=>sum+Number(i.qty||0),0);{const f=_naTkField(labels.articles,String(articles),width,paymentAlign);Array.isArray(f)?lines.push(...f):lines.push(f);}
  if(showSep)lines.push(eq);
  const taxBreakdown=_naTicketTaxBreakdown(v);if(showIGV&&taxBreakdown.taxActive){const p=taxBreakdown;{const f=_naTkField('Subtotal',_naTkMoney(p.subtotal,showCurrency),width,paymentAlign);Array.isArray(f)?lines.push(...f):lines.push(f);}{const f=_naTkField('IGV 18%',_naTkMoney(p.totalIGV,showCurrency),width,paymentAlign);Array.isArray(f)?lines.push(...f):lines.push(f);}}
  {const f=_naTkField(labels.total,_naTkMoney(total,showCurrency),width,paymentAlign);Array.isArray(f)?lines.push(...f):lines.push(f);}
  if(showSep)lines.push(eq);
  if(showPayment){lines.push('');const addPay=(label,value)=>{const f=_naTkField(label,value,width,paymentAlign);Array.isArray(f)?lines.push(...f):lines.push(f);};addPay(labels.payment,_naTkPayment(v?.metodo));const received=Number(v?.recibido??v?.received??(v?.metodo==='efectivo'?total:0)),change=Number(v?.vuelto??v?.change??Math.max(0,received-total));if(showReceived&&v?.metodo==='efectivo'){addPay(labels.received,_naTkMoney(received,showCurrency));addPay(labels.change,_naTkMoney(change,showCurrency));}if(v?.metodo==='mixto'&&v?.paymentBreakdown){const mix=v.paymentBreakdown,digitalLabel=mix.digitalMethod==='yape'?'Yape':mix.digitalMethod==='plin'?'Plin':'Transferencia';addPay('Efectivo',_naTkMoney(mix.efectivo,showCurrency));addPay(digitalLabel,_naTkMoney(mix.digital,showCurrency));}}
  lines.push('');if(showSep)lines.push(eq);
  const footerParts=String(pie||'').split('|').map(x=>x.trim()).filter(Boolean);for(const part of footerParts){for(const line of _naTkWrap(part,width))lines.push(_naTkAlignLine(line,width,footerAlign));lines.push('');}if(lines[lines.length-1]==='')lines.pop();if(showSep)lines.push(eq);
  return{lines,width,mm,text:lines.join('\n'),showCurrency};
}
function _baseRenderTicketPreview(){
  const v=tkCurrentVenta||{id:'V-000001',operation:'00000001',fecha:obtenerHoy(),hora:nowT(),cajero:'Frank',metodo:'efectivo',recibido:25,vuelto:4,anulada:false,items:[{name:'Producto de ejemplo',qty:2,precio:8.5},{name:'Segundo producto',qty:1,precio:4}]};
  const built=_naBuildThermalTicket(v,true),wrap=document.getElementById('tkPreviewWrap'),body=document.getElementById('ticketBody'),font=document.getElementById('tkFuente')?.value||"'Courier New',monospace",size=_naTicketPreviewSize();
  const selected=document.getElementById('tkAncho')?.value,customWrap=document.getElementById('tkCustomWidthWrap');if(customWrap)customWrap.style.display=selected==='custom'?'block':'none';const info=document.getElementById('tkWidthInfo');if(info)info.textContent=`${built.mm} mm · aproximadamente ${built.width} caracteres por línea`;
  wrap.style.width=`${built.mm}mm`;wrap.style.maxWidth='calc(100vw - 38px)';wrap.style.boxSizing='border-box';body.style.fontFamily=font;body.style.fontSize=size;body.style.background='#fff';body.style.color='#000';body.style.filter='grayscale(1)';body.style.padding=built.mm<=40?'8px 4px':'10px 6px';body.style.boxSizing='border-box';body.style.width='100%';body.style.overflow='hidden';body.innerHTML=`<pre class="thermal-ticket-pre">${_naEsc(built.text)}</pre>`;
}

let _naPrinterPort=null,_naPrinterConnectionType=null,_naAuthorizedPrinterPorts=[];
function _naEsAndroid(){return /Android/i.test(navigator.userAgent||'');}
function _naEsMovil(){return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent||'');}
function abrirOpcionesImpresion(){
  _naSaveTicketSettings();
  const cfg=appConfig.printer||{},android=_naEsAndroid(),serialOK=!!navigator.serial;
  const baud=document.getElementById('printerBaud');if(baud)baud.value=String(cfg.baudRate||9600);
  const cut=document.getElementById('printerAutoCut');if(cut)cut.checked=cfg.autoCut!==false;
  const appCard=document.getElementById('printerBluetoothAppCard'),directCard=document.getElementById('printerBluetoothDirectCard'),usbCard=document.querySelector('.printer-option-card.usb'),settings=document.querySelector('.printer-settings-row'),searchBtn=document.getElementById('printerSearchBluetoothBtn');
  if(appCard)appCard.style.display=_naEsMovil()?'flex':'none';
  if(directCard)directCard.style.display=serialOK?'flex':'none';
  if(settings)settings.style.display=serialOK?'grid':'none';
  if(searchBtn){searchBtn.disabled=!serialOK;searchBtn.textContent=serialOK?'🔍 Buscar impresora Bluetooth':'🔒 Bluetooth directo no disponible';}
  if(usbCard){usbCard.classList.toggle('is-disabled',!serialOK);const btn=usbCard.querySelector('.printer-option-btn');if(btn){btn.disabled=!serialOK;btn.textContent=serialOK?'🔗 Conectar e imprimir':'🔒 Navegador sin Web Serial';}}
  const info=document.getElementById('printerCompatibilityInfo');
  if(info){
    if(serialOK){
      info.innerHTML='<div class="printer-platform-note"><span>ℹ️</span><div><strong>Chrome puede buscar impresoras USB o Bluetooth que funcionen como puerto serial.</strong><br>La lista del POS muestra únicamente dispositivos que autorizaste anteriormente. Para añadir otro, toca <b>Buscar impresora Bluetooth</b>.</div></div>';
    }else if(android){
      info.innerHTML='<div class="printer-platform-note"><span>ℹ️</span><div><strong>Este navegador no ofrece conexión Bluetooth directa.</strong><br>Usa <b>Bluetooth mediante app</b> o <b>Impresión del sistema</b>.</div></div>';
    }else{
      info.innerHTML='ℹ️ La conexión directa no está disponible. Usa Impresión del sistema.';
    }
  }
  _naActualizarEstadoImpresora(_naPrinterPort?'Impresora conectada.':'Busca una impresora o selecciona una opción de impresión.');
  document.getElementById('mPrinter').classList.add('open');
  setTimeout(()=>actualizarDispositivosBluetooth(false),0);
}
function imprimirTicket(){abrirOpcionesImpresion();}
function _naPrinterPortKind(port){const info=port?.getInfo?.()||{};if(info.bluetoothServiceClassId)return'Bluetooth SPP';if(info.usbVendorId!=null)return`USB ${Number(info.usbVendorId).toString(16).padStart(4,'0').toUpperCase()}`;return'Bluetooth/Serial';}
function _naPrinterPortIsConnected(port){return port===_naPrinterPort&&!!port?.writable;}
async function actualizarDispositivosBluetooth(showToast=false){
  const summary=document.getElementById('printerBluetoothSummary'),list=document.getElementById('printerBluetoothDevices');if(!summary||!list)return;
  let bluetoothState='Estado Bluetooth no verificable',available=null,ports=[],ble=[];
  try{if(navigator.bluetooth?.getAvailability)available=await navigator.bluetooth.getAvailability();}catch(error){}
  if(available===true)bluetoothState='Bluetooth disponible';else if(available===false)bluetoothState='Bluetooth apagado o no disponible';
  try{if(navigator.serial?.getPorts)ports=await navigator.serial.getPorts();}catch(error){}
  try{if(navigator.bluetooth?.getDevices&&window.isSecureContext)ble=await navigator.bluetooth.getDevices();}catch(error){}
  _naAuthorizedPrinterPorts=ports;
  const rows=[];
  ports.forEach((port,index)=>{const connected=_naPrinterPortIsConnected(port),kind=_naPrinterPortKind(port),info=port.getInfo?.()||{},idParts=[];if(info.usbVendorId!=null)idParts.push(`VID ${Number(info.usbVendorId).toString(16).toUpperCase()}`);if(info.usbProductId!=null)idParts.push(`PID ${Number(info.usbProductId).toString(16).toUpperCase()}`);rows.push(`<div class="printer-device-row"><div class="printer-device-icon">${kind.startsWith('USB')?'🔌':'🖨️'}</div><div class="printer-device-info"><div class="printer-device-name">${kind} autorizado ${index+1}</div><div class="printer-device-meta">${idParts.join(' · ')||'Puerto autorizado por Chrome'}</div><span class="printer-device-state ${connected?'connected':''}">${connected?'● Conectada':'● Autorizada'}</span></div><button class="printer-device-action" onclick="usarPuertoAutorizado(${index})">${connected?'Imprimir':'Conectar'}</button></div>`);});
  ble.forEach((device,index)=>{const connected=!!device.gatt?.connected;rows.push(`<div class="printer-device-row"><div class="printer-device-icon">🔵</div><div class="printer-device-info"><div class="printer-device-name">${_naEsc(device.name||`Dispositivo BLE ${index+1}`)}</div><div class="printer-device-meta">Bluetooth Low Energy autorizado</div><span class="printer-device-state ${connected?'connected':''}">${connected?'● En línea':'● Autorizado'}</span></div><button class="printer-device-action" disabled style="background:var(--slate);opacity:.65">BLE</button></div>`);});
  summary.textContent=`${bluetoothState} · ${ports.length+ble.length} dispositivo(s) autorizado(s)`;
  list.innerHTML=rows.length?rows.join(''):'<div class="printer-device-empty">No hay impresoras autorizadas para este POS. Toca “Buscar impresora Bluetooth” para elegir una.</div>';
  if(showToast)toast(rows.length?`${rows.length} dispositivo(s) autorizado(s)`:'No hay dispositivos autorizados todavía',rows.length?'success':'error');
}
async function buscarImpresoraBluetooth(){
  if(!navigator.serial){toast('Este navegador no permite buscar impresoras seriales','error');return;}
  try{
    _naActualizarEstadoImpresora('Abriendo selector de impresoras Bluetooth…');
    await _naConectarPuerto('bluetooth');
    await actualizarDispositivosBluetooth(false);
    _naActualizarEstadoImpresora('Impresora Bluetooth conectada. Ya puedes imprimir.');
    toast('✅ Impresora Bluetooth conectada','success');
  }catch(error){
    if(error?.name==='AbortError'||/no seleccionaste/i.test(error?.message||'')){_naActualizarEstadoImpresora('No seleccionaste ninguna impresora.');return;}
    console.error(error);const msg=_naMensajePermisoImpresora(error);_naActualizarEstadoImpresora(msg,true);toast(msg,'error');
  }
}
async function usarPuertoAutorizado(index){
  const port=_naAuthorizedPrinterPorts[index];if(!port){toast('El dispositivo ya no está disponible','error');await actualizarDispositivosBluetooth(false);return;}
  try{
    if(port===_naPrinterPort&&port.writable){await _naEnviarTicketPuerto(port);return;}
    await _naCerrarPuertoImpresora();
    const baud=Math.max(300,Number(document.getElementById('printerBaud')?.value)||9600);
    await port.open({baudRate:baud,dataBits:8,stopBits:1,parity:'none',flowControl:'none'});
    _naPrinterPort=port;_naPrinterConnectionType=_naPrinterPortKind(port).startsWith('USB')?'usb':'bluetooth';
    _naActualizarEstadoImpresora(`Dispositivo autorizado conectado a ${baud} bps.`);
    await actualizarDispositivosBluetooth(false);
    toast('Impresora conectada','success');
  }catch(error){const msg=_naMensajePermisoImpresora(error);_naActualizarEstadoImpresora(msg,true);toast(msg,'error');}
}
function _naMensajePermisoImpresora(error){const name=error?.name||'',raw=String(error?.message||'');if(name==='NotAllowedError'||name==='SecurityError'||/permission denied/i.test(raw))return'Chrome no autorizó esta acción. Selecciona la impresora en el cuadro del navegador o usa Impresión del sistema.';if(name==='NotFoundError')return'No se seleccionó una impresora compatible.';if(/already open|open/i.test(raw)&&/port/i.test(raw))return'La impresora ya está siendo usada por otra aplicación. Ciérrala y vuelve a intentar.';return raw||'No se pudo conectar con la impresora.';}
async function _naEnviarTicketPuerto(port){const data=_naCrearTicketEscPos();if(!port?.writable)throw new Error('La impresora no tiene un canal de escritura disponible.');const writer=port.writable.getWriter();try{for(let i=0;i<data.length;i+=256)await writer.write(data.slice(i,i+256));}finally{writer.releaseLock();}_naActualizarEstadoImpresora('Ticket enviado correctamente.');toast('✅ Ticket enviado a la impresora','success');}
function guardarAjustesImpresora(){
  appConfig.printer=appConfig.printer||{};
  appConfig.printer.baudRate=Math.max(300,Number(document.getElementById('printerBaud')?.value)||9600);
  appConfig.printer.autoCut=!!document.getElementById('printerAutoCut')?.checked;
  saveAppState();
}
function _naActualizarEstadoImpresora(message='',error=false){
  const banner=document.getElementById('printerStatusBanner'),title=document.getElementById('printerStatusTitle'),sub=document.getElementById('printerStatusSub'),icon=document.getElementById('printerStatusIcon'),disconnect=document.getElementById('printerDisconnectBtn');
  if(!banner||!title||!sub||!icon)return;
  banner.classList.remove('connected','error');
  if(error){banner.classList.add('error');icon.textContent='🔴';title.textContent='No se pudo conectar';sub.textContent=message||'Revisa la conexión y los permisos del navegador.';}
  else if(_naPrinterPort&&_naPrinterPort.writable){banner.classList.add('connected');icon.textContent='🟢';title.textContent=`Impresora conectada por ${_naPrinterConnectionType==='bluetooth'?'Bluetooth':'cable'}`;sub.textContent=message||'Lista para enviar tickets directamente.';}
  else{icon.textContent='⚪';title.textContent='Sin impresora conectada';sub.textContent=message||'Selecciona Bluetooth mediante app, cable o impresión del sistema.';}
  if(disconnect)disconnect.style.display=_naPrinterPort?'block':'none';
}
async function _naCerrarPuertoImpresora(){
  if(!_naPrinterPort)return;
  try{if(_naPrinterPort.readable||_naPrinterPort.writable)await _naPrinterPort.close();}catch(error){}
  _naPrinterPort=null;_naPrinterConnectionType=null;
}
async function desconectarImpresora(){await _naCerrarPuertoImpresora();_naActualizarEstadoImpresora('La impresora fue desconectada.');await actualizarDispositivosBluetooth(false);toast('Impresora desconectada');}
async function _naConectarPuerto(tipo){
  if(!navigator.serial){throw new Error('Tu navegador no ofrece conexión serial directa. Usa Impresión del sistema.');}
  if(_naPrinterPort&&_naPrinterPort.writable&&_naPrinterConnectionType===tipo)return _naPrinterPort;
  await _naCerrarPuertoImpresora();
  let port;
  try{
    if(tipo==='bluetooth'){
      try{port=await navigator.serial.requestPort({filters:[{bluetoothServiceClassId:'00001101-0000-1000-8000-00805f9b34fb'}]});}
      catch(filterError){if(filterError?.name==='NotFoundError')throw filterError;port=await navigator.serial.requestPort();}
    }else port=await navigator.serial.requestPort();
  }catch(error){if(error?.name==='NotFoundError')throw new Error('No seleccionaste ninguna impresora.');if(error?.name==='NotAllowedError'||error?.name==='SecurityError')throw new Error('Chrome no autorizó el acceso a la impresora.');throw error;}
  const baud=Math.max(300,Number(document.getElementById('printerBaud')?.value)||9600);
  await port.open({baudRate:baud,dataBits:8,stopBits:1,parity:'none',flowControl:'none'});
  _naPrinterPort=port;_naPrinterConnectionType=tipo;
  appConfig.printer={...(appConfig.printer||{}),mode:tipo,baudRate:baud,autoCut:!!document.getElementById('printerAutoCut')?.checked};
  saveAppState();
  const info=port.getInfo?port.getInfo():{};
  const detected=info.bluetoothServiceClassId?'Bluetooth':info.usbVendorId!=null?'USB/OTG':'serial';
  _naActualizarEstadoImpresora(`Puerto ${detected} conectado a ${baud} bps.`);
  return port;
}
function _naCrearTicketTexto(){_naSaveTicketSettings();const v=tkCurrentVenta||{id:'V-000',fecha:obtenerHoy(),hora:nowT(),cajero:_naGetBusiness().cajero||'',items:[]};return _naBuildThermalTicket(v,false).text;}

async function _naFallbackTicketCompartido(text,name,file,reason=''){
  try{if(navigator.clipboard?.writeText&&window.isSecureContext){await navigator.clipboard.writeText(text);_naActualizarEstadoImpresora('Ticket copiado. Ábrelo en la aplicación de tu impresora.');toast('Ticket copiado al portapapeles','success');return;}}catch(error){}
  const blob=URL.createObjectURL(file),a=document.createElement('a');a.href=blob;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(blob),1500);
  _naActualizarEstadoImpresora('Chrome no permitió compartir directamente. El ticket se descargó para abrirlo con tu app de impresión.');
  toast('Ticket descargado; ábrelo con la app de la impresora','success');
}
async function compartirTicketBluetooth(){
  const text=_naCrearTicketTexto(),name=`ticket-${(tkCurrentVenta?.id||'venta').replace(/[^a-z0-9_-]/gi,'_')}.txt`,file=new File([text],name,{type:'text/plain;charset=utf-8'});
  try{
    if(!navigator.share){await _naFallbackTicketCompartido(text,name,file);return;}
    try{
      if(navigator.canShare?.({files:[file]})){await navigator.share({title:'Ticket de venta',text,files:[file]});}
      else await navigator.share({title:'Ticket de venta',text});
    }catch(firstError){
      if(firstError?.name==='AbortError')return;
      if(firstError?.name==='NotAllowedError'||firstError?.name==='SecurityError'||/permission denied/i.test(firstError?.message||'')){
        try{await navigator.share({title:'Ticket de venta',text});}
        catch(secondError){if(secondError?.name==='AbortError')return;await _naFallbackTicketCompartido(text,name,file,secondError.message);return;}
      }else throw firstError;
    }
    appConfig.printer={...(appConfig.printer||{}),mode:'android-share'};saveAppState();
    _naActualizarEstadoImpresora('Ticket compartido. Elige la aplicación de tu impresora Bluetooth.');
    toast('Selecciona tu app de impresión térmica','success');
  }catch(error){if(error?.name==='AbortError')return;console.error(error);await _naFallbackTicketCompartido(text,name,file,error.message);}
}
function _naPrinterAscii(value){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[¡]/g,'!').replace(/[¿]/g,'?').replace(/[^\x20-\x7E\n]/g,'').replace(/\s+$/gm,'');}
function _naPrinterCenter(text,width){const clean=_naPrinterAscii(text).slice(0,width),left=Math.max(0,Math.floor((width-clean.length)/2));return ' '.repeat(left)+clean;}
function _naPrinterPair(left,right,width){left=_naPrinterAscii(left);right=_naPrinterAscii(right);const maxLeft=Math.max(1,width-right.length-1);if(left.length>maxLeft)left=left.slice(0,maxLeft);return left+' '.repeat(Math.max(1,width-left.length-right.length))+right;}
function _naPrinterWrap(text,width){const words=_naPrinterAscii(text).split(/\s+/).filter(Boolean),lines=[];let line='';for(const word of words){if(!line){line=word.slice(0,width);continue;}if((line+' '+word).length<=width)line+=' '+word;else{lines.push(line);line=word.slice(0,width);}}if(line)lines.push(line);return lines.length?lines:[''];}
function _naConcatBytes(parts){const total=parts.reduce((sum,p)=>sum+p.length,0),out=new Uint8Array(total);let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;}
function _naCrearTicketEscPos(){
  _naSaveTicketSettings();const v=tkCurrentVenta||{items:[]},built=_naBuildThermalTicket(v,false),enc=new TextEncoder(),bytes=[],txt=s=>bytes.push(enc.encode(_naPrinterAscii(s)));
  bytes.push(Uint8Array.from([0x1B,0x40]));
  bytes.push(Uint8Array.from([0x1B,0x61,0x00]));
  const totalLabel=_naTkLabels(built.width,(appConfig.ticket||{}).layoutMode||'auto').total;
  for(const line of built.lines){const isBusiness=line.trim()&&line.trim()===_naTicketAscii((_naGetBusiness().nombre||'').toUpperCase()).slice(0,built.width),isTotal=line.includes(totalLabel+' :');if(isBusiness||isTotal)bytes.push(Uint8Array.from([0x1B,0x45,0x01]));txt(line+'\n');if(isBusiness||isTotal)bytes.push(Uint8Array.from([0x1B,0x45,0x00]));}
  txt('\n\n');if(document.getElementById('printerAutoCut')?.checked)bytes.push(Uint8Array.from([0x1D,0x56,0x00]));return _naConcatBytes(bytes);
}

async function imprimirPorConexion(tipo){
  try{
    _naActualizarEstadoImpresora(`Buscando impresora por ${tipo==='bluetooth'?'Bluetooth':'cable'}...`);
    const port=await _naConectarPuerto(tipo);await _naEnviarTicketPuerto(port);await actualizarDispositivosBluetooth(false);
  }catch(error){console.error(error);const msg=_naMensajePermisoImpresora(error);_naActualizarEstadoImpresora(msg,true);toast(msg,'error');}
}
function imprimirTicketSistema(){
  _naSaveTicketSettings();const built=_naBuildThermalTicket(tkCurrentVenta||{items:[]},false),content=document.getElementById('ticketBody').innerHTML,w=window.open('','_blank','width=500,height=700');if(!w){toast('Permite ventanas emergentes para imprimir','error');return;}
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Ticket</title><style>@page{size:${built.mm}mm auto;margin:1.5mm}html,body{background:#fff!important;color:#000!important;margin:0;padding:0}body{font-family:'Courier New',monospace;width:${built.mm}mm;max-width:${built.mm}mm;margin:0 auto}#ticketBody{padding:${built.mm<=40?'1mm':'2mm'};box-sizing:border-box}.thermal-ticket-pre{margin:0;white-space:pre;font-family:'Courier New',monospace;font-size:${built.mm<=40?'7.5px':built.mm<=58?'9px':'10px'};line-height:1.25;color:#000}*{color:#000!important;background:#fff!important;box-shadow:none!important;text-shadow:none!important;filter:grayscale(1)!important}</style></head><body><div id="ticketBody">${content}</div>




</body></html>`);w.document.close();w.focus();w.onafterprint=()=>w.close();setTimeout(()=>w.print(),300);appConfig.printer={...(appConfig.printer||{}),mode:'system'};saveAppState();
}

if(navigator.serial){navigator.serial.addEventListener('disconnect',event=>{if(event.target===_naPrinterPort){_naPrinterPort=null;_naPrinterConnectionType=null;_naActualizarEstadoImpresora('La impresora se desconectó.');actualizarDispositivosBluetooth(false);}});navigator.serial.addEventListener('connect',()=>actualizarDispositivosBluetooth(false));}
