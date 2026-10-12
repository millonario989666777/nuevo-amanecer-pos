// A VARIOS line already shows the VARIOS badge; its default name 'VARIOS' must not be repeated ('VARIOSVARIOS').
function _naSaleItemTitle(item){const name=String(item?.name||item?.nombre||'').trim();if(item?.ventaLibre&&(!name||name.toUpperCase()==='VARIOS'))return'';return name||'Producto';}

// Seguridad: las ventas restauradas o importadas se representan con nodos DOM.
function _naSecElement(tag,className,text){
  const element=document.createElement(tag);
  if(className)element.className=className;
  if(text!==undefined)element.textContent=String(text);
  return element;
}
function _naSecAppend(parent,tag,className,text){
  const element=_naSecElement(tag,className,text);
  parent.appendChild(element);
  return element;
}
function _naSecButton(className,text,action,id){
  const button=_naSecElement('button',className,text);
  button.type='button';
  button.dataset.naSaleAction=action;
  if(id!==undefined)button.dataset.saleId=String(id);
  return button;
}
function _naSecSaleMethod(value){
  const method=Object.prototype.hasOwnProperty.call(mpLbl,value)?value:'efectivo';
  return{className:mpCls[method]||'mp-ef',label:mpLbl[method]||mpLbl.efectivo};
}
// Etapa 2: los 4 totales se pintan al instante con su valor guardado o «—» (misma altura, CLS 0)
// y se calculan después del primer pintado, en tiempo libre, sobre TODAS las ventas del período.
let _naSecKpiMemo=null,_naSecKpiJob=0;
function _naSecIdle(fn,timeout){if(typeof requestIdleCallback==='function')return requestIdleCallback(fn,{timeout:timeout||300});return setTimeout(()=>fn({timeRemaining:()=>8,didTimeout:true}),16);}
function _naSecKpiKey(){return [ventasTab,_naF8RangeFromPeriod('today').from,ventas.length,(typeof gastos!=='undefined'&&gastos)?gastos.length:0,(typeof cajMovs!=='undefined'&&cajMovs)?cajMovs.length:0].join('|');}
function _naSecComputeKpis(){
  const range=ventasTab==='hoy'?_naF8RangeFromPeriod('today'):ventasTab==='semana'?_naF8RangeFromPeriod('week'):{from:'0000-01-01',to:'9999-12-31'};
  const sales=_naF8SaleRows(range),expenses=_naF8UnifiedExpenses(range),metrics=_naF8SaleMetrics(sales);
  const operating=_naF8Money(expenses.filter(e=>!_naF8IsInvestment(e)).reduce((a,e)=>a+_naNumber(e.monto),0));
  return [metrics.revenue,metrics.gross,operating,_naF8Money(metrics.gross-operating)];
}
function _naSecRenderSaleKpis(){
  const container=document.getElementById('ventasKPI');
  if(!container)return;
  const key=_naSecKpiKey(),memo=_naSecKpiMemo&&_naSecKpiMemo.key===key&&_naSecKpiMemo.ventas===ventas?_naSecKpiMemo.values:null;
  container.replaceChildren();
  const vals=[];
  [['teal','Ventas'],['green','Ganancia bruta'],['amber','Gastos operativos'],['purple','Ganancia neta']].forEach(([tone,label],i)=>{
    const card=_naSecAppend(container,'div',`vkpi ${tone}`);
    vals.push(_naSecAppend(card,'div','vkpi-val',memo?fmt(memo[i]):'—'));
    _naSecAppend(card,'div','vkpi-lbl',label);
  });
  if(memo)return;
  const job=++_naSecKpiJob;
  requestAnimationFrame(()=>_naSecIdle(()=>{
    if(job!==_naSecKpiJob||!container.isConnected)return;
    const values=_naSecComputeKpis();_naSecKpiMemo={key,ventas,values};
    vals.forEach((el,i)=>{if(el.isConnected)el.textContent=fmt(values[i]);});
  },400));
}
function _naSecRenderTopProducts(container){
  const totals=new Map();
  ventas.filter(sale=>!sale.anulada).forEach(sale=>(Array.isArray(sale.items)?sale.items:[]).forEach(item=>{
    const key=String(item.id??item.sku??item.name??item.nombre??'');
    if(!totals.has(key))totals.set(key,{icon:item.icon||'📦',name:item.name||item.nombre||'Producto',qty:0,total:0});
    const row=totals.get(key);
    row.qty+=_naUnitsSold(item);
    row.total+=_naNumber(item.precio??item.precioUnitario)*_naNumber(item.qty??item.cantidad);
  }));
  const top=[...totals.values()].sort((a,b)=>b.total-a.total).slice(0,6),max=top[0]?.total||1;
  const chart=_naSecAppend(container,'div','v-chart');
  _naSecAppend(chart,'div','v-chart-title','🏆 Top 6 productos');
  const bars=_naSecAppend(chart,'div','bars');
  top.forEach(product=>{
    const column=_naSecAppend(bars,'div','bar-col');
    _naSecAppend(column,'div','bar-v',fmtS(product.total));
    const bar=_naSecAppend(column,'div','bar');
    bar.style.height=`${Math.max(4,(product.total/max)*65)}px`;
    _naSecAppend(column,'div','bar-lbl',product.icon||'📦');
  });
  const list=_naSecAppend(container,'div','v-list-wrap');
  top.forEach((product,index)=>{
    const card=_naSecAppend(list,'div','venta-card'),header=_naSecAppend(card,'div','v-header');
    _naSecAppend(header,'div','v-num',index+1);
    const info=_naSecAppend(header,'div','v-info');
    _naSecAppend(info,'div','v-items-txt',`${product.icon||'📦'} ${product.name}`);
    const meta=_naSecAppend(info,'div','v-meta');
    _naSecAppend(meta,'span','',`${product.qty} unidades vendidas`);
    const right=_naSecAppend(header,'div','v-right');
    _naSecAppend(right,'div','v-total',fmt(product.total));
  });
}
function _naSecSaleAudit(detail,label,value){
  const box=_naSecAppend(detail,'div');
  _naSecAppend(box,'span','',label);
  _naSecAppend(box,'strong','',value);
}
function _naSecRenderSaleCard(list,sale,index){
  const card=_naSecAppend(list,'div',`venta-card${sale.anulada?' anulada':''}`);
  const header=_naSecAppend(card,'div','v-header');
  header.dataset.naSaleAction='toggle';
  header.dataset.saleTarget=`vd-sec-${index}`;
  const displayId=String(sale.id??'').replace(/^V-/,'#')||`#${index+1}`;
  _naSecAppend(header,'div','v-num',displayId);
  const info=_naSecAppend(header,'div','v-info'),itemsText=_naSecAppend(info,'div','v-items-txt');
  if(sale.anulada)_naSecAppend(itemsText,'span','badge-anulada','ANULADA');
  if(window.NA_REVIEWS?.isFlagged(sale)){const rv=window.NA_REVIEWS.reviewFor(sale),st=rv?.status;_naSecAppend(itemsText,'span','badge-descuento-revision',st==='aprobado'?'⚠ Descuento aprobado':st==='rechazado'?'⚠ Descuento rechazado':'⚠ Descuento por autorizar');}
  const shownBadges=new Set();
  (Array.isArray(sale.items)?sale.items:[]).forEach((item,itemIndex)=>{
    if(itemIndex)itemsText.appendChild(document.createTextNode(', '));
    const badgeKind=item.ventaLibre?'free':item.ventaSinStock?'shortage':'';
    const showBadge=badgeKind&&!shownBadges.has(badgeKind);
    if(showBadge){shownBadges.add(badgeKind);_naSecAppend(itemsText,'span',`sale-special-badge ${badgeKind}`,badgeKind==='free'?'VARIOS':'SIN STOCK');}
    const prefix=_naNumber(item.qty??item.cantidad)>1?`${_naNumber(item.qty??item.cantidad)}x `:'';
    const itemName=_naSaleItemTitle(item);
    if(showBadge)itemsText.appendChild(document.createTextNode(' '));
    if(prefix||itemName)itemsText.appendChild(document.createTextNode(`${prefix}${itemName}`.trim()));
  });
  const meta=_naSecAppend(info,'div','v-meta');
  _naSecAppend(meta,'span','',`${sale.fecha||''} ${sale.hora24||sale.hora||''}`.trim());
  _naSecAppend(meta,'span','',`👤 ${sale.cajeroNombre||sale.cajero||'Cajero'}${sale.cajeroId?` · ${sale.cajeroId}`:''}`);
  const stateClass=sale.anulada?'cancelled':sale.estado==='credito'?'credit':'completed';
  _naSecAppend(meta,'span',`sale-state-badge ${stateClass}`,_naSaleStateLabel(sale));
  _naSecAppend(meta,'span','sale-type-badge',_naSaleTypeLabel(sale));
  const right=_naSecAppend(header,'div','v-right');
  _naSecAppend(right,'div','v-total',sale.anulada?'—':fmt(totalV(sale)));
  const method=_naSecSaleMethod(sale.metodo);
  _naSecAppend(right,'span',`mp ${method.className}`,method.label);

  const detail=_naSecAppend(card,'div','v-detalle');
  detail.id=`vd-sec-${index}`;
  (Array.isArray(sale.items)?sale.items:[]).forEach(item=>{
    const row=_naSecAppend(detail,'div','det-row'),label=_naSecAppend(row,'span');
    label.style.fontWeight='700';
    label.appendChild(document.createTextNode(`${item.icon||'📦'} ${_naSaleItemTitle(item)} `.replace(/\s+$/,' ')));
    if(item.ventaLibre)_naSecAppend(label,'span','sale-special-badge free','VARIOS');
    else if(item.ventaSinStock)_naSecAppend(label,'span','sale-special-badge shortage','SIN STOCK');
    const quantity=_naSecAppend(label,'span','',` x${_naNumber(item.qty??item.cantidad)}`);
    quantity.style.color='var(--slate)';
    quantity.style.fontSize='11px';
    _naSecAppend(row,'span','det-price',fmt(_naNumber(item.precio??item.precioUnitario)*_naNumber(item.qty??item.cantidad)));
  });
  const totalRow=_naSecAppend(detail,'div','det-row');
  _naSecAppend(totalRow,'span','','Total');
  const totalValue=_naSecAppend(totalRow,'span','',fmt(totalV(sale)));
  totalValue.style.color='var(--teal)';
  const audit=_naSecAppend(detail,'div','sale-audit-grid');
  _naSecSaleAudit(audit,'Estado',_naSaleStateLabel(sale));
  _naSecSaleAudit(audit,'Tipo de venta',_naSaleTypeLabel(sale));
  _naSecSaleAudit(audit,'Cajero',`${sale.cajeroNombre||sale.cajero||'Cajero'}${sale.cajeroId?` · ${sale.cajeroId}`:''}`);
  _naSecSaleAudit(audit,'Cliente',sale.clienteNombre||'Consumidor final');
  _naSecSaleAudit(audit,'Fecha y hora',`${sale.fecha||''} · ${sale.hora24||sale.hora||''}`);
  _naSecSaleAudit(audit,'Operación',sale.paymentRef||sale.operation||'-');
  if(sale.nota)_naSecSaleAudit(audit,'Nota',String(sale.nota));
  const units=(Array.isArray(sale.items)?sale.items:[]).reduce((sum,item)=>sum+_naUnitsSold(item),0);
  _naSecSaleAudit(audit,'Líneas / unidades',`${_naInt(sale.cantidadLineas,(sale.items||[]).length)} / ${_naNumber(sale.unidadesFisicas,units)}`);
  _naSecSaleAudit(audit,'Método',method.label);
  if(sale.metodo==='mixto'&&sale.paymentBreakdown){
    [['💵 Efectivo',sale.paymentBreakdown.efectivo],[sale.paymentBreakdown.digitalMethod==='yape'?'📱 Yape':sale.paymentBreakdown.digitalMethod==='plin'?'📱 Plin':'🏦 Transferencia',sale.paymentBreakdown.digital]].forEach(([label,value])=>{
      const row=_naSecAppend(detail,'div','det-row');
      _naSecAppend(row,'span','',label);
      _naSecAppend(row,'span','',fmt(value));
    });
  }
  const actions=_naSecAppend(detail,'div','det-acts');
  actions.appendChild(_naSecButton('btn-det btn-reimp','🧾 Ticket','ticket',sale.id));
  if(!sale.anulada&&(!sale.canonicalReadOnly||window.NA_ANNUL?.canAnnul(sale)))actions.appendChild(_naSecButton('btn-det btn-anul','🚫 Anular','annul',sale.id));
  else if(sale.canonicalReadOnly)_naSecAppend(actions,'span','', 'CANON · solo lectura').style.cssText='font-size:11px;color:var(--slate);font-weight:700';
  else _naSecAppend(actions,'span','', 'Anulada').style.cssText='font-size:11px;color:var(--red);font-weight:700';
}
function _naSecSalesRendered(){try{window.dispatchEvent(new CustomEvent('na:sales-rendered'));}catch(_){}}
function _naSecRenderSales(){
  _naF8ToggleReportControls();
  if(ventasTab==='reportes'){_naF8RenderReport();_naSecSalesRendered();return;}
  _naSecRenderSaleKpis();
  const container=document.getElementById('ventasContent');
  if(!container){_naSecSalesRendered();return;}
  container.replaceChildren();
  if(ventasTab==='productos'){_naSecRenderTopProducts(container);_naSecSalesRendered();return;}
  const rows=ventasTab==='historial'?ventas.filter(sale=>{
    const search=sinTildes((document.getElementById('ventasSearch')?.value||'').toLowerCase()),method=document.getElementById('ventasMetodo')?.value||'';
    if(method==='__descuento')return _naSaleMatchesSearch(sale,search)&&!!window.NA_REVIEWS?.isFlagged(sale);
    return _naSaleMatchesSearch(sale,search)&&(!method||sale.metodo===method);
  }):ventasFiltradas();
  if(!rows.length){
    const empty=_naSecAppend(container,'div','empty-state');
    _naSecAppend(empty,'div','ei','📊');
    _naSecAppend(empty,'p','','Sin ventas en este período');
    _naSecSalesRendered();
    return;
  }
  const list=_naSecAppend(container,'div','v-list-wrap');
  // Etapa 2: se pinta primero una página y el resto por tandas al acercarse al final.
  // Totales, conteos, filtros, búsqueda y exportación siguen usando TODAS las ventas (rows/ventas).
  _naSecCancelSalesRows();
  // Tandas pequeñas (20) en tiempo libre para que el desplazamiento no se trabe.
  let next=0,busy=false;const FIRST=20,STEP=20,PER_TRIGGER=60;
  // Cada tanda va en su propio bloque contenido: agregar una tanda no recalcula ni repinta las anteriores.
  const chunk=n=>{const end=Math.min(rows.length,next+n);const box=document.createElement('div');box.className='v-chunk';for(;next<end;next++)_naSecRenderSaleCard(box,rows[next],next);list.insertBefore(box,list.querySelector(':scope > .na-sales-more'));};
  chunk(FIRST);
  if(next<rows.length&&typeof IntersectionObserver==='function'){
    const sentinel=_naSecAppend(list,'div','na-sales-more');sentinel.style.cssText='height:1px';
    const pump=(left,observer)=>_naSecIdle(deadline=>{
      if(observer!==_naSecSalesObserver||!list.isConnected){busy=false;return;}
      // Una tanda de STEP tarjetas por tiempo libre (pausas < 50 ms).
      const before=next;chunk(STEP);
      left-=next-before;
      if(next>=rows.length){busy=false;_naSecCancelSalesRows();return;}
      if(left>0)pump(left,observer);else busy=false;
    },200);
    const observer=new IntersectionObserver(entries=>{
      if(observer!==_naSecSalesObserver||!list.isConnected){observer.disconnect();return;}
      if(!entries.some(e=>e.isIntersecting)||busy)return;
      busy=true;pump(PER_TRIGGER,observer);
    },{rootMargin:'1200px 0px'});
    _naSecSalesObserver=observer;observer.observe(sentinel);
  }else chunk(rows.length);
  _naSecSalesRendered();
}
let _naSecSalesObserver=null;
function _naSecCancelSalesRows(){if(_naSecSalesObserver){_naSecSalesObserver.disconnect();_naSecSalesObserver=null;}document.querySelector('#ventasContent .na-sales-more')?.remove();}
ventasRender=_naSecRenderSales;
document.getElementById('ventasContent')?.addEventListener('click',event=>{
  const control=event.target.closest('[data-na-sale-action]');
  if(!control)return;
  const action=control.dataset.naSaleAction;
  if(action==='toggle')document.getElementById(control.dataset.saleTarget)?.classList.toggle('open');
  else if(action==='ticket')verTicket(control.dataset.saleId);
  else if(action==='annul')anularV(control.dataset.saleId);
});
_naF10RenderSalesAdmin=function(){
  const container=document.getElementById('masterSalesContent');
  if(!container)return;
  const query=sinTildes(_naF10SalesQuery.toLowerCase());
  const rows=ventas.slice().sort((a,b)=>_naF10SaleTime(b)-_naF10SaleTime(a)).filter(sale=>!query||_naSaleMatchesSearch(sale,query)).slice(0,100);
  container.replaceChildren();
  const toolbar=_naSecAppend(container,'div','f10-sales-toolbar'),search=_naSecElement('input','fi');
  search.value=_naF10SalesQuery;
  search.placeholder='Buscar venta, operación, cajero, cliente o producto';
  search.addEventListener('input',()=>{_naF10SalesQuery=search.value;_naF10RenderSalesAdmin();});
  toolbar.appendChild(search);
  const backup=_naSecElement('button','f10-btn','💾 Respaldo');
  backup.type='button';
  backup.addEventListener('click',()=>_naF10DownloadSnapshot('antes_gestion_ventas'));
  toolbar.appendChild(backup);
  _naSecAppend(container,'div','f10-warning','Por seguridad contable, una venta confirmada no se elimina ni se edita directamente. Puedes reimprimir, anular con reversión o agregar una nota administrativa. La venta original siempre permanece.');
  const list=_naSecAppend(container,'div','f10-sales-list');
  if(!rows.length){
    const empty=_naSecAppend(list,'div','empty-state');
    _naSecAppend(empty,'p','','No se encontraron ventas');
    return;
  }
  rows.forEach(sale=>{
    const card=_naSecAppend(list,'div',`f10-sale${sale.anulada?' anulada':''}`),head=_naSecAppend(card,'div','f10-sale-head'),identity=_naSecAppend(head,'div');
    _naSecAppend(identity,'strong','',`${sale.id||''} · ${sale.clienteNombre||'Consumidor final'}`);
    const products=(Array.isArray(sale.items)?sale.items:[]).map(item=>`${item.qty||item.cantidad||1}x ${item.name||item.nombre||'Producto'}`).join(', ');
    _naSecAppend(identity,'span','',`${sale.fecha||''} ${sale.hora24||sale.hora||''} · ${sale.cajeroNombre||sale.cajero||'Cajero'}${sale.cajeroId?` · ${sale.cajeroId}`:''}\n${products}`);
    _naSecAppend(head,'span','f10-sale-total',sale.anulada?'ANULADA':fmt(totalV(sale)));
    const notes=Array.isArray(sale.adminNotes)?sale.adminNotes:[],lastNote=notes[notes.length-1];
    if(lastNote)_naSecAppend(card,'div','f10-note',`📝 ${lastNote.text||''} · ${lastNote.cashierNombre||'Admin'}`);
    const actions=_naSecAppend(card,'div','f10-sale-actions');
    actions.appendChild(_naSecButton('f10-btn','🧾 Ticket','ticket',sale.id));
    if(!sale.canonicalReadOnly)actions.appendChild(_naSecButton('f10-btn primary','📝 Nota','note',sale.id));
    if(!sale.anulada&&(!sale.canonicalReadOnly||window.NA_ANNUL?.canAnnul(sale)))actions.appendChild(_naSecButton('f10-btn danger','🚫 Anular','admin-annul',sale.id));
  });
};
document.getElementById('masterSalesContent')?.addEventListener('click',event=>{
  const control=event.target.closest('[data-na-sale-action]');
  if(!control)return;
  const action=control.dataset.naSaleAction,id=control.dataset.saleId;
  if(action==='ticket')verTicket(id);
  else if(action==='note')_naF10AddSaleNote(id);
  else if(action==='admin-annul')_naF10AdminAnnulSale(id);
});
