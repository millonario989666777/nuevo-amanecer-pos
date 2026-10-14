
// Seguridad: los movimientos de caja restaurados o importados nunca se interpretan como HTML.
function _naSecCashButton(className,text,action){
  const button=_naSecElement('button',className,text);
  button.type='button';
  button.dataset.naCashAction=action;
  return button;
}
// CANON no guarda quién abrió la caja (canonical_cash_sessions no tiene cajero): no se muestra "Cajero:" vacío.
function _naSecCashCashierText(){const own=String(cajEstado?.cajeroNombre||cajEstado?.cajero||'').trim();if(own)return own;const sid=cajEstado?.sessionId||cajEstado?.session_id;const rec=sid&&window.NA_RECORD_CASHIER?window.NA_RECORD_CASHIER.get(['caja:'+sid]):null;if(rec&&rec.nombre)return rec.nombre;let opened='';try{const map=sid&&window.NuevoAmanecerCashHistory?.cashierMap?.();opened=String(map?.[String(sid)]?.nombre||'').trim();}catch(_){}return opened||'sin registrar';}
// Parte de una venta que quedó a crédito: no es dinero que entra a caja.
function _naSecCashCreditPart(movement){
  if(!movement||movement.tipo!=='ing')return 0;
  const credit=_naNumber(movement.credito);
  if(credit>0)return credit;
  return movement.metodo==='credito'?_naNumber(movement.monto):0;
}
function _naSecCashSalesCredit(){
  try{return Number(_naCajaMovsSesion().reduce((sum,movement)=>sum+(_naIsSaleIncomeMove(movement)?_naSecCashCreditPart(movement):0),0).toFixed(2));}catch(_){return 0;}
}
function _naSecCashBanner(container,totals){
  const wrap=_naSecAppend(container,'div','caj-banner-wrap');
  if(cajEstado.cerrada){
    const banner=_naSecAppend(wrap,'div','banner-cerrada-cj');
    _naSecAppend(banner,'div','bn-title',`🔒 Cerrada — ${cajEstado.horaCierre||''}`);
    _naSecAppend(banner,'div','bn-monto',fmt(totals.ef));
    _naSecAppend(banner,'div','bn-sub',`Cajero: ${_naSecCashCashierText()}`);
    if(cajEstado.contado!=null)_naSecAppend(banner,'div','',`Contado: ${fmt(cajEstado.contado)} · Diferencia: ${fmt(Number(cajEstado.diferencia||0))}`).style.cssText='font-size:11px;opacity:.8';
    banner.appendChild(_naSecCashButton('btn-abrir-cj','🔓 Nueva apertura','open'));
    return;
  }
  const banner=_naSecAppend(wrap,'div','banner-abierta'),copy=_naSecAppend(banner,'div');
  _naSecAppend(copy,'div','bn-title',`🟢 Abierta desde ${cajEstado.hora||''}`);
  _naSecAppend(copy,'div','bn-monto',fmt(totals.ef));
  _naSecAppend(copy,'div','bn-sub',`Fondo: ${fmt(cajEstado.fondo)} · Cajero: ${_naSecCashCashierText()}`);
  banner.appendChild(_naSecCashButton('btn-cerrar-cj','🔒 Cerrar','close'));
}
function _naSecCashMovement(parent,movement){
  const allowedTypes=new Set(['ing','egr','cob','gas']),type=allowedTypes.has(movement.tipo)?movement.tipo:'egr',positive=type==='ing'||type==='cob';
  const credit=_naSecCashCreditPart(movement),amount=_naNumber(movement.monto),creditOnly=credit>0&&credit>=amount-0.005;
  const row=_naSecAppend(parent,'div',`mov-item ${type}${creditOnly?' credito':''}`);
  _naSecAppend(row,'div',`mov-ic ${type}${creditOnly?' credito':''}`,creditOnly?'📝':(CAJ_IC[type]||'📋'));
  const info=_naSecAppend(row,'div');
  info.style.cssText='flex:1;min-width:0';
  _naSecAppend(info,'div','mov-desc',String(movement.desc||'Movimiento').replace(/\s*@+\s*$/,'')||'Movimiento');
  _naSecAppend(info,'div','mov-meta',`${movement.cat||''} · ${creditOnly?'a crédito (no entra a caja)':(movement.metodo||'')}${credit>0&&!creditOnly?` · ${fmt(credit)} a crédito`:''} · ${movement.hora24||movement.hora||''} · ${movement.cajeroNombre||movement.cajero||''}`);
  if(creditOnly)_naSecAppend(row,'div','mov-amt credito',`${fmt(movement.monto)} crédito`);
  else _naSecAppend(row,'div',`mov-amt ${positive?'pos':'neg'}`,`${positive?'+':'-'}${fmt(positive&&credit>0?amount-credit:movement.monto)}`);
}
function _naSecCashMovementList(container,movements,title){
  const wrap=_naSecAppend(container,'div','cj-mov-wrap');
  _naSecAppend(wrap,'div','mov-section-title',title);
  const list=_naSecAppend(wrap,'div','mov-list');
  movements.forEach(movement=>_naSecCashMovement(list,movement));
}
function _naSecCashStats(container,totals){
  const grid=_naSecAppend(container,'div','cj-stats-grid'),salesCredit=_naSecCashSalesCredit();
  [
    ['green','📈','Ventas',totals.ven],
    ['red','📉','Egresos',totals.egr],
    ['teal','🤝','Cobros',totals.cob],
    ['amber','🧾','Gastos',totals.gas]
  ].forEach(([tone,icon,label,value])=>{
    const card=_naSecAppend(grid,'div',`cjsg ${tone}`);
    _naSecAppend(card,'div','cjsg-icon',icon);
    const copy=_naSecAppend(card,'div');
    _naSecAppend(copy,'div','cjsg-lbl',label);
    _naSecAppend(copy,'div','cjsg-val',fmt(value));
    if(label==='Ventas'&&salesCredit>0)_naSecAppend(copy,'div','cjsg-sub',`Contado ${fmt(Math.max(0,value-salesCredit))} · Crédito ${fmt(salesCredit)}`);
  });
}
function _naSecCashActions(container){
  const actions=_naSecAppend(container,'div','cj-acciones');
  if(cajEstado.cerrada){actions.style.opacity='.4';actions.style.pointerEvents='none';}
  [['ing','💵','Ingreso'],['egr','💸','Egreso'],['cob','🤝','Cobro'],['gas','🧾','Gasto']].forEach(([type,icon,label])=>{
    const button=_naSecCashButton(`btn-cjac ${type}`,'',`move-${type}`);
    _naSecAppend(button,'span','bci',icon);
    button.appendChild(document.createTextNode(label));
    actions.appendChild(button);
  });
}
function _naSecCashClosing(container,totals){
  const outer=_naSecAppend(container,'div');
  outer.style.cssText='padding:12px 13px';
  const summary=_naSecAppend(outer,'div');
  summary.style.cssText='background:var(--white);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:9px';
  {const h=_naSecAppend(summary,'div','','Resumen del turno');h.style.cssText='font-size:12px;font-weight:800;color:var(--dark);margin-bottom:11px';h.insertAdjacentHTML('afterbegin','<i class="na-ic na-ic-bars" aria-hidden="true"></i> ');}
  [
    ['Fondo inicial',fmt(cajEstado.fondo),'var(--dark)'],
    ['Ventas del día',`+${fmt(totals.ven)}`,'#15803d'],
    ...(_naSecCashSalesCredit()>0?[['  · de ellas a crédito (no entra a caja)',fmt(_naSecCashSalesCredit()),'#7c3aed']]:[]),
    ['Cobros crédito (efectivo)',`+${fmt(totals.cob)}`,'var(--teal)'],
    ['Gastos operativos',`-${fmt(totals.gas)}`,'var(--amber)'],
    ['Egresos / Retiros',`-${fmt(totals.ret)}`,'var(--red)']
  ].forEach(([label,value,color])=>{
    const row=_naSecAppend(summary,'div');
    row.style.cssText='display:flex;justify-content:space-between;font-size:13px;font-weight:700;padding:6px 0;border-bottom:1px solid var(--border);color:var(--slate)';
    _naSecAppend(row,'span','',label);
    const amount=_naSecAppend(row,'span','',value);
    amount.style.cssText=`color:${color};font-weight:800`;
  });
  const expected=_naSecAppend(summary,'div');
  expected.style.cssText='display:flex;justify-content:space-between;font-size:16px;font-weight:800;padding:9px 0 0';
  _naSecAppend(expected,'span','','Efectivo esperado');
  _naSecAppend(expected,'span','',fmt(totals.ef)).style.color='var(--teal)';
  if(cajEstado.cerrada){
    const closed=_naSecAppend(outer,'div');
    closed.style.cssText='background:var(--green-light);border:1px solid #bbf7d0;border-radius:11px;padding:13px;text-align:center';
    _naSecAppend(closed,'div','','✅').style.cssText='font-size:20px;margin-bottom:5px';
    _naSecAppend(closed,'div','','Caja cerrada correctamente').style.cssText='font-size:14px;font-weight:800;color:#15803d';
    _naSecAppend(closed,'div','',`Hora: ${cajEstado.horaCierre||''} · Cajero: ${_naSecCashCashierText()}`).style.cssText='font-size:11px;color:var(--slate);margin-top:3px';
  }else{
    const close=_naSecCashButton('','Proceder al cierre de caja','close');close.insertAdjacentHTML('afterbegin','<i class="na-ic na-ic-lock" aria-hidden="true"></i> ');
    close.style.cssText="width:100%;background:var(--dark);color:var(--white);border:none;border-radius:11px;padding:14px;font-size:14px;font-weight:800;cursor:pointer;font-family:'Nunito',sans-serif";
    outer.appendChild(close);
  }
}
cajRender=function(){
  if(isModuleLocked('caja')&&!(globalThis.NuevoAmanecerCanonical&&typeof NuevoAmanecerCanonical.enabled==='function'&&NuevoAmanecerCanonical.enabled()))toast('Módulo de caja protegido','error');
  if(cajEstado.abierta&&!cajEstado.cerrada&&cajEstado.fechaApertura&&cajEstado.fechaApertura!==obtenerHoy())_naWarnOtherDayTill();
  const container=document.getElementById('cajContent');
  if(!container)return;
  const movements=_naCajaMovsSesion(),allMovements=cajMovs;
  let totals;
  cajMovs=movements;
  try{totals=cajTotales();}finally{cajMovs=allMovements;}
  if(document.getElementById('mCierre')?.classList.contains('open'))_naRefreshClosingCashTotals(totals);
  container.replaceChildren();
  if(!cajEstado.abierta&&!cajEstado.cerrada){
    const outer=_naSecAppend(container,'div');
    outer.style.padding='13px';
    const banner=_naSecAppend(outer,'div','banner-cerrada-cj'),copy=_naSecAppend(banner,'div');
    _naSecAppend(copy,'div','bn-title','🔒 Caja sin abrir');
    _naSecAppend(copy,'div','','Inicia el turno para registrar').style.cssText='font-size:12px;opacity:.7;margin-top:3px';
    banner.appendChild(_naSecCashButton('btn-abrir-cj','🔓 Abrir caja','open'));
    updateDashboard();
    return;
  }
  if(cajTab==='resumen'){
    _naSecCashBanner(container,totals);
    _naSecCashStats(container,totals);
    _naSecCashActions(container);
    _naSecCashMovementList(container,[...movements].reverse().slice(0,5),'Últimos movimientos');
  }else if(cajTab==='movimientos'){
    _naSecCashMovementList(container,[...movements].reverse(),`${movements.length} movimientos`);
  }else _naSecCashClosing(container,totals);
  updateDashboard();
};
document.getElementById('cajContent')?.addEventListener('click',event=>{
  const control=event.target.closest('[data-na-cash-action]');
  if(!control)return;
  const action=control.dataset.naCashAction;
  if(action==='open')abrirModalApertura();
  else if(action==='close')prepCierre();
  else if(action.startsWith('move-'))abrirMovCaja(action.slice(5));
});
