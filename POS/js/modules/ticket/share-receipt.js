/* Receipt sharing is a presentation action. It never writes sales, stock or payments. */
(function(root){
  'use strict';
  const FORMATS=['image','text','pdf'];
  let active=null,version=0,busy=false,returnFocus=null;
  const copy=value=>JSON.parse(JSON.stringify(value));
  function config(){try{if(typeof appConfig!=='undefined')return appConfig;}catch(_){}return root.appConfig||{};}
  function settings(){const t=config().ticket||{};return{format:FORMATS.includes(t.shareFormat)?t.shareFormat:'image',ask:t.shareAsk!==false};}
  function setSettings(value){if(!FORMATS.includes(value.format))throw new Error('Formato inválido');const c=config();c.ticket=c.ticket||{};c.ticket.shareFormat=value.format;c.ticket.shareAsk=value.ask!==false;}
  function normalizePhone(value){
    const raw=String(value||'').trim();if(!/^[+\d\s().-]+$/.test(raw))return'';
    let n=raw.replace(/\D/g,'');if(n.startsWith('00'))n=n.slice(2);
    if(/^9\d{8}$/.test(n))n='51'+n;
    if(n.startsWith('51'))return /^519\d{8}$/.test(n)?n:'';
    return (raw.startsWith('+')||raw.startsWith('00'))&&/^[1-9]\d{8,14}$/.test(n)?n:'';
  }
  function textUrl(phone,text){const number=normalizePhone(phone);if(!number)throw new Error('Ingresa un número de WhatsApp válido, con código de país');return 'https://wa.me/'+number+'?text='+encodeURIComponent(text);}
  function money(value){return'S/ '+Number(value).toFixed(2);}
  function known(value){return value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));}
  function dateFields(timestamp){if(!timestamp)return{fecha:'',hora:''};const d=new Date(timestamp);if(!Number.isFinite(d.getTime()))return{fecha:'',hora:''};const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const part=k=>parts.find(p=>p.type===k).value;return{fecha:part('year')+'-'+part('month')+'-'+part('day'),hora:d.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour12:true})};}
  function itemsFromCredit(cr){return(Array.isArray(cr.items)?cr.items:[]).map(i=>({...i,name:i.name||i.nombre||'Concepto',qty:Number(i.qty??i.cantidad??1),precio:Number(i.precio??i.precioUnitario??0)}));}
  // ---- Estado de cuenta del cliente (solo lectura, presentación) ----------
  // Deuda total = créditos abiertos confirmados en la réplica canónica + ventas
  // a crédito aún en la cola local. Cada crédito se cuenta una sola vez: la
  // venta de este comprobante se excluye de la lista y se suma aparte, y una
  // venta pendiente deja de contarse como pendiente en cuanto llega a CANON.
  const GENERIC_CUSTOMER=/^(consumidor final|cliente gen[eé]rico|cliente general|p[uú]blico general|varios|sin cliente)$/i;
  const toCents=value=>Math.round(Number(value)*100);
  const centsMoney=c=>money(c/100);
  function creditCustomerId(cr){const id=cr?.cliId??cr?.clienteId??cr?.customer_id;return id===null||id===undefined||id===''?'':String(id);}
  function creditSaleId(cr){const id=cr?.ventaId??cr?.sale_id;return id===null||id===undefined||id===''?'':String(id);}
  function creditVoided(cr){if(!cr||cr.anulado===true)return true;const st=String(cr.status||cr.estado||'').toLowerCase();return st==='anulado'||st==='void'||st==='voided';}
  function openCents(cr){
    if(creditVoided(cr))return 0;
    let c;
    if(known(cr.saldo))c=toCents(cr.saldo);
    else if(known(cr.balance_cents))c=Math.round(Number(cr.balance_cents));
    else if(known(cr.current_balance_cents))c=Math.round(Number(cr.current_balance_cents));
    else if(known(cr.monto))c=toCents(Number(cr.monto)-Number(cr.pagado||0));
    else return 0;
    return c>0?c:0;
  }
  function pendingOutboxCredits(){
    // Credits of sales still in the local outbox (not yet in `creditos`).
    try{const p=root.NuevoAmanecerCanonicalSaleIntegration?.lastProjection?.();return(Array.isArray(p?.credits)?p.credits:[]).filter(cr=>cr&&(cr.status==='PENDING_SYNC'||cr.source==='CANONICAL_OUTBOX'));}catch(_){return[];}
  }
  // "2026-10-11  8:33 p.m." in America/Lima (UTC-5, no DST): 12-hour clock,
  // hour without leading zero but space-padded to 2 so the minutes line up.
  function nowLabel(now=Date.now()){const l=new Date(now-5*60*60*1000),p=v=>String(v).padStart(2,'0'),h24=l.getUTCHours(),h12=h24%12||12;return l.getUTCFullYear()+'-'+p(l.getUTCMonth()+1)+'-'+p(l.getUTCDate())+' '+String(h12).padStart(2,' ')+':'+p(l.getUTCMinutes())+' '+(h24<12?'a.m.':'p.m.');}
  const DEFAULT_PLACE='PUERTO SUNGARO';
  function plainUpper(value){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7E]/g,'').replace(/\s+/g,' ').trim().toUpperCase();}
  // Place label from the store settings: an explicit city/locality field if
  // present, else the first address segment that is not a street (no digits),
  // e.g. "Puerto Súngaro, Huánuco" -> "PUERTO SUNGARO".
  function placeLabel(){
    let b=null;try{if(typeof _naGetBusiness==='function')b=_naGetBusiness();}catch(_){}
    if(!b){const c=config();b=c.business||null;}
    if(!b)return DEFAULT_PLACE;
    for(const key of ['ciudad','localidad','distrito','city']){const v=plainUpper(b[key]);if(v)return v;}
    const parts=String(b.direccion||'').split(/[,\n|]/).map(plainUpper).filter(Boolean);
    return parts.find(part=>!/\d/.test(part))||DEFAULT_PLACE;
  }
  function accountSummary(data,sale,cr){
    const customer=data.customer||{};
    const isCredit=data.kind==='credit'||sale.metodo==='credito'||sale.metodoPago==='credito';
    if(!isCredit)return null;
    const customerId=String(customer.id??customer.customer_id??sale.clienteId??sale.customer_id??creditCustomerId(cr)??'');
    if(!customerId||customerId==='null'||customerId==='undefined')return null;
    const name=String(customer.nombre||customer.name||sale.clienteNombre||'').trim();
    if(customer.generico===true||customer.generic===true||GENERIC_CUSTOMER.test(name))return null;
    const thisSaleId=data.kind==='credit'?creditSaleId(cr):String(sale.id||'');
    const thisCreditId=cr&&cr.id!==undefined&&cr.id!==null?String(cr.id):'';
    const isThis=row=>{const sid=creditSaleId(row),id=row?.id===undefined||row?.id===null?'':String(row.id);return(thisSaleId&&(sid===thisSaleId||id==='pending:'+thisSaleId))||(thisCreditId&&id===thisCreditId);};
    const confirmed=credits().filter(row=>row&&creditCustomerId(row)===customerId);
    const confirmedSales=new Set(confirmed.map(creditSaleId).filter(Boolean));
    const confirmedThis=confirmed.find(isThis);
    // Pending outbox credits that already reached CANON are counted once (as confirmed).
    const pending=pendingOutboxCredits().filter(row=>creditCustomerId(row)===customerId&&!confirmedSales.has(creditSaleId(row)));
    const seen=new Set();let previous=0,openCount=0,pendingOthers=0;
    for(const row of confirmed.concat(pending)){
      if(isThis(row))continue;
      const key=row.id!==undefined&&row.id!==null?'id:'+row.id:'sale:'+creditSaleId(row);if(seen.has(key))continue;seen.add(key);
      const c=openCents(row);if(c<=0)continue;previous+=c;openCount++;if(!confirmed.includes(row))pendingOthers++;
    }
    // Balance of this sale/credit: the receipt's own figure, else the replica's.
    let current=null;
    if(known(cr.saldo))current=Math.max(0,toCents(cr.saldo));
    else if(confirmedThis)current=openCents(confirmedThis);
    else if(data.fresh||data.pendingSync){const total=(sale.items||[]).reduce((s,i)=>s+Number(i.qty||0)*Number(i.precio||0),0);const amount=known(cr.monto)?Number(cr.monto):total;current=Math.max(0,toCents(amount)-(known(cr.pagoInicial)?toCents(cr.pagoInicial):0));}
    else{const p=pendingOutboxCredits().find(isThis);if(p)current=openCents(p);}
    if(current===null)return null;
    if(current>0)openCount++;
    const thisPending=!confirmedThis&&(data.pendingSync===true||String(sale.status||'')==='PENDING_SYNC'||pendingOutboxCredits().some(isThis));
    const total=previous+current;
    let line=null,available=null;
    const record=customers().find(c=>String(c.id)===customerId)||customer;
    if(record.lineaCreditoManualActiva===true&&known(record.lineaCreditoManual)&&Number(record.lineaCreditoManual)>0){line=toCents(record.lineaCreditoManual);available=Math.max(0,line-total);}
    return{customerId,kind:data.kind==='credit'?'credit':'sale',previousCents:previous,currentCents:current,totalCents:total,openCount,pendingOthers,thisPending,lineCents:line,availableCents:available,asOf:nowLabel(),place:placeLabel()};
  }
  // Contrato unico de presentacion. Nunca modifica venta, pagos, outbox ni credito.
  function ticketExtrasForSale(sale){
    if(!sale||sale._naReceiptContext?.kind==='payment'||(sale.metodo!=='credito'&&sale.metodoPago!=='credito'))return null;
    const options=sale._naReceiptContext||{};
    const credit=options.credit&&Object.keys(options.credit).length?options.credit:(credits().find(c=>creditSaleId(c)===String(sale.id))||{});
    const customer=options.customer||customerFor(sale.clienteId??sale.customer_id??sale.cliente?.id)||{};
    const data={kind:options.kind||'sale',sale,credit,customer,fresh:options.fresh===true,pendingSync:options.pendingSync===true||String(sale.status||'')==='PENDING_SYNC'};
    const summary=accountSummary(data,sale,credit);
    const items=Array.isArray(sale.items)?sale.items:[];
    const original=known(credit.monto)?Number(credit.monto):items.reduce((sum,item)=>sum+Number(item.qty??item.cantidad??0)*Number(item.precio??item.precioUnitario??0),0);
    const initial=known(credit.pagoInicial)?Number(credit.pagoInicial):options.fresh===true?0:null;
    const balance=known(credit.saldo)?Number(credit.saldo):summary?summary.currentCents/100:options.fresh===true?Math.max(0,original-(initial||0)):null;
    return{amount:original,initial,balance,due:credit.vence||options.due||sale.credit_due||null,account:summary};
  }
  function accountLines(summary,width){
    const out=wrap('ESTADO DE CUENTA DEL CLIENTE',width);
    const field=(label,value)=>{const text=label+': '+value;for(let start=0;start<text.length;start+=width)out.push(text.slice(start,start+width));};
    if(summary.asOf)field('Al',summary.asOf);
    field('Deuda anterior',centsMoney(summary.previousCents));
    field(summary.kind==='credit'?'Este crédito':'Esta venta',centsMoney(summary.currentCents));
    field('Deuda total',centsMoney(summary.totalCents));
    field('Créditos abiertos',String(summary.openCount));
    if(summary.lineCents!==null){field('Línea de crédito',centsMoney(summary.lineCents));field('Línea disponible',centsMoney(summary.availableCents));}


    return out;
  }
  function wrap(text,width){const out=[];let line='';for(const word of String(text).split(/\s+/).filter(Boolean)){if(!line)line=word;else if((line+' '+word).length<=width)line+=' '+word;else{out.push(line);line=word;}}if(line)out.push(line);return out.flatMap(l=>{const parts=[];for(let i=0;i<l.length;i+=width)parts.push(l.slice(i,i+width));return parts;});}
  function build(input){
    const data=copy(input),customer=data.customer||{},cr=data.credit||{},pay=data.payment||{};
    if(pay.saldoAntes===undefined)pay.saldoAntes=pay.saldoAnterior;if(pay.saldoDespues===undefined)pay.saldoDespues=pay.saldoActual;
    let sale=data.sale||{id:cr.ventaId||cr.id,fecha:cr.fecha||'',hora:cr.hora||'',cajero:cr.cajeroNombre||cr.cajero||'',metodo:'credito',items:itemsFromCredit(cr)};
    sale={...sale,clienteNombre:customer.nombre||customer.name||sale.clienteNombre||cr.clienteNombre||'',clienteDni:customer.dni||customer.document||sale.clienteDni||''};
    // Shared historical receipts must never substitute today's metadata.
    sale.fecha=sale.fecha||'No registrada';
    if(!sale.hora24&&!sale.hora)sale.hora='No registrada';
    if(!sale.cajeroNombre&&!sale.cajero)sale.cajero='No registrado';
    const generator=root._naBuildThermalTicket;
    if(typeof generator!=='function')throw new Error('Generador de ticket no disponible');
    // The share receipt appends its own account block after the credit fields.
    const built=generator({...sale,_naSkipAccountSummary:true,_naReceiptContext:{kind:data.kind,credit:cr,customer,fresh:data.fresh===true,pendingSync:data.pendingSync===true,due:data.due}},false);let lines=built.lines.slice();const width=built.width||42;
    const field=(label,value)=>{const text=label+': '+value;for(let start=0;start<text.length;start+=width)lines.push(text.slice(start,start+width));};
    if(data.kind==='payment'){
      // Payment receipt contains the original purchase, explicitly labeled;
      // it never represents those items as a second sale.
      lines=['RECIBO DE ABONO','COMPRA / CRÉDITO RELACIONADO',...lines,'-'.repeat(width)];
      field('Crédito',cr.id||cr.credit_id||'');field('Concepto',cr.desc||cr.concept||'Crédito');
      field('Abono N.º',pay.id||pay.pagoId||pay.operation_id||'');
      field('Fecha abono',pay.fecha||dateFields(pay.timestamp).fecha||'No registrada');
      const time=pay.hora||dateFields(pay.timestamp).hora;if(time)field('Hora abono',time);
      field('Abono recibido',money(pay.monto??pay.montoPagado??Number(pay.amount_cents||0)/100));
      field('Saldo anterior',known(pay.saldoAntes)?money(pay.saldoAntes):'No registrado');
      field('Saldo pendiente',known(pay.saldoDespues)?money(pay.saldoDespues):'No registrado');
      field('Método del abono',pay.metodo||pay.payment_method||'No registrado');
      if(pay.numeroOperacion||pay.reference)field('Referencia abono',pay.numeroOperacion||pay.reference);
      (data.allocations||[]).forEach(row=>{field('Crédito',row.id);field('Abono',money(row.amount));field('Saldo de ese crédito',money(row.balance));});
    }else if(!root._naF11ReceiptZonesEnabled&&(data.kind==='credit'||sale.metodo==='credito')){
      lines.push('-'.repeat(width));field('Tipo',data.kind==='credit'?'Crédito registrado':'Venta a crédito');
      const total=(sale.items||[]).reduce((s,i)=>s+Number(i.qty||0)*Number(i.precio||0),0);
      const amount=known(cr.monto)?Number(cr.monto):total;
      field('Monto original',money(amount));
      // For a just-created credit the initial payment is known. Do not infer
      // the original down payment from cumulative later repayments on re-send.
      if(known(cr.pagoInicial))field('Pago inicial',money(cr.pagoInicial));
      else if(data.fresh)field('Pago inicial',money(0));
      field('Saldo pendiente',known(cr.saldo)?money(cr.saldo):data.fresh?money(amount):'No registrado');
      if(cr.vence||data.due||sale.credit_due)field('Vencimiento',cr.vence||data.due||sale.credit_due);
    }
    // Estado de outbox permanece interno; nunca se imprime ni se comparte.
    if(!root._naF11ReceiptZonesEnabled&&data.kind!=='payment'){const summary=accountSummary(data,sale,cr);if(summary)accountLines(summary,width).forEach(line=>lines.push(line));}
    return{kind:data.kind,id:String((data.kind==='payment'&&(pay.id||pay.pagoId||pay.operation_id))||sale.id||cr.id||'comprobante'),customerName:sale.clienteNombre||'Sin cliente',phone:normalizePhone(customer.tel||customer.phone||''),lines,text:lines.join('\n'),width,mm:built.mm||80};
  }
  function pdf(pages){
    if(!pages.length)throw new Error('PDF sin páginas');
    const enc=new TextEncoder(),chunks=[],offsets=[0];let length=0;
    const add=value=>{const bytes=typeof value==='string'?enc.encode(value):value;chunks.push(bytes);length+=bytes.length;};
    const obj=(id,body)=>{offsets[id]=length;add(id+' 0 obj\n');body();add('\nendobj\n');};
    add('%PDF-1.4\n');
    obj(1,()=>add('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2,()=>add('<< /Type /Pages /Count '+pages.length+' /Kids ['+pages.map((_,i)=>(3+i*3)+' 0 R').join(' ')+'] >>'));
    pages.forEach((page,i)=>{const p=3+i*3,w=(page.mm||80)*72/25.4,h=w*page.height/page.width;
      obj(p,()=>add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+w+' '+h.toFixed(3)+'] /Resources << /XObject << /Im0 '+(p+1)+' 0 R >> >> /Contents '+(p+2)+' 0 R >>'));
      obj(p+1,()=>{add('<< /Type /XObject /Subtype /Image /Width '+page.width+' /Height '+page.height+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+page.bytes.length+' >>\nstream\n');add(page.bytes);add('\nendstream');});
      const stream='q\n'+w+' 0 0 '+h.toFixed(3)+' 0 0 cm\n/Im0 Do\nQ\n';
      obj(p+2,()=>add('<< /Length '+enc.encode(stream).length+' >>\nstream\n'+stream+'endstream'));
    });
    const xref=length;add('xref\n0 '+offsets.length+'\n0000000000 65535 f \n');
    for(let i=1;i<offsets.length;i++)add(String(offsets[i]).padStart(10,'0')+' 00000 n \n');
    add('trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n');
    return new Blob(chunks,{type:'application/pdf'});
  }
  function canvasFor(receipt,start=0,end=receipt.lines.length){
    const canvas=root.document.createElement('canvas'),fontSize=24,lineHeight=32,pad=32;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('No se pudo generar la imagen');
    const font='24px "Courier New", monospace';ctx.font=font;
    const widest=Math.max(receipt.width,...receipt.lines.slice(start,end).map(l=>Array.from(l).length));
    canvas.width=Math.ceil(widest*ctx.measureText('M').width+pad*2);
    canvas.height=pad*2+(end-start)*lineHeight;
    if(canvas.width*canvas.height>24000000)throw new Error('Ticket muy largo: elige PDF o texto');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#000';ctx.font=font;ctx.textBaseline='top';
    receipt.lines.slice(start,end).forEach((line,i)=>ctx.fillText(line,pad,pad+i*lineHeight));return canvas;
  }
  async function fileFor(receipt,format){
    const name='comprobante-'+receipt.id.replace(/[^a-z0-9_-]/gi,'_').slice(0,100);
    if(format==='image'){
      const canvas=canvasFor(receipt);const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('No se pudo generar PNG')),'image/png'));
      return new root.File([blob],name+'.png',{type:'image/png'});
    }
    if(format==='pdf'){
      const pages=[];
      // Fixed line boundaries preserve all products on large purchases without
      // clipping a line or allocating one enormous bitmap.
      for(let start=0;start<receipt.lines.length;start+=90){const c=canvasFor(receipt,start,Math.min(start+90,receipt.lines.length)),b64=c.toDataURL('image/jpeg',.95).split(',')[1];const binary=root.atob(b64);pages.push({bytes:Uint8Array.from(binary,ch=>ch.charCodeAt(0)),width:c.width,height:c.height,mm:receipt.mm});}
      return new root.File([pdf(pages)],name+'.pdf',{type:'application/pdf'});
    }
    return new root.File([receipt.text],name+'.txt',{type:'text/plain;charset=utf-8'});
  }
  function notify(message,tone='error'){try{if(typeof toast==='function'){toast(message,tone);return;}}catch(_){}if(typeof root.toast==='function')root.toast(message,tone);}
  function el(tag,cls,text){const node=root.document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
  function close(){version++;active=null;const overlay=root.document.getElementById('naReceiptShare');overlay?.classList.remove('open');returnFocus?.focus?.();}
  function ensureModal(){
    let overlay=root.document.getElementById('naReceiptShare');if(overlay)return overlay;
    overlay=el('div','modal-overlay na-receipt-overlay');overlay.id='naReceiptShare';
    const modal=el('section','modal na-receipt-modal');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','naReceiptTitle');
    const head=el('div','mhead teal'),title=el('div','mhead-title','Compartir comprobante');title.id='naReceiptTitle';const x=el('button','btn-close-m','×');x.type='button';x.setAttribute('aria-label','Cerrar');x.onclick=close;head.append(title,x);
    const body=el('div','mbody'),name=el('strong','na-receipt-client');name.id='naReceiptClient';
    const label=el('label','fl','WhatsApp del cliente'),phone=el('input','fi');phone.id='naReceiptPhone';phone.type='tel';phone.placeholder='+51 987 654 321';phone.maxLength=32;label.htmlFor=phone.id;
    const formatLabel=el('label','fl','Formato'),format=el('select','fs');format.id='naReceiptFormat';formatLabel.htmlFor=format.id;
    [['image','Imagen PNG'],['text','Texto'],['pdf','PDF']].forEach(([value,text])=>{const opt=el('option','',text);opt.value=value;format.append(opt);});format.onchange=prepare;
    const details=el('details','na-receipt-preview'),summary=el('summary','','Vista previa del comprobante'),pre=el('pre','');pre.id='naReceiptText';details.append(summary,pre);
    const status=el('p','na-receipt-status');status.id='naReceiptStatus';status.setAttribute('role','status');
    const buttons=el('div','mbtns'),cancel=el('button','mbtn mbtn-cancel','Cancelar'),send=el('button','mbtn mbtn-ok','Compartir');send.id='naReceiptSend';cancel.type=send.type='button';cancel.onclick=close;send.onclick=share;buttons.append(cancel,send);
    const download=el('button','na-receipt-download','Descargar comprobante');download.type='button';download.onclick=()=>{if(active?.file)downloadFile(active.file);};
    body.append(name,label,phone,formatLabel,format,details,status,buttons,download);modal.append(head,body);overlay.append(modal);root.document.body.append(overlay);
    overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
    overlay.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();close();}if(e.key==='Tab'){const focusable=Array.from(modal.querySelectorAll('button,input,select,summary')).filter(n=>!n.disabled&&!n.hidden);const first=focusable[0],last=focusable[focusable.length-1];if(e.shiftKey&&root.document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&root.document.activeElement===last){e.preventDefault();first.focus();}}});return overlay;
  }
  async function prepare(){
    if(!active)return;const state=active,token=++version,format=root.document.getElementById('naReceiptFormat').value;state.format=format;state.file=null;
    const status=root.document.getElementById('naReceiptStatus'),send=root.document.getElementById('naReceiptSend');send.disabled=true;status.textContent='Preparando comprobante…';
    try{state.file=await fileFor(state.receipt,format);if(token!==version||active!==state)return;
      status.textContent=format==='text'?'Se abrirá el chat del número indicado. Confirma el envío en WhatsApp.':'Elige WhatsApp y el contacto en el menú de compartir. Si no está disponible, descarga el archivo.';
      send.textContent=format==='text'?'Enviar por WhatsApp':'Compartir';send.disabled=false;
    }catch(error){if(token!==version||active!==state)return;status.textContent=error.message+' Puedes elegir texto.';}
  }
  function open(input,automatic=false){
    if(automatic&&!settings().ask)return false;
    const receipt=build(input),overlay=ensureModal();returnFocus=root.document.activeElement;
    active={receipt,format:settings().format,file:null};busy=false;
    root.document.getElementById('naReceiptClient').textContent=receipt.customerName;
    root.document.getElementById('naReceiptPhone').value=receipt.phone?'+'+receipt.phone:'';
    root.document.getElementById('naReceiptFormat').value=active.format;
    root.document.getElementById('naReceiptText').textContent=receipt.text;
    overlay.classList.add('open');prepare();
    // P1-D (mobile): focus the dialog title, never the phone input, so the
    // on-screen keyboard does not pop up after every sale.
    const title=root.document.getElementById('naReceiptTitle');if(title){title.setAttribute('tabindex','-1');title.focus({preventScroll:true});}return true;
  }
  function downloadFile(file){const url=root.URL.createObjectURL(file),a=el('a');a.href=url;a.download=file.name;root.document.body.append(a);a.click();a.remove();root.setTimeout(()=>root.URL.revokeObjectURL(url),30000);notify('Comprobante descargado. Puedes adjuntarlo en WhatsApp.','success');}
  async function share(){
    if(!active||busy||!active.file)return;const state=active;
    const phone=root.document.getElementById('naReceiptPhone');
    if(state.format==='text'&&!normalizePhone(phone.value)){notify('Ingresa un número de WhatsApp válido, con código de país');phone.focus();return;}
    busy=true;
    const send=root.document.getElementById('naReceiptSend');send.disabled=true;
    try{
      if(state.format==='text'){
        const url=textUrl(root.document.getElementById('naReceiptPhone').value,state.receipt.text);
        const chat=root.open(url,'_blank');if(chat)chat.opener=null;else root.location.assign(url);
      }else if(root.navigator?.share&&root.navigator.canShare?.({files:[state.file]})){
        await root.navigator.share({title:'Comprobante Nuevo Amanecer',files:[state.file]});
      }else downloadFile(state.file);
    }catch(error){if(error.name!=='AbortError')notify('No se pudo compartir. Puedes descargar el comprobante.');}
    finally{busy=false;if(active===state)send.disabled=false;}
  }
  function safely(input){try{open(input,true);}catch(error){notify('Operación guardada. No se pudo preparar el comprobante; reintenta desde el historial.');root.console?.warn('[Comprobante]',error.message);}}
  function customers(){try{if(typeof clientes!=='undefined')return clientes;}catch(_){}return root.clientes||[];}
  function sales(){try{if(typeof ventas!=='undefined')return ventas;}catch(_){}return root.ventas||[];}
  function credits(){try{if(typeof creditos!=='undefined')return creditos;}catch(_){}return root.creditos||[];}
  function customerFor(id){return customers().find(c=>String(c.id)===String(id));}
  function saleInput(sale){const credit=credits().find(cr=>String(cr.ventaId)===String(sale.id));return{kind:'sale',sale,credit,customer:customerFor(sale.clienteId||sale.customer_id||sale.cliente?.id),due:credit?.vence||sale.credit_due,fresh:false};}
  function shareSale(id){const sale=sales().find(s=>String(s.id)===String(id));if(!sale){notify('Venta no encontrada');return;}open(saleInput(sale));}
  function shareCredit(id){const cr=credits().find(c=>String(c.id)===String(id));if(!cr){notify('Crédito no encontrado');return;}const sale=sales().find(s=>String(s.id)===String(cr.ventaId));open({kind:'credit',credit:cr,sale,customer:customerFor(cr.cliId||cr.clienteId)});}
  function sharePayment(creditId,paymentId){const cr=credits().find(c=>String(c.id)===String(creditId)),pay=cr?.pagos?.find(p=>String(p.id||p.pagoId)===String(paymentId));if(!cr||!pay){notify('Pago no encontrado');return;}const sale=sales().find(s=>String(s.id)===String(cr.ventaId));open({kind:'payment',credit:cr,sale,payment:pay,customer:customerFor(cr.cliId||cr.clienteId)});}
  function onSale(sale,customer,extra={}){safely({kind:'sale',sale,customer,fresh:true,...extra});}
  function onPayment(credit,receipt,amountCents,method,reference,createdAt){
    if(!credit||!receipt?.operation_id)return;
    const balance=receipt.balance_cents??receipt.current_balance_cents;
    const date=dateFields(createdAt);
    const pay={id:receipt.operation_id,monto:amountCents/100,metodo:method,numeroOperacion:reference,...date,saldoAntes:Number(credit.saldo),saldoDespues:known(balance)?Number(balance)/100:Number(credit.saldo)-amountCents/100};
    safely({kind:'payment',credit,payment:pay,sale:sales().find(s=>String(s.id)===String(credit.ventaId)),customer:customerFor(credit.cliId||credit.clienteId)});
  }
  function onPayments(entries,method,reference,createdAt){
    if(!entries.length)return;
    const ids=new Set(entries.map(row=>String(row.credit.cliId||row.credit.clienteId)));
    // Do not disclose debts from another customer in the same receipt.
    if(ids.size!==1){notify('Cobro confirmado. Comparte cada comprobante desde el historial.','success');return;}
    const first=entries[0],cr={...first.credit,id:entries.map(e=>e.credit.id).join(', '),desc:'Abono a '+entries.length+' créditos',items:entries.flatMap(e=>itemsFromCredit(e.credit))};
    const amount=entries.reduce((sum,e)=>sum+e.amount_cents/100,0),before=entries.reduce((sum,e)=>sum+Number(e.credit.saldo),0),after=entries.reduce((sum,e)=>sum+Number(e.receipt.current_balance_cents)/100,0);
    safely({kind:'payment',credit:cr,payment:{id:first.receipt.operation_id,monto:amount,metodo:method,numeroOperacion:reference,...dateFields(createdAt),saldoAntes:before,saldoDespues:after},customer:customerFor(first.credit.cliId||first.credit.clienteId),allocations:entries.map(e=>({id:e.credit.id,amount:e.amount_cents/100,balance:e.receipt.current_balance_cents/100}))});
  }
  function installTicketButton(){
    const footer=root.document.querySelector('#mTicket .mfooter')||root.document.querySelector('#mTicket .mbtns')||root.document.querySelector('#mTicket .modal');if(!footer||root.document.getElementById('naTicketShare'))return;const button=el('button','na-receipt-history','Compartir comprobante');button.id='naTicketShare';button.type='button';button.onclick=()=>{let sale;try{sale=tkCurrentVenta;}catch(_){sale=root.tkCurrentVenta;}if(sale)open(saleInput(sale));};footer.append(button);
  }
  // Printed / previewed ticket (Ver ticket, imprimir, ESC/POS): same account
  // block after the footer, for credit sales of an identified customer only.
  function installPrintedAccountSummary(){
    const base=root._naBuildThermalTicket;
    if(root._naF11ReceiptZonesEnabled||typeof base!=='function'||base._naAccountSummary)return false;
    const wrapped=function(v,fromDom){
      const built=base.apply(this,arguments);
      try{
        if(!v||v._naSkipAccountSummary||!built||!Array.isArray(built.lines))return built;
        if(v.metodo!=='credito'&&v.metodoPago!=='credito')return built;
        const credit=credits().find(cr=>creditSaleId(cr)===String(v.id))||{};
        const summary=accountSummary({kind:'sale',sale:v,credit,customer:customerFor(v.clienteId??v.customer_id??v.cliente?.id)||{},pendingSync:String(v.status||'')==='PENDING_SYNC'},v,credit);
        if(!summary)return built;
        const width=built.width||42,ascii=line=>String(line).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[¡]/g,'!').replace(/[¿]/g,'?').replace(/[^\x20-\x7E]/g,'').replace(/\s+$/,'');
        const lines=built.lines.concat(accountLines(summary,width).map(line=>ascii(line)));
        return{...built,lines,text:lines.join('\n')};
      }catch(error){root.console?.warn?.('[Ticket estado de cuenta]',error.message);return built;}
    };
    wrapped._naAccountSummary=true;root._naBuildThermalTicket=wrapped;return true;
  }
  installPrintedAccountSummary();
  root.NAReceiptShare=Object.freeze({formatAsOf:nowLabel,placeLabel,accountSummary:(input)=>{const data=copy(input);return accountSummary(data,data.sale||{},data.credit||{});},accountLines,ticketExtrasForSale,installPrintedAccountSummary,onPayments,installTicketButton,settings,setSettings,normalizePhone,textUrl,build,pdf,fileFor,open,close,onSale,onPayment,onStoredPayment:(cr,pay)=>safely({kind:'payment',credit:cr,payment:pay,sale:sales().find(s=>String(s.id)===String(cr.ventaId)),customer:customerFor(cr.cliId||cr.clienteId)}),onCredit:cr=>safely({kind:'credit',credit:cr,customer:customerFor(cr.cliId||cr.clienteId),fresh:true}),shareSale,shareCredit,sharePayment});
})(globalThis);
