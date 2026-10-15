
// Seguridad: clientes y créditos usan delegación; ningún ID restaurado forma código ejecutable.
function _naSecCreditAction(className,text,action,id){
  const button=_naSecElement('button',className,text);
  button.type='button';
  button.dataset.naCreditAction=action;
  if(id!==undefined)button.dataset.creditId=String(id);
  return button;
}
function _naSecCreditPolicyBadge(parent,evaluation){
  const badge=_naSecAppend(parent,'span','credit-policy-badge');
  if(!evaluation.enabled){badge.classList.add('off');badge.textContent='CRÉDITOS DESACTIVADOS';}
  else if(evaluation.manualActive){badge.classList.add('manual');badge.textContent=`LÍNEA MANUAL${evaluation.manualAboveProfit?' · EXCEPCIÓN':''}`;}
  else if(evaluation.eligible){badge.classList.add('ok');badge.textContent='APTO PARA CRÉDITO';}
  else if(evaluation.autoEligible){badge.classList.add('warn');badge.textContent='SIN GANANCIA DISPONIBLE';}
  else{badge.classList.add('bad');badge.textContent='AÚN NO CALIFICA';}
}
function _naSecCreditEvaluation(parent,evaluation){
  const row=_naSecAppend(parent,'div','credit-eval-inline'),main=_naSecAppend(row,'div','cei-main'),title=_naSecAppend(main,'div','cei-title','📊 Evaluación de crédito ');
  _naSecCreditPolicyBadge(title,evaluation);
  _naSecAppend(main,'div','cei-sub',`${_naCreditRequirementText(evaluation)} · Conducta: ${_naCreditBehaviorLabel(evaluation.history.behavior)}`);
  const value=_naSecAppend(row,'div','cei-value');
  _naSecAppend(value,'strong','',fmt(evaluation.available));
  _naSecAppend(value,'span','',`DISPONIBLE DE ${fmt(evaluation.assignedLine)}`);
}
function _naSecCreditCard(parent,credit){
  _naSyncCreditStatus(credit);
  const pct=credit.monto>0?Math.min(100,_naNumber(credit.pagado)/_naNumber(credit.monto)*100):0,days=diasHasta(credit.vence),pending=_naCreditOutstanding(credit);
  const dateLabel=credit.status==='cancelado'?'Pagado completamente':credit.status==='anulado'?'Crédito anulado':days===null?'—':days<0?`Venció hace ${Math.abs(days)}d`:days===0?'Vence hoy':days<=7?`Vence en ${days}d`:credit.vence;
  const dateColor=credit.status==='cancelado'?'#15803d':credit.status==='anulado'||days!==null&&days<0?'var(--red)':days!==null&&days<=7?'var(--amber)':'var(--slate)';
  const statusClass=credit.status==='cancelado'?'cs-c':credit.status==='vencido'||credit.status==='anulado'?'cs-m':'cs-v',payments=Array.isArray(credit.pagos)?credit.pagos.filter(pay=>pay?.status!=='REVERTED').length:0;
  const card=_naSecAppend(parent,'div','cr-item'),top=_naSecAppend(card,'div','cr-top'),copy=_naSecAppend(top,'div');
  _naSecAppend(copy,'div','cr-desc',`${credit.tipo==='contrato_privado'?'📋':'🛒'} ${credit.desc||'Crédito'}`);
  const date=_naSecAppend(copy,'div','cr-date',dateLabel);
  date.style.color=dateColor;
  _naSecAppend(copy,'div','credit-status-note',`${payments} pago${payments===1?'':'s'} registrado${payments===1?'':'s'}${credit.ventaId?` · Venta ${credit.ventaId}`:''}`);
  _naSecAppend(top,'span',`c-status ${statusClass}`,_naCreditStatusLabel(credit));
  const amounts=_naSecAppend(card,'div','cr-amounts');
  [['Original','cra-o',credit.monto],['Pagado','cra-p',credit.pagado],['Pendiente','cra-r',pending]].forEach(([label,tone,value])=>{
    const box=_naSecAppend(amounts,'div','cra');
    _naSecAppend(box,'div','cra-lbl',label);
    _naSecAppend(box,'div',`cra-val ${tone}`,fmt(value));
  });
  const progress=_naSecAppend(card,'div','cr-prog'),fill=_naSecAppend(progress,'div','cr-prog-fill');
  fill.style.width=`${Math.max(0,pct).toFixed(0)}%`;
  const actions=_naSecAppend(card,'div','cr-acts');
  if(!credit.anulado&&credit.status!=='cancelado'&&pending>0)actions.appendChild(_naSecCreditAction('btn-cr btn-pago-cr','💵 Registrar pago','pay',credit.id));
  const history=_naSecCreditAction('btn-cr','📄 Ver historial','detail',credit.id);
  history.style.cssText='background:#f1f5f9;color:var(--slate)';
  actions.appendChild(history);
}
function _naSecClientCard(parent,client){
  const debt=_naClientDebtFast(client),status=statusCli(client),debtClass=status==='vencido'?'mal':status==='proximo'?'parcial':'ok',statusClass=status==='vencido'?'cs-m':status==='proximo'?'cs-p':status==='vigente'?'cs-v':'cs-c';
  const statusLabel=status==='vencido'?'VENCIDO':status==='proximo'?'PR\u00d3XIMO':status==='vigente'?'VIGENTE':'AL D\u00cdA',cardClass=status==='vencido'?'vencido-c':status==='proximo'?'proximo-c':'';
  const credits=_naClientAllCreditsFast(client.id),evaluation=_naEvaluateClientCredit(client.id);

  credits.forEach(_naSyncCreditStatus);

  const activeCredits=credits
    .filter(credit=>!credit.anulado&&credit.status!=='cancelado'&&_naCreditOutstanding(credit)>0)
    .sort((a,b)=>String(a.vence||'9999-12-31').localeCompare(String(b.vence||'9999-12-31')));

  const pastCredits=credits
    .filter(credit=>credit.anulado||credit.status==='cancelado'||_naCreditOutstanding(credit)<=0)
    .sort((a,b)=>new Date(b.timestamp||b.fecha||0)-new Date(a.timestamp||a.fecha||0));

  const card=_naSecAppend(parent,'div',`client-card ${cardClass}`);
  card.dataset.clientId=String(client.id);

  const header=_naSecAppend(card,'div','client-header');
  header.dataset.naCreditAction='toggle-client';

  const avatar=_naSecAppend(header,'div','c-avatar',initials(client.nombre));
  avatar.style.background=colorFor(client.color);

  const info=_naSecAppend(header,'div','c-info');
  _naSecAppend(info,'div','c-name',client.nombre);
  _naSecAppend(info,'div','c-meta',`${_naDocumentValue(client.dni)?`\u{1F4CB} ${client.dni}`:''} ${client.tel?`\u{1F4F1} ${client.tel}`:''} ${credits.length?`\u00b7 ${credits.length} cr\u00e9dito(s)`:''}`.trim());

  const right=_naSecAppend(header,'div','c-right');
  _naSecAppend(right,'div',`c-deuda ${debtClass}`,fmt(debt));
  _naSecAppend(right,'span',`c-status ${statusClass}`,statusLabel);

  const creditArea=_naSecAppend(card,'div','client-creds');
  const creditHeader=_naSecAppend(creditArea,'div','creds-hdr');
  _naSecAppend(creditHeader,'span','','Cr\u00e9ditos registrados');

  const actions=_naSecAppend(creditHeader,'div','credit-header-actions');
  const evaluate=_naSecCreditAction('btn-credit-eval','\u{1F4CA} Evaluar l\u00ednea','evaluate-client');
  evaluate.dataset.clientId=String(client.id);
  actions.appendChild(evaluate);

  if(evaluation.enabled){
    const add=_naSecCreditAction('btn-add-cr','+ Nuevo cr\u00e9dito','new-credit');
    add.dataset.clientId=String(client.id);
    actions.appendChild(add);
  }

  _naSecCreditEvaluation(creditArea,evaluation);

  if(!credits.length){
    _naSecAppend(creditArea,'div','','Sin cr\u00e9ditos').style.cssText='text-align:center;color:var(--slate);font-size:12px;padding:14px 0;font-weight:700';
    return;
  }

  const activeTitle=_naSecAppend(creditArea,'div','','Cr\u00e9ditos activos ('+activeCredits.length+')');
  activeTitle.style.cssText='margin:14px 0 7px;padding:8px 10px;border-radius:9px;background:#ecfdf5;color:#166534;font-size:11px;font-weight:900';

  if(activeCredits.length)activeCredits.forEach(credit=>_naSecCreditCard(creditArea,credit));
  else _naSecAppend(creditArea,'div','','No hay cr\u00e9ditos pendientes').style.cssText='color:var(--slate);font-size:11px;padding:8px 4px 12px;font-weight:700';

  if(pastCredits.length){
    const pastTitle=_naSecAppend(creditArea,'div','','Historial de cr\u00e9ditos ('+pastCredits.length+')');
    pastTitle.style.cssText='margin:16px 0 7px;padding:8px 10px;border-radius:9px;background:#f1f5f9;color:var(--slate);font-size:11px;font-weight:900';
    pastCredits.forEach(credit=>_naSecCreditCard(creditArea,credit));
  }
}
_baseCliRender=function(){
  const expired=clientes.filter(client=>statusCli(client)==='vencido').length,soon=clientes.filter(client=>statusCli(client)==='proximo').length,current=clientes.filter(client=>statusCli(client)==='vigente').length;
  [['cliB0',clientes.length],['cliB1',expired],['cliB2',soon],['cliB3',current],['cliS0',clientes.length],['cliS1',`S/${clientes.reduce((sum,client)=>sum+_naClientDebtFast(client),0).toFixed(0)}`],['cliS2',expired],['cliS3',`S/${cobradoHoy.toFixed(2)}`]].forEach(([id,value])=>{const element=document.getElementById(id);if(element)element.textContent=String(value);});{const _naPaidLbl=document.getElementById('cliS3')?.parentElement?.querySelector('.ss-lbl');if(_naPaidLbl)_naPaidLbl.textContent='Cobrado hoy (todos los medios)';}
  const search=sinTildes((document.getElementById('cliSearch')?.value||'').toLowerCase()),sort=document.getElementById('cliSort')?.value||'';
  let rows=clientes.filter(client=>{
    const matches=sinTildes((client.nombre||'').toLowerCase()).includes(search)||_naDocumentValue(client.dni).includes(search),status=statusCli(client);
    return cliTab==='vencidos'?matches&&status==='vencido':cliTab==='proximos'?matches&&status==='proximo':cliTab==='vigentes'?matches&&status==='vigente':matches;
  });
  if(sort==='deuda')rows.sort((a,b)=>_naClientDebtFast(b)-_naClientDebtFast(a));else rows.sort((a,b)=>(a.nombre||'').localeCompare(b.nombre||''));
  const list=document.getElementById('cliList');
  if(!list)return;
  if(window.NA_CLIENT_CREDIT_ACCOUNTS_V2&&typeof window.NA_CLIENT_CREDIT_ACCOUNTS_V2.renderClientList==='function'&&
     window.NA_CLIENT_CREDIT_ACCOUNTS_V2.renderClientList(rows,list))return;
  list.replaceChildren();
  if(!rows.length){
    const empty=_naSecAppend(list,'div','empty-state');
    _naSecAppend(empty,'div','ei','👥');
    _naSecAppend(empty,'p','','Sin clientes en esta vista');
  }else rows.forEach(client=>_naSecClientCard(list,client));
};
document.getElementById('cliList')?.addEventListener('click',event=>{
  const control=event.target.closest('[data-na-credit-action]');
  if(!control)return;
  const action=control.dataset.naCreditAction;
  if(action==='toggle-client')control.closest('.client-card')?.querySelector('.client-creds')?.classList.toggle('open');
  else if(action==='evaluate-client')abrirEvaluacionCredito(control.dataset.clientId);
  else if(action==='new-credit')abrirCred(control.dataset.clientId);
  else if(action==='pay')abrirPago(control.dataset.creditId);
  else if(action==='detail')abrirDetalleCredito(control.dataset.creditId);
});
const _naSecBaseAbrirCred=abrirCred;
abrirCred=function(clientId){
  _naSecBaseAbrirCred(clientId);
  const evaluation=_naEvaluateClientCredit(clientId),name=document.getElementById('mCredNom');
  if(!evaluation.exists||!name||!document.getElementById('mCred')?.classList.contains('open'))return;
  name.replaceChildren();
  name.appendChild(document.createTextNode(evaluation.client.nombre));
  name.appendChild(document.createElement('br'));
  const summary=_naSecElement('small','',`Score ${evaluation.score} · Disponible ${fmt(evaluation.available)}`);
  summary.style.cssText='color:var(--slate);font-size:11px';
  name.appendChild(summary);
};
const _naSecBaseAbrirPago=abrirPago;
abrirPago=function(creditId){
  _naSecBaseAbrirPago(creditId);
  const credit=creditos.find(row=>String(row.id)===String(creditId)),box=document.getElementById('pagoInfoBox');
  if(!credit||!box||!document.getElementById('mPagoCred')?.classList.contains('open'))return;
  const client=clientes.find(row=>String(row.id)===String(credit.cliId)),pending=_naCreditOutstanding(credit);
  box.replaceChildren();
  [['Cliente',client?.nombre||credit.clienteNombre||'Cliente',''],['Crédito',credit.desc||'Crédito',''],['Pagado',fmt(credit.pagado),'#15803d'],['Pendiente',fmt(pending),'var(--red)']].forEach(([label,value,color],index)=>{
    const row=_naSecAppend(box,'div',`pi-row${index===3?' main':''}`);
    _naSecAppend(row,'span','',label);
    const amount=_naSecAppend(row,'span','',value);
    if(color)amount.style.color=color;
    if(index===0)amount.style.fontWeight='800';
  });
};
function _naSecCreditDetailItem(parent,item,paid){
  const left=Math.max(0,item.subtotal-paid),row=_naSecAppend(parent,'div','credit-detail-item'),copy=_naSecAppend(row,'div');
  _naSecAppend(copy,'strong','',item.nombre);
  _naSecAppend(copy,'small','',`${item.cantidad} × ${fmt(item.precioUnitario)}${item.modo&&item.modo!=='minorista'?` · ${item.modo}`:''}`);
  const values=_naSecAppend(row,'div');
  values.style.textAlign='right';
  _naSecAppend(values,'strong','',fmt(item.subtotal));
  _naSecAppend(values,'small','',`Pagado ${fmt(paid)} · Falta ${fmt(left)}`);
}
abrirDetalleCredito=function(creditId){
  const credit=creditos.find(row=>String(row.id)===String(creditId));
  if(!credit){toast('No se encontr\u00f3 el cr\u00e9dito','error');return;}

  const container=document.getElementById('creditoDetalleContent');
  if(!container)return;

  _naSyncCreditStatus(credit);

  const client=clientes.find(row=>String(row.id)===String(credit.cliId));
  const items=_naCreditItems(credit);
  const paidMap=_naCreditPaidMap(credit);
  const payments=[...(Array.isArray(credit.pagos)?credit.pagos:[])]
    .sort((a,b)=>new Date(b.timestamp||`${b.fecha||''}T${b.hora24||b.hora||'00:00:00'}`)-new Date(a.timestamp||`${a.fecha||''}T${a.hora24||a.hora||'00:00:00'}`));
  const pending=_naCreditOutstanding(credit);

  const paymentMoment=payment=>{
    const stamp=payment?.timestamp&&Number.isFinite(new Date(payment.timestamp).getTime())
      ?new Date(payment.timestamp)
      :null;

    return{
      date:payment?.fecha||stamp?.toLocaleDateString('es-PE')||'Fecha no registrada',
      time:payment?.hora24||payment?.hora||stamp?.toLocaleTimeString('es-PE',{
        hour:'2-digit',
        minute:'2-digit',
        second:'2-digit',
        hour12:false
      })||'Hora no registrada'
    };
  };

  const createdStamp=credit.timestamp&&Number.isFinite(new Date(credit.timestamp).getTime())
    ?new Date(credit.timestamp)
    :null;

  const createdDate=credit.fecha||createdStamp?.toLocaleDateString('es-PE')||'Fecha no registrada';
  const createdTime=credit.hora24||credit.hora||createdStamp?.toLocaleTimeString('es-PE',{
    hour:'2-digit',
    minute:'2-digit',
    second:'2-digit',
    hour12:false
  })||'Hora no registrada';

  const latestPayment=payments[0]||null;
  const latestMoment=latestPayment?paymentMoment(latestPayment):null;

  container.replaceChildren();

  const summary=_naSecAppend(container,'div','credit-detail-summary');

  [
    ['Cliente',client?.nombre||credit.clienteNombre||'Cliente'],
    ['Estado',_naCreditStatusLabel(credit)],
    ['Monto original',fmt(credit.monto)],
    ['Total abonado',fmt(credit.pagado)],
    ['Saldo pendiente',fmt(pending)],
    ['\u00daltimo abono',latestPayment?fmt(latestPayment.monto):'Sin pagos']
  ].forEach(([label,value])=>{
    const box=_naSecAppend(summary,'div','credit-detail-box');
    _naSecAppend(box,'span','',label);
    _naSecAppend(box,'strong','',value);
  });

  const meta=_naSecAppend(container,'div','credit-pay-meta');

  [
    ['Cr\u00e9dito',credit.desc||'Cr\u00e9dito'],
    ['Compra / registro',`${createdDate} \u00b7 ${createdTime}`],
    ['Vencimiento',credit.vence||'No registrado'],
    ['\u00daltimo pago',latestPayment?`${fmt(latestPayment.monto)} \u00b7 ${latestMoment.date} \u00b7 ${latestMoment.time}`:'Sin pagos registrados'],
    ['Cantidad de pagos',String(payments.length)],
    ['Cajero de origen',`${credit.cajeroNombre||credit.cajero||'Cajero'}${credit.cajeroId?` \u00b7 ${credit.cajeroId}`:''}`],
    ['Venta vinculada',credit.ventaId||'Cr\u00e9dito manual']
  ].forEach(([label,value])=>{
    const chip=_naSecAppend(meta,'div','credit-pay-chip');
    _naSecAppend(chip,'span','',label);
    _naSecAppend(chip,'strong','',value);
  });

  const productSection=_naSecAppend(container,'div','credit-detail-section');
  _naSecAppend(productSection,'h4','','\u{1F6D2} Productos o conceptos financiados');

  items.forEach(item=>{
    _naSecCreditDetailItem(
      productSection,
      item,
      Math.min(item.subtotal,_naNumber(paidMap.get(item.itemKey)))
    );
  });

  const paymentSection=_naSecAppend(container,'div','credit-detail-section');
  _naSecAppend(paymentSection,'h4','',`\u{1F4B5} Historial completo de pagos (${payments.length})`);

  if(!payments.length){
    _naSecAppend(
      paymentSection,
      'div',
      'credit-status-note',
      'Todav\u00eda no se registraron pagos para este cr\u00e9dito.'
    );
  }

  payments.forEach((payment,index)=>{
    const moment=paymentMoment(payment);
    const paymentNumber=payments.length-index;

    const card=_naSecAppend(paymentSection,'div','credit-payment-card');
    const head=_naSecAppend(card,'div','credit-payment-head');
    const copy=_naSecAppend(head,'div');

    _naSecAppend(
      copy,
      'strong',
      '',
      `Pago ${paymentNumber}${index===0?' \u00b7 \u00daLTIMO PAGO':''}`
    );

    _naSecAppend(
      copy,
      'div',
      'credit-payment-sub',
      `${payment.diaSemana||''} ${moment.date} \u00b7 ${moment.time} \u00b7 ${payment.horarioPago||''}`.trim()
    );

    _naSecAppend(head,'span','',fmt(payment.monto));

    _naSecAppend(
      card,
      'div',
      'credit-payment-sub',
      `M\u00e9todo: ${_NA_CREDIT_METHOD_LABELS[payment.metodo]||payment.metodo||'No registrado'}`
    );

    if(payment.operacion){
      _naSecAppend(
        card,
        'div',
        'credit-payment-sub',
        `N.\u00b0 de operaci\u00f3n: ${payment.operacion}`
      );
    }

    _naSecAppend(
      card,
      'div',
      'credit-payment-sub',
      `Cajero: ${payment.cajeroNombre||payment.cajero||'Cajero'}${payment.cajeroId?` \u00b7 ${payment.cajeroId}`:''}`
    );

    _naSecAppend(
      card,
      'div',
      'credit-payment-sub',
      `Saldo antes: ${fmt(payment.saldoAnterior)} \u2192 Saldo despu\u00e9s: ${fmt(payment.saldoActual)}`
    );

    // FIX03: el pago original permanece visible; marcado como revertido y enlazado a su reversión.
    if(payment.status==='REVERTED'){
      _naSecAppend(
        card,
        'div',
        'credit-payment-sub credit-payment-reversed',
        payment.canonical
          ? `\u21a9\ufe0f ANULADO${payment.reversalFecha?` el ${String(payment.reversalFecha).split('-').reverse().join('/')}${payment.reversalHora?` ${payment.reversalHora}`:''}`:''} \u00b7 no suma al saldo${payment.reversalReason?` \u00b7 Motivo: ${payment.reversalReason}`:''}`
          : `\u21a9\ufe0f REVERTIDO${payment.reversalId?` \u00b7 Reversi\u00f3n ${payment.reversalId}`:''}${payment.reversalReason?` \u00b7 Motivo: ${payment.reversalReason}`:''}`
      ).style.cssText='color:var(--red);font-weight:800';
    }else if(!credit.anulado&&!(payment.canonical&&!payment.canonicalLive)){
      // CANON: only LIVE payments (canonical events) can be annulled; imported history cannot.
      const revert=_naSecCreditAction('btn-cr',payment.canonical?'\u21a9\ufe0f Anular abono':'\u21a9\ufe0f Revertir pago','revert-payment',credit.id);
      revert.dataset.paymentId=String(payment.pagoId||payment.id||'');
      revert.style.cssText='background:#fef2f2;color:var(--red);margin-top:8px';
      card.appendChild(revert);
    }

    if(Array.isArray(payment.desgloseProductos)&&payment.desgloseProductos.length){
      const allocation=_naSecAppend(card,'div','credit-payment-allocation');

      payment.desgloseProductos.forEach(item=>{
        const row=_naSecAppend(allocation,'div');
        _naSecAppend(row,'span','',item.nombre||'Concepto');
        _naSecAppend(row,'strong','',fmt(item.monto));
      });
    }
  });

  if(!credit.anulado&&credit.status!=='cancelado'&&pending>0){
    const actions=_naSecAppend(container,'div','mbtns');
    actions.style.marginTop='12px';

    const pay=_naSecCreditAction(
      'mbtn mbtn-ok green',
      '\u{1F4B5} Registrar nuevo pago',
      'detail-pay',
      credit.id
    );

    actions.appendChild(pay);
  }

  document.getElementById('mCreditoDetalle')?.classList.add('open');
  document.querySelector('#mCreditoDetalle .modal')?.scrollTo(0,0);
};document.getElementById('creditoDetalleContent')?.addEventListener('click',event=>{
  const control=event.target.closest('[data-na-credit-action="detail-pay"]');
  if(!control)return;
  cerrarModal('mCreditoDetalle');
  abrirPago(control.dataset.creditId);
});
document.getElementById('creditoDetalleContent')?.addEventListener('click',event=>{
  const control=event.target.closest('[data-na-credit-action="revert-payment"]');
  if(!control)return;
  revertirPagoCredito(control.dataset.creditId,control.dataset.paymentId);
});
