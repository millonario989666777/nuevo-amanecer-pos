
// NUEVO FASE 7 — evaluación y línea de crédito basada en compras, ganancia real y puntualidad.
const _NA_CREDIT_POLICY_DEFAULTS={enabled:true,minPurchases:1000,minProfit:400,initialLine:5,punctualRate:10,lateRate:5};
let _naCreditEvaluationClientId=null,_naManualCreditClientId=null;

function _naCreditPolicy(){
  const raw=appConfig?.creditPolicy||{},cfg={..._NA_CREDIT_POLICY_DEFAULTS,...raw};
  cfg.enabled=cfg.enabled!==false;
  cfg.minPurchases=Math.max(0,Math.min(100000,_naNumber(cfg.minPurchases,1000)));
  cfg.minProfit=Math.max(0,Math.min(100000,_naNumber(cfg.minProfit,400)));
  cfg.initialLine=Math.max(0,Math.min(100000,_naNumber(cfg.initialLine,5)));
  cfg.punctualRate=Math.max(0,Math.min(100,_naNumber(cfg.punctualRate,10)));
  cfg.lateRate=Math.max(0,Math.min(100,_naNumber(cfg.lateRate,5)));
  appConfig.creditPolicy=cfg;return cfg;
}
function _naClientSales(clientId){const key=String(clientId);return (Array.isArray(ventas)?ventas:[]).filter(v=>!v.anulada&&String(v.clienteId??'')===key);}
function _naSaleItemProfit(item){const qty=Math.max(0,_naNumber(item?.qty??item?.cantidad)),units=Math.max(1,_naInt(item?.unitsPerQty,1)),revenue=Math.max(0,_naNumber(item?.subtotal,_naNumber(item?.precio??item?.precioUnitario)*qty));let unitCost=Number(item?.costo);if(!Number.isFinite(unitCost)){const prod=productos.find(p=>String(p.id)===String(item?.productoId??item?.id));unitCost=Math.max(0,_naNumber(prod?.costo));}return revenue-Math.max(0,unitCost)*qty*units;}
function _naSaleCreditRecord(sale){return (Array.isArray(creditos)?creditos:[]).find(cr=>String(cr.id)===String(sale?.creditId))||(Array.isArray(creditos)?creditos:[]).find(cr=>String(cr.ventaId)===String(sale?.id))||null;}
function _naSaleRealizationFactor(sale){const method=String(sale?.metodo||sale?.metodoPago||'').toLowerCase();if(method!=='credito'&&!sale?.creditId)return 1;const cr=_naSaleCreditRecord(sale);if(!cr)return 0;const amount=Math.max(0,_naNumber(cr.monto));return amount>0?Math.max(0,Math.min(1,_naNumber(cr.pagado)/amount)):0;}
function _naCreditCompletionDate(cr){  let cumulative=0;const amount=Math.max(0,_naNumber(cr?.monto)),payments=(Array.isArray(cr?.pagos)?cr.pagos:[]).filter(pay=>pay?.status!=='REVERTED').slice().sort((a,b)=>new Date(a.timestamp||`${a.fecha||''}T${a.hora24||a.hora||'00:00:00'}`)-new Date(b.timestamp||`${b.fecha||''}T${b.hora24||b.hora||'00:00:00'}`));for(const pay of payments){cumulative+=Math.max(0,_naNumber(pay.monto??pay.montoPagado));if(cumulative+0.001>=amount){const d=new Date(pay.timestamp||`${pay.fecha||''}T${pay.hora24||pay.hora||'23:59:59'}`);if(Number.isFinite(d.getTime()))return d;}}const fallback=new Date(cr?.updatedAt||'');return Number.isFinite(fallback.getTime())&&_naCreditOutstanding(cr)<=.001?fallback:null;}
function _naCreditHistoryMetrics(clientId){
  const list=(Array.isArray(creditos)?creditos:[]).filter(cr=>String(cr.cliId??cr.clienteId)===String(clientId)&&!cr.anulado&&cr.status!=='anulado');let punctual=0,late=0,unknown=0,completed=0,partial=0,overdueActive=0,debt=0;
  for(const cr of list){_naSyncCreditStatus(cr);const pending=_naCreditOutstanding(cr);debt+=pending;if(pending<=.001){completed++;const completedAt=_naCreditCompletionDate(cr),due=cr.vence?new Date(`${String(cr.vence).slice(0,10)}T23:59:59`):null;if(completedAt&&due&&Number.isFinite(due.getTime())){if(completedAt<=due)punctual++;else late++;}else unknown++;}else{if(_naNumber(cr.pagado)>0)partial++;const d=diasHasta(cr.vence);if(d!==null&&d<0){late++;overdueActive++;}}}
  let behavior='sin_historial';if(punctual||late){if(late===0&&punctual>0)behavior='puntual';else if(late>punctual)behavior='impuntual';else behavior='irregular';}else if(partial>0)behavior='en_proceso';
  return{total:list.length,punctual,late,unknown,completed,partial,overdueActive,debt:_naRoundMoney(debt),behavior};
}
function _naCreditBehaviorLabel(value){return({puntual:'Puntual',impuntual:'Impuntual',irregular:'Irregular',en_proceso:'En proceso',sin_historial:'Sin historial'})[value]||'Sin historial';}
function _naEvaluateClientCredit(clientId){
  const client=clientes.find(c=>String(c.id)===String(clientId)),cfg=_naCreditPolicy();if(!client)return{exists:false,enabled:cfg.enabled,eligible:false,assignedLine:0,available:0};
  const sales=_naClientSales(client.id);let purchases=0,grossProfit=0,realizedProfit=0,itemCount=0;
  for(const sale of sales){const total=Math.max(0,_naNumber(typeof totalV==='function'?totalV(sale):sale.total));purchases+=total;const profit=(Array.isArray(sale.items)?sale.items:[]).reduce((sum,item)=>sum+_naSaleItemProfit(item),0);grossProfit+=profit;realizedProfit+=profit*_naSaleRealizationFactor(sale);itemCount+=(Array.isArray(sale.items)?sale.items:[]).reduce((sum,item)=>sum+Math.max(0,_naNumber(item.qty??item.cantidad)),0);}
  purchases=_naRoundMoney(purchases);grossProfit=_naRoundMoney(grossProfit);realizedProfit=_naRoundMoney(realizedProfit);const history=_naCreditHistoryMetrics(client.id),byPurchases=purchases+0.001>=cfg.minPurchases,byProfit=realizedProfit+0.001>=cfg.minProfit,autoEligible=byPurchases||byProfit;
  let autoLine=0,rate=0;if(autoEligible&&realizedProfit>0){if(history.completed===0&&history.late===0){autoLine=Math.min(cfg.initialLine,realizedProfit);}else{rate=history.behavior==='puntual'?cfg.punctualRate:cfg.lateRate;autoLine=realizedProfit*rate/100;const minimum=Math.min(cfg.initialLine,realizedProfit);autoLine=Math.max(minimum,autoLine);autoLine=Math.min(autoLine,realizedProfit);}}
  autoLine=_naRoundMoney(autoLine);const manualActive=client.lineaCreditoManualActiva===true,manualLine=_naRoundMoney(client.lineaCreditoManual),assignedLine=manualActive?manualLine:autoLine,eligible=cfg.enabled&&(manualActive?assignedLine>0:autoEligible&&assignedLine>0),available=cfg.enabled?_naRoundMoney(Math.max(0,assignedLine-history.debt)):0;
  let score=0;score+=Math.min(30,cfg.minPurchases>0?purchases/cfg.minPurchases*30:30);score+=Math.min(30,cfg.minProfit>0?realizedProfit/cfg.minProfit*30:30);score+=Math.min(15,sales.length*3);if(history.behavior==='puntual')score+=25;else if(history.behavior==='irregular')score+=12;else if(history.behavior==='en_proceso')score+=8;else if(history.behavior==='sin_historial')score+=5;score=Math.max(0,Math.min(100,Math.round(score)));
  const criterion=manualActive?'manual':byPurchases&&byProfit?'compras_y_ganancia':byPurchases?'compras':byProfit?'ganancia':'no_cumple',source=manualActive?'manual':'automatica',manualAboveProfit=manualActive&&manualLine>realizedProfit+0.001;
  return{exists:true,client,cfg,enabled:cfg.enabled,sales,purchases,grossProfit,realizedProfit,transactions:sales.length,itemCount,averageTicket:sales.length?_naRoundMoney(purchases/sales.length):0,history,byPurchases,byProfit,autoEligible,eligible,automaticLine:autoLine,manualActive,manualLine,assignedLine:_naRoundMoney(assignedLine),available,criterion,source,score,rate,manualAboveProfit};
}
calcularScoreCredito=function(clienteId){const e=_naEvaluateClientCredit(clienteId);return{score:e.score||0,lineaMaxima:e.assignedLine||0,lineaDisponible:e.available||0,elegible:!!e.eligible,gananciaReal:e.realizedProfit||0,deudaActual:e.history?.debt||0,fuente:e.source||'automatica'};}
function _naCreditBadge(e){if(!e.enabled)return'<span class="credit-policy-badge off">CRÉDITOS DESACTIVADOS</span>';if(e.manualActive)return`<span class="credit-policy-badge manual">LÍNEA MANUAL${e.manualAboveProfit?' · EXCEPCIÓN':''}</span>`;if(e.eligible)return'<span class="credit-policy-badge ok">APTO PARA CRÉDITO</span>';if(e.autoEligible)return'<span class="credit-policy-badge warn">SIN GANANCIA DISPONIBLE</span>';return'<span class="credit-policy-badge bad">AÚN NO CALIFICA</span>';}
function _naCreditRequirementText(e){if(e.manualActive)return'Línea manual activa';if(e.byPurchases&&e.byProfit)return'Cumple por compras acumuladas y ganancia real';if(e.byPurchases)return'Cumple por compras acumuladas';if(e.byProfit)return'Cumple por ganancia real';return`Requiere ${fmt(Math.max(0,e.cfg.minPurchases-e.purchases))} adicionales en compras o ${fmt(Math.max(0,e.cfg.minProfit-e.realizedProfit))} de ganancia real`;}
function _naCreditInlineHtml(e){return`<div class="credit-eval-inline"><div class="cei-main"><div class="cei-title">📊 Evaluación de crédito ${_naCreditBadge(e)}</div><div class="cei-sub">${_naCreditRequirementText(e)} · Conducta: ${_naCreditBehaviorLabel(e.history.behavior)}</div></div><div class="cei-value"><strong>${fmt(e.available)}</strong><span>DISPONIBLE DE ${fmt(e.assignedLine)}</span></div></div>`;}
function _naCreditEvaluationDetailHtml(e){
  const manualInfo=e.manualActive?`<div class="credit-eval-note">Línea manual activa${e.client.lineaCreditoManualAt?' · actualizada '+_naEsc(new Date(e.client.lineaCreditoManualAt).toLocaleString('es-PE')):''}.</div>`:'';
  return`<div class="credit-evaluation-hero"><div class="ceh-top"><div><h3>${_naEsc(e.client.nombre)}</h3><p>${e.client.dni?'DNI/RUC '+_naEsc(e.client.dni)+' · ':''}Score ${e.score}/100 · ${_naCreditBehaviorLabel(e.history.behavior)}</p><div style="margin-top:8px">${_naCreditBadge(e)}</div></div><div class="ceh-line"><strong>${fmt(e.available)}</strong><span>DISPONIBLE · LÍNEA ${fmt(e.assignedLine)}</span></div></div></div><div class="credit-eval-grid"><div class="credit-eval-card"><span>Compras acumuladas</span><strong>${fmt(e.purchases)}</strong><small>${e.transactions} venta${e.transactions===1?'':'s'} · ticket promedio ${fmt(e.averageTicket)}</small></div><div class="credit-eval-card"><span>Ganancia real cobrada</span><strong>${fmt(e.realizedProfit)}</strong><small>Ganancia histórica estimada: ${fmt(e.grossProfit)}</small></div><div class="credit-eval-card"><span>Deuda activa</span><strong>${fmt(e.history.debt)}</strong><small>${e.history.total} crédito${e.history.total===1?'':'s'} registrado${e.history.total===1?'':'s'}</small></div><div class="credit-eval-card"><span>Comportamiento</span><strong>${_naCreditBehaviorLabel(e.history.behavior)}</strong><small>${e.history.punctual} puntual · ${e.history.late} tardío/vencido · ${e.history.partial} parcial</small></div></div><div class="credit-requirements"><div class="credit-req-row"><span>Compras mínimas: ${fmt(e.cfg.minPurchases)}</span><strong class="${e.byPurchases?'done':'pending'}">${e.byPurchases?'✓ Cumple':'Pendiente '+fmt(Math.max(0,e.cfg.minPurchases-e.purchases))}</strong></div><div class="credit-req-row"><span>Ganancia real mínima: ${fmt(e.cfg.minProfit)}</span><strong class="${e.byProfit?'done':'pending'}">${e.byProfit?'✓ Cumple':'Pendiente '+fmt(Math.max(0,e.cfg.minProfit-e.realizedProfit))}</strong></div><div class="credit-req-row"><span>Regla de acceso</span><strong class="${e.autoEligible?'done':'pending'}">Compras O ganancia</strong></div><div class="credit-req-row"><span>Línea automática</span><strong>${fmt(e.automaticLine)}</strong></div></div>${manualInfo}<div class="credit-eval-note">La línea automática nunca supera la ganancia real cobrada. La deuda vigente se descuenta para calcular el monto disponible. Puedes asignar una línea manual directamente; el cambio se registra automáticamente.</div><div class="mbtns" style="margin-top:13px;flex-wrap:wrap"><button class="mbtn mbtn-cancel" onclick="cerrarModal('mEvaluacionCredito')">Cerrar</button><button class="mbtn mbtn-ok purple" onclick="abrirLineaCreditoManual('${_naEsc(String(e.client.id))}')">💳 Ajustar línea de crédito</button>${e.enabled&&e.eligible&&e.available>0?`<button class="mbtn mbtn-ok green" onclick="cerrarModal('mEvaluacionCredito');abrirCred('${_naEsc(String(e.client.id))}')">➕ Nuevo crédito</button>`:''}</div>`;
}
function abrirEvaluacionCredito(clientId){const e=_naEvaluateClientCredit(clientId);if(!e.exists){toast('No se encontró el cliente','error');return;}_naCreditEvaluationClientId=e.client.id;const box=document.getElementById('evaluacionCreditoContent');if(box)box.innerHTML=_naCreditEvaluationDetailHtml(e);document.getElementById('mEvaluacionCredito')?.classList.add('open');document.querySelector('#mEvaluacionCredito .modal')?.scrollTo(0,0);}
function abrirLineaCreditoManual(clientId){
  const e=_naEvaluateClientCredit(clientId);
  if(!e.exists){toast('No se encontró el cliente','error');return;}
  _naManualCreditClientId=e.client.id;
  document.getElementById('lineaManualMonto').value=String(e.manualActive?e.manualLine:e.automaticLine);
  const summary=document.getElementById('lineaManualResumen');
  if(summary)summary.innerHTML=`<div class="cms-head"><div><div class="cms-title">${_naEsc(e.client.nombre)}</div><div class="cms-sub">Automática ${fmt(e.automaticLine)} · Ganancia real ${fmt(e.realizedProfit)} · Deuda ${fmt(e.history.debt)}</div></div>${_naCreditBadge(e)}</div>`;
  const autoBtn=document.getElementById('btnLineaAutomatica');
  if(autoBtn)autoBtn.style.display=e.manualActive?'inline-flex':'none';
  actualizarAdvertenciaLineaManual();
  const reasonInput=_naEnsureManualLineReasonField();if(reasonInput)reasonInput.value='';
  cerrarModal('mEvaluacionCredito');
  document.getElementById('mLineaCreditoManual')?.classList.add('open');
  setTimeout(()=>document.getElementById('lineaManualMonto')?.focus(),60);
}
function actualizarAdvertenciaLineaManual(){const e=_naEvaluateClientCredit(_naManualCreditClientId),amount=Math.max(0,_naNumber(document.getElementById('lineaManualMonto')?.value)),box=document.getElementById('lineaManualAdvertencia');if(!box||!e.exists)return;const aboveProfit=amount>e.realizedProfit+.001,belowDebt=amount+0.001<e.history.debt;box.className=`credit-manual-warning ${!aboveProfit&&!belowDebt?'safe':''}`;box.textContent=belowDebt?`La línea es menor que la deuda activa (${fmt(e.history.debt)}). El cliente no tendrá crédito disponible hasta reducir su deuda.`:aboveProfit?`Aviso de riesgo: ${fmt(amount)} supera la ganancia real cobrada de ${fmt(e.realizedProfit)}. Se aplicará como línea manual.`:`La línea dejará disponible ${fmt(Math.max(0,amount-e.history.debt))} después de descontar la deuda activa.`;}
function _naCanonicalCreditPolicyAuthority(){const canonical=globalThis.NuevoAmanecerCanonical;if(!canonical||typeof canonical.enabled!=='function')return false;try{return canonical.enabled()===true;}catch(_){return false;}}
// P1-5: a manual credit line is an owner decision: free-text reason (8-500 chars, same
// rule as the CANON policy ledger) and the master PIN when one is configured.
// The field is injected by JS so the shared LAB/CANON modal markup stays identical.
function _naEnsureManualLineReasonField(){
  let input=document.getElementById('lineaManualMotivo');if(input)return input;
  const anchor=document.getElementById('lineaManualAdvertencia');if(!anchor||!anchor.parentNode)return null;
  const group=document.createElement('div');group.className='fg';
  const label=document.createElement('div');label.className='fl';label.textContent='Motivo del cambio ';
  const req=document.createElement('span');req.className='req';req.textContent='*';label.appendChild(req);
  input=document.createElement('textarea');input.id='lineaManualMotivo';input.className='fi';input.rows=2;input.maxLength=500;
  input.placeholder='Ej.: cliente puntual, compra grande acordada con el dueño';
  group.append(label,input);anchor.parentNode.insertBefore(group,anchor.nextSibling);return input;
}
function _naManualLineReason(){return String(document.getElementById('lineaManualMotivo')?.value||'').replace(/[\x00-\x1f\x7f]+/g,' ').replace(/\s+/g,' ').trim();}
function _naAuthorizeManualLine(clientName){
  if(typeof _naSecurity==='undefined'||!_naSecurity?.pinEnabled)return true;
  return typeof _naVerifyPin==='function'?_naVerifyPin(`Cambiar línea de crédito de ${clientName}`):false;
}
async function guardarLineaCreditoManual(){
  const e=_naEvaluateClientCredit(_naManualCreditClientId);
  if(!e.exists)return;
  const amount=Math.max(0,_naNumber(document.getElementById('lineaManualMonto')?.value));
  if(amount>1e6){toast('La línea manual máxima permitida es S/ 1,000,000','error');return;}
  _naEnsureManualLineReasonField();
  const reason=_naManualLineReason();
  if(reason.length<8||reason.length>500){toast('Escribe el motivo del cambio (mínimo 8 caracteres)','error');document.getElementById('lineaManualMotivo')?.focus?.();return;}
  if(!_naAuthorizeManualLine(e.client.nombre))return;
  const canonicalPolicyBridge=globalThis.NuevoAmanecerCanonicalCustomerCreditPolicyBridge;
  if(_naCanonicalCreditPolicyAuthority()){
    if(!canonicalPolicyBridge||typeof canonicalPolicyBridge.saveManual!=='function'){toast('No se guardó la línea: integración CANON no disponible','error');return;}
    const canonicalCashier=_naCashierSnapshot(cajEstado?.cajeroId||appConfig.activeCashierId);
    return await canonicalPolicyBridge.saveManual({
      customer_id:String(e.client.id),
      manual_limit_cents:Math.round(amount*100),
      reason,
      administrator_id:canonicalCashier.id||null,
      administrator_name:canonicalCashier.nombre||'Propietario'
    });
  }
  const before=_naClone(e.client),cashier=_naCashierSnapshot(cajEstado?.cajeroId||appConfig.activeCashierId),now=new Date();
  e.client.lineaCreditoManualActiva=true;
  e.client.lineaCreditoManual=_naRoundMoney(amount);
  e.client.lineaCreditoManualMotivo=reason;
  e.client.lineaCreditoManualAt=now.toISOString();
  e.client.lineaCreditoManualPor=cashier.nombre||'Propietario';
  e.client.lineaCreditoManualPorId=cashier.id||'';
  _naAudit('Línea de crédito manual',`${e.client.nombre}: ${fmt(before.lineaCreditoManual||0)} → ${fmt(amount)} · ${reason}`);
  const result=await saveAllData();
  if(!_naWasPersisted(result)){
    Object.keys(e.client).forEach(key=>delete e.client[key]);
    Object.assign(e.client,before);
    cliRender();
    toast('No se guardó la línea manual porque la persistencia no fue verificada','error');
    return;
  }
  cerrarModal('mLineaCreditoManual');
  cliRender();
  toast(`Línea manual guardada: ${fmt(amount)}`,'success');
  abrirEvaluacionCredito(e.client.id);
}
async function restaurarLineaCreditoAutomatica(){
  const e=_naEvaluateClientCredit(_naManualCreditClientId);
  if(!e.exists||!e.manualActive)return;
  const typed=_naManualLineReason(),reason=typed.length>=8&&typed.length<=500?typed:'Restauración automática del propietario';
  if(!_naAuthorizeManualLine(e.client.nombre))return;
  const canonicalPolicyBridge=globalThis.NuevoAmanecerCanonicalCustomerCreditPolicyBridge;
  if(_naCanonicalCreditPolicyAuthority()){
    if(!canonicalPolicyBridge||typeof canonicalPolicyBridge.restoreAutomatic!=='function'){toast('No se restauró la línea: integración CANON no disponible','error');return;}
    const canonicalCashier=_naCashierSnapshot(cajEstado?.cajeroId||appConfig.activeCashierId);
    return await canonicalPolicyBridge.restoreAutomatic({
      customer_id:String(e.client.id),
      reason,
      administrator_id:canonicalCashier.id||null,
      administrator_name:canonicalCashier.nombre||'Propietario'
    });
  }
  const before=_naClone(e.client);
  delete e.client.lineaCreditoManualActiva;
  delete e.client.lineaCreditoManual;
  delete e.client.lineaCreditoManualMotivo;
  delete e.client.lineaCreditoManualAt;
  delete e.client.lineaCreditoManualPor;
  delete e.client.lineaCreditoManualPorId;
  _naAudit('Línea automática restaurada',`${e.client.nombre} · ${reason}`);
  const result=await saveAllData();
  if(!_naWasPersisted(result)){
    Object.keys(e.client).forEach(key=>delete e.client[key]);
    Object.assign(e.client,before);
    toast('No se pudo restaurar el cálculo automático','error');
    return;
  }
  cerrarModal('mLineaCreditoManual');
  cliRender();
  toast('Se restauró la línea automática','success');
  abrirEvaluacionCredito(e.client.id);
}
function _naCreditModalSummaryHtml(e){const blocked=!e.eligible||e.available<=0;return`<div class="credit-modal-summary ${blocked?'is-blocked':e.manualActive?'is-manual':''}" id="creditEligibilityBox"><div class="cms-head"><div><div class="cms-title">${_naCreditBadge(e)}</div><div class="cms-sub">${_naCreditRequirementText(e)}</div></div><button type="button" class="btn-credit-eval" onclick="cerrarModal('mCred');abrirEvaluacionCredito('${_naEsc(String(e.client.id))}')">Ver evaluación</button></div><div class="cms-grid"><div class="cms-cell"><span>Línea asignada</span><strong>${fmt(e.assignedLine)}</strong></div><div class="cms-cell"><span>Deuda activa</span><strong>${fmt(e.history.debt)}</strong></div><div class="cms-cell"><span>Disponible</span><strong>${fmt(e.available)}</strong></div></div></div>`;}
abrirCred=function(cliId){if(isModuleLocked('clientes')){toast('Clientes y créditos están protegidos','error');return;}const e=_naEvaluateClientCredit(cliId);if(!e.exists){toast('No se encontró el cliente','error');return;}if(!e.enabled){toast('La creación de créditos está desactivada en Configuración','error');abrirEvaluacionCredito(e.client.id);return;}if(!e.eligible||e.available<=0){toast(e.autoEligible?'El cliente no tiene línea disponible':'El cliente todavía no cumple los requisitos de crédito','error');abrirEvaluacionCredito(e.client.id);return;}cliCredId=e.client.id;document.getElementById('mCredAv').style.background=colorFor(e.client.color);document.getElementById('mCredAv').textContent=initials(e.client.nombre);document.getElementById('mCredNom').innerHTML=`${_naEsc(e.client.nombre)}<br><small style="color:var(--slate);font-size:11px">Score ${e.score} · Disponible ${fmt(e.available)}</small>`;const old=document.getElementById('creditEligibilityBox');old?.remove();const info=document.createElement('div');info.innerHTML=_naCreditModalSummaryHtml(e);document.getElementById('mCredNom').closest('div[style*="background"]')?.insertAdjacentElement('afterend',info.firstElementChild);['crDesc','crMonto','crVence'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});const amount=document.getElementById('crMonto');if(amount){amount.max=String(e.available.toFixed(2));amount.placeholder=`Máximo ${e.available.toFixed(2)}`;}const btn=document.querySelector('#mCred .mbtn-ok');if(btn)btn.disabled=false;document.getElementById('mCred').classList.add('open');}
guardarCred=async function(){
  if(isModuleLocked('clientes')){toast('El sistema está en modo solo lectura','error');return;}
  const btnOk=document.querySelector('#mCred .mbtn-ok'),btnText=btnOk?.textContent||'Guardar';
  if(btnOk?.disabled)return;
  if(btnOk){btnOk.disabled=true;btnOk.textContent='Procesando…';}
  try{
  const client=clientes.find(c=>String(c.id)===String(cliCredId)),e=_naEvaluateClientCredit(cliCredId),desc=_naClean(document.getElementById('crDesc')?.value),amount=Math.max(0,_naNumber(document.getElementById('crMonto')?.value)),due=document.getElementById('crVence')?.value;if(!client||!desc||amount<=0||!due){toast('Completa los campos obligatorios','error');return;}if(!e.enabled){toast('La creación de créditos está desactivada','error');return;}if(!e.eligible||e.available<=0){toast('El cliente no tiene línea de crédito disponible','error');abrirEvaluacionCredito(client.id);return;}if(amount>e.available+.001){toast(`El crédito supera la línea disponible de ${fmt(e.available)}`,'error');return;}
  const backup=_naClone(creditos),now=new Date(),cashier=_naCashierSnapshot(cajEstado?.cajeroId||cajEstado?.cajero||appConfig.activeCashierId),id=Date.now(),record=_naNormalizeCreditRecord({id,cliId:client.id,clienteId:client.id,clienteNombre:client.nombre,clienteDni:client.dni||'',tipo:document.getElementById('crTipo').value,desc,monto:amount,pagado:0,saldo:amount,vence:due,status:diasHasta(due)<0?'vencido':'vigente',fecha:obtenerHoy(),hora:nowT(),hora24:_naTime24(now),timestamp:now.toISOString(),ventaId:null,anulado:false,pagos:[],items:[{itemKey:'concepto:0',productoId:null,nombre:desc,cantidad:1,precioUnitario:amount,subtotal:amount,modo:'concepto'}],cajero:cashier.nombre,cajeroNombre:cashier.nombre,cajeroId:cashier.id,lineaCreditoAsignada:e.assignedLine,lineaCreditoDisponibleAntes:e.available,gananciaClienteAlCrear:e.realizedProfit,deudaClienteAntes:e.history.debt,scoreCreditoAlCrear:e.score,fuenteLineaCredito:e.source,criterioCredito:e.criterion,excepcionManualCredito:e.manualActive},creditos.length);creditos.push(record);const result=await saveAllData();if(!_naWasPersisted(result)){creditos=backup;cliRender();toast('No se registró el crédito porque no existe guardado permanente verificado','error');return;}cerrarModal('mCred');_naAudit('Crédito registrado con línea evaluada',`${client.nombre} · ${fmt(amount)} de ${fmt(e.available)} disponible`);cliRender();toast(`Crédito registrado · Disponible restante ${fmt(e.available-amount)}`,'success');globalThis.NAReceiptShare?.onCredit(record);
  }finally{if(btnOk){btnOk.disabled=false;btnOk.textContent=btnText;}}
}
const _naF7BasePaymentState=_naPaymentState;
_naPaymentState=function(){if(posPayM!=='credito')return _naF7BasePaymentState();const total=cart.reduce((sum,item)=>sum+_naNumber(item.precio)*_naNumber(item.qty),0),clientId=document.getElementById('mCreditoCliente')?.value,due=document.getElementById('mCreditoVence')?.value,cfg=_naCreditPolicy();if(!cfg.enabled)return{valid:false,message:'Las ventas a crédito están desactivadas en Configuración.',tone:'error'};if(!clientId)return{valid:false,message:'Selecciona el cliente del crédito.',tone:'error'};if(!due)return{valid:false,message:'Selecciona la fecha de vencimiento.',tone:'error'};const e=_naEvaluateClientCredit(clientId);if(!e.eligible)return{valid:false,message:e.autoEligible?'El cliente no tiene línea de crédito asignada.':'El cliente aún no cumple S/ 1,000 en compras o S/ 400 de ganancia real.',tone:'error'};if(total>e.available+.001)return{valid:false,message:`Línea insuficiente: disponible ${fmt(e.available)} para una venta de ${fmt(total)}.`,tone:'error'};return{valid:true,message:`Crédito autorizado: ${fmt(total)} de ${fmt(e.available)} disponible.`,tone:'ok'};};
function _naSyncPaymentCustomerVisibility(){const sale=document.getElementById('mVentaCliente'),credit=document.getElementById('mCreditoCliente'),clientDetails=document.getElementById('mClienteDetails'),creditField=credit?.closest('.fg');if(clientDetails)clientDetails.hidden=!!sale?.value||posPayM==='credito';if(creditField)creditField.hidden=!!sale?.value;}
const _naF7BaseSelPM=selPM;
selPM=function(btn){if(btn?.dataset?.method==='credito'&&!_naCreditPolicy().enabled){toast('Las ventas a crédito están desactivadas','error');return;}const isDigitalGroup=btn?.dataset?.digitalGroup==='true',digitalMethod=btn?.dataset?.digitalMethod,channel=isDigitalGroup?(document.querySelector('.digital-channel-btn.active')?.dataset.digitalMethod||'yape'):digitalMethod;let result;if(channel){const proxy={dataset:{method:channel},classList:{add(){}}};result=_naF7BaseSelPM(proxy);document.querySelectorAll('.pm-btn').forEach(item=>item.classList.remove('active'));const digitalGroup=document.querySelector('.pm-btn[data-digital-group="true"]');digitalGroup?.classList.add('active');digitalGroup?.setAttribute('aria-pressed','true');document.querySelectorAll('.digital-channel-btn').forEach(item=>{const active=item.dataset.digitalMethod===channel;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});}else{result=_naF7BaseSelPM(btn);const digitalGroup=document.querySelector('.pm-btn[data-digital-group="true"]');digitalGroup?.setAttribute('aria-pressed','false');document.querySelectorAll('.digital-channel-btn').forEach(item=>{const active=item.dataset.digitalMethod==='yape';item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});}const method=posPayM,sale=document.getElementById('mVentaCliente'),credit=document.getElementById('mCreditoCliente');if(method==='credito'&&sale?.value&&credit&&credit.value!==sale.value){credit.value=sale.value;credit.dispatchEvent(new Event('change',{bubbles:true}));}_naSyncPaymentCustomerVisibility();return result;};
document.getElementById('mCreditoCliente')?.addEventListener('change',function(){if(posPayM==='credito'){const sale=document.getElementById('mVentaCliente'),credit=document.getElementById('mCreditoCliente');if(sale&&credit&&credit.value&&sale.value!==credit.value){sale.value=credit.value;sale.dispatchEvent(new Event('change',{bubbles:true}));}}_naSyncPaymentCustomerVisibility();});
document.getElementById('mVentaCliente')?.addEventListener('change',_naSyncPaymentCustomerVisibility);
const _naF7BaseAbrirCobro=abrirCobro;
abrirCobro=function(tipo){const result=_naF7BaseAbrirCobro(tipo),digitalGroup=document.querySelector('.pm-btn[data-digital-group="true"]'),credit=document.getElementById('mCreditoCliente');digitalGroup?.setAttribute('aria-pressed','false');if(credit){credit.value='';credit.dispatchEvent(new Event('change',{bubbles:true}));}document.querySelectorAll('.digital-channel-btn').forEach(item=>{const active=item.dataset.digitalMethod==='yape';item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});_naSyncClientPickerButtons();_naSyncPaymentCustomerVisibility();_naApplyCreditPolicyUI();return result;};
_naPopulateCreditClients=function(){const all=clientes.slice().sort((a,b)=>a.nombre.localeCompare(b.nombre)),sale=document.getElementById('mVentaCliente'),credit=document.getElementById('mCreditoCliente');if(sale)sale.innerHTML='<option value="">Sin cliente</option>'+all.map(c=>`<option value="${_naEsc(c.id)}">${_naEsc(c.nombre)}${c.dni?' · '+_naEsc(c.dni):''}</option>`).join('');if(credit)credit.innerHTML='<option value="">Selecciona un cliente</option>'+all.map(c=>{const e=_naEvaluateClientCredit(c.id),note=e.eligible?` · disponible ${fmt(e.available)}`:' · sin línea disponible';return`<option value="${_naEsc(c.id)}">${_naEsc(c.nombre)}${c.dni?' · '+_naEsc(c.dni):''}${note}</option>`;}).join('');_naInstallClientPickers();_naSyncClientPickerButtons();};
function _naApplyCreditPolicyUI(){const enabled=_naCreditPolicy().enabled,method=document.querySelector('.pm-btn[data-method="credito"]');if(method){method.hidden=!enabled;method.style.display=enabled?'':'none';}if(!enabled&&posPayM==='credito'){const cash=document.querySelector('.pm-btn[data-method="efectivo"]');if(cash)_naF7BaseSelPM(cash);}document.querySelectorAll('[data-na-new-credit]').forEach(btn=>btn.hidden=!enabled);}
function _naCreditPolicyConfigHtml(){const cfg=_naCreditPolicy(),evaluations=clientes.map(c=>_naEvaluateClientCredit(c.id)),eligible=evaluations.filter(e=>e.eligible).length,totalAvailable=evaluations.reduce((sum,e)=>sum+e.available,0);return`<div class="cfg-panel" style="grid-column:1/-1"><div class="cfg-panel-title">🤝 Evaluación y línea de crédito</div><div class="cfg-panel-sub">Calcula la capacidad usando compras acumuladas, ganancia real cobrada, deuda y puntualidad.</div><div class="cfg-setting-list">${_naCfgSetting('🧾','Activar nuevas ventas y créditos','Al desactivarlo se ocultan las nuevas ventas a crédito. Las deudas existentes siguen visibles para poder cobrarlas.',`<div class="cfg-toggle ${cfg.enabled?'active':''}" id="creditPolicyEnabled" onclick="creditPolicyToggleEnabled()"><div class="cfg-toggle-knob"></div></div>`)}</div><div class="credit-policy-config-grid"><div class="credit-policy-field"><label>Compras mínimas (S/)</label><input class="credit-policy-input" type="number" min="0" step="50" value="${cfg.minPurchases}" onchange="creditPolicySetNumber('minPurchases',this.value)"><small>Se evalúa con condición O.</small></div><div class="credit-policy-field"><label>Ganancia real mínima (S/)</label><input class="credit-policy-input" type="number" min="0" step="25" value="${cfg.minProfit}" onchange="creditPolicySetNumber('minProfit',this.value)"><small>Solo ganancia efectivamente cobrada.</small></div><div class="credit-policy-field"><label>Línea inicial (S/)</label><input class="credit-policy-input" type="number" min="0" step="0.50" value="${cfg.initialLine}" onchange="creditPolicySetNumber('initialLine',this.value)"><small>Para el primer crédito autorizado.</small></div><div class="credit-policy-field"><label>% cliente puntual</label><input class="credit-policy-input" type="number" min="0" max="100" step="1" value="${cfg.punctualRate}" onchange="creditPolicySetNumber('punctualRate',this.value)"><small>Ejemplo: 10% de su ganancia real.</small></div><div class="credit-policy-field"><label>% cliente impuntual</label><input class="credit-policy-input" type="number" min="0" max="100" step="1" value="${cfg.lateRate}" onchange="creditPolicySetNumber('lateRate',this.value)"><small>Ejemplo: 5% de su ganancia real.</small></div><div class="credit-policy-field"><label>Estado actual</label><div class="credit-policy-input" style="display:flex;align-items:center;height:auto;min-height:40px">${eligible} aptos · ${fmt(totalAvailable)} disponible</div><small>La deuda activa ya está descontada.</small></div></div><div class="cfg-business-note" style="margin-top:13px">Regla automática: compras acumuladas ≥ ${fmt(cfg.minPurchases)} <b>O</b> ganancia real ≥ ${fmt(cfg.minProfit)}. La línea automática no supera la ganancia real. Las excepciones manuales requieren PIN, motivo y auditoría.</div></div>`;}
const _naF7BaseRenderCfgContent=renderCfgContent;
renderCfgContent=function(cat){_naF7BaseRenderCfgContent(cat);if(cat==='pos'){document.getElementById('cfgContent')?.insertAdjacentHTML('beforeend',_naCreditPolicyConfigHtml());}_naApplyCreditPolicyUI();};
async function creditPolicyToggleEnabled(){if(isModuleLocked('configuracion')){toast('Configuración general protegida','error');return;}if(!_naAuthorize('configuracion','Activar o desactivar créditos'))return;const before=_naClone(appConfig.creditPolicy||{});appConfig.creditPolicy={..._naCreditPolicy(),enabled:!_naCreditPolicy().enabled};_naApplyCreditPolicyUI();renderCfgContent('pos');const result=await saveAppState();if(!_naWasPersisted(result)){appConfig.creditPolicy=before;renderCfgContent('pos');toast('No se pudo guardar la configuración de créditos','error');return;}_naAudit('Sistema de créditos',appConfig.creditPolicy.enabled?'activado':'desactivado');toast(appConfig.creditPolicy.enabled?'Créditos activados':'Nuevos créditos desactivados','success');cliRender();}
async function creditPolicySetNumber(key,value){if(isModuleLocked('configuracion')){toast('Configuración general protegida','error');return;}if(!_naAuthorize('configuracion','Modificar reglas de crédito'))return;if(!['minPurchases','minProfit','initialLine','punctualRate','lateRate'].includes(key))return;const before=_naClone(appConfig.creditPolicy||{}),max=['punctualRate','lateRate'].includes(key)?100:100000,number=Math.max(0,Math.min(max,_naNumber(value)));appConfig.creditPolicy={..._naCreditPolicy(),[key]:number};renderCfgContent('pos');const result=await saveAppState();if(!_naWasPersisted(result)){appConfig.creditPolicy=before;renderCfgContent('pos');toast('No se pudo guardar la regla de crédito','error');return;}_naAudit('Regla de crédito',`${key}: ${number}`);cliRender();}
const _naF7BaseApplyConfigUI=_naApplyConfigUI;
_naApplyConfigUI=function(){const result=_naF7BaseApplyConfigUI();_naCreditPolicy();_naApplyCreditPolicyUI();return result;};
_baseCliRender=function(){
  const venc=clientes.filter(c=>statusCli(c)==='vencido').length,prox=clientes.filter(c=>statusCli(c)==='proximo').length,vig=clientes.filter(c=>statusCli(c)==='vigente').length;document.getElementById('cliB0').textContent=clientes.length;document.getElementById('cliB1').textContent=venc;document.getElementById('cliB2').textContent=prox;document.getElementById('cliB3').textContent=vig;const totD=clientes.reduce((a,c)=>a+deudaT(c),0);document.getElementById('cliS0').textContent=clientes.length;document.getElementById('cliS1').textContent=`S/${totD.toFixed(0)}`;document.getElementById('cliS2').textContent=venc;document.getElementById('cliS3').textContent=`S/${cobradoHoy.toFixed(2)}`;const s=sinTildes(document.getElementById('cliSearch').value.toLowerCase()),sort=document.getElementById('cliSort').value;let list=clientes.filter(c=>{const m=sinTildes(c.nombre.toLowerCase()).includes(s)||(c.dni||'').includes(s);if(cliTab==='vencidos')return m&&statusCli(c)==='vencido';if(cliTab==='proximos')return m&&statusCli(c)==='proximo';if(cliTab==='vigentes')return m&&statusCli(c)==='vigente';return m;});if(sort==='deuda')list.sort((a,b)=>deudaT(b)-deudaT(a));else list.sort((a,b)=>a.nombre.localeCompare(b.nombre));const wrap=document.getElementById('cliList');if(!list.length){wrap.innerHTML='<div class="empty-state"><div class="ei">👥</div><p>Sin clientes en esta vista</p></div>';return;}wrap.innerHTML=list.map(c=>{const deuda=deudaT(c),s2=statusCli(c),dcls=s2==='vencido'?'mal':s2==='proximo'?'parcial':'ok',scls=s2==='vencido'?'cs-m':s2==='proximo'?'cs-p':s2==='vigente'?'cs-v':'cs-c',slbl=s2==='vencido'?'VENCIDO':s2==='proximo'?'PRÓXIMO':s2==='vigente'?'VIGENTE':'AL DÍA',cardcls=s2==='vencido'?'vencido-c':s2==='proximo'?'proximo-c':'',crs=creditos.filter(x=>String(x.cliId)===String(c.id)),crHtml=crs.length?crs.map(cr=>_naCreditCardHtml(cr)).join(''):'<div style="text-align:center;color:var(--slate);font-size:12px;padding:14px 0;font-weight:700">Sin créditos</div>',e=_naEvaluateClientCredit(c.id),arg=JSON.stringify(String(c.id));return`<div class="client-card ${cardcls}" data-client-id="${_naEsc(c.id)}"><div class="client-header" onclick='toggleCliCard(${arg})'><div class="c-avatar" style="background:${colorFor(c.color)}">${_naEsc(initials(c.nombre))}</div><div class="c-info"><div class="c-name">${_naEsc(c.nombre)}</div><div class="c-meta">${c.dni?`📋 ${_naEsc(c.dni)}`:''} ${c.tel?`📱 ${_naEsc(c.tel)}`:''} ${crs.length?`· ${crs.length} crédito(s)`:''}</div></div><div class="c-right"><div class="c-deuda ${dcls}">${fmt(deuda)}</div><span class="c-status ${scls}">${slbl}</span></div></div><div class="client-creds" id="cc-${_naEsc(c.id)}"><div class="creds-hdr"><span>Créditos registrados</span><div class="credit-header-actions"><button class="btn-credit-eval" onclick='abrirEvaluacionCredito(${arg})'>📊 Evaluar línea</button>${e.enabled?`<button class="btn-add-cr" data-na-new-credit onclick='abrirCred(${arg})'>+ Nuevo crédito</button>`:''}</div></div>${_naCreditInlineHtml(e)}${crHtml}</div></div>`;}).join('');
};

// MEJORA FASE 7: asegurar la política y la interfaz después de cargar datos antiguos.
document.addEventListener('DOMContentLoaded',()=>{_naCreditPolicy();setTimeout(()=>{_naApplyCreditPolicyUI();if(document.getElementById('pageClientes')?.classList.contains('active'))cliRender();},250);});
