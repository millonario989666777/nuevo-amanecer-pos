// =============================================================================
// NUEVO FASE 11 — EDITOR AVANZADO DE TICKET POR ZONAS
// Mantiene impresión térmica lineal; evita coordenadas absolutas incompatibles.
// =============================================================================
const _NA_F11_ZONE_DEFS={
  h:{name:'Encabezado',icon:'🏪',desc:'Negocio, RUC, dirección y teléfono.'},
  i:{name:'Datos de venta',icon:'🧾',desc:'Ticket, operación, fecha, cajero y cliente.'},
  p:{name:'Productos',icon:'📦',desc:'Cantidad, descripción, precio unitario e importe.'},
  t:{name:'Totales',icon:'💰',desc:'Artículos, descuento, IGV y total a pagar.'},
  y:{name:'Forma de pago',icon:'💳',desc:'Método, efectivo, digital, recibido y vuelto.'},
  c:{name:'Detalle del crédito',icon:'📄',desc:'Importe, pago inicial, saldo y vencimiento.'},
  a:{name:'Estado de cuenta',icon:'📊',desc:'Deuda acumulada y línea disponible del cliente.'},
  f:{name:'Pie de página',icon:'💬',desc:'Mensaje final personalizado.'}
};
const _NA_F11_DEFAULT_ORDER='h,i,p,t,y,c,a,f';
const _NA_F11_DEFAULT_SETTINGS='h1cn01;i1ln10;p1lc10;t1sn01;y1sn10;c1ln10;a1ln10;f1cn00';
const _NA_F11_ALIGN={l:'left',c:'center',r:'right',s:'split'};
const _NA_F11_ALIGN_CODE={left:'l',center:'c',right:'r',split:'s'};
const _NA_F11_DENSITY={c:'compact',n:'normal',r:'relaxed'};
const _NA_F11_DENSITY_CODE={compact:'c',normal:'n',relaxed:'r'};
Object.assign(_naDefaults.ticket,{zoneOrder:_NA_F11_DEFAULT_ORDER,zoneSettings:_NA_F11_DEFAULT_SETTINGS});
appConfig.ticket={..._naDefaults.ticket,...(appConfig.ticket||{})};
let _naF11DragCode='';
// El editor existente es la unica autoridad del orden de los bloques, tambien al compartir.
globalThis._naF11ReceiptZonesEnabled=true;

function _naF11ParseOrder(raw){
  const valid=Object.keys(_NA_F11_ZONE_DEFS),seen=new Set(),result=[];
  for(const code of String(raw||'').split(',').map(v=>v.trim()))if(valid.includes(code)&&!seen.has(code)){seen.add(code);result.push(code);}
  // Las configuraciones anteriores de seis zonas se migran en memoria sin borrar el orden del propietario.
  for(const code of valid)if(!seen.has(code)){const footer=result.indexOf('f');if((code==='c'||code==='a')&&footer>=0)result.splice(footer,0,code);else result.push(code);}
  return result;
}
function _naF11DefaultSettings(){
  return _naF11ParseSettings(_NA_F11_DEFAULT_SETTINGS,true);
}
function _naF11ParseSettings(raw,skipDefaults=false){
  const result={};
  for(const part of String(raw||'').split(';')){
    const m=part.trim().match(/^([hiptyfca])([01])([lcrs])([cnr])([01])([01])$/);if(!m)continue;
    result[m[1]]={enabled:m[2]==='1',align:_NA_F11_ALIGN[m[3]]||'left',density:_NA_F11_DENSITY[m[4]]||'normal',separator:m[5]==='1',emphasis:m[6]==='1'};
  }
  if(!skipDefaults){const defaults=_naF11DefaultSettings();for(const code of Object.keys(_NA_F11_ZONE_DEFS))result[code]={...defaults[code],...(result[code]||{})};}
  return result;
}
function _naF11EncodeSettings(settings){
  return Object.keys(_NA_F11_ZONE_DEFS).map(code=>{const s=settings[code]||_naF11DefaultSettings()[code],a=_NA_F11_ALIGN_CODE[s.align]||'l',d=_NA_F11_DENSITY_CODE[s.density]||'n';return `${code}${s.enabled!==false?'1':'0'}${a}${d}${s.separator?'1':'0'}${s.emphasis?'1':'0'}`;}).join(';');
}
function _naF11State(){
  const ticket=appConfig.ticket||{};return{order:_naF11ParseOrder(ticket.zoneOrder),settings:_naF11ParseSettings(ticket.zoneSettings)};
}
function _naF11PersistState(state){
  appConfig.ticket.zoneOrder=_naF11ParseOrder(state.order.join(',')).join(',');appConfig.ticket.zoneSettings=_naF11EncodeSettings(state.settings);
}
function _naF11SelectOptions(current,options){return options.map(([value,label])=>`<option value="${value}" ${current===value?'selected':''}>${label}</option>`).join('');}
function _naF11RenderEditor(){
  const list=document.getElementById('tkZoneList');if(!list)return;const state=_naF11State(),active=state.order.filter(code=>state.settings[code]?.enabled!==false).length;
  const status=document.getElementById('tkZoneStatus');if(status)status.textContent=`${active} zona${active===1?'':'s'} activa${active===1?'':'s'}`;
  list.innerHTML=state.order.map((code,index)=>{const def=_NA_F11_ZONE_DEFS[code],s=state.settings[code];return `<div class="ticket-zone-row ${s.enabled?'':'is-off'}" draggable="true" data-zone="${code}" ondragstart="ticketZoneDragStart(event,'${code}')" ondragend="ticketZoneDragEnd(event)" ondragover="ticketZoneDragOver(event)" ondragleave="ticketZoneDragLeave(event)" ondrop="ticketZoneDrop(event,'${code}')"><div class="ticket-zone-order"><button type="button" ${index===0?'disabled':''} onclick="ticketZoneMove('${code}',-1)" aria-label="Subir ${def.name}">↑</button><button type="button" ${index===state.order.length-1?'disabled':''} onclick="ticketZoneMove('${code}',1)" aria-label="Bajar ${def.name}">↓</button></div><div class="ticket-zone-name"><span class="ticket-zone-icon">${def.icon}</span><span class="ticket-zone-copy"><strong>${def.name}</strong><small>${def.desc}</small></span></div><div class="ticket-zone-control"><label>Alineación</label><select onchange="ticketZoneSet('${code}','align',this.value)">${_naF11SelectOptions(s.align,[['left','Izquierda'],['center','Centro'],['right','Derecha'],['split','Etiqueta / dato']])}</select></div><div class="ticket-zone-control"><label>Espaciado</label><select onchange="ticketZoneSet('${code}','density',this.value)">${_naF11SelectOptions(s.density,[['compact','Compacto'],['normal','Normal'],['relaxed','Amplio']])}</select></div><div class="ticket-zone-flags"><label class="ticket-zone-toggle" title="Mostrar u ocultar zona"><input type="checkbox" ${s.enabled?'checked':''} onchange="ticketZoneSet('${code}','enabled',this.checked)"><span class="ticket-zone-slider"></span></label><label class="ticket-zone-flag"><input type="checkbox" ${s.separator?'checked':''} onchange="ticketZoneSet('${code}','separator',this.checked)"> Separador</label><label class="ticket-zone-flag"><input type="checkbox" ${s.emphasis?'checked':''} onchange="ticketZoneSet('${code}','emphasis',this.checked)"> Destacar</label></div></div>`;}).join('');
}
function _naF11Refresh(){_naF11RenderEditor();renderTicketPreview();}
function ticketZoneSet(code,key,value){const state=_naF11State();if(!state.settings[code])return;if(key==='enabled'||key==='separator'||key==='emphasis')state.settings[code][key]=!!value;else if(key==='align'&&['left','center','right','split'].includes(value))state.settings[code].align=value;else if(key==='density'&&['compact','normal','relaxed'].includes(value))state.settings[code].density=value;_naF11PersistState(state);_naF11Refresh();}
function ticketZoneMove(code,delta){const state=_naF11State(),index=state.order.indexOf(code),next=index+Number(delta);if(index<0||next<0||next>=state.order.length)return;[state.order[index],state.order[next]]=[state.order[next],state.order[index]];_naF11PersistState(state);_naF11Refresh();}
function ticketZoneDragStart(event,code){_naF11DragCode=code;event.currentTarget.classList.add('dragging');try{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',code);}catch(error){}}
function ticketZoneDragEnd(event){event.currentTarget.classList.remove('dragging');document.querySelectorAll('.ticket-zone-row.drag-over').forEach(row=>row.classList.remove('drag-over'));_naF11DragCode='';}
function ticketZoneDragOver(event){event.preventDefault();event.currentTarget.classList.add('drag-over');}
function ticketZoneDragLeave(event){event.currentTarget.classList.remove('drag-over');}
function ticketZoneDrop(event,target){event.preventDefault();event.currentTarget.classList.remove('drag-over');const source=_naF11DragCode||event.dataTransfer?.getData('text/plain');if(!source||source===target)return;const state=_naF11State(),from=state.order.indexOf(source),to=state.order.indexOf(target);if(from<0||to<0)return;state.order.splice(from,1);state.order.splice(to,0,source);_naF11PersistState(state);_naF11Refresh();}
function ticketZonePreset(name){
  const presets={
    compacto:{order:'h,i,p,t,y,f',settings:'h1cc01;i1lc10;p1lc10;t1sc01;y1sc10;f1cc00'},
    clasico:{order:_NA_F11_DEFAULT_ORDER,settings:_NA_F11_DEFAULT_SETTINGS},
    detallado:{order:'h,i,p,t,y,f',settings:'h1cr01;i1sr10;p1ln10;t1sr01;y1sr10;f1cr00'},
    minimo:{order:'h,p,t,f,i,y',settings:'h1cc01;i0lc00;p1lc10;t1sc01;y0lc00;f1cc00'}
  },preset=presets[name];if(!preset)return;appConfig.ticket.zoneOrder=preset.order;appConfig.ticket.zoneSettings=preset.settings;_naF11Refresh();toast('Diseño de ticket aplicado','success');
}
function ticketZoneReset(){if(!confirm('¿Restablecer el orden y formato de las zonas del ticket?'))return;appConfig.ticket.zoneOrder=_NA_F11_DEFAULT_ORDER;appConfig.ticket.zoneSettings=_NA_F11_DEFAULT_SETTINGS;_naF11Refresh();toast('Zonas restablecidas','success');}

function _naF11FieldLines(label,value,width,align){const result=_naTkField(label,value,width,align);return Array.isArray(result)?result:[result];}
function _naF11AlignLines(lines,width,align){if(align==='split')return lines;return lines.map(line=>_naTkAlignLine(line,width,align));}
function _naF11ZoneHeader(ctx,s){
  const out=[],highlight=ctx.showHeader&&s.emphasis&&ctx.showSep;if(highlight)out.push(ctx.eq);
  const nameLines=_naTkWrap(ctx.name.toUpperCase(),ctx.width);out.push(..._naF11AlignLines(nameLines,ctx.width,s.align));
  if(ctx.ruc)out.push(..._naF11AlignLines(_naTkWrap(ctx.ruc,ctx.width),ctx.width,s.align));
  if(highlight)out.push(ctx.eq);
  if(ctx.address)out.push(..._naF11AlignLines(_naTkWrap(ctx.address,ctx.width),ctx.width,s.align));
  if(ctx.phone)out.push(..._naF11AlignLines(_naTkWrap(ctx.phone,ctx.width),ctx.width,s.align));return out;
}
function _naF11ZoneInfo(ctx,s){
  const out=[],push=(label,value)=>{if(value!==''&&value!==null&&value!==undefined)out.push(..._naF11FieldLines(label,value,ctx.width,s.align));};
  if(ctx.v?._naReceiptContext?.kind!=='payment'&&(ctx.v?.metodo==='credito'||ctx.v?.metodoPago==='credito'))out.push(..._naTkWrap('COMPROBANTE DE VENTA A CREDITO',ctx.width).map(line=>_naTkAlignLine(line,ctx.width,'center')));
  if(ctx.showNum)push(ctx.labels.ticket,ctx.v?.id||'');if(ctx.showOperation){const op=_naTkOperation(ctx.v);if(op)push(ctx.labels.operation,op);}push(ctx.labels.date,_naTkFormatDate(ctx.v?.fecha||obtenerHoy()));push(ctx.labels.time,ctx.v?.hora24||ctx.v?.hora||nowT());push(ctx.labels.cashier,ctx.v?.cajeroNombre||ctx.v?.cajero||ctx.business.cajero||'');
  const client=ctx.v?.clienteNombre||ctx.v?.cliente?.nombre||'',dni=ctx.v?.clienteDni||ctx.v?.cliente?.dni||'';if(client)push('Cliente',client);if(dni)push('DNI',dni);if(ctx.v?.anulada)push('Estado','ANULADA');return out;
}
function _naF11ZoneProducts(ctx,s){
  const out=[],items=ctx.items;if(!items.length)return[_naTkAlignLine('Sin productos',ctx.width,s.align==='split'?'left':s.align)];out.push(..._naTkWrap('DETALLE DE PRODUCTOS',ctx.width));
  if(ctx.width>=24){const qtyW=ctx.width>=38?4:3,amtW=Math.min(ctx.width>=38?(ctx.showCurrency?10:8):(ctx.showCurrency?8:7),Math.max(6,Math.floor(ctx.width*.31))),descW=ctx.width-qtyW-amtW-2;out.push(_naTkPadRight(ctx.labels.qty,qtyW)+' '+_naTkPadRight(ctx.labels.desc,descW)+' '+_naTkPadLeft(ctx.labels.amount,amtW));
    for(const item of items){const amount=_naTkMoney(Number(item.qty||item.cantidad||0)*Number(item.precio??item.precioUnitario??0),ctx.showCurrency),suffix=item.ventaSinStock?' SIN STOCK':'',descLines=_naTkWrap((item.name||item.nombre||'Producto')+suffix,Math.max(3,descW));descLines.forEach((d,index)=>out.push(_naTkPadRight(index===0?String(item.qty||item.cantidad||0):'',qtyW)+' '+_naTkPadRight(d,descW)+' '+_naTkPadLeft(index===0?amount:'',amtW)));if(ctx.showUnit&&ctx.width>=26)out.push(_naTkPair('','P.U. '+_naTkMoney(item.precio??item.precioUnitario,ctx.showCurrency),ctx.width));}
  }else{for(const item of items){const qty=Number(item.qty||item.cantidad||0),prefix=`${qty}x `,descWidth=Math.max(5,ctx.width-prefix.length),suffix=item.ventaSinStock?' SIN STOCK':'',descLines=_naTkWrap((item.name||item.nombre||'Producto')+suffix,descWidth);descLines.forEach((d,index)=>out.push((index===0?prefix:' '.repeat(prefix.length))+d));out.push(_naTkPadLeft(_naTkMoney(qty*Number(item.precio??item.precioUnitario??0),ctx.showCurrency),ctx.width));if(ctx.showUnit)out.push(_naTkPadLeft('P.U. '+_naTkMoney(item.precio??item.precioUnitario,ctx.showCurrency),ctx.width));}}
  return out;
}
function _naF11ZoneTotals(ctx,s){
  const out=[],align=s.align,articles=ctx.items.reduce((sum,i)=>sum+Number(i.qty||i.cantidad||0),0),discount=Math.max(0,Number(ctx.v?.descuentoTotal||0)),before=Math.max(ctx.total,Number(ctx.v?.subtotalAntesDescuento||ctx.total+discount));
  if(s.emphasis&&ctx.showSep)out.push(ctx.eq);out.push(..._naF11FieldLines(ctx.labels.articles,String(articles),ctx.width,align));if(discount>0){out.push(..._naF11FieldLines('Subtotal',_naTkMoney(before,ctx.showCurrency),ctx.width,align));out.push(..._naF11FieldLines('Descuento','- '+_naTkMoney(discount,ctx.showCurrency),ctx.width,align));}
  const parts=_naTicketTaxBreakdown(ctx.v);if(ctx.showIGV&&parts.taxActive){out.push(..._naF11FieldLines('Subtotal',_naTkMoney(parts.subtotal,ctx.showCurrency),ctx.width,align));out.push(..._naF11FieldLines('IGV 18%',_naTkMoney(parts.totalIGV,ctx.showCurrency),ctx.width,align));}
  out.push(..._naF11FieldLines(ctx.labels.total,_naTkMoney(ctx.total,ctx.showCurrency),ctx.width,align));if(s.emphasis&&ctx.showSep)out.push(ctx.eq);return out;
}
function _naF11ZonePayment(ctx,s){
  if(!ctx.showPayment)return[];const out=[],add=(label,value)=>out.push(..._naF11FieldLines(label,value,ctx.width,s.align));add(ctx.labels.payment,_naTkPayment(ctx.v?.metodo));const received=Number(ctx.v?.recibido??ctx.v?.received??(ctx.v?.metodo==='efectivo'?ctx.total:0)),change=Number(ctx.v?.vuelto??ctx.v?.change??Math.max(0,received-ctx.total));if(ctx.showReceived&&ctx.v?.metodo==='efectivo'){add(ctx.labels.received,_naTkMoney(received,ctx.showCurrency));add(ctx.labels.change,_naTkMoney(change,ctx.showCurrency));}if(ctx.v?.metodo==='mixto'&&ctx.v?.paymentBreakdown){const mix=ctx.v.paymentBreakdown;add('Efectivo',_naTkMoney(mix.efectivo,ctx.showCurrency));add(mix.digitalMethod==='yape'?'Yape/Plin':'Transferencia',_naTkMoney(mix.digital,ctx.showCurrency));}if(ctx.v?.paymentRef)add('Referencia',ctx.v.paymentRef);return out;
}
function _naF11ZoneCredit(ctx,s){
  const extra=globalThis.NAReceiptShare?.ticketExtrasForSale?.(ctx.v);
  if(!extra)return[];
  const out=_naTkWrap('DETALLE DEL CREDITO (ESTA VENTA)',ctx.width);
  const add=(label,value)=>{if(value!==null&&value!==undefined&&value!=='')out.push(..._naF11FieldLines(label,value,ctx.width,s.align));};
  const money=value=>value===null||value===undefined?null:_naTkMoney(value,ctx.showCurrency);
  add('Tipo de venta','Venta a credito');
  add('Monto original',money(extra.amount));
  add('Pago inicial',money(extra.initial));
  add('Saldo pendiente',money(extra.balance));
  add('Fecha de vencimiento',extra.due? _naTkFormatDate(extra.due):null);
  return out;
}
function _naF11ZoneAccount(ctx,s){
  const extra=globalThis.NAReceiptShare?.ticketExtrasForSale?.(ctx.v);
  if(!extra?.account)return[];
  // El bloque forma parte de las zonas editables, sin un segundo wrapper al final.
  const rows=globalThis.NAReceiptShare.accountLines(extra.account,ctx.width);
  // La impresión térmica mantiene la compatibilidad ASCII histórica; PNG/PDF conservan acentos.
  const printable=ctx.v?._naReceiptContext?rows:rows.map(line=>String(line).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[¡]/g,'!').replace(/[¿]/g,'?').replace(/[^\x20-\x7E]/g,'').replace(/\s+$/,''));
  return s.align==='left'||s.align==='split'?printable:_naF11AlignLines(printable,ctx.width,s.align);
}
function _naF11ZoneFooter(ctx,s){const out=[];for(const part of String(ctx.pie||'').split('|').map(x=>x.trim()).filter(Boolean))out.push(..._naF11AlignLines(_naTkWrap(part,ctx.width),ctx.width,s.align));return out;}
function _naF11ComposeZones(ctx,state){
  const builders={h:_naF11ZoneHeader,i:_naF11ZoneInfo,p:_naF11ZoneProducts,t:_naF11ZoneTotals,y:_naF11ZonePayment,c:_naF11ZoneCredit,a:_naF11ZoneAccount,f:_naF11ZoneFooter},lines=[],active=state.order.filter(code=>state.settings[code]?.enabled!==false);
  active.forEach((code,index)=>{const s=state.settings[code],zone=(builders[code]?.(ctx,s)||[]).filter(line=>line!==undefined&&line!==null);if(!zone.length)return;if(s.density==='relaxed'&&lines.length&&lines[lines.length-1]!=='')lines.push('');lines.push(...zone);if(s.separator&&ctx.showSep&&zone[zone.length-1]!==ctx.dash&&zone[zone.length-1]!==ctx.eq)lines.push(ctx.dash);if(index<active.length-1){if(s.density==='relaxed')lines.push('','');else if(s.density==='normal')lines.push('');}});
  while(lines[0]==='')lines.shift();while(lines[lines.length-1]==='')lines.pop();return lines;
}

// CORRECCIÓN FASE 11: el generador único alimenta vista previa, texto, sistema y ESC/POS.
_naBuildThermalTicket=function(v,fromDom=true){
  const cfg=appConfig.ticket||{},mm=fromDom?_naTicketSelectedMm():(cfg.ancho==='custom'?Number(cfg.customMm||60):parseFloat(cfg.ancho)||80),width=_naTicketChars(mm),mode=(fromDom?document.getElementById('tkLayout')?.value:cfg.layoutMode)||'auto',labels=_naTkLabels(width,mode);
  const get=(id,fallback='')=>fromDom?(document.getElementById(id)?.value??fallback):fallback,check=(id,fallback=true)=>fromDom?(document.getElementById(id)?.checked??fallback):fallback,b=_naGetBusiness();
  const ctx={v:v||{items:[]},business:b,width,mm,mode,labels,name:get('tkNegocio',(b.nombre||'NUEVO AMANECER').toUpperCase()),ruc:get('tkRuc',b.ruc?`RUC/DNI: ${b.ruc}`:''),address:get('tkDireccion',b.direccion||''),phone:get('tkTelefono',b.telefono?`Tel: ${b.telefono}`:''),pie:get('tkPie',cfg.pie||'GRACIAS POR SU COMPRA'),showHeader:check('tkShowLogo',cfg.showLogo!==false),showNum:check('tkShowNum',cfg.showNum!==false),showOperation:check('tkShowOperation',cfg.showOperation!==false),showIGV:check('tkShowIGV',!!cfg.showIGV),showCurrency:check('tkShowCurrency',cfg.showCurrency!==false),showUnit:check('tkShowUnitPrice',cfg.showUnitPrice!==false),showPayment:check('tkShowPayment',cfg.showPayment!==false),showReceived:check('tkShowReceived',cfg.showReceived!==false),showSep:check('tkShowSep',cfg.showSep!==false),eq:'='.repeat(width),dash:'-'.repeat(width)};
  ctx.items=Array.isArray(ctx.v.items)?ctx.v.items:[];ctx.total=totalV(ctx.v);const state=_naF11State(),lines=_naF11ComposeZones(ctx,state);return{lines,width,mm,text:lines.join('\n'),showCurrency:ctx.showCurrency,zones:state.order.slice()};
};

const _naF11BaseSaveTicketSettings=_naSaveTicketSettings;
_naSaveTicketSettings=function(){_naF11BaseSaveTicketSettings();const state=_naF11State();_naF11PersistState(state);};
const _naF11BaseHydrateTicket=_naHydrateTicket;
_naHydrateTicket=function(){appConfig.ticket={..._naDefaults.ticket,...(appConfig.ticket||{})};_naF11BaseHydrateTicket();_naF11RenderEditor();};

// MEJORA FASE 11: los selectores antiguos funcionan como controles rápidos de las zonas equivalentes.
function _naF11SyncLegacyAlign(code,value){const state=_naF11State();if(state.settings[code])state.settings[code].align=value;_naF11PersistState(state);_naF11RenderEditor();}
document.addEventListener('change',event=>{const map={tkAlign:['h'],tkInfoAlign:['i'],tkPaymentAlign:['t','y'],tkFooterAlign:['f']},codes=map[event.target?.id];if(!codes)return;const state=_naF11State();for(const code of codes)state.settings[code].align=event.target.value;_naF11PersistState(state);_naF11Refresh();});
document.addEventListener('DOMContentLoaded',()=>{appConfig.ticket={..._naDefaults.ticket,...(appConfig.ticket||{})};_naF11RenderEditor();});
