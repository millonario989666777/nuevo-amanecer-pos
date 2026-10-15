
// ===== GASTOS =====
let gastos=[];
let gasTab='hoy';const CAT_ICONS={'Servicios':'<i class="na-ic na-ic-bulb" aria-hidden="true"></i>','Proveedor':'<i class="na-ic na-ic-box" aria-hidden="true"></i>','Operativo':'<i class="na-ic na-ic-store" aria-hidden="true"></i>','Personal':'<i class="na-ic na-ic-user" aria-hidden="true"></i>','Transporte':'<i class="na-ic na-ic-car" aria-hidden="true"></i>','Otro':'<i class="na-ic na-ic-clip" aria-hidden="true"></i>'};
function gasSetTab(btn,tab){document.querySelectorAll('#pageGastos .tab').forEach(t=>t.classList.remove('active'));btn.classList.add('active');gasTab=tab;gasRender();}
function gasGetList(){const s=sinTildes(document.getElementById('gasSearch').value.toLowerCase()),cat=document.getElementById('gasCatFilter').value;const LUNES=getLunesSemana();return gastos.filter(g=>{let mt=true;if(gasTab==='hoy')mt=g.fecha===obtenerHoy();else if(gasTab==='semana')mt=g.fecha>=LUNES&&g.fecha<=obtenerHoy();const ms=!s||sinTildes(g.desc.toLowerCase()).includes(s)||sinTildes(g.cat.toLowerCase()).includes(s);return !g.voided&&mt&&ms&&(!cat||g.cat===cat);});}
function gasRender(){const list=gasGetList();const total=list.reduce((a,g)=>a+g.monto,0),mayor=list.length?Math.max(...list.map(g=>g.monto)):0;const catCnt={};list.forEach(g=>{catCnt[g.cat]=(catCnt[g.cat]||0)+g.monto;});const topCat=Object.entries(catCnt).sort((a,b)=>b[1]-a[1])[0];document.getElementById('gasS0').textContent=fmt(total);document.getElementById('gasS1').textContent=list.length;document.getElementById('gasS2').textContent=fmt(mayor);document.getElementById('gasS3').textContent=topCat?topCat[0].substring(0,8):'—';const wrap=document.getElementById('gasContent');if(!list.length){wrap.innerHTML='<div class="empty-state"><div class="ei"><i class="na-ic na-ic-receipt" aria-hidden="true"></i></div><p>Sin gastos en este período</p></div>';return;}const byDate={};list.forEach(g=>{if(!byDate[g.fecha])byDate[g.fecha]=[];byDate[g.fecha].push(g);});wrap.innerHTML=Object.entries(byDate).sort((a,b)=>b[0].localeCompare(a[0])).map(([fecha,gs])=>{const subtotal=gs.reduce((a,g)=>a+g.monto,0);return`<div style="font-size:10px;font-weight:800;color:var(--slate);text-transform:uppercase;letter-spacing:.06em;margin:6px 0 5px;display:flex;justify-content:space-between"><span>${fecha===obtenerHoy()?'Hoy':fecha}</span><span style="color:var(--red)">${fmt(subtotal)}</span></div>${gs.map(g=>`<div class="gasto-card egreso"><div class="gasto-icon">${CAT_ICONS[g.cat]||'<i class="na-ic na-ic-clip" aria-hidden="true"></i>'}</div><div class="gasto-info"><div class="gasto-desc">${g.desc}</div><div class="gasto-meta"><span class="gasto-cat">${g.cat}</span><span><i class="na-ic na-ic-card" aria-hidden="true"></i> ${g.metodo}</span>${g.nota?`<span>${g.nota}</span>`:''}</div></div><div class="gasto-monto">${fmt(g.monto)}</div></div>`).join('')}`;}).join('');}
function abrirModalGasto(){['gasDesc','gasNota'].forEach(id=>document.getElementById(id).value='');document.getElementById('gasMonto').value='';document.getElementById('gasFecha').value=obtenerHoy();document.getElementById('mGasto').classList.add('open');}


// ===== CONFIG & CONTROL MAESTRO =====




function cfgUpdateStats(){const totalProds=document.getElementById('cfgTotalProds');if(totalProds)totalProds.textContent=productos.length;const totalClis=document.getElementById('cfgTotalClis');if(totalClis)totalClis.textContent=clientes.length;const totalVentas=document.getElementById('cfgTotalVentas');if(totalVentas)totalVentas.textContent=ventas.filter(v=>v.fecha===obtenerHoy()&&!v.anulada).length;}
function setToggle(id,active){const el=document.getElementById(id);if(el)el.classList.toggle('active',active);}
const LOCK_KEYS={master:'na_master_lock',readOnly:'na_readonly',modules:{productos:'na_lock_productos',ventas:'na_lock_ventas',caja:'na_lock_caja',clientes:'na_lock_clientes',gastos:'na_lock_gastos',importacion:'na_lock_importacion',configuracion:'na_lock_configuracion'}};
const SECURITY_KEY='na_security_v26';
const SECURITY_DEFAULTS={
  pinEnabled:false,pinHash:'',autoLockMinutes:0,
  requirePin:{locks:true,anularVenta:true,descuentos:false,reset:true,cerrarCaja:false,importar:true,configuracion:false},
  rules:{allowDiscounts:true,maxDiscount:20,allowGenericProducts:true,allowExpiredLots:false,auditEnabled:true},
  logs:[]
};
function _naSecMerge(raw={}){return{...SECURITY_DEFAULTS,...raw,requirePin:{...SECURITY_DEFAULTS.requirePin,...(raw.requirePin||{})},rules:{...SECURITY_DEFAULTS.rules,...(raw.rules||{})},logs:Array.isArray(raw.logs)?raw.logs.slice(0,500):[]};}
function _naLoadSecurity(){try{return _naSecMerge(JSON.parse(localStorage.getItem(SECURITY_KEY)||'{}'));}catch(error){return _naSecMerge();}}
let _naSecurity=_naLoadSecurity(),_naAutoLockTimer=null;
function _naSecHash(value){let h=2166136261;const s=`NA24:${String(value||'')}`;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return(`00000000${(h>>>0).toString(16)}`).slice(-8);}
function _naSaveSecurity(persist=true){try{localStorage.setItem(SECURITY_KEY,JSON.stringify(_naSecurity));}catch(error){console.warn('[Persistencia] No se pudo escribir la configuración de seguridad local:',error?.name||'Error');}if(persist&&typeof saveAppState==='function')return saveAppState();return null;}
function _naAudit(action,detail=''){if(!_naSecurity.rules.auditEnabled)return;_naSecurity.logs.unshift({id:Date.now(),at:new Date().toISOString(),action:String(action),detail:String(detail||'')});_naSecurity.logs=_naSecurity.logs.slice(0,100);_naSaveSecurity(false);}
function _naPinValid(pin){return _naSecurity.pinEnabled&&_naSecurity.pinHash&&_naSecHash(pin)===_naSecurity.pinHash;}
function _naVerifyPin(reason='Confirmar acción'){if(!_naSecurity.pinEnabled||!_naSecurity.pinHash)return true;const pin=prompt(`🔐 ${reason}\nIngresa el PIN maestro:`);if(pin===null)return false;if(!_naPinValid(pin)){toast('PIN incorrecto','error');_naAudit('PIN incorrecto',reason);return false;}return true;}
function _naAuthorize(action,reason){if(!_naSecurity.pinEnabled)return true;if(!_naSecurity.requirePin[action])return true;return _naVerifyPin(reason);}
function _naGetSecurityPath(path){return String(path).split('.').reduce((obj,key)=>obj?.[key],_naSecurity);}
function _naSetSecurityPath(path,value){const parts=String(path).split('.');let obj=_naSecurity;while(parts.length>1){const k=parts.shift();if(!obj[k]||typeof obj[k]!=='object')obj[k]={};obj=obj[k];}obj[parts[0]]=value;}
function _naSecurityToggle(id,value,handler){return `<div class="cfg-toggle ${value?'active':''}" id="${id}" onclick="${handler}"><div class="cfg-toggle-knob"></div></div>`;}
function securitySetPin(){const first=prompt('Crea un PIN maestro de 4 a 8 números:');if(first===null)return false;if(!/^\d{4,8}$/.test(first)){toast('El PIN debe tener entre 4 y 8 números','error');return false;}const second=prompt('Repite el nuevo PIN:');if(second!==first){toast('Los PIN no coinciden','error');return false;}_naSecurity.pinHash=_naSecHash(first);_naSecurity.pinEnabled=true;sessionStorage.removeItem('na_security_locked');_naAudit('PIN maestro configurado');_naSaveSecurity();_naResetAutoLockTimer();renderCfgContent('control');toast('PIN maestro activado','success');return true;}
function securityChangePin(){if(_naSecurity.pinEnabled&&!_naVerifyPin('Cambiar PIN maestro'))return;securitySetPin();}
function securityTogglePin(){if(_naSecurity.pinEnabled){if(!_naVerifyPin('Desactivar protección con PIN'))return;_naSecurity.pinEnabled=false;_naSecurity.pinHash='';_naSecurity.autoLockMinutes=0;sessionStorage.removeItem('na_security_locked');_naAudit('Protección con PIN desactivada');_naSaveSecurity();_naHideSecurityLock();renderCfgContent('control');toast('Protección con PIN desactivada');}else securitySetPin();}
function securityToggleOption(path){if(_naSecurity.pinEnabled&&_naSecurity.requirePin.locks&&!_naVerifyPin('Modificar control maestro'))return;const next=!Boolean(_naGetSecurityPath(path));_naSetSecurityPath(path,next);_naAudit('Ajuste de seguridad',`${path}: ${next?'activado':'desactivado'}`);_naSaveSecurity();if(path==='rules.allowGenericProducts')_naUpdateFreeSaleUI();renderCfgContent('control');}
function securitySetAutoLock(value){if(_naSecurity.pinEnabled&&_naSecurity.requirePin.locks&&!_naVerifyPin('Cambiar bloqueo automático')){renderCfgContent('control');return;}_naSecurity.autoLockMinutes=Math.max(0,Number(value)||0);_naAudit('Bloqueo automático',_naSecurity.autoLockMinutes?`${_naSecurity.autoLockMinutes} minutos`:'desactivado');_naSaveSecurity();_naResetAutoLockTimer();renderCfgContent('control');}
function securitySetMaxDiscount(value){let n=Math.max(0,Math.min(99,Number(value)||0));_naSecurity.rules.maxDiscount=n;_naAudit('Límite de descuento',`${n}%`);_naSaveSecurity();}
function securityIsLocked(){return sessionStorage.getItem('na_security_locked')==='true';}
function _naShowSecurityLock(){const el=document.getElementById('securityLockScreen');if(!el)return;el.classList.add('open');document.body.classList.add('security-session-locked');setTimeout(()=>document.getElementById('securityUnlockPin')?.focus(),50);}
function _naHideSecurityLock(){document.getElementById('securityLockScreen')?.classList.remove('open');document.body.classList.remove('security-session-locked');const input=document.getElementById('securityUnlockPin');if(input)input.value='';}
function securityLockNow(auto=false){if(!_naSecurity.pinEnabled){toast('Primero configura un PIN maestro','error');return;}sessionStorage.setItem('na_security_locked','true');_naAudit(auto?'Bloqueo automático':'Bloqueo manual');_naSaveSecurity(false);_naShowSecurityLock();}
function securityUnlock(){const input=document.getElementById('securityUnlockPin'),pin=input?.value||'';if(!_naPinValid(pin)){if(input){input.value='';input.focus();}const msg=document.getElementById('securityUnlockMsg');if(msg)msg.textContent='PIN incorrecto. Inténtalo nuevamente.';_naAudit('Intento de desbloqueo fallido');return;}sessionStorage.removeItem('na_security_locked');const msg=document.getElementById('securityUnlockMsg');if(msg)msg.textContent='';_naAudit('Sesión desbloqueada');_naSaveSecurity(false);_naHideSecurityLock();_naResetAutoLockTimer();toast('Sistema desbloqueado','success');}
function _naResetAutoLockTimer(){clearTimeout(_naAutoLockTimer);if(!_naSecurity.pinEnabled||!_naSecurity.autoLockMinutes||securityIsLocked())return;_naAutoLockTimer=setTimeout(()=>securityLockNow(true),_naSecurity.autoLockMinutes*60000);}
function _naInitSecurity(){if(securityIsLocked()&&_naSecurity.pinEnabled)_naShowSecurityLock();else{sessionStorage.removeItem('na_security_locked');_naHideSecurityLock();}_naResetAutoLockTimer();['pointerdown','touchstart','keydown'].forEach(evt=>document.addEventListener(evt,()=>{if(!securityIsLocked())_naResetAutoLockTimer();},{passive:true,capture:true}));}
function securityClearLog(){if(!_naVerifyPin('Limpiar registro de seguridad'))return;if(!confirm('¿Borrar todo el registro de seguridad?'))return;_naSecurity.logs=[];_naSaveSecurity();renderCfgContent('control');toast('Registro de seguridad eliminado','success');}
function securityExportLog(){const data=JSON.stringify(_naSecurity.logs,null,2),blob=new Blob([data],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`seguridad_nuevo_amanecer_${obtenerHoy()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);_naAudit('Registro de seguridad exportado');toast('Registro descargado','success');}
function _naSecurityLogHtml(){if(!_naSecurity.logs.length)return '<div class="sec-empty">Sin eventos registrados todavía.</div>';return _naSecurity.logs.slice(0,8).map(item=>{const d=new Date(item.at),date=Number.isNaN(d.getTime())?item.at:d.toLocaleString('es-PE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});return `<div class="sec-log-row"><div class="sec-log-dot"></div><div class="sec-log-main"><strong>${_naEsc(item.action)}</strong><span>${_naEsc(item.detail||'Sin detalle')}</span></div><time>${_naEsc(date)}</time></div>`;}).join('');}

function loadMasterConfig(){const master=storage.getItem(LOCK_KEYS.master)==='true',readOnly=storage.getItem(LOCK_KEYS.readOnly)==='true';setToggle('cfgMasterLock',master);setToggle('cfgReadOnly',readOnly);for(let mod in LOCK_KEYS.modules){const locked=storage.getItem(LOCK_KEYS.modules[mod])==='true';setToggle(`cfgLock${mod.charAt(0).toUpperCase()+mod.slice(1)}`,locked);}}





async function resetAllData(){
  const backup=_naBuildSnapshot();
  productos=[];ventas=[];clientes=[];creditos=[];gastos=[];cajMovs=[];cashClosures=[];cobradoHoy=0;
  cajEstado={abierta:false,fondo:0,cajero:'',cajeroNombre:'',cajeroId:null,hora:'',hora24:'',fechaApertura:obtenerHoy(),cerrada:true,horaCierre:nowT(),horaCierre24:_naTime24(),sessionId:null};
  cart=[];
  const persistResult=await saveAllData();
  if(!_naWasPersisted(persistResult)){
    _naApplySnapshot(backup);await saveAllData();
    toast('No se pudo guardar el reinicio total de forma permanente','error');return;
  }
  _naMarkCatalogState({seeded:false,suppressed:true});
  posUpdateCart();invRender();cliRender();ventasRender();cajRender();gasRender();cfgUpdateStats();updateDashboard();
  for(const key of Object.values(LOCK_KEYS.modules))storage.removeItem(key);
  storage.removeItem('na_cart');
  toast('🚨 Todos los datos han sido eliminados','error');
}


// ===== CONFIG POR CATEGORÍAS =====
let currentCfgCategory=storage.getItem('na_cfg_category')||'negocio';



function filterCfgCategories(){const query=document.getElementById('cfgSearchCat').value.toLowerCase();document.querySelectorAll('.cfg-cat-btn').forEach(btn=>{const text=btn.textContent.toLowerCase();btn.classList.toggle('hidden',!text.includes(query));});}

// ===== DARK MODE =====
let isDark=false;
window.__naSetIsDark=function(value){isDark=!!value;};

// ===== NUEVO AMANECER v4.0 — CORRECCIONES Y MEJORAS =====
// FASE 7: evaluación y línea de crédito con ganancia real
const _naDefaults={
  igvActive:true,margenActive:true,stockAlertActive:true,printAuto:false,mayoristaActive:true,alertsEnabled:true,stockMin:5,
  business:{nombre:'Multiservicios Nuevo Amanecer',ruc:'',direccion:'Puerto Súngaro, Huánuco',telefono:'',cajero:'Frank'},
  appearance:{fontSize:'normal',accent:'#00bca4',accentDark:'#009e8a'},
  customCategories:[],
  // NUEVO FASE 5: registro local de cajeros con ID estable. Los permisos se ampliarán en Control Maestro.
  cashiers:[{id:'CAJ-001',nombre:'Frank',activo:true}],
  activeCashierId:'CAJ-001',
  scanner:{enabled:true,sound:true,minLength:4,maxIntervalMs:65},
  freeSale:{allowRegisteredNoStock:false,allowGenericSale:true,shortcut:'F2'},
  // NUEVO FASE 7: reglas de evaluación y línea de crédito.
  creditPolicy:{enabled:true,minPurchases:1000,minProfit:400,initialLine:5,punctualRate:10,lateRate:5},
  // NUEVO FASE 9: parámetros conservadores para sugerencias de reposición.
  purchaseSuggestion:{historyDays:90,coverageDays:30,safetyDays:7},
  ticket:{ancho:'80mm',customMm:60,fuente:"'Courier New',monospace",tamano:'11px',previewCustomPx:11,align:'center',infoAlign:'left',paymentAlign:'split',footerAlign:'center',layoutMode:'auto',pie:'¡GRACIAS POR SU COMPRA! | Su preferencia nos motiva. | ¡Vuelva pronto!',showLogo:true,showIGV:false,showNum:true,showOperation:true,showCurrency:true,showUnitPrice:true,showPayment:true,showReceived:true,showSep:true},
  printer:{mode:'system',baudRate:9600,autoCut:true}
};
const _naMerge=(base,extra)=>({...base,...(extra||{}),business:{...base.business,...(extra?.business||{})},appearance:{...base.appearance,...(extra?.appearance||{})},scanner:{...base.scanner,...(extra?.scanner||{})},freeSale:{...base.freeSale,...(extra?.freeSale||{})},creditPolicy:{...base.creditPolicy,...(extra?.creditPolicy||{})},purchaseSuggestion:{...base.purchaseSuggestion,...(extra?.purchaseSuggestion||{})},ticket:{...base.ticket,...(extra?.ticket||{})},printer:{...base.printer,...(extra?.printer||{})}});
appConfig=_naMerge(_naDefaults,appConfig);
const _naDatePlus=days=>{const d=new Date(obtenerHoy()+'T12:00:00');d.setDate(d.getDate()+days);const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${day}`;};
const _naUnitsPerQty=item=>Math.max(1,_naInt(item?.unitsPerQty,1));
const _naUnitsSold=item=>Math.max(0,_naNumber(item?.qty,0))*_naUnitsPerQty(item);
const _naLineKey=(id,mode='unidad')=>`${id}-${mode}`;
const _naSessionOpen=()=>!!(cajEstado?.abierta&&!cajEstado?.cerrada&&cajEstado?.fechaApertura===obtenerHoy());
const _naGetBusiness=()=>appConfig.business||_naDefaults.business;

// NUEVO FASE 5 — Registro local de cajeros y compatibilidad con datos anteriores.
function _naCashierIdNumber(value){const match=String(value||'').match(/(\d+)/);return match?Number(match[1]):0;}
function _naNextCashierId(){const max=(Array.isArray(appConfig.cashiers)?appConfig.cashiers:[]).reduce((n,c)=>Math.max(n,_naCashierIdNumber(c?.id)),0);return `CAJ-${String(max+1).padStart(3,'0')}`;}
function _naNormalizeCashier(raw,index=0){const nombre=_naClean(raw?.nombre||raw?.name||'');if(!nombre)return null;const fallback=`CAJ-${String(index+1).padStart(3,'0')}`,rawId=_naClean(raw?.id||fallback),safeId=rawId.replace(/[^A-Za-z0-9_-]/g,'').slice(0,40)||fallback;return{id:safeId,nombre:nombre.slice(0,100),activo:raw?.activo!==false,createdAt:raw?.createdAt||null,updatedAt:raw?.updatedAt||null};}
function _naEnsureCashierConfig(){
  const legacyName=_naClean(appConfig?.business?.cajero||'Frank')||'Frank',seen=new Set(),list=[];let nextNumber=1;
  for(const [index,raw] of (Array.isArray(appConfig.cashiers)?appConfig.cashiers:[]).entries()){
    const item=_naNormalizeCashier(raw,index);if(!item)continue;let id=item.id;
    nextNumber=Math.max(nextNumber,_naCashierIdNumber(id)+1);
    while(seen.has(id.toLowerCase()))id=`CAJ-${String(nextNumber++).padStart(3,'0')}`;
    seen.add(id.toLowerCase());list.push(raw&&typeof raw==='object'?Object.assign(raw,item,{id}):{...item,id});
  }
  if(!list.length)list.push({id:'CAJ-001',nombre:legacyName,activo:true,createdAt:null,updatedAt:null});
  if(list.length===1&&list[0].id==='CAJ-001'&&list[0].nombre==='Frank'&&legacyName!=='Frank')list[0].nombre=legacyName;
  // CORRECCIÓN FASE 5: conservar un cajero de una caja antigua aunque aún no estuviera en el registro local.
  const sessionName=_naClean(cajEstado?.cajeroNombre||cajEstado?.cajero||'');
  if(sessionName&&!list.some(c=>c.nombre.toLowerCase()===sessionName.toLowerCase())){let sessionId=`CAJ-${String(nextNumber++).padStart(3,'0')}`;while(seen.has(sessionId.toLowerCase()))sessionId=`CAJ-${String(nextNumber++).padStart(3,'0')}`;seen.add(sessionId.toLowerCase());list.push({id:sessionId,nombre:sessionName.slice(0,100),activo:true,createdAt:null,updatedAt:null});}
  const sessionCashier=sessionName?list.find(c=>c.nombre.toLowerCase()===sessionName.toLowerCase()):null;if(sessionCashier&&cajEstado){if(!cajEstado.cajeroId)cajEstado.cajeroId=sessionCashier.id;if(!cajEstado.cajeroNombre)cajEstado.cajeroNombre=sessionCashier.nombre;}
  let active=list.find(c=>String(c.id)===String(appConfig.activeCashierId)&&c.activo);
  if(!active)active=list.find(c=>c.activo&&c.nombre.toLowerCase()===legacyName.toLowerCase())||list.find(c=>c.activo);
  if(!active){list[0].activo=true;active=list[0];}
  appConfig.cashiers=list.slice(0,50);appConfig.activeCashierId=active.id;appConfig.business=appConfig.business||{};appConfig.business.cajero=active.nombre;
  return active;
}
function _naActiveCashiers(){_naEnsureCashierConfig();return appConfig.cashiers.filter(c=>c.activo);}
function _naFindCashier(ref){const key=String(ref??'').trim().toLowerCase(),list=Array.isArray(appConfig.cashiers)?appConfig.cashiers:[];return list.find(c=>String(c.id).toLowerCase()===key)||list.find(c=>String(c.nombre||'').toLowerCase()===key)||null;}
function _naGetActiveCashier(){const ensured=_naEnsureCashierConfig();return appConfig.cashiers.find(c=>String(c.id)===String(appConfig.activeCashierId)&&c.activo)||ensured;}
function _naCashierSnapshot(ref){const found=_naFindCashier(ref);if(found)return{id:found.id,nombre:found.nombre};const legacy=_naClean(ref||'');if(legacy)return{id:'',nombre:legacy.slice(0,100)};const active=_naGetActiveCashier();return{id:active.id,nombre:active.nombre};}
function _naPopulateCashierSelect(selectId='cajCajero',selectedRef=null){const select=document.getElementById(selectId);if(!select)return;const active=_naActiveCashiers(),selected=_naFindCashier(selectedRef)||_naFindCashier(cajEstado?.cajeroId)||_naGetActiveCashier();select.innerHTML=active.map(c=>`<option value="${_naEsc(c.id)}">${_naEsc(c.nombre)} · ${_naEsc(c.id)}</option>`).join('');if(selected&&active.some(c=>c.id===selected.id))select.value=selected.id;else if(active[0])select.value=active[0].id;}
function _naCashierOptionsHtml(){const active=_naActiveCashiers(),current=_naGetActiveCashier();return active.map(c=>`<option value="${_naEsc(c.id)}" ${c.id===current.id?'selected':''}>${_naEsc(c.nombre)} · ${_naEsc(c.id)}</option>`).join('');}
// Cajero del turno abierto: el de la caja o, si la caja vino del servidor sin cajero, quien la abrió en este aparato.
function _naEmployeeDevice(){const r=window.NA_ROLES;return !!(r&&typeof r.canConfigure==='function'&&!r.canConfigure());}
function _naOwnerOnlyBlocked(){if(!_naEmployeeDevice())return false;toast('Solo el dueño puede cambiar los cajeros.','error');return true;}
function _naOpenCashierId(){if(!cajEstado?.abierta||cajEstado?.cerrada)return '';if(cajEstado.cajeroId)return String(cajEstado.cajeroId);const sid=cajEstado.sessionId||cajEstado.session_id;const rec=sid&&window.NA_RECORD_CASHIER?window.NA_RECORD_CASHIER.get(['caja:'+sid]):null;return rec&&rec.id?String(rec.id):'';}
function _naCashierConfigHtml(){const current=_naGetActiveCashier(),openId=_naOpenCashierId();return `<div class="cashier-config-wrap"><div class="cfg-setting"><div class="cfg-setting-main"><div class="cfg-setting-icon">👤</div><div><div class="cfg-setting-title">Cajero activo por defecto</div><div class="cfg-setting-desc">Se usará al abrir una nueva caja. Una caja abierta conserva su propio cajero.</div></div></div><div class="cfg-setting-tail" style="width:min(100%,320px)"><select class="fs" id="cfgCajero" onchange="cashierSelectActive(this.value)">${_naCashierOptionsHtml()}</select></div></div><div class="cashier-add-row"><div><div class="fl">Agregar cajero local</div><input class="fi" id="cfgNewCashierName" maxlength="100" placeholder="Nombre completo"></div><button class="cfg-save-btn" type="button" onclick="cashierAddFromConfig()">➕ Agregar</button></div><div class="cashier-list">${appConfig.cashiers.map(c=>`<div class="cashier-row"><div class="cashier-main"><div class="cashier-avatar">${_naEsc(initials(c.nombre)||'C')}</div><div class="cashier-copy"><strong>${_naEsc(c.nombre)}${c.id===current.id?'<span class="cashier-status current">ACTIVO</span>':''}${c.activo?'':'<span class="cashier-status inactive">INACTIVO</span>'}</strong><small>${_naEsc(c.id)}${openId===String(c.id)?' · turno abierto':''}</small></div></div><div class="cashier-actions">${c.id!==current.id&&c.activo?`<button class="cashier-mini-btn primary" type="button" onclick="cashierSelectActive('${_naEsc(c.id)}')">Usar</button>`:''}<button class="cashier-mini-btn" type="button" onclick="cashierRenameFromConfig('${_naEsc(c.id)}')">Renombrar</button><button class="cashier-mini-btn ${c.activo?'danger':''}" type="button" ${openId===String(c.id)?'disabled title="No se puede desactivar durante un turno abierto"':''} onclick="cashierToggleFromConfig('${_naEsc(c.id)}')">${c.activo?'Desactivar':'Reactivar'}</button></div></div>`).join('')}</div><div class="cfg-business-note">Esta fase registra el nombre y el ID del cajero en ventas, caja, gastos y cobros. PIN y permisos individuales se implementarán en la ampliación del Control Maestro.</div></div>`;}
async function _naPersistCashierChange(before,successMessage){const result=await saveAppState();if(!_naWasPersisted(result)){appConfig.cashiers=before.cashiers;appConfig.activeCashierId=before.activeCashierId;appConfig.business=before.business;_naEnsureCashierConfig();renderCfgContent('negocio');toast('No se pudo guardar el cambio de cajero de forma permanente','error');return false;}_naApplyConfigUI();renderCfgContent('negocio');toast(successMessage,'success');return true;}
async function cashierSelectActive(id){if(_naOwnerOnlyBlocked())return;if(isModuleLocked('configuracion')){toast('Configuración protegida','error');renderCfgContent('negocio');return;}if(!_naAuthorize('configuracion','Cambiar cajero activo')){renderCfgContent('negocio');return;}const previous=_naGetActiveCashier(),previousId=appConfig.activeCashierId;_naCaptureVisibleConfig();const before={cashiers:_naClone(appConfig.cashiers),activeCashierId:previousId,business:{..._naClone(appConfig.business),cajero:previous.nombre}},cashier=_naFindCashier(id);if(!cashier||!cashier.activo){toast('Selecciona un cajero activo','error');renderCfgContent('negocio');return;}appConfig.activeCashierId=cashier.id;appConfig.business.cajero=cashier.nombre;{const sel=document.getElementById('cfgCajero');if(sel)sel.value=cashier.id;}_naAudit('Cajero activo cambiado',`${cashier.id} · ${cashier.nombre}`);await _naPersistCashierChange(before,`Cajero activo: ${cashier.nombre}`);}
async function cashierAddFromConfig(){if(_naOwnerOnlyBlocked())return;if(isModuleLocked('configuracion')){toast('Configuración protegida','error');return;}if(!_naAuthorize('configuracion','Agregar cajero'))return;_naCaptureVisibleConfig();const input=document.getElementById('cfgNewCashierName'),nombre=_naClean(input?.value||'').slice(0,100);if(nombre.length<2){toast('Ingresa un nombre válido','error');input?.focus();return;}if(appConfig.cashiers.some(c=>c.nombre.toLowerCase()===nombre.toLowerCase())){toast('Ya existe un cajero con ese nombre','error');return;}if(appConfig.cashiers.length>=50){toast('Se alcanzó el máximo de 50 cajeros locales','error');return;}const before={cashiers:_naClone(appConfig.cashiers),activeCashierId:appConfig.activeCashierId,business:_naClone(appConfig.business)},now=new Date().toISOString(),cashier={id:_naNextCashierId(),nombre,activo:true,createdAt:now,updatedAt:now};appConfig.cashiers.push(cashier);_naAudit('Cajero agregado',`${cashier.id} · ${cashier.nombre}`);await _naPersistCashierChange(before,`Cajero ${nombre} agregado`);}
async function cashierRenameFromConfig(id){if(_naOwnerOnlyBlocked())return;if(isModuleLocked('configuracion')){toast('Configuración protegida','error');return;}if(!_naAuthorize('configuracion','Renombrar cajero'))return;_naCaptureVisibleConfig();const cashier=_naFindCashier(id);if(!cashier)return;const nombre=_naClean(prompt('Nuevo nombre del cajero:',cashier.nombre)||'').slice(0,100);if(!nombre||nombre===cashier.nombre)return;if(appConfig.cashiers.some(c=>c.id!==cashier.id&&c.nombre.toLowerCase()===nombre.toLowerCase())){toast('Ya existe otro cajero con ese nombre','error');return;}const before={cashiers:_naClone(appConfig.cashiers),activeCashierId:appConfig.activeCashierId,business:_naClone(appConfig.business)},old=cashier.nombre;cashier.nombre=nombre;cashier.updatedAt=new Date().toISOString();if(appConfig.activeCashierId===cashier.id)appConfig.business.cajero=nombre;_naAudit('Cajero renombrado',`${cashier.id} · ${old} → ${nombre}`);await _naPersistCashierChange(before,`Cajero actualizado: ${nombre}`);}
async function cashierToggleFromConfig(id){if(_naOwnerOnlyBlocked())return;if(isModuleLocked('configuracion')){toast('Configuración protegida','error');return;}if(!_naAuthorize('configuracion','Cambiar estado del cajero'))return;_naCaptureVisibleConfig();const cashier=_naFindCashier(id);if(!cashier)return;if(_naOpenCashierId()&&_naOpenCashierId()===String(cashier.id)){toast('No se puede desactivar el cajero de una caja abierta','error');return;}if(cashier.activo&&_naActiveCashiers().length<=1){toast('Debe permanecer al menos un cajero activo','error');return;}const before={cashiers:_naClone(appConfig.cashiers),activeCashierId:appConfig.activeCashierId,business:_naClone(appConfig.business)};cashier.activo=!cashier.activo;cashier.updatedAt=new Date().toISOString();if(!cashier.activo&&appConfig.activeCashierId===cashier.id){const next=appConfig.cashiers.find(c=>c.activo);appConfig.activeCashierId=next.id;appConfig.business.cajero=next.nombre;}{const sel=document.getElementById('cfgCajero');if(sel)sel.value=appConfig.activeCashierId;} _naAudit(cashier.activo?'Cajero reactivado':'Cajero desactivado',`${cashier.id} · ${cashier.nombre}`);await _naPersistCashierChange(before,cashier.activo?`Cajero ${cashier.nombre} reactivado`:`Cajero ${cashier.nombre} desactivado`);}

// NUEVO FASE 5 — Metadatos normalizados y auditables de cada venta.
const _naTime24=(date=new Date())=>`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:${String(date.getSeconds()).padStart(2,'0')}`;
function _naParseTime24(value){const raw=String(value||'').trim(),m=raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);if(!m)return'';let hour=Math.min(23,Number(m[1]));const suffix=sinTildes(raw.toLowerCase()).replace(/\s/g,'');if(/p\.?m\.?/.test(suffix)&&hour<12)hour+=12;if(/a\.?m\.?/.test(suffix)&&hour===12)hour=0;return `${String(hour).padStart(2,'0')}:${m[2]}:${m[3]||'00'}`;}
function _naSaleType(items=[]){const modes=new Set((Array.isArray(items)?items:[]).map(i=>i?.ventaModo==='caja'||_naUnitsPerQty(i)>1?'mayorista':'minorista'));return modes.size>1?'mixta':modes.has('mayorista')?'mayorista':'minorista';}
function _naSaleState(v){return v?.anulada?'anulada':v?.metodo==='credito'||v?.metodoPago==='credito'?'credito':'completada';}
function _naSaleStateLabel(v){return({completada:'Completada',credito:'En crédito',anulada:'Anulada'})[_naSaleState(v)]||'Completada';}
function _naSaleTypeLabel(v){return({mayorista:'Mayorista',minorista:'Minorista',mixta:'Mixta'})[v?.tipoVenta||_naSaleType(v?.items)]||'Minorista';}
function _naSaleCashier(v){const found=_naFindCashier(v?.cajeroId||v?.cajeroNombre||v?.cajero);return{id:_naClean(v?.cajeroId||found?.id||''),nombre:_naClean(v?.cajeroNombre||v?.cajero||found?.nombre||'Cajero')||'Cajero'};}
function _naNormalizeSaleRecord(raw,index=0){const v={...(raw||{})},items=(Array.isArray(v.items)?v.items:[]).map(i=>{const qty=Math.max(0,_naNumber(i.qty??i.cantidad,1)),price=Math.max(0,_naNumber(i.precio??i.precioUnitario)),units=Math.max(1,_naInt(i.unitsPerQty,1));return{...i,productoId:i.productoId??i.id,id:i.id??i.productoId,name:_naClean(i.name||i.nombre||'Producto'),nombre:_naClean(i.nombre||i.name||'Producto'),qty,cantidad:qty,precio:price,precioUnitario:price,subtotal:Number((price*qty).toFixed(2)),costo:Math.max(0,_naNumber(i.costo)),incluyeIGV:i.incluyeIGV!==false,tipoImpuesto:_naTaxType(i.tipoImpuesto),unitsPerQty:units,modo:i.modo||i.ventaModo||(units>1?'mayorista':'minorista'),ventaModo:i.ventaModo||(units>1?'caja':'unidad')};}),calcTotal=Number(items.reduce((sum,i)=>sum+i.subtotal,0).toFixed(2)),calcSubtotal=Number(items.reduce((sum,i)=>sum+Math.max(i.precioUnitario,_naNumber(i._precioOriginal,i.precioUnitario))*i.cantidad,0).toFixed(2)),cashier=_naSaleCashier(v),timestamp=(()=>{const parsed=new Date(v.timestamp||'');return Number.isNaN(parsed.getTime())?null:parsed;})(),hora24=_naParseTime24(v.hora24)||(timestamp?_naTime24(timestamp):_naParseTime24(v.hora));return{...v,id:String(v.id||`V-${String(index+1).padStart(3,'0')}`),items,fecha:v.fecha||(timestamp?timestamp.toISOString().slice(0,10):obtenerHoy()),hora:v.hora||(timestamp?timestamp.toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):nowT()),hora24:hora24||'00:00:00',timestamp:v.timestamp||(v.fecha?`${v.fecha}T${hora24||'00:00:00'}`:new Date().toISOString()),cajero:cashier.nombre,cajeroId:cashier.id||null,cajeroNombre:cashier.nombre,total:calcTotal,subtotal:Math.max(calcTotal,_naNumber(v.subtotal,calcSubtotal)),descuentoTotal:Math.max(0,_naNumber(v.descuentoTotal,calcSubtotal-calcTotal)),metodo:v.metodo||v.metodoPago||'efectivo',metodoPago:v.metodoPago||v.metodo||'efectivo',estado:_naSaleState(v),tipoVenta:v.tipoVenta||_naSaleType(items),cantidadLineas:items.length,unidadesFisicas:items.reduce((sum,i)=>sum+_naUnitsSold(i),0),clienteId:v.clienteId??null,clienteNombre:_naClean(v.clienteNombre||'')||null};}
function _naSaleMatchesSearch(v,query){const q=sinTildes(String(query||'').toLowerCase());if(!q)return true;const fields=[v.id,v.operation,v.paymentRef,v.cajero,v.cajeroNombre,v.cajeroId,v.clienteNombre,v.estado,v.tipoVenta,...(v.items||[]).flatMap(i=>[i.name,i.nombre,i.sku,i.barcode])];return fields.some(value=>sinTildes(String(value||'').toLowerCase()).includes(q));}

_naEnsureCashierConfig();
const _naGetJSON=(key,fallback)=>{try{const raw=storage.getItem(key);if(!raw)return fallback;const parsed=JSON.parse(raw);return parsed??fallback;}catch(error){console.warn('Dato local dañado:',key,error);return fallback;}};
function _naCategoryText(value){return sinTildes(String(value||'').toLowerCase()).replace(/\s+/g,' ').trim();}
const _naBaseCategories=[
  {value:'abarrotes',label:'Abarrotes'},
  {value:'accesorios',label:'Accesorios'},
  {value:'bebidas',label:'Bebidas'},
  {value:'snacks',label:'Snacks'},
  {value:'helados',label:'Helados'},
  {value:'licores',label:'Licores'},
  {value:'limpieza',label:'Limpieza'},
  {value:'cuidado',label:'Cuidado personal'},
  {value:'bebe',label:'Bebés'},
  {value:'hogar',label:'Hogar y bazar'},
  {value:'tecnologia',label:'Tecnología'},
  {value:'libreria',label:'Librería'},
  {value:'servicios',label:'Servicios'}
];
function _naCategoryKey(value){return sinTildes(String(value||'').toLowerCase()).replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').trim();}
function _naCategoryTitle(value){return String(value||'').replace(/_/g,' ').replace(/\b\w/g,chr=>chr.toUpperCase()).trim()||'Sin categoría';}
function _naCustomCategories(){if(!Array.isArray(appConfig.customCategories))appConfig.customCategories=[];const seen=new Set(),out=[];for(const item of appConfig.customCategories){const label=_naClean(typeof item==='string'?item:(item?.label||item?.value||''));const key=_naCategoryKey(typeof item==='string'?item:(item?.value||label));if(!key||seen.has(key))continue;seen.add(key);out.push({value:key,label:label||_naCategoryTitle(key)});}appConfig.customCategories=out;return out;}
let _naCategoryRenderDepth=0,_naCategoryRenderCatalog=null,_naCategoryRenderLabels=null;
function _naWithCategoryCatalog(callback){_naCategoryRenderDepth++;try{return callback();}finally{if(--_naCategoryRenderDepth===0){_naCategoryRenderCatalog=null;_naCategoryRenderLabels=null;}}}
function _naAllCategories(){if(_naCategoryRenderCatalog)return _naCategoryRenderCatalog;const seen=new Set(),out=[];const add=(value,label)=>{const key=_naCategoryKey(value);if(!key||seen.has(key))return;seen.add(key);out.push({value:key,label:label||_naCategoryTitle(key)});};_naBaseCategories.forEach(cat=>add(cat.value,cat.label));_naCustomCategories().forEach(cat=>add(cat.value,cat.label));(Array.isArray(productos)?productos:[]).forEach(prod=>add(prod.cat,_naCategoryTitle(prod.cat)));if(_naCategoryRenderDepth){_naCategoryRenderCatalog=out;_naCategoryRenderLabels=new Map(out.map(cat=>[cat.value,cat.label]));}return out;}
function _naCategoryLabel(value){const key=_naCategoryKey(value);const cats=_naAllCategories(),label=_naCategoryRenderLabels?_naCategoryRenderLabels.get(key):cats.find(cat=>cat.value===key)?.label;return label||_naCategoryTitle(key||value);}
function renderCategorySelects(opts={}){const cats=_naAllCategories(),invSel=document.getElementById('invCat'),prodSel=document.getElementById('pCat');if(invSel){const current=opts.invValue!==undefined?opts.invValue:invSel.value;invSel.innerHTML='<option value="">Todas las categorías</option>'+cats.map(cat=>`<option value="${cat.value}">${_naEsc(cat.label)}</option>`).join('');if(current&&[...invSel.options].some(op=>op.value===current))invSel.value=current;else invSel.value='';}if(prodSel){const current=opts.prodValue!==undefined?opts.prodValue:(prodSel.value||'abarrotes');prodSel.innerHTML=cats.map(cat=>`<option value="${cat.value}">${_naEsc(cat.label)}</option>`).join('');if(current&&[...prodSel.options].some(op=>op.value===current))prodSel.value=current;else prodSel.value='abarrotes';}}
function toggleNewCategoryField(force){const wrap=document.getElementById('newCatWrap'),input=document.getElementById('pCatNueva');if(!wrap)return;const show=typeof force==='boolean'?force:(wrap.style.display==='none'||!wrap.style.display);wrap.style.display=show?'flex':'none';if(show){setTimeout(()=>input?.focus(),30);}else if(input)input.value='';}
async function agregarCategoriaProducto(){const input=document.getElementById('pCatNueva');const raw=_naClean(input?.value||'');const key=_naCategoryKey(raw);if(!raw||!key){toast('Escribe un nombre válido para la categoría','error');return;}const existing=_naAllCategories().find(cat=>cat.value===key);if(!existing){appConfig.customCategories=[..._naCustomCategories(),{value:key,label:raw}];}renderCategorySelects({prodValue:key,invValue:document.getElementById('invCat')?.value||''});toggleNewCategoryField(false);await _naFinalizeOperationPersistence(existing?'La categoría ya existía':'Categoría agregada','No se pudo guardar la categoría');}
function _naClassifyProductCategory(name,current='abarrotes'){
  const n=_naCategoryText(name),has=(...terms)=>terms.some(term=>n.includes(term));
  if(has('prestamo','recarga','pago de servicio','servicio digital'))return'servicios';
  if(has('redmi','samsung','jbl','tronsmart','earpods','audifono','cable tipo c','boombox','m20pro','jbl go','jbl flip','jbl charge','jbl clip'))return'tecnologia';
  if(has('tijera escolar','cola escolar','cola sintetica','pegamento','goma en barra','silicona liquida','borrador','lapicero','cuaderno','plumon','regla escolar'))return'libreria';
  if(has('panal','pamper','ninet talla','ninet xl','ninet m','ninet l'))return'bebe';
  if(has('nosotras','prestobarba','afeitar','rexona','shampoo','pantene','heno de pravia','camay','spa jabon','spa hidrat','spa exfol','kolynos','crema dental','cepillo dental','dento','sedal','deo men','deo rexona','gel muscular','schick'))return'cuidado';
  if(has('cerveza','aguardiente','cusquena','cristal lt','corona 330'))return'licores';
  if(has('helado','frio rico','sin parar','pezidori','copa hel','jet hel','sublime','alaska','emoticarita','creaturas','mini sandwich','bombones x 72','bb chicha morada','turbo','copa k bana','kiko 85'))return'helados';
  if(has('deterg','lavavaj','lejia','clorox','quitamanchas','esponja','fibra verde','suavizante','ambientador','mata moscas','matamoscas','matacucarachas','mata todo','insecticida','tokay espiral','papel higienico','servilleta','escoba','escobilla','bolivar aroma','jabon bolivar','jabon patito','popeye jabon','trome jabon','opal ultra','suave resistemax','sunny x 900','sunny det','marsella aromaterapia','patito 640','patito limon','bolivar suav'))return'limpieza';
  if(has('taper','balde','bolsa 5x','palitos para brochetas','encendedor de cocina','food saver','super glue','supper glue','boalco'))return'hogar';
  if(has('funda','case','mica','protector de pantalla','cargador','cable usb','memoria sd','usb','adaptador','aro de luz','soporte celular'))return'accesorios';
  if(has('gaseosa','agua ','agua san','monster','energizante','volt ','sporade','rehidrat','electrolight','frugos','jugo ','pulp ','nectar','maltin','pepsi','fanta','kola ','coca cola','inca kola','big cola','bebida de aloe','yogurt','yomost','yofresh','leche ninos chocolata','gloria beb durazno','pura vida agua','iq x 3l','iq amarilla'))return'bebidas';
  if(has('galleta','galletas','gomita','gomitas','gomas trululu','chicle','chocolate','wafer','caramelo','caramelos','paneton','nachos','papita','papas picantes','cuates','frito lay','cheese','dulces','postres','kekes','chupete','mentitas','chomp','vizzio','bizcocho','palichys','chicharon','casino','oreo','ritz','canonazo','chocman','pokeke','trident','oka loka','ambrosoli','chocobum','doña pepe','dona pepe','tuyo individual','mellown gummy','fanny deli'))return'snacks';
  const valid=_naAllCategories().map(cat=>cat.value);
  return valid.includes(current)?current:'abarrotes';
}
async function reclasificarCatalogo(showMessage=true){let changed=0;productos.forEach(p=>{const next=_naClassifyProductCategory(p.name,p.cat);if(next!==p.cat){p.cat=next;changed++;}});renderCategorySelects();posRender();invRender();const message=`Catálogo reclasificado: ${changed} producto${changed===1?'':'s'} actualizado${changed===1?'':'s'}`;if(showMessage)await _naFinalizeOperationPersistence(message,'No se pudo guardar la reclasificación');else await saveAllData();return changed;}
const _naSetSaveStatus=(ok=true,msg='Guardado local')=>{const el=document.getElementById('saveStatus');if(!el)return;el.classList.remove('saved','error');el.classList.add(ok?'saved':'error');if(window.NA_ICON_TEXT)NA_ICON_TEXT(el,ok?'save':'alert',msg);else el.textContent=ok?`💾 ${msg}`:`⚠️ ${msg}`;};
const _naSyncCreditStatus=cr=>{if(!cr)return'vigente';cr.monto=Math.max(0,_naNumber(cr.monto));cr.pagado=Math.min(cr.monto,Math.max(0,_naNumber(cr.pagado)));if(cr.anulado){cr.status='anulado';return cr.status;}if(cr.pagado>=cr.monto&&cr.monto>0)cr.status='cancelado';else{const d=diasHasta(cr.vence);cr.status=d!==null&&d<0?'vencido':'vigente';}return cr.status;};
// NUEVO FASE 6: modelo completo de créditos, pagos y desglose por producto.
const _NA_CREDIT_METHOD_LABELS={efectivo:'💵 Efectivo',yape:'📲 Yape',plin:'📲 Plin',transferencia:'🏦 Transferencia'};
function _naCreditSchedule(date=new Date()){const h=date.getHours();return h>=6&&h<12?'Mañana':h>=12&&h<18?'Tarde':'Noche';}
function _naCreditDayName(date=new Date()){return['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][date.getDay()];}
function _naCreditStatusLabel(cr){_naSyncCreditStatus(cr);return cr.status==='cancelado'?'PAGADO':cr.status==='anulado'?'ANULADO':cr.status==='vencido'?'VENCIDO':'VIGENTE';}
function _naCreditOutstanding(cr){return Math.max(0,Number((_naNumber(cr?.monto)-_naNumber(cr?.pagado)).toFixed(2)));}
function _naCreditItemKey(item,index){return _naClean(item?.itemKey||`${item?.productoId??item?.id??'concepto'}:${index}`);}
function _naNormalizeCreditItem(raw,index,creditAmount=0){const qty=Math.max(0.0001,_naNumber(raw?.cantidad??raw?.qty,1)),unit=Math.max(0,_naNumber(raw?.precioUnitario??raw?.precio)),subtotal=Math.max(0,_naNumber(raw?.subtotal,unit*qty)),finalSubtotal=Number((subtotal||(index===0?creditAmount:0)).toFixed(2)),finalUnit=unit||Number((finalSubtotal/qty).toFixed(4));return{itemKey:_naCreditItemKey(raw,index),productoId:raw?.productoId??raw?.id??null,id:raw?.id??raw?.productoId??null,sku:_naClean(raw?.sku||''),nombre:_naClean(raw?.nombre||raw?.name||raw?.desc||`Concepto ${index+1}`),name:_naClean(raw?.name||raw?.nombre||raw?.desc||`Concepto ${index+1}`),cantidad:qty,qty,precioUnitario:finalUnit,precio:finalUnit,subtotal:finalSubtotal,modo:_naClean(raw?.modo||raw?.ventaModo||'minorista'),ventaModo:_naClean(raw?.ventaModo||raw?.modo||'unidad')};}
function _naCreditItems(cr){
  let source=Array.isArray(cr?.items)&&cr.items.length?cr.items:null;
  if(!source&&cr?.ventaId){const sale=ventas.find(v=>String(v.id)===String(cr.ventaId));if(sale?.items?.length)source=sale.items;}
  if(!source||!source.length)source=[{itemKey:'concepto:0',productoId:null,nombre:cr?.desc||'Saldo general',cantidad:1,precioUnitario:_naNumber(cr?.monto),subtotal:_naNumber(cr?.monto),modo:'concepto'}];
  const normalized=source.map((item,index)=>_naNormalizeCreditItem(item,index,_naNumber(cr?.monto)));
  const sum=normalized.reduce((a,i)=>a+i.subtotal,0),target=_naNumber(cr?.monto);if(normalized.length&&Math.abs(sum-target)>.01){const last=normalized[normalized.length-1];last.subtotal=Number(Math.max(0,last.subtotal+(target-sum)).toFixed(2));last.precioUnitario=last.precio=Number((last.subtotal/Math.max(.0001,last.cantidad)).toFixed(4));}
  return normalized;
}
function _naNormalizeCreditAllocation(raw,index){return{itemKey:_naClean(raw?.itemKey||`${raw?.productoId??'concepto'}:${index}`),productoId:raw?.productoId??raw?.id??null,nombre:_naClean(raw?.nombre||raw?.name||`Producto ${index+1}`),monto:Math.max(0,_naNumber(raw?.monto)),subtotalCredito:Math.max(0,_naNumber(raw?.subtotalCredito)),saldoAnteriorProducto:Math.max(0,_naNumber(raw?.saldoAnteriorProducto)),saldoActualProducto:Math.max(0,_naNumber(raw?.saldoActualProducto))};}
function _naNormalizeCreditPayment(raw,cr,index){const amount=Math.max(0,_naNumber(raw?.monto??raw?.montoPagado)),timestamp=raw?.canonicalDateKnown===false?null:(raw?.canonicalDateKnown===true?raw.timestamp:(raw?.timestamp&&Number.isFinite(new Date(raw.timestamp).getTime())?new Date(raw.timestamp).toISOString():new Date(`${raw?.fecha||cr.fecha||obtenerHoy()}T${raw?.hora24||'00:00:00'}`).toISOString())),date=timestamp?new Date(timestamp):new Date(NaN);return{...raw,id:_naClean(raw?.id||raw?.pagoId||`P-${timestamp?date.getTime():'UNKNOWN'}-${index+1}`),pagoId:_naClean(raw?.pagoId||raw?.id||`P-${timestamp?date.getTime():'UNKNOWN'}-${index+1}`),creditoId:raw?.creditoId??cr.id,clienteId:raw?.clienteId??cr.cliId,clienteNombre:_naClean(raw?.clienteNombre||cr.clienteNombre||clientes.find(c=>String(c.id)===String(cr.cliId))?.nombre||'Cliente'),monto:amount,montoPagado:amount,saldoAnterior:Math.max(0,_naNumber(raw?.saldoAnterior)),saldoActual:Math.max(0,_naNumber(raw?.saldoActual)),fecha:raw?.canonicalDateKnown===false?'Fecha no registrada':String(raw?.fecha||timestamp.slice(0,10)).slice(0,10),hora:raw?.canonicalDateKnown===false?'':_naClean(raw?.hora||raw?.hora24||_naTime24(date)),hora24:raw?.canonicalDateKnown===false?'':_naClean(raw?.hora24||_naTime24(date)),timestamp,diaSemana:raw?.canonicalDateKnown===false?'Fecha no registrada':_naClean(raw?.diaSemana||_naCreditDayName(date)),horarioPago:raw?.canonicalDateKnown===false?'':_naClean(raw?.horarioPago||_naCreditSchedule(date)),metodo:raw?.canonicalDateKnown===true?_naClean(raw?.metodo||raw?.source_method||'Desconocido'):(['efectivo','yape','plin','transferencia'].includes(raw?.metodo)?raw.metodo:'efectivo'),operacion:_naClean(raw?.operacion||raw?.numeroOperacion||raw?.referencia||''),numeroOperacion:_naClean(raw?.numeroOperacion||raw?.operacion||raw?.referencia||''),referencia:_naClean(raw?.referencia||raw?.operacion||raw?.numeroOperacion||''),cajero:_naClean(raw?.cajero||raw?.cajeroNombre||'Cajero'),cajeroNombre:_naClean(raw?.cajeroNombre||raw?.cajero||'Cajero'),cajeroId:_naClean(raw?.cajeroId||''),desgloseProductos:(Array.isArray(raw?.desgloseProductos)?raw.desgloseProductos:[]).map(_naNormalizeCreditAllocation)};}
function _naNormalizeCreditRecord(cr,index=0){
  const client=clientes.find(c=>String(c.id)===String(cr?.cliId??cr?.clienteId)),candidate=cr?.timestamp?new Date(cr.timestamp):new Date(`${cr?.fecha||obtenerHoy()}T${cr?.hora24||'00:00:00'}`),date=Number.isFinite(candidate.getTime())?candidate:new Date(),item={...cr,id:cr?.id??Date.now()+index,cliId:cr?.cliId??cr?.clienteId??null,clienteId:cr?.clienteId??cr?.cliId??null,clienteNombre:_naClean(cr?.clienteNombre||client?.nombre||'Cliente'),clienteDni:_naClean(cr?.clienteDni||client?.dni||''),desc:_naClean(cr?.desc||'Crédito'),monto:Math.max(0,_naNumber(cr?.monto)),pagado:Math.max(0,_naNumber(cr?.pagado)),vence:cr?.canonicalDueKnown===false?'':(cr?.vence?String(cr.vence).slice(0,10):obtenerHoy()),fecha:String(cr?.fecha||date.toISOString().slice(0,10)).slice(0,10),hora:_naClean(cr?.hora||cr?.hora24||_naTime24(date)),hora24:_naClean(cr?.hora24||_naTime24(date)),timestamp:date.toISOString(),cajero:_naClean(cr?.cajero||cr?.cajeroNombre||'Cajero'),cajeroNombre:_naClean(cr?.cajeroNombre||cr?.cajero||'Cajero'),cajeroId:_naClean(cr?.cajeroId||''),anulado:!!cr?.anulado};
  item.items=_naCreditItems(item);
  const rawPayments=Array.isArray(cr?.pagos)?cr.pagos.slice():[],signatures=new Set(rawPayments.map(pay=>`${_naClean(pay?.pagoId||pay?.id)}|${_naClean(pay?.timestamp||`${pay?.fecha||''}T${pay?.hora24||pay?.hora||''}`)}|${_naNumber(pay?.monto??pay?.montoPagado).toFixed(2)}`));
  for(const move of Array.isArray(cajMovs)?cajMovs:[]){if(move?.tipo!=='cob'||String(move?.creditoId)!==String(item.id))continue;const signature=`${_naClean(move?.pagoId||move?.id)}|${_naClean(move?.timestamp||`${move?.fecha||''}T${move?.hora24||move?.hora||''}`)}|${_naNumber(move?.monto).toFixed(2)}`;const fallback=`|${_naClean(move?.timestamp||`${move?.fecha||''}T${move?.hora24||move?.hora||''}`)}|${_naNumber(move?.monto).toFixed(2)}`;if(signatures.has(signature)||[...signatures].some(sig=>sig.endsWith(fallback)))continue;rawPayments.push({id:move.pagoId||`P-MOV-${move.id}`,pagoId:move.pagoId||`P-MOV-${move.id}`,creditoId:item.id,clienteId:item.cliId,clienteNombre:item.clienteNombre,monto:move.monto,fecha:move.fecha,hora:move.hora,hora24:move.hora24,timestamp:move.timestamp,metodo:move.metodo,operacion:move.numeroOperacion||move.referencia||'',referencia:move.referencia||move.numeroOperacion||'',cajero:move.cajero,cajeroNombre:move.cajeroNombre,cajeroId:move.cajeroId,horarioPago:move.horarioPago});signatures.add(signature);}
  // FIX03: un pago REVERTED permanece en el historial byte-fiel pero aporta 0 al saldo recalculado.
  item.pagos=rawPayments.map((pay,i)=>_naNormalizeCreditPayment(pay,item,i)).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));const loggedTotal=item.pagos.filter(pay=>pay.status!=='REVERTED').reduce((sum,pay)=>sum+pay.monto,0),legacyPaid=Math.max(0,item.pagado-loggedTotal);let runningPaid=Math.min(item.monto,legacyPaid),processed=[];
  for(const pay of item.pagos){if(pay.status==='REVERTED'){processed.push(pay);continue;}const before=Math.max(0,Number((item.monto-runningPaid).toFixed(2))),available=Math.min(pay.monto,before),temp={...item,pagado:runningPaid,pagos:processed},allocation=Array.isArray(pay.desgloseProductos)&&pay.desgloseProductos.length?{rows:pay.desgloseProductos}:_naAllocateCreditPayment(temp,available);pay.monto=pay.montoPagado=available;pay.saldoAnterior=before;runningPaid=Math.min(item.monto,Number((runningPaid+available).toFixed(2)));pay.saldoActual=Math.max(0,Number((item.monto-runningPaid).toFixed(2)));pay.desgloseProductos=allocation.rows.map(_naNormalizeCreditAllocation);processed.push(pay);}
  item.pagos=processed;item.pagado=Math.min(item.monto,Math.max(item.pagado,runningPaid));item.saldo=_naCreditOutstanding(item);item.estado=_naSyncCreditStatus(item);return item;
}
function _naCreditPaidMap(cr){
  const map=new Map(),items=_naCreditItems(cr);for(const item of items)map.set(item.itemKey,0);
  let logged=0;for(const pay of Array.isArray(cr?.pagos)?cr.pagos:[]){if(pay?.status==='REVERTED')continue;logged+=_naNumber(pay.monto);for(const row of Array.isArray(pay.desgloseProductos)?pay.desgloseProductos:[]){const key=_naClean(row.itemKey);if(key)map.set(key,_naNumber(map.get(key))+_naNumber(row.monto));}}
  let legacy=Math.max(0,_naNumber(cr?.pagado)-logged);for(const item of items){if(legacy<=.001)break;const used=_naNumber(map.get(item.itemKey)),available=Math.max(0,item.subtotal-used),part=Math.min(available,legacy);map.set(item.itemKey,used+part);legacy=Number((legacy-part).toFixed(2));}
  return map;
}
function _naAllocateCreditPayment(cr,amount){
  let cents=Math.max(0,Math.round(_naNumber(amount)*100)),remaining=cents;const items=_naCreditItems(cr),paid=_naCreditPaidMap(cr),rows=[];
  for(const item of items){if(remaining<=0)break;const subtotalCents=Math.round(item.subtotal*100),paidCents=Math.round(_naNumber(paid.get(item.itemKey))*100),available=Math.max(0,subtotalCents-paidCents),part=Math.min(available,remaining);if(part<=0)continue;rows.push({itemKey:item.itemKey,productoId:item.productoId,nombre:item.nombre,monto:part/100,subtotalCredito:subtotalCents/100,saldoAnteriorProducto:available/100,saldoActualProducto:(available-part)/100});remaining-=part;}
  if(remaining>0&&rows.length){rows[rows.length-1].monto=Number((rows[rows.length-1].monto+remaining/100).toFixed(2));rows[rows.length-1].saldoActualProducto=Math.max(0,Number((rows[rows.length-1].saldoActualProducto-remaining/100).toFixed(2)));remaining=0;}
  return{rows,total:Number(((cents-remaining)/100).toFixed(2)),unallocated:Number((remaining/100).toFixed(2))};
}
function _naCreditPaymentOperationUsed(operation){const key=_naClean(operation).toLowerCase();if(!key)return false;for(const cr of creditos){for(const pay of Array.isArray(cr.pagos)?cr.pagos:[]){if([_naClean(pay.operacion),_naClean(pay.numeroOperacion),_naClean(pay.referencia)].some(v=>v.toLowerCase()===key))return true;}}if(ventas.some(v=>!v.anulada&&_naClean(v.paymentRef).toLowerCase()===key))return true;return cajMovs.some(m=>_naClean(m.referencia||m.numeroOperacion).toLowerCase()===key);}
function _naCreditCardHtml(cr){
  _naSyncCreditStatus(cr);const pct=cr.monto>0?Math.min(100,_naNumber(cr.pagado)/_naNumber(cr.monto)*100):0,d=diasHasta(cr.vence),label=_naCreditStatusLabel(cr),dateLabel=cr.status==='cancelado'?'Pagado completamente':cr.status==='anulado'?'Crédito anulado':d===null?'—':d<0?`Venció hace ${Math.abs(d)}d`:d===0?'Vence hoy':d<=7?`Vence en ${d}d`:cr.vence,color=cr.status==='cancelado'?'#15803d':cr.status==='anulado'?'var(--red)':d!==null&&d<0?'var(--red)':d!==null&&d<=7?'var(--amber)':'var(--slate)',statusClass=cr.status==='cancelado'?'cs-c':cr.status==='vencido'||cr.status==='anulado'?'cs-m':'cs-v',payments=Array.isArray(cr.pagos)?cr.pagos.length:0,pending=_naCreditOutstanding(cr);
  return`<div class="cr-item"><div class="cr-top"><div><div class="cr-desc">${cr.tipo==='contrato_privado'?'<i class="na-ic na-ic-clip" aria-hidden="true"></i>':'<i class="na-ic na-ic-cart" aria-hidden="true"></i>'} ${_naEsc(cr.desc)}</div><div class="cr-date" style="color:${color}">${_naEsc(dateLabel)}</div><div class="credit-status-note">${payments} pago${payments===1?'':'s'} registrado${payments===1?'':'s'}${cr.ventaId?' · Venta '+_naEsc(cr.ventaId):''}</div></div><span class="c-status ${statusClass}">${label}</span></div><div class="cr-amounts"><div class="cra"><div class="cra-lbl">Original</div><div class="cra-val cra-o">${fmt(cr.monto)}</div></div><div class="cra"><div class="cra-lbl">Pagado</div><div class="cra-val cra-p">${fmt(cr.pagado)}</div></div><div class="cra"><div class="cra-lbl">Pendiente</div><div class="cra-val cra-r">${fmt(pending)}</div></div></div><div class="cr-prog"><div class="cr-prog-fill" style="width:${pct.toFixed(0)}%"></div></div><div class="cr-acts">${!cr.anulado&&cr.status!=='cancelado'&&pending>0?`<button class="btn-cr btn-pago-cr" onclick="abrirPago('${_naEsc(String(cr.id))}')"><i class="na-ic na-ic-cash" aria-hidden="true"></i> Registrar pago</button>`:''}<button class="btn-cr" style="background:#f1f5f9;color:var(--slate)" onclick="abrirDetalleCredito('${_naEsc(String(cr.id))}')"><i class="na-ic na-ic-file" aria-hidden="true"></i> Ver historial</button></div></div>`;
}
function _naCreditPaymentMethodChanged(){const method=document.getElementById('pagoMetodo')?.value||'efectivo',wrap=document.getElementById('pagoOperacionWrap'),input=document.getElementById('pagoOperacion');if(wrap)wrap.hidden=method==='efectivo';if(method==='efectivo'&&input)input.value='';_naUpdateCreditPaymentPreview();}
function _naUpdateCreditPaymentPreview(){const cr=creditos.find(x=>String(x.id)===String(pagoCredId)),amount=Math.max(0,_naNumber(document.getElementById('pagoMonto')?.value)),preview=document.getElementById('pagoDesglosePreview'),saldo=document.getElementById('abonoSaldo');if(!cr||!preview)return;const pending=_naCreditOutstanding(cr);if(saldo)saldo.textContent=fmt(Math.max(0,pending-amount));if(amount<=0){preview.innerHTML='<div class="credit-breakdown-title">Desglose del abono</div><div class="credit-status-note">Ingresa un monto para ver cómo se distribuirá entre los productos.</div>';return;}const allocation=_naAllocateCreditPayment(cr,Math.min(amount,pending));preview.innerHTML=`<div class="credit-breakdown-title">Desglose del abono</div>${allocation.rows.map(row=>`<div class="credit-breakdown-row"><span>${_naEsc(row.nombre)}</span><strong>${fmt(row.monto)}</strong></div>`).join('')||'<div class="credit-status-note">No se encontraron conceptos pendientes.</div>'}`;}
function abrirDetalleCredito(crId){const cr=creditos.find(x=>String(x.id)===String(crId));if(!cr){toast('No se encontró el crédito','error');return;}const container=document.getElementById('creditoDetalleContent');if(!container)return;container.innerHTML=_naCreditDetailHtml(cr);document.getElementById('mCreditoDetalle').classList.add('open');document.querySelector('#mCreditoDetalle .modal')?.scrollTo(0,0);}
function _naCreditDetailHtml(cr){
  _naSyncCreditStatus(cr);const client=clientes.find(c=>String(c.id)===String(cr.cliId)),items=_naCreditItems(cr),paidMap=_naCreditPaidMap(cr),payments=[...(Array.isArray(cr.pagos)?cr.pagos:[])].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)),pending=_naCreditOutstanding(cr),status=_naCreditStatusLabel(cr);
  const productHtml=items.map(item=>{const paid=Math.min(item.subtotal,_naNumber(paidMap.get(item.itemKey))),left=Math.max(0,item.subtotal-paid);return`<div class="credit-detail-item"><div><strong>${_naEsc(item.nombre)}</strong><small>${item.cantidad} × ${fmt(item.precioUnitario)}${item.modo&&item.modo!=='minorista'?' · '+_naEsc(item.modo):''}</small></div><div style="text-align:right"><strong>${fmt(item.subtotal)}</strong><small>Pagado ${fmt(paid)} · Falta ${fmt(left)}</small></div></div>`;}).join('');
  const paymentHtml=payments.length?payments.map(pay=>`<div class="credit-payment-card"><div class="credit-payment-head"><div><strong>${_naEsc(pay.pagoId||pay.id)}</strong><div class="credit-payment-sub">${_naEsc(pay.diaSemana)} ${_naEsc(pay.fecha)} · ${_naEsc(pay.hora24||pay.hora)} · ${_naEsc(pay.horarioPago)}</div></div><span>${fmt(pay.monto)}</span></div><div class="credit-payment-sub">${_naEsc(_NA_CREDIT_METHOD_LABELS[pay.metodo]||pay.metodo)}${pay.operacion?' · Operación '+_naEsc(pay.operacion):''}<br>Cajero: ${_naEsc(pay.cajeroNombre||pay.cajero||'Cajero')}${pay.cajeroId?' · '+_naEsc(pay.cajeroId):''}<br>Saldo: ${fmt(pay.saldoAnterior)} → ${fmt(pay.saldoActual)}</div>${Array.isArray(pay.desgloseProductos)&&pay.desgloseProductos.length?`<div class="credit-payment-allocation">${pay.desgloseProductos.map(row=>`<div><span>${_naEsc(row.nombre)}</span><strong>${fmt(row.monto)}</strong></div>`).join('')}</div>`:''}</div>`).join(''):'<div class="credit-status-note">Todavía no se registraron pagos.</div>';
  return`<div class="credit-detail-summary"><div class="credit-detail-box"><span>Cliente</span><strong>${_naEsc(client?.nombre||cr.clienteNombre||'Cliente')}</strong></div><div class="credit-detail-box"><span>Estado</span><strong>${status}</strong></div><div class="credit-detail-box"><span>Saldo pendiente</span><strong>${fmt(pending)}</strong></div></div><div class="credit-pay-meta"><div class="credit-pay-chip"><span>Crédito</span><strong>${_naEsc(cr.desc)}</strong></div><div class="credit-pay-chip"><span>Fecha / vencimiento</span><strong>${_naEsc(cr.fecha)} · ${_naEsc(cr.vence)}</strong></div><div class="credit-pay-chip"><span>Cajero de origen</span><strong>${_naEsc(cr.cajeroNombre||cr.cajero||'Cajero')}${cr.cajeroId?' · '+_naEsc(cr.cajeroId):''}</strong></div><div class="credit-pay-chip"><span>Venta vinculada</span><strong>${_naEsc(cr.ventaId||'Crédito manual')}</strong></div></div><div class="credit-detail-section"><h4>🛒 Productos o conceptos financiados</h4>${productHtml}</div><div class="credit-detail-section"><h4>💵 Historial de pagos (${payments.length})</h4>${paymentHtml}</div>${!cr.anulado&&cr.status!=='cancelado'&&pending>0?`<div class="mbtns" style="margin-top:12px"><button class="mbtn mbtn-ok green" onclick="cerrarModal('mCreditoDetalle');abrirPago('${_naEsc(String(cr.id))}')"><i class="na-ic na-ic-cash" aria-hidden="true"></i> Registrar nuevo pago</button></div>`:''}`;
}
const _naCajaMovsSesion=()=>{if(cajEstado?.sessionId)return cajMovs.filter(m=>m.sessionId===cajEstado.sessionId);const fecha=cajEstado?.fechaApertura||obtenerHoy();return cajMovs.filter(m=>m.fecha===fecha);};

function _naNormalizeData(){
  _naEnsureCashierConfig();
  productos=(Array.isArray(productos)?productos:[]).map((p,index)=>({
    ...p,id:p.id??Date.now()+index,name:_naClean(p.name||'Producto'),descripcion:_naClean(p.descripcion||''),sku:_naClean(p.sku||`PROD-${index+1}`),barcode:_naClean(p.barcode||''),codigosAlternativos:_naNormalizeAltCodes(p.codigosAlternativos,p.codigoAlternativo),codigoAlternativo:_naNormalizeAltCodes(p.codigosAlternativos,p.codigoAlternativo)[0]||'',cat:_naClassifyProductCategory(p.name,_naClean(p.cat||'abarrotes').toLowerCase()),marca:_naClean(p.marca||'Sin marca')||'Sin marca',unidad:_naClean(p.unidad||'unidad')||'unidad',unidadCompra:_naClean(p.unidadCompra||(p.unidCaja?'caja':'unidad'))||'unidad',factorCompra:Math.max(0.001,_naNumber(p.factorCompra,p.unidCaja||1)),icon:p.icon||'📦',imagen:p.imagen||null,
    costo:Math.max(0,_naNumber(p.costo)),precio:Math.max(0,_naNumber(p.precio)),incluyeIGV:p.incluyeIGV!==false,tipoImpuesto:_naTaxType(p.tipoImpuesto),impuestoComplementario:_naClean(p.impuestoComplementario||''),precioCaja:_naNumber(p.precioCaja)>0?_naNumber(p.precioCaja):null,unidCaja:_naInt(p.unidCaja)>0?_naInt(p.unidCaja):null,
    controlInventario:p.controlInventario!==false,stock:p.controlInventario===false?0:_naInt(p.stock),stockMin:Math.max(0,_naInt(p.stockMin,_naInt(appConfig.stockMin,5))),venc:p.venc?String(p.venc).slice(0,10):null
  }));
  ventas=(Array.isArray(ventas)?ventas:[]).map((v,index)=>_naNormalizeSaleRecord(v,index));
  clientes=(Array.isArray(clientes)?clientes:[]).map((c,index)=>({...c,nombre:_naClean(c.nombre||'Cliente'),dni:_naClean(c.dni||''),tel:_naClean(c.tel||''),dir:_naClean(c.dir||''),color:_naInt(c.color,index)%8,totalCompras:Math.max(0,_naNumber(c.totalCompras))}));
  creditos=(Array.isArray(creditos)?creditos:[]).map((cr,index)=>_naNormalizeCreditRecord(cr,index));
  gastos=(Array.isArray(gastos)?gastos:[]).map(g=>({...g,desc:_naClean(g.desc||'Gasto'),monto:Math.max(0,_naNumber(g.monto)),fecha:g.fecha?String(g.fecha).slice(0,10):obtenerHoy()}));
  cajMovs=(Array.isArray(cajMovs)?cajMovs:[]).map(m=>({...m,monto:Math.max(0,_naNumber(m.monto)),efectivo:Math.max(0,_naNumber(m.efectivo)),fecha:m.fecha?String(m.fecha).slice(0,10):obtenerHoy()}));
  inventoryMovements=(Array.isArray(inventoryMovements)?inventoryMovements:[]).map(m=>({...m,productId:m?.productId??null,type:_naClean(m?.type)||'AJUSTE',before:_naInt(m?.before),delta:_naNumber(m?.delta),after:_naInt(m?.after),reason:_naClean(m?.reason||''),source:_naClean(m?.source)||'MANUAL',referenceId:m?.referenceId==null?null:String(m.referenceId),fecha:m?.fecha?String(m.fecha).slice(0,10):obtenerHoy()}));
  cart=(Array.isArray(cart)?cart:[]).map((it,index)=>({...it,qty:Math.max(1,_naNumber(it.qty,1)),precio:Math.max(0,_naNumber(it.precio)),costo:Math.max(0,_naNumber(it.costo)),unitsPerQty:Math.max(1,_naInt(it.unitsPerQty,1)),_lineKey:it._lineKey||_naLineKey(it.id,it.unitsPerQty>1?'caja':'unidad')}));
}

function _naCaptureVisibleConfig(){
  const b=appConfig.business;
  if(document.getElementById('cfgNombre'))b.nombre=_naClean(document.getElementById('cfgNombre').value)||b.nombre;
  if(document.getElementById('cfgRuc'))b.ruc=_naClean(document.getElementById('cfgRuc').value);
  if(document.getElementById('cfgDir'))b.direccion=_naClean(document.getElementById('cfgDir').value)||b.direccion;
  if(document.getElementById('cfgTel'))b.telefono=_naClean(document.getElementById('cfgTel').value);
  if(document.getElementById('cfgCajero')){const selected=_naFindCashier(document.getElementById('cfgCajero').value);if(selected&&selected.activo){appConfig.activeCashierId=selected.id;b.cajero=selected.nombre;}}
  const toggleMap={igvToggle:'igvActive',margenToggle:'margenActive',stockToggle:'stockAlertActive',printToggle:'printAuto',mayoristaToggle:'mayoristaActive'};
  Object.entries(toggleMap).forEach(([id,key])=>{const el=document.getElementById(id);if(el)appConfig[key]=el.classList.contains('active');});
  const sm=document.getElementById('cfgStockMin');if(sm)appConfig.stockMin=Math.max(0,_naInt(sm.value,5));
  const fs=document.getElementById('cfgFontSize');if(fs)appConfig.appearance.fontSize=fs.value;
  const msg=document.getElementById('cfgMensaje');if(msg)appConfig.ticket.pie=_naClean(msg.value)||appConfig.ticket.pie;
}
function _naSaveTicketSettings(){const ticketModal=document.getElementById('mTicket');if(!ticketModal?.classList.contains('open'))return;const ids={tkAncho:'ancho',tkCustomMm:'customMm',tkFuente:'fuente',tkTamano:'tamano',tkCustomPreviewPx:'previewCustomPx',tkAlign:'align',tkInfoAlign:'infoAlign',tkPaymentAlign:'paymentAlign',tkFooterAlign:'footerAlign',tkLayout:'layoutMode',tkPie:'pie'};Object.entries(ids).forEach(([id,key])=>{const el=document.getElementById(id);if(!el)return;if(id==='tkCustomMm')appConfig.ticket[key]=Math.max(20,Math.min(120,Number(el.value||60)));else if(id==='tkCustomPreviewPx')appConfig.ticket[key]=Math.max(7,Math.min(24,Number(el.value||11)));else appConfig.ticket[key]=el.value;});const checks={tkShowLogo:'showLogo',tkShowNum:'showNum',tkShowOperation:'showOperation',tkShowSep:'showSep',tkShowCurrency:'showCurrency',tkShowUnitPrice:'showUnitPrice',tkShowPayment:'showPayment',tkShowReceived:'showReceived'};Object.entries(checks).forEach(([id,key])=>{const el=document.getElementById(id);if(el)appConfig.ticket[key]=el.checked;});const igv=document.getElementById('tkShowIGV');if(igv&&appConfig.igvActive&&igv.dataset.naUserSet==='1'){appConfig.ticket.showIGV=igv.checked;try{localStorage.setItem('na_show_igv_line',igv.checked?'1':'0');}catch(_){}delete igv.dataset.naUserSet;}const b=appConfig.business;if(document.getElementById('tkNegocio'))b.nombre=_naClean(document.getElementById('tkNegocio').value)||b.nombre;if(document.getElementById('tkRuc'))b.ruc=_naClean(document.getElementById('tkRuc').value.replace(/^(?:RUC(?:\/DNI)?|DNI)\s*:\s*/i,''));if(document.getElementById('tkDireccion'))b.direccion=_naClean(document.getElementById('tkDireccion').value)||b.direccion;if(document.getElementById('tkTelefono'))b.telefono=_naClean(document.getElementById('tkTelefono').value.replace(/^Tel\s*:\s*/i,''));}
function _naHydrateTicket(){const b=_naGetBusiness(),t=appConfig.ticket,values={tkAncho:t.ancho||'80mm',tkCustomMm:t.customMm||60,tkFuente:t.fuente,tkTamano:t.tamano||'11px',tkCustomPreviewPx:t.previewCustomPx||11,tkAlign:t.align||'center',tkInfoAlign:t.infoAlign||'left',tkPaymentAlign:t.paymentAlign||'split',tkFooterAlign:t.footerAlign||'center',tkLayout:t.layoutMode||'auto',tkNegocio:b.nombre.toUpperCase(),tkRuc:b.ruc?`RUC/DNI: ${b.ruc}`:'',tkDireccion:b.direccion,tkTelefono:b.telefono?`Tel: ${b.telefono}`:'',tkPie:t.pie};Object.entries(values).forEach(([id,value])=>{const el=document.getElementById(id);if(el)el.value=value;});const checks={tkShowLogo:t.showLogo,tkShowIGV:appConfig.igvActive&&(()=>{try{const v=localStorage.getItem('na_show_igv_line');return v===null?t.showIGV!==false:v!=='0';}catch(_){return t.showIGV!==false;}})(),tkShowNum:t.showNum,tkShowOperation:t.showOperation!==false,tkShowSep:t.showSep,tkShowCurrency:t.showCurrency!==false,tkShowUnitPrice:t.showUnitPrice!==false,tkShowPayment:t.showPayment!==false,tkShowReceived:t.showReceived!==false};Object.entries(checks).forEach(([id,value])=>{const el=document.getElementById(id);if(el)el.checked=!!value;});const igv=document.getElementById('tkShowIGV');if(igv){igv.disabled=!appConfig.igvActive;igv.title=appConfig.igvActive?'':'El IGV está desactivado en el POS';}const custom=document.getElementById('tkCustomWidthWrap');if(custom)custom.style.display=t.ancho==='custom'?'block':'none';const previewCustom=document.getElementById('tkCustomPreviewWrap');if(previewCustom)previewCustom.style.display=t.tamano==='custom'?'block':'none';}

function _naApplyConfigUI(){
  const b=_naGetBusiness(),a=appConfig.appearance;
  document.documentElement.style.setProperty('--teal',a.accent||'#00bca4');document.documentElement.style.setProperty('--teal-dark',a.accentDark||'#009e8a');
  const zoom=a.fontSize==='grande'?1.07:a.fontSize==='muy-grande'?1.14:1;document.body.style.zoom=window.innerWidth>700?String(zoom):'1';
  const name=document.getElementById('topBusinessName');if(name)name.textContent=b.nombre.replace(/^Multiservicios\s+/i,'')||'Nuevo Amanecer';
  const sub=document.getElementById('topBusinessSub');if(sub)sub.textContent=`${b.direccion||'Puerto Súngaro'} · Multiservicios`;
  const activeCashier=_naGetActiveCashier(),avatar=document.getElementById('topAvatar');if(avatar){avatar.textContent=(activeCashier.nombre||'C').trim().charAt(0).toUpperCase();avatar.title=`${activeCashier.nombre} · ${activeCashier.id}`;}
  const may=document.getElementById('btnMayorista');if(may){may.style.display=_naMayoristaAvailable()?'block':'none';if(!_naMayoristaAvailable()&&modoMayorista){modoMayorista=false;const tag=document.getElementById('modoMayoristaTag');if(tag)tag.style.display='none';}}
  _naUpdateScannerIndicator();
  _naUpdateFreeSaleUI();
  _naHydrateTicket();
}
function updateDashboard(){const hoy=obtenerHoy(),validas=ventas.filter(v=>v.fecha===hoy&&!v.anulada),total=validas.reduce((sum,v)=>sum+totalV(v),0);const qv=document.getElementById('qsVentas');if(qv)qv.textContent=_naInicioMoney(total);const qvs=document.getElementById('qsVentasSub');if(qvs)qvs.textContent=`${validas.length} ${validas.length===1?'transacción':'transacciones'}`;const cajaActiva=_naSessionOpen(),t=typeof cajTotales==='function'?cajTotales():{ef:0};const qc=document.getElementById('qsCaja');if(qc)qc.textContent=_naInicioMoney(cajaActiva?t.ef:0);const qcs=document.getElementById('qsCajaSub');const cajaTexto=cajaActiva?_naInicioCashText(cajEstado):(cajEstado?.cerrada?'Caja cerrada':'Caja no abierta');if(qcs)qcs.textContent=cajaTexto;const {active:activos,debt:deuda}=_naInicioCredits(creditos);const qp=document.getElementById('qsPorCobrar');if(qp)qp.textContent=_naInicioMoney(deuda);const qps=document.getElementById('qsPorCobrarSub');if(qps)qps.textContent=`${activos.length} crédito${activos.length===1?'':'s'} activo${activos.length===1?'':'s'}`;const crit=appConfig.stockAlertActive?productos.filter(_naCriticalStock).length:0;const qs=document.getElementById('qsStockCritico');if(qs)qs.textContent=appConfig.stockAlertActive?crit:'—';const qss=document.getElementById('qsStockCriticoSub');if(qss)qss.textContent=appConfig.stockAlertActive?(crit===1?'producto por reponer':'productos por reponer'):'alertas desactivadas';const heroSales=document.getElementById('menuVentasHero');if(heroSales)heroSales.textContent=_naInicioMoney(total);const heroSalesSub=document.getElementById('menuVentasHeroSub');if(heroSalesSub)heroSalesSub.textContent=`${validas.length} ${validas.length===1?'transacción':'transacciones'} registradas hoy`;const heroCaja=document.getElementById('menuCajaEstado');if(heroCaja){heroCaja.textContent=cajaTexto;heroCaja.className='hero-pill '+(cajaActiva?'success':'warn');}const heroProductos=document.getElementById('menuProductosEstado');if(heroProductos)heroProductos.textContent=`${productos.length} productos cargados`;const heroCreditos=document.getElementById('menuCreditosEstado');if(heroCreditos)heroCreditos.textContent=`${activos.length} crédito${activos.length===1?'':'s'} activo${activos.length===1?'':'s'}`;const productosCargados=document.getElementById('menuProductosCargados');if(productosCargados)productosCargados.textContent=String(productos.length);const clientesCargados=document.getElementById('menuClientesCargados');if(clientesCargados)clientesCargados.textContent=String(clientes.length);const ultimaVenta=document.getElementById('menuUltimaVenta');const ultimoMov=document.getElementById('menuUltimoMovimiento');const ultima=ventas.filter(v=>!v.anulada).slice().sort((a,b)=>new Date((b.fecha||'')+'T'+((b.hora24||'00:00:00').substring(0,8)||'00:00:00'))-new Date((a.fecha||'')+'T'+((a.hora24||'00:00:00').substring(0,8)||'00:00:00')))[0];if(ultima){const monto=_naInicioMoney(totalV(ultima));if(ultimaVenta)ultimaVenta.textContent=`${monto}`;if(ultimoMov)ultimoMov.textContent=`Último movimiento: ${ultima.id||'venta'} · ${monto}`;}else{if(ultimaVenta)ultimaVenta.textContent='Sin ventas';if(ultimoMov)ultimoMov.textContent='Sin movimientos recientes';}}


const _NA_DB_NAME='NuevoAmanecerPOS',_NA_DB_STORE='state',_NA_SNAPSHOT_KEY='snapshot_v9',_NA_LOCAL_KEY='na_snapshot_v9',_NA_SESSION_KEY='na_snapshot_v9_session',_NA_LOCAL_CONFIG_KEY='na_local_config_v1';
let _naDbPromise=null,_naDbLastError=null,_naPersistChain=Promise.resolve(),_naLastPersistOK=true,_naLoadedUIState={},_naPersistWarningState='';
let _naLastPersistResult={ok:true,durable:true,temporary:false,storage:'unknown',verified:false,error:null};
let _naCloudDurableSnapshot=null;
const _naSafePersistError=error=>{if(!error)return null;const name=String(error.name||'StorageError').slice(0,60),code=String(error.code||'').slice(0,40),message=String(error.message||'No fue posible verificar el almacenamiento').replace(/[\r\n]+/g,' ').slice(0,180);return{name,code,message};};
const _naPersistFailed=error=>({ok:false,durable:false,temporary:false,storage:'none',verified:false,error:_naSafePersistError(error)||{name:'StorageError',code:'',message:'No existe almacenamiento disponible'}});
function _naOpenDB(){
  if(_naDbPromise)return _naDbPromise;
  _naDbPromise=new Promise(resolve=>{
    if(!('indexedDB' in window)||!indexedDB){_naDbLastError=new Error('IndexedDB no disponible');resolve(null);return;}let done=false;const finish=value=>{if(done)return;done=true;resolve(value);};const timer=setTimeout(()=>{_naDbLastError=new Error('IndexedDB no respondió a tiempo');finish(null);},1500);
    try{const req=indexedDB.open(_NA_DB_NAME,1);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(_NA_DB_STORE))db.createObjectStore(_NA_DB_STORE);};req.onsuccess=()=>{clearTimeout(timer);_naDbLastError=null;finish(req.result);};req.onerror=()=>{clearTimeout(timer);_naDbLastError=req.error||new Error('No se pudo abrir IndexedDB');finish(null);};req.onblocked=()=>{clearTimeout(timer);_naDbLastError=new Error('IndexedDB está bloqueado por otra pestaña');finish(null);};}catch(error){clearTimeout(timer);_naDbLastError=error;finish(null);}
  });return _naDbPromise;
}
async function _naReadIDBSnapshot(){const db=await _naOpenDB();if(!db)return null;return new Promise(resolve=>{try{const tx=db.transaction(_NA_DB_STORE,'readonly'),req=tx.objectStore(_NA_DB_STORE).get(_NA_SNAPSHOT_KEY);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>{_naDbLastError=req.error||new Error('No se pudo leer IndexedDB');resolve(null);};}catch(error){_naDbLastError=error;resolve(null);}});}
async function _naWriteIDBSnapshot(snapshot,expectedSerialized){const db=await _naOpenDB();if(!db)return{ok:false,verified:false,error:_naDbLastError};const written=await new Promise(resolve=>{try{const tx=db.transaction(_NA_DB_STORE,'readwrite');tx.objectStore(_NA_DB_STORE).put(snapshot,_NA_SNAPSHOT_KEY);tx.oncomplete=()=>resolve({ok:true,error:null});tx.onerror=()=>resolve({ok:false,error:tx.error||new Error('No se pudo escribir IndexedDB')});tx.onabort=()=>resolve({ok:false,error:tx.error||new Error('La escritura en IndexedDB fue cancelada')});}catch(error){resolve({ok:false,error});}});if(!written.ok)return{ok:false,verified:false,error:written.error};const stored=await _naReadIDBSnapshot();try{const verified=JSON.stringify(stored)===expectedSerialized;return{ok:verified,verified,error:verified?null:new Error('IndexedDB no devolvió el dato esperado')};}catch(error){return{ok:false,verified:false,error};}}
function _naGetLocks(){return{master:storage.getItem(LOCK_KEYS.master)==='true',readOnly:storage.getItem(LOCK_KEYS.readOnly)==='true',modules:Object.fromEntries(Object.entries(LOCK_KEYS.modules).map(([k,v])=>[k,storage.getItem(v)==='true']))};}
function _naApplyLocks(locks={}){storage.setItem(LOCK_KEYS.master,!!locks.master);storage.setItem(LOCK_KEYS.readOnly,!!locks.readOnly);Object.entries(LOCK_KEYS.modules).forEach(([k,key])=>storage.setItem(key,!!locks.modules?.[k]));}
function _naBuildSnapshot(){
  _naCaptureVisibleConfig();_naSaveTicketSettings();
  const cloudSync=typeof NuevoAmanecerOutbox!=='undefined'?NuevoAmanecerOutbox.snapshot():null;
  return{version:9,updatedAt:new Date().toISOString(),appConfig:_naClone(appConfig),ui:{currentPage:document.querySelector('.page.active')?.id||'pageMenu',isDark:document.body.classList.contains('dark'),currentCfgCategory},locks:_naGetLocks(),security:_naClone(_naSecurity),data:{productos:_naClone(productos),ventas:_naClone(ventas),clientes:_naClone(clientes),creditos:_naClone(creditos),gastos:_naClone(gastos),cajMovs:_naClone(cajMovs),cajEstado:_naClone(cajEstado),cashClosures:_naClone(cashClosures),inventoryMovements:_naClone(inventoryMovements)},cart:_naClone(cart),draft:_naGetJSON('na_cart_draft',null),...(cloudSync?{cloudSync}: {})};
}
function _naParseStoredSnapshot(raw){if(typeof raw!=='string'||!raw)return null;try{return JSON.parse(raw);}catch(error){return null;}}
function _naCanonicalRuntimeEnabled(){return typeof NuevoAmanecerCanonical!=='undefined'&&NuevoAmanecerCanonical&&typeof NuevoAmanecerCanonical.enabled==='function'&&NuevoAmanecerCanonical.enabled();}
function _naValidLocalConfigState(state){return !!(state&&state.version===1&&state.appConfig&&typeof state.appConfig==='object'&&!Array.isArray(state.appConfig));}
function _naBuildLocalConfigState(){
  _naCaptureVisibleConfig();_naSaveTicketSettings();
  return{version:1,updatedAt:new Date().toISOString(),appConfig:_naClone(appConfig),ui:{currentPage:document.querySelector('.page.active')?.id||'pageMenu',isDark:document.body.classList.contains('dark'),currentCfgCategory},locks:_naGetLocks(),security:_naClone(_naSecurity)};
}
function _naReadLocalConfigState(){
  const local=_naParseStoredSnapshot(storage.readPersistent(_NA_LOCAL_CONFIG_KEY));if(_naValidLocalConfigState(local))return local;
  const session=_naParseStoredSnapshot(storage.readSession(_NA_LOCAL_CONFIG_KEY));return _naValidLocalConfigState(session)?session:null;
}
function _naApplyLocalConfigState(state){
  if(!_naValidLocalConfigState(state))return false;
  appConfig=_naMerge(_naDefaults,state.appConfig);_naEnsureCashierConfig();
  if(state.ui&&typeof state.ui==='object'){_naLoadedUIState={..._naLoadedUIState,...state.ui};if(state.ui.currentCfgCategory)currentCfgCategory=state.ui.currentCfgCategory;}
  if(state.locks&&typeof state.locks==='object')_naApplyLocks(state.locks);
  if(state.security&&typeof state.security==='object'){_naSecurity=_naSecMerge(state.security);_naSaveSecurity(false);}
  return true;
}
function _naPersistLocalConfigState(){
  let serialized;
  try{serialized=JSON.stringify(_naBuildLocalConfigState());if(typeof serialized!=='string')throw new Error('La configuración no se pudo serializar');}
  catch(error){return Promise.resolve(_naPersistFailed(error));}
  const local=storage.writePersistent(_NA_LOCAL_CONFIG_KEY,serialized),session=storage.writeSession(_NA_LOCAL_CONFIG_KEY,serialized);
  if(local.ok&&local.verified)return Promise.resolve({ok:true,durable:true,temporary:false,storage:'localStorage',verified:true,error:null});
  if(session.ok&&session.verified)return Promise.resolve({ok:true,durable:false,temporary:true,storage:'sessionStorage',verified:true,error:_naSafePersistError(local.error)||{name:'StorageError',code:'',message:'No se pudo verificar almacenamiento permanente'}});
  return Promise.resolve(_naPersistFailed(local.error||session.error));
}
function _naReadLocalSnapshot(){return _naParseStoredSnapshot(storage.readPersistent(_NA_LOCAL_KEY));}
function _naReadSessionSnapshot(){return _naParseStoredSnapshot(storage.readSession(_NA_SESSION_KEY)||storage.readSession(_NA_LOCAL_KEY));}
function _naWriteLocalSnapshot(serialized){return storage.writePersistent(_NA_LOCAL_KEY,serialized);}
function _naWriteSessionSnapshot(serialized){return storage.writeSession(_NA_SESSION_KEY,serialized);}
// Boot reads of loadAllData() reused once by the first canonical replica read (invalidated by any write).
let _naBootStorageReads=null;
async function _naCommitSnapshot(snapshot,serialized){_naBootStorageReads=null;
  if(typeof NuevoAmanecerCanonical!=='undefined'&&NuevoAmanecerCanonical.enabled()&&!_naCanonicalReplicaCommit)return _naPersistFailed(new Error('CANONICAL_LEGACY_PERSISTENCE_BLOCKED'));
  const local=_naWriteLocalSnapshot(serialized),session=_naWriteSessionSnapshot(serialized),idb=await _naWriteIDBSnapshot(snapshot,serialized);
  const idbOK=!!(idb.ok&&idb.verified),localOK=!!(local.ok&&local.verified),sessionOK=!!(session.ok&&session.verified),durable=idbOK||localOK,temporary=!durable&&sessionOK;
  const storageName=idbOK?'indexedDB':localOK?'localStorage':sessionOK?'sessionStorage':'none',error=durable?null:_naSafePersistError(idb.error||local.error||session.error)||{name:'StorageError',code:'',message:'No fue posible verificar un almacenamiento permanente'};
  return{ok:durable||temporary,durable,temporary,storage:storageName,verified:durable||temporary,error};
}
let _naCanonicalReplicaCommit=false;
function _naCanonicalReplicaOrder(a,b){if(!a)return-1;if(!b)return 1;if(a.authority_epoch!==b.authority_epoch)return a.authority_epoch>b.authority_epoch?1:-1;if(a.promotion_id!==b.promotion_id)return 0;if(a.revision!==b.revision)return a.revision>b.revision?1:-1;const af=Number(a.financial_revision||0),bf=Number(b.financial_revision||0);return af===bf?0:af>bf?1:-1;}
window._naReadCanonicalReplica=async function(){const boot=_naBootStorageReads;_naBootStorageReads=null;const idb=boot?boot.idb:await _naReadIDBSnapshot(),local=boot?boot.local:_naReadLocalSnapshot(),items=[idb,local].filter(s=>_naValidSnapshot(s)&&s.canonicalReplica);if(!items.length)return null;if(items.length===1)return _naClone(items[0].canonicalReplica);const order=_naCanonicalReplicaOrder(items[0].canonicalReplica,items[1].canonicalReplica);if(order===0&&items[0].canonicalReplica.promotion_id!==items[1].canonicalReplica.promotion_id)return null;return _naClone(items[order>=0?0:1].canonicalReplica);};
window._naWriteCanonicalReplica=function(replica){const persist=async()=>{try{const candidates=[await _naReadIDBSnapshot(),_naReadLocalSnapshot(),_naReadSessionSnapshot()].filter(_naValidSnapshot).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))),current=candidates[0]||_naLegacySnapshot();const base=_naValidSnapshot(current)?current:_naBuildSnapshot();const next=_naClone(base);next.canonicalReplica=_naClone(replica);const serialized=JSON.stringify(next);_naCanonicalReplicaCommit=true;try{const result=await _naCommitSnapshot(next,serialized);if(_naWasPersisted(result))_naCloudDurableSnapshot=_naClone(next);return _naPublishPersistResult(result);}finally{_naCanonicalReplicaCommit=false;}}catch(error){return _naPublishPersistResult(_naPersistFailed(error));}};_naPersistChain=_naPersistChain.then(persist,persist);return _naPersistChain;};
function _naPublishPersistResult(result){
  _naLastPersistResult=result;_naLastPersistOK=!!result.durable;
  if(result.durable){_naPersistWarningState='';_naSetSaveStatus(true,result.storage==='indexedDB'?'Guardado permanente verificado':'Guardado local verificado');return result;}
  if(result.temporary){_naSetSaveStatus(false,'Solo respaldo temporal · exporta una copia');if(_naPersistWarningState!=='temporary'){_naPersistWarningState='temporary';toast('Los datos solo están respaldados en esta pestaña y podrían perderse al cerrarla. Exporta un respaldo JSON.','error');}return result;}
  _naSetSaveStatus(false,'Sin almacenamiento · exporta una copia');if(_naPersistWarningState!=='failed'){_naPersistWarningState='failed';toast('No se pudo guardar ni crear un respaldo temporal. No cierres la pestaña y exporta un respaldo si está disponible.','error');}return result;
}
function _naQueuePersist(){
  if(typeof NuevoAmanecerCanonical!=='undefined'&&NuevoAmanecerCanonical.enabled())return Promise.resolve(_naPersistFailed(new Error('CANONICAL_LEGACY_PERSISTENCE_BLOCKED')));
  let snapshot,serialized;
  try{snapshot=_naBuildSnapshot();serialized=JSON.stringify(snapshot);if(typeof serialized!=='string')throw new Error('El estado no se pudo serializar');}catch(error){console.error('[Persistencia] No se pudo preparar el guardado:',error?.name||'Error');return Promise.resolve(_naPublishPersistResult(_naPersistFailed(error)));}
  const persist=async()=>{const outbox=typeof NuevoAmanecerOutbox!=='undefined'?NuevoAmanecerOutbox:null;let nextCloudSync=null;try{if(outbox){nextCloudSync=await outbox.prepare(snapshot);snapshot.cloudSync=nextCloudSync;serialized=JSON.stringify(snapshot);}const result=await _naCommitSnapshot(snapshot,serialized);if(outbox&&_naWasPersisted(result)){outbox.accept(nextCloudSync);_naCloudDurableSnapshot=_naClone(snapshot);outbox.scheduleSync();}return _naPublishPersistResult(result);}catch(error){console.error('[Persistencia] Falló la cola de guardado:',error?.name||'Error');return _naPublishPersistResult(_naPersistFailed(error));}};
  _naPersistChain=_naPersistChain.then(persist,persist);
  return _naPersistChain;
}
function _naQueueCloudSyncPersist(operation,patch){
  const persist=async()=>{try{const snapshot=_naClone(_naCloudDurableSnapshot);if(!_naValidSnapshot(snapshot))throw new Error('No existe snapshot durable para actualizar el OUTBOX');const nextCloudSync=NuevoAmanecerOutbox.updateState(snapshot.cloudSync,operation,patch);snapshot.cloudSync=nextCloudSync;const result=await _naCommitSnapshot(snapshot,JSON.stringify(snapshot));if(_naWasPersisted(result)){NuevoAmanecerOutbox.accept(nextCloudSync);_naCloudDurableSnapshot=_naClone(snapshot);}return _naPublishPersistResult(result);}catch(error){console.error('[Persistencia] No se pudo guardar el estado OUTBOX:',error?.name||'Error');return _naPublishPersistResult(_naPersistFailed(error));}};
  _naPersistChain=_naPersistChain.then(persist,persist);return _naPersistChain;
}
const _naWasPersisted=result=>!!(result&&result.durable&&result.verified);
function _naFlushRecoveryBeforeUnload(){try{const outbox=typeof NuevoAmanecerOutbox!=='undefined'?NuevoAmanecerOutbox:null,snapshot=outbox?_naClone(_naCloudDurableSnapshot):_naBuildSnapshot();if(outbox&&!snapshot)return _naPersistFailed(new Error('No existe snapshot durable para recuperar'));const serialized=JSON.stringify(snapshot);if(typeof serialized!=='string')return _naPersistFailed(new Error('El estado no se pudo serializar'));const local=_naWriteLocalSnapshot(serialized),session=_naWriteSessionSnapshot(serialized),durable=!!(local.ok&&local.verified),temporary=!durable&&!!(session.ok&&session.verified);return{ok:durable||temporary,durable,temporary,storage:durable?'localStorage':temporary?'sessionStorage':'none',verified:durable||temporary,error:durable?null:_naSafePersistError(local.error||session.error)};}catch(error){console.error('[Persistencia] No se pudo preparar la recuperación de cierre:',error?.name||'Error');return _naPersistFailed(error);}}
async function _naFinalizeOperationPersistence(successMessage,failureMessage='No se pudo guardar el cambio'){
  const result=await saveAllData();
  if(_naWasPersisted(result)){if(successMessage)toast(successMessage,'success');return result;}
  toast(result.temporary?`${failureMessage}. Solo existe una copia temporal en esta pestaña.`:failureMessage,'error');return result;
}
function _naValidSnapshot(s){return !!(s&&typeof s==='object'&&s.data&&Array.isArray(s.data.productos)&&Array.isArray(s.data.ventas)&&Array.isArray(s.data.clientes)&&Array.isArray(s.data.creditos)&&Array.isArray(s.data.gastos)&&Array.isArray(s.data.cajMovs)&&(!Object.prototype.hasOwnProperty.call(s.data,'inventoryMovements')||Array.isArray(s.data.inventoryMovements))&&(!Object.prototype.hasOwnProperty.call(s,'cloudSync')||typeof NuevoAmanecerOutbox==='undefined'||NuevoAmanecerOutbox.valid(s.cloudSync)));}
function _naApplySnapshot(s,allowCanonicalReplica=false){
  if(typeof NuevoAmanecerCanonical!=='undefined'&&NuevoAmanecerCanonical.enabled()&&!allowCanonicalReplica)return false;
  if(!_naValidSnapshot(s))return false;_naLoadedUIState=s.ui||{};appConfig=_naMerge(_naDefaults,s.appConfig||{});_naEnsureCashierConfig();productos=s.data.productos;ventas=s.data.ventas;clientes=s.data.clientes;creditos=s.data.creditos;gastos=s.data.gastos;cajMovs=s.data.cajMovs;cajEstado=s.data.cajEstado||cajEstado;cashClosures=Array.isArray(s.data.cashClosures)?s.data.cashClosures:[];inventoryMovements=Array.isArray(s.data.inventoryMovements)?s.data.inventoryMovements:[];cart=Array.isArray(s.cart)?s.cart:[];if(typeof NuevoAmanecerOutbox!=='undefined'){NuevoAmanecerOutbox.restore(s.cloudSync,s);NuevoAmanecerOutbox.initializeBaseline(s);}if(s.ui?.currentCfgCategory)currentCfgCategory=s.ui.currentCfgCategory;if(s.locks)_naApplyLocks(s.locks);if(s.security){_naSecurity=_naSecMerge(s.security);_naSaveSecurity(false);}if(s.draft)storage.setItem('na_cart_draft',JSON.stringify(s.draft));return true;
}
function _naLegacySnapshot(){
  const p=_naGetJSON('na_productos',null),v=_naGetJSON('na_ventas',null),c=_naGetJSON('na_clientes',null),cr=_naGetJSON('na_creditos',null),g=_naGetJSON('na_gastos',null),cm=_naGetJSON('na_cajMovs',null),ce=_naGetJSON('na_cajEstado',null),legacyState=_naGetJSON('na_app_state',{}),savedCart=_naGetJSON('na_cart',[]);
  if(![p,v,c,cr,g,cm].some(Array.isArray))return null;
  return{version:8,updatedAt:new Date(0).toISOString(),appConfig:_naMerge(_naDefaults,legacyState),ui:{currentPage:legacyState.currentPage||'pageMenu',isDark:!!legacyState.isDark,currentCfgCategory:storage.getItem('na_cfg_category')||'negocio'},locks:_naGetLocks(),data:{productos:Array.isArray(p)?p:productos,ventas:Array.isArray(v)?v:[],clientes:Array.isArray(c)?c:[],creditos:Array.isArray(cr)?cr:[],gastos:Array.isArray(g)?g:[],cajMovs:Array.isArray(cm)?cm:[],cajEstado:ce||cajEstado},cart:Array.isArray(savedCart)?savedCart:[]};
}
const _naTracksStock=p=>p?.controlInventario!==false;
function _naReconcileCart(source){let changed=0;const out=[];for(const old of Array.isArray(source)?source:[]){const prod=productos.find(p=>String(p.id)===String(old.id));if(!prod){if(Number(old.id)<0)out.push(old);else changed++;continue;}const mode=old.ventaModo==='caja'||_naInt(old.unitsPerQty,1)>1?'caja':'unidad',units=mode==='caja'?_naInt(prod.unidCaja,0):1;if(mode==='caja'&&(!appConfig.mayoristaActive||units<1||_naNumber(prod.precioCaja)<=0)){changed++;continue;}const maxQty=_naTracksStock(prod)&&!_naFreeSaleCfg().allowRegisteredNoStock?Math.floor(prod.stock/Math.max(1,units)):Number.MAX_SAFE_INTEGER;if(maxQty<1){changed++;continue;}const qty=Math.min(Math.max(1,_naNumber(old.qty,1)),maxQty),basePrice=mode==='caja'?_naNumber(prod.precioCaja):_naNumber(prod.precio);let price=basePrice;if(old._descuento>0)price=Number((basePrice*(100-old._descuento)/100).toFixed(2));out.push({...prod,qty,precio:price,costo:prod.costo,unitsPerQty:units,_lineKey:_naLineKey(prod.id,mode),ventaModo:mode,_precioOriginal:old._descuento>0?basePrice:undefined,_descuento:old._descuento||undefined});if(qty!==old.qty||price!==old.precio)changed++;}return{cart:out,changed};}
saveAppState=function(){return _naCanonicalRuntimeEnabled()?_naPersistLocalConfigState():_naQueuePersist();};
saveAllData=function(){return _naQueuePersist();};
loadAllData=async function(){
  if(_naCanonicalRuntimeEnabled()){
    const [idb,local]=await Promise.all([_naReadIDBSnapshot(),Promise.resolve(_naReadLocalSnapshot())]);_naBootStorageReads={idb,local};const saved=[idb,local].filter(_naValidSnapshot).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))[0]||_naLegacySnapshot();
    if(saved){_naApplySnapshot(saved,true);_naCloudDurableSnapshot=_naClone(saved);}
    const localConfig=_naReadLocalConfigState();if(localConfig)_naApplyLocalConfigState(localConfig);
    _naNormalizeData();return;
  }
  const [idb,local,session]=await Promise.all([_naReadIDBSnapshot(),Promise.resolve(_naReadLocalSnapshot()),Promise.resolve(_naReadSessionSnapshot())]),candidates=[{snapshot:idb,storage:'indexedDB',durable:true},{snapshot:local,storage:'localStorage',durable:true},{snapshot:session,storage:'sessionStorage',durable:false}].filter(item=>_naValidSnapshot(item.snapshot)).sort((a,b)=>String(b.snapshot.updatedAt||'').localeCompare(String(a.snapshot.updatedAt||''))),source=candidates[0]||null;let chosen=source?.snapshot||_naLegacySnapshot();
  if(chosen){_naApplySnapshot(chosen);_naCloudDurableSnapshot=_naClone(chosen);}
  if(source&&!source.durable)_naPublishPersistResult({ok:true,durable:false,temporary:true,storage:'sessionStorage',verified:true,error:{name:'TemporaryRecovery',code:'',message:'Se recuperó el estado desde la pestaña actual'}});
  const seeded=_naApplySeedCatalog(false,!!chosen);
  _naNormalizeData();const rec=_naReconcileCart(cart);cart=rec.cart;if(rec.changed)toast(`${rec.changed} artículo(s) del carrito fueron ajustados al stock actual`,'error');
  if(!chosen||seeded)await saveAllData();
};
loadAppState=function(){
  const snap=_naReadLocalSnapshot()||_naReadSessionSnapshot(),legacy=_naGetJSON('na_app_state',{}),state=Object.keys(_naLoadedUIState||{}).length?_naLoadedUIState:(_naValidSnapshot(snap)?snap.ui||{}:legacy);window.NA_THEME.resolveLegacy(!!state.isDark);window.NA_THEME.apply();_naApplyConfigUI();const pageId=state.currentPage;if(pageId&&pageId!=='pageMenu'&&document.getElementById(pageId))goPage(pageId);else _naSchedulePageRender('pageMenu');
};



const _naBaseUpdateDashboard=updateDashboard;
updateDashboard=function(){const menu=document.getElementById('pageMenu');if(menu&&!menu.classList.contains('active'))return;return _naBaseUpdateDashboard();};

getLunesSemana=function(){const d=new Date(obtenerHoy()+'T12:00:00'),day=d.getDay(),diff=day===0?6:day-1;d.setDate(d.getDate()-diff);const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),dd=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${dd}`;};
let _naPageRenderEpoch=0;
function _naActivePageId(){return document.querySelector('.page.active')?.id||'pageMenu';}
function _naRenderPageNow(id){
  if(id==='pageMenu'){updateDashboard();return;}
  if(id==='pagePOS'){posRender();posUpdateCart();return;}
  if(id==='pageInventario'){invRender();invBadges();return;}
  if(id==='pageClientes'){cliRender();return;}
  if(id==='pageCaja'){const label=document.getElementById('cajFechaLbl');if(label)label.textContent=window.NALimaTime?NALimaTime.shortDateLabel(new Date()):new Date().toLocaleDateString('es-PE',{timeZone:'America/Lima',weekday:'short',day:'numeric',month:'short'});cajRender();return;}
  if(id==='pageVentas'){ventasRender();return;}
  if(id==='pageGastos'){gasRender();return;}
  if(id==='pageConfig'){document.getElementById('pageConfig')?.classList.remove('cfg-menu-open');switchCfgCategory(currentCfgCategory);}
}
function _naSchedulePageRender(id){
  const target=document.getElementById(id),epoch=++_naPageRenderEpoch;
  if(!target)return;
  requestAnimationFrame(()=>setTimeout(()=>{
    if(epoch!==_naPageRenderEpoch||!target.classList.contains('active'))return;
    _naRenderPageNow(id);
  },0));
}
goPage=function(id){const target=document.getElementById(id);if(!target){toast('Módulo no disponible','error');return;}const configMode=id==='pageConfig'&&window.innerWidth<=960;const mobileScrollPages=new Set(['pageInventario','pageClientes','pageVentas','pageCaja','pageGastos']);const mobileScroll=window.innerWidth<=700&&mobileScrollPages.has(id);document.documentElement.classList.toggle('config-page-scroll',configMode);document.body.classList.toggle('config-page-scroll',configMode);document.body.classList.toggle('module-mobile-scroll',mobileScroll);document.documentElement.classList.remove('cfg-menu-lock');document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));target.classList.add('active');document.getElementById('backBtn').style.display='block';window.scrollTo(0,0);_naSchedulePageRender(id);saveAppState();};
goMenu=function(){document.documentElement.classList.remove('config-page-scroll','cfg-menu-lock');document.body.classList.remove('config-page-scroll','module-mobile-scroll');document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));const menu=document.getElementById('pageMenu');menu.classList.add('active');document.getElementById('backBtn').style.display='none';window.scrollTo(0,0);_naSchedulePageRender('pageMenu');saveAppState();};

// POS: precio por caja correcto, control de stock por unidades y líneas separadas.
toggleMayorista=function(){if(_naCanonSaleMode()){modoMayorista=false;const tag=document.getElementById('modoMayoristaTag');if(tag)tag.style.display='none';toast(_NA_CANON_BOX_MSG,'error');posRender();return;}if(!appConfig.mayoristaActive){toast('La venta mayorista está desactivada','error');return;}modoMayorista=!modoMayorista;const btn=document.getElementById('btnMayorista'),tag=document.getElementById('modoMayoristaTag');if(btn){btn.style.background=modoMayorista?'var(--amber-light)':'var(--white)';btn.style.borderColor=modoMayorista?'var(--amber)':'var(--border)';btn.style.color=modoMayorista?'#b45309':'var(--dark)';}if(tag)tag.style.display=modoMayorista?'inline-block':'none';toast(modoMayorista?'🛍️ Modo mayorista activado':'🛒 Modo minorista');posRender();};
posRender=function(){const s=sinTildes((document.getElementById('posSearch')?.value||'').toLowerCase()),list=productos.filter(p=>(posCat==='todo'||p.cat===posCat)&&(sinTildes((p.name||'').toLowerCase()).includes(s)||sinTildes(p.descripcion||'').includes(s)||sinTildes(p.marca||'').includes(s)||(p.sku||'').toLowerCase().includes(s)||(p.barcode||'').includes(s)||_naProductAltCodes(p).some(code=>code.toLowerCase().includes(s))));const a=document.getElementById('posArea');if(!a)return;if(!list.length){a.innerHTML='<div class="empty-state" style="grid-column:1/-1"><div class="ei"><i class="na-ic na-ic-search" aria-hidden="true"></i></div><p>Sin productos</p></div>';return;}const allowNoStock=_naAllowNoStockSale(),boxMode=modoMayorista&&!_naCanonSaleMode();a.innerHTML=list.map(p=>{const caja=boxMode&&p.precioCaja>0&&p.unidCaja>0,price=caja?p.precioCaja:p.precio,label=caja?`Caja x${p.unidCaja} · S/ ${price.toFixed(2)}`:`S/ ${price.toFixed(2)}`,tracked=_naTracksStock(p),hasStock=!tracked||p.stock>0,available=hasStock||allowNoStock,st=!tracked?'ok':p.stock<=0?'out':p.stock<=p.stockMin?'low':'ok',stockLabel=!tracked?'Sin control':(p._canonicalPendingStock&&Number.isFinite(p._canonicalRemoteStock)?`CANON ${p._canonicalRemoteStock} (−${Number(p._canonicalPendingDelta||Math.max(0,p._canonicalRemoteStock-p.stock))} pend.)`:p.stock<0?`Faltante: ${Math.abs(p.stock)}`:p.stock===0?(allowNoStock?'Sin stock · permitido':'Sin stock'):`Stock: ${p.stock}`),classes=`product-card${!hasStock?' no-stock':''}${!hasStock&&allowNoStock?' sale-allowed':''}${caja?' box-mode':''}`;return`<div class="${classes}" role="button" tabindex="${available?'0':'-1'}" aria-disabled="${available?'false':'true'}" onclick="${available?`posAdd(${JSON.stringify(p.id)})`:''}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${available?`posAdd(${JSON.stringify(p.id)})`:''}}"><div class="p-price-badge">${_naEsc(label)}</div><div class="p-img">${p.imagen?`<img src="${p.imagen}" alt="${_naEsc(p.name)}">`:_naEsc(p.icon||'📦')}</div><div class="p-stock-badge ${st}">${_naEsc(stockLabel)}</div><div class="p-name">${_naEsc(p.name)}</div></div>`;}).join('');};
function _naReservedUnits(productId,excludeKey=null){return cart.filter(it=>it.id===productId&&it._lineKey!==excludeKey).reduce((sum,it)=>sum+_naUnitsSold(it),0);}
function _naSaleUiLocked(){const canonical=typeof NuevoAmanecerCanonical!=='undefined'&&NuevoAmanecerCanonical&&typeof NuevoAmanecerCanonical.enabled==='function'&&NuevoAmanecerCanonical.enabled();return isModuleLocked('ventas',canonical?{canonicalSaleUi:true}:undefined);}
posAdd=function(id){if(_naSaleUiLocked()){toast('Las ventas están bloqueadas','error');return false;}const p=productos.find(x=>String(x.id)===String(id));if(!p)return false;const canon=_naCanonSaleMode(),box=!!(!canon&&modoMayorista&&p.precioCaja>0&&p.unidCaja>0),mode=box?'caja':'unidad',unitsPerQty=box?p.unidCaja:1,price=box?p.precioCaja:p.precio,key=_naLineKey(p.id,mode),existing=cart.find(x=>x._lineKey===key),used=_naReservedUnits(p.id,key),current=existing?_naUnitsSold(existing):0,projected=used+current+unitsPerQty,shortage=_naTracksStock(p)?Math.max(0,projected-_naNumber(p.stock)):0,allowNoStock=_naAllowNoStockSale();if(shortage>0&&!allowNoStock){toast(`Stock insuficiente: quedan ${Math.max(0,_naNumber(p.stock)-used-current)} unidades${canon?' (CANON no permite vender sin stock)':''}`,'error');return false;}if(existing)existing.qty+=1;else cart.push({...p,qty:1,precio:price,unitsPerQty,_lineKey:key,ventaModo:mode,stockAntes:_naNumber(p.stock)});_naRefreshProductCartShortage(p.id);if(shortage>0){toast(`⚠️ ${p.name} se agregó sin stock disponible`,'error');_naAudit('Venta sin stock agregada',`${p.name} · faltante ${shortage}`);}posUpdateCart();const badge=document.getElementById('cartBadge');try{if(window.NA_MOTION&&window.NA_MOTION.cart&&typeof window.NA_MOTION.cart.pulse==='function')window.NA_MOTION.cart.pulse(badge);}catch(_){}document.getElementById('cartDrawer')?.classList.add('open');document.getElementById('cartBackdrop')?.classList.add('open');const fab=document.querySelector('.cart-fab');if(fab){fab.style.transform='scale(1.18)';setTimeout(()=>fab.style.transform='scale(1)',140);}return true;};
posAddBySku=function(codigo){const code=String(codigo||'').trim(),prod=productos.find(p=>_naProductMatchesCode(p,code));if(prod){posAdd(prod.id);return;}if(!_naGenericSaleAllowed()){toast('El código no existe y la venta libre está desactivada o bloqueada','error');return;}abrirVentaLibre({codigo:code,nombre:'VARIOS'});};
posQty=function(key,d){const it=cart.find(x=>x._lineKey===String(key)||String(x.id)===String(key));if(!it)return;const prod=productos.find(p=>String(p.id)===String(it.id));if(d>0&&prod&&_naTracksStock(prod)){const usedOther=_naReservedUnits(prod.id,it._lineKey),nextUnits=(it.qty+d)*_naUnitsPerQty(it),shortage=Math.max(0,usedOther+nextUnits-_naNumber(prod.stock));if(shortage>0&&!_naFreeSaleCfg().allowRegisteredNoStock){toast(`Stock máximo alcanzado (${Math.max(0,prod.stock)} unidades)`,'error');return;}}it.qty+=d;if(it.qty<=0)cart=cart.filter(x=>x._lineKey!==it._lineKey);if(prod)_naRefreshProductCartShortage(prod.id);posUpdateCart();};
posRm=function(key){cart=cart.filter(x=>x._lineKey!==String(key)&&String(x.id)!==String(key));posUpdateCart();};
posUpdateCart=function(persist=true){
  const parts=_naTaxBreakdownForSaleItems(cart,!!appConfig.igvActive),count=cart.reduce((a,b)=>a+_naNumber(b.qty),0),units=cart.reduce((a,b)=>a+_naUnitsSold(b),0),badge=document.getElementById('cartBadge');
  if(badge){badge.style.display=count>0?'flex':'none';badge.textContent=count;badge.title=`${units} unidades físicas`;}
  document.getElementById('posSubtotal').textContent=fmt(parts.subtotal);document.getElementById('posIgv').textContent=fmt(parts.totalIGV);document.getElementById('posTotal').textContent=fmt(parts.totalVenta);document.getElementById('btnRapido').disabled=!cart.length;document.getElementById('btnPagar').disabled=!cart.length;
  const descBadge=document.getElementById('btnDescInfo'),discounts=cart.map(i=>_naNumber(i._descuento)).filter(x=>x>0);if(descBadge){descBadge.style.display=discounts.length?'block':'none';if(discounts.length)descBadge.textContent=`🏷️ Descuento activo — toca aquí para quitar`;}
  const ci=document.getElementById('cartItems');if(ci){if(!cart.length)ci.innerHTML='<div class="cart-empty">El carrito está vacío</div>';else ci.innerHTML=cart.map(it=>{const box=_naUnitsPerQty(it)>1,mode=box?`<span class="line-mode">Caja x${_naUnitsPerQty(it)}</span>`:'',desc=it._descuento>0?`<span style="font-size:10px;color:var(--amber);margin-left:4px">-${it._descuento.toFixed(1)}%</span>`:'',special=it.ventaLibre?'<span class="cart-item-flag free">VARIOS</span>':it.ventaSinStock?'<span class="cart-item-flag shortage">SIN STOCK</span>':'',key=_naEsc(it._lineKey);return`<div class="cart-item"><div style="font-size:19px">${it.imagen?`<img src="${it.imagen}" style="width:30px;height:30px;object-fit:cover;border-radius:6px" alt="${_naEsc(it.name)}">`:_naEsc(it.icon||'📦')}</div><div class="ci-info"><div class="ci-name">${_naEsc(it.name)}${desc}${special}</div><div class="ci-price">${fmt(it.precio)} ${box?'por caja':'c/u'} ${mode}</div></div><div class="ci-qty"><button class="qty-btn" onclick="posQty('${key}',-1)">−</button><span class="qty-num">${it.qty}</span><button class="qty-btn" onclick="posQty('${key}',1)">+</button></div><div class="ci-sub">${fmt(it.precio*it.qty)}</div><button class="btn-rm" aria-label="Quitar" onclick="posRm('${key}')"><i class="na-ic na-ic-trash" aria-hidden="true"></i></button></div>`;}).join('');}
  if(persist)saveAllData();
};
cancelarVenta=function(){cart=[];const badge=document.getElementById('btnDescInfo');if(badge)badge.style.display='none';posUpdateCart();document.getElementById('cartDrawer')?.classList.remove('open');document.getElementById('cartBackdrop')?.classList.remove('open');toast('Venta cancelada');};
abrirDescuento=function(){if(!cart.length){toast('El carrito está vacío','error');return;}if(typeof window._naDiscountSheet==='function'){const subtotal=cart.reduce((a,b)=>a+_naNumber(b._precioOriginal??b.precio)*_naNumber(b.qty),0);if(typeof closeCartMenu==='function')closeCartMenu();return window._naDiscountSheet(subtotal).then(desc=>{if(desc!=null)aplicarDescuentoPorcentaje(desc);});}const val=prompt('Descuento global (%) para esta venta:','0');if(val===null)return;const desc=_naNumber(val,NaN);if(!Number.isFinite(desc)||desc<=0||desc>=100){toast('Ingresa un porcentaje entre 0 y 99','error');return;}aplicarDescuentoPorcentaje(desc);};
aplicarDescuentoPorcentaje=function(desc){let limitado=false;const warnings=[];cart.forEach(it=>{if(it._precioOriginal==null)it._precioOriginal=it.precio;const base=it._precioOriginal,cost=_naNumber(it.costo)*_naUnitsPerQty(it);let maxDesc=99;if(appConfig.margenActive){if(cost>0&&cost<base)maxDesc=Math.floor(((base-cost)/base)*10000)/100;else if(cost>=base&&cost>0)maxDesc=0;}const itemDesc=Math.min(desc,maxDesc);if(itemDesc<desc){limitado=true;warnings.push(`${it.name}: máx. ${maxDesc.toFixed(1)}%`);}it.precio=Number((base*(100-itemDesc)/100).toFixed(2));it._descuento=itemDesc;});posUpdateCart();const badge=document.getElementById('btnDescInfo');if(badge){badge.style.display='block';badge.textContent=`🏷️ Descuento ${desc}% activo — toca aquí para quitar`;}toast(limitado?`Descuento ajustado para no vender bajo costo: ${warnings.slice(0,2).join(', ')}`:`Descuento de ${desc}% aplicado`,limitado?'error':'success');closeCartMenu();};

let _naClientPickerTarget='';
function _naClientPickerNormalize(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();}
function _naClientPickerButton(selectId){return document.getElementById(selectId+'SearchTrigger');}
function _naClientPickerSelectedText(select){const option=select?.options?.[select.selectedIndex];return option?.textContent?.trim()||(select?.id==='mVentaCliente'?'Sin cliente':'Selecciona un cliente');}
function _naSyncClientPickerButton(selectId){const select=document.getElementById(selectId),button=_naClientPickerButton(selectId);if(!select||!button)return;const label=button.querySelector('.na-client-picker-trigger-label');if(label)label.textContent=_naClientPickerSelectedText(select);button.classList.toggle('has-value',!!select.value);}
function _naSyncClientPickerButtons(){_naSyncClientPickerButton('mVentaCliente');_naSyncClientPickerButton('mCreditoCliente');}
function _naInstallClientPickers(){['mVentaCliente','mCreditoCliente'].forEach(selectId=>{const select=document.getElementById(selectId);if(!select)return;if(select.dataset.naSearchPicker==='1'){_naSyncClientPickerButton(selectId);return;}select.dataset.naSearchPicker='1';select.classList.add('na-client-picker-native');select.setAttribute('aria-hidden','true');select.tabIndex=-1;const button=document.createElement('button');button.type='button';button.id=selectId+'SearchTrigger';button.className='na-client-picker-trigger';button.dataset.clientSelect=selectId;button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls','mClientSearchPicker');const icon=document.createElement('span');icon.className='na-client-picker-trigger-icon';if(window.NA_ICON)icon.innerHTML=NA_ICON('search');else icon.textContent='🔍';const label=document.createElement('span');label.className='na-client-picker-trigger-label';const arrow=document.createElement('span');arrow.className='na-client-picker-trigger-arrow';arrow.textContent='⌄';button.append(icon,label,arrow);button.addEventListener('click',()=>_naOpenClientPicker(selectId));select.insertAdjacentElement('afterend',button);select.addEventListener('change',()=>_naSyncClientPickerButton(selectId));_naSyncClientPickerButton(selectId);});}
function _naEnsureClientPickerModal(){let overlay=document.getElementById('mClientSearchPicker');if(overlay)return overlay;overlay=document.createElement('div');overlay.id='mClientSearchPicker';overlay.className='modal-overlay na-client-picker-overlay';overlay.style.zIndex='430';const modal=document.createElement('div');modal.className='modal na-client-picker-modal';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','mClientSearchPickerTitle');const head=document.createElement('div');head.className='mhead teal';const title=document.createElement('div');title.id='mClientSearchPickerTitle';title.className='mhead-title';title.textContent='Selecciona un cliente';const close=document.createElement('button');close.type='button';close.className='btn-close-m';close.setAttribute('aria-label','Cerrar buscador de clientes');close.textContent='✕';close.addEventListener('click',_naCloseClientPicker);head.append(title,close);const body=document.createElement('div');body.className='mbody na-client-picker-body';const searchBox=document.createElement('div');searchBox.className='na-client-picker-search';const searchIcon=document.createElement('span');searchIcon.textContent='🔍';const input=document.createElement('input');input.id='mClientSearchInput';input.type='search';input.autocomplete='off';input.spellcheck=false;input.placeholder='Buscar por nombre o DNI...';input.setAttribute('aria-label','Buscar cliente por nombre o DNI');searchBox.append(searchIcon,input);const meta=document.createElement('div');meta.id='mClientSearchMeta';meta.className='na-client-picker-meta';const list=document.createElement('div');list.id='mClientSearchList';list.className='na-client-picker-list';body.append(searchBox,meta,list);modal.append(head,body);overlay.append(modal);overlay.addEventListener('click',event=>{if(event.target===overlay)_naCloseClientPicker();});input.addEventListener('input',()=>_naRenderClientPicker(input.value));document.body.appendChild(overlay);return overlay;}
function _naRenderClientPicker(query=''){const select=document.getElementById(_naClientPickerTarget),list=document.getElementById('mClientSearchList'),meta=document.getElementById('mClientSearchMeta');if(!select||!list)return;const needle=_naClientPickerNormalize(query),options=Array.from(select.options||[]).filter(option=>{if(!option.value&&select.id!=='mVentaCliente')return false;return !needle||_naClientPickerNormalize(option.textContent).includes(needle);});list.replaceChildren();if(!options.length){const empty=document.createElement('div');empty.className='na-client-picker-empty';empty.textContent='No se encontraron clientes con ese nombre.';list.appendChild(empty);}else options.forEach(option=>{const row=document.createElement('button');row.type='button';row.className='na-client-picker-row';if(String(select.value)===String(option.value))row.classList.add('selected');const copy=document.createElement('span');copy.className='na-client-picker-copy';const name=document.createElement('strong');const detail=document.createElement('small');if(!option.value){name.textContent='Sin cliente';detail.textContent='Registrar la venta sin asociar cliente';}else{const parts=String(option.textContent||'').split(' · ');name.textContent=parts.shift()||'Cliente';detail.textContent=parts.join(' · ');}copy.append(name,detail);const mark=document.createElement('span');mark.className='na-client-picker-mark';mark.textContent=String(select.value)===String(option.value)?'✓':'›';row.append(copy,mark);row.addEventListener('click',()=>_naChooseClientPicker(option.value));list.appendChild(row);});if(meta){const clients=options.filter(option=>!!option.value).length;meta.textContent=needle?`${clients} cliente${clients===1?'':'s'} encontrado${clients===1?'':'s'}`:`${clients} cliente${clients===1?'':'s'} disponibles`;}}
function _naOpenClientPicker(selectId){_naInstallClientPickers();const select=document.getElementById(selectId);if(!select)return;_naClientPickerTarget=selectId;const overlay=_naEnsureClientPickerModal(),title=document.getElementById('mClientSearchPickerTitle'),input=document.getElementById('mClientSearchInput');if(title)title.textContent=selectId==='mCreditoCliente'?'Selecciona el cliente del crédito':'Selecciona un cliente';if(input)input.value='';overlay.classList.add('open');_naRenderClientPicker('');setTimeout(()=>input?.focus(),40);}
function _naChooseClientPicker(value){const select=document.getElementById(_naClientPickerTarget);if(!select)return;select.value=String(value??'');select.dispatchEvent(new Event('change',{bubbles:true}));_naSyncClientPickerButton(select.id);_naCloseClientPicker();}
function _naCloseClientPicker(){document.getElementById('mClientSearchPicker')?.classList.remove('open');document.getElementById('mClientSearchInput')?.blur();}
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.getElementById('mClientSearchPicker')?.classList.contains('open'))_naCloseClientPicker();});
function _naPopulateCreditClients(){const options='<option value="">Sin cliente</option>'+clientes.slice().sort((a,b)=>a.nombre.localeCompare(b.nombre)).map(c=>`<option value="${_naEsc(c.id)}">${_naEsc(c.nombre)}${_naDocumentValue(c.dni)?' · '+_naEsc(c.dni):''}</option>`).join('');const sale=document.getElementById('mVentaCliente');if(sale)sale.innerHTML=options;const credit=document.getElementById('mCreditoCliente');if(credit)credit.innerHTML='<option value="">Selecciona un cliente</option>'+options.replace('<option value="">Sin cliente</option>','');_naInstallClientPickers();_naSyncClientPickerButtons();}
function _naSetPaymentHint(message='',tone='info'){const el=document.getElementById('mPaymentHint');if(!el)return;el.textContent=message;el.className=`payment-hint ${tone}`;}
function _naSetQuickPaymentHint(message='',tone='info'){const el=document.getElementById('mQuickPaymentHint');if(!el)return;el.textContent=message;el.className=`payment-hint ${tone}`;}
function _naDigitalSalePayment(method=posPayM){return method==='yape'||method==='plin'||method==='transferencia'||method==='mixto';}
function _naDigitalVerificationControl(){if(posPayM==='mixto')return document.getElementById('mMixedDigitalVerified');if(posPayM==='transferencia'&&_naQuickPaymentActive)return document.getElementById('mQuickDigitalVerified');if(posPayM==='yape'||posPayM==='plin'||posPayM==='transferencia')return document.getElementById('mDigitalVerified');return null;}
function _naDigitalPaymentVerified(){return _naDigitalVerificationControl()?.checked===true;}
function _naQuickPaymentVerificationChanged(){const verified=document.getElementById('mQuickDigitalVerified')?.checked===true;_naSetQuickPaymentHint(verified?'Pago verificado. Ya puedes registrar la transferencia.':'Debes verificar que recibiste el pago antes de registrar una transferencia.',verified?'ok':'error');}
function _naPaymentFocusTarget(){const verification=_naDigitalVerificationControl();if(_naDigitalSalePayment()&&verification?.checked!==true)return verification;if(posPayM==='efectivo')return document.getElementById('mMontoRec');if(posPayM==='credito')return document.getElementById('mCreditoCliente');if(posPayM==='mixto')return _naNumber(document.getElementById('mMixedCash')?.value)>0?document.getElementById('mMixedRef'):document.getElementById('mMixedCash');return document.getElementById('mDigitalRef');}
// Money in integer cents: cash is limited to 2 decimals and digital = total - cash exactly.
function _naMixedPaymentData(){const totalCents=cart.reduce((a,b)=>a+Math.round(_naNumber(b.precio)*100)*_naNumber(b.qty),0),total=totalCents/100,cashCents=Math.max(0,Math.round(_naNumber(document.getElementById('mMixedCash')?.value)*100)),cash=cashCents/100,digital=Math.max(0,totalCents-cashCents)/100,digitalMethod=document.getElementById('mMixedDigitalMethod')?.value||'transferencia',reference=_naClean(document.getElementById('mMixedRef')?.value);return{total,cash,digital,digitalMethod,reference};}
function setMixedCash(amount){const input=document.getElementById('mMixedCash');if(!input)return;input.value=_naNumber(amount).toFixed(2);document.querySelectorAll('[data-mixed-cash]').forEach(btn=>btn.classList.toggle('active',_naNumber(btn.dataset.mixedCash)===_naNumber(amount)));calcMixedPayment();input.focus();}
function calcMixedPayment(){const data=_naMixedPaymentData(),amount=document.getElementById('mMixedDigitalAmount'),summary=document.getElementById('mMixedSummaryText'),sumTotal=document.getElementById('mMixedSummaryTotal');if(amount)amount.textContent=fmt(data.digital);if(sumTotal)sumTotal.textContent=fmt(data.cash+data.digital);if(summary){if(data.cash<=0)summary.textContent='Ingresa cuánto paga en efectivo.';else if(data.cash>=data.total)summary.textContent='El efectivo debe ser menor al total para usar pago mixto.';else summary.textContent=`${fmt(data.cash)} en efectivo + ${fmt(data.digital)} por ${data.digitalMethod==='yape'?'Yape':data.digitalMethod==='plin'?'Plin':'transferencia'}.`;}document.querySelectorAll('[data-mixed-cash]').forEach(btn=>btn.classList.toggle('active',Math.abs(_naNumber(btn.dataset.mixedCash)-data.cash)<.001));_naValidatePaymentForm();}
let _naQuickPaymentActive=false,_naQuickPaymentProc=false;

function _naOpenQuickPayment(){
  if(_naSaleUiLocked()){
    toast('El modulo de ventas esta bloqueado en Control maestro','error');
    return;
  }

  if(!_naSessionOpen()){
    toast('Primero abre la caja del dia para registrar ventas','error');
    goPage('pageCaja');
    return;
  }

  const total=cart.reduce((sum,item)=>sum+_naNumber(item.precio)*_naNumber(item.qty),0);
  const totalEl=document.getElementById('mQuickPaymentTotal');

  if(totalEl)totalEl.textContent=fmt(total);

  _naQuickPaymentActive=false;
  _naQuickPaymentProc=false;

  const verification=document.getElementById('mQuickDigitalVerified');
  if(verification)verification.checked=false;
  _naSetQuickPaymentHint('Para transferencia, confirma primero que el pago fue recibido.','info');

  document.querySelectorAll('#mCobroRapido .quick-pay-option').forEach(button=>{
    button.disabled=false;
  });

  document.getElementById('mCobroRapido')?.classList.add('open');
  document.querySelector('#mCobroRapido .pay-modal-body')?.scrollTo(0,0);
}

async function confirmarPagoRapido(method){
  if(!['efectivo','transferencia'].includes(method)||_naQuickPaymentProc||posProc||!cart.length)return;

  if(method==='transferencia'&&document.getElementById('mQuickDigitalVerified')?.checked!==true){
    const message='Debes verificar que recibiste el pago antes de registrar la transferencia.';
    _naSetQuickPaymentHint(message,'error');
    toast(message,'error');
    document.getElementById('mQuickDigitalVerified')?.focus();
    return;
  }

  _naQuickPaymentProc=true;
  _naQuickPaymentActive=method==='transferencia';
  posPayM=method;

  const buttons=[...document.querySelectorAll('#mCobroRapido .quick-pay-option')];
  buttons.forEach(button=>button.disabled=true);

  const total=cart.reduce((sum,item)=>sum+_naNumber(item.precio)*_naNumber(item.qty),0);
  const cashInput=document.getElementById('mMontoRec');
  const digitalRef=document.getElementById('mDigitalRef');

  if(cashInput)cashInput.value=total.toFixed(2);
  if(digitalRef)digitalRef.value='';

  const previousCartLength=cart.length;

  try{
    await confirmarVenta();

    if(previousCartLength>0&&!cart.length){
      cerrarModal('mCobroRapido');
    }
  }finally{
    _naQuickPaymentActive=false;
    _naQuickPaymentProc=false;
    buttons.forEach(button=>button.disabled=false);
  }
}
function _naPaymentState(){const total=cart.reduce((a,b)=>_naNumber(a)+_naNumber(b.precio)*_naNumber(b.qty),0);if(!cart.length)return{valid:false,message:'El carrito está vacío.',tone:'error'};if(posPayM==='efectivo'){const received=_naNumber(document.getElementById('mMontoRec')?.value);if(received+0.0001<total)return{valid:false,message:`Falta recibir ${fmt(Math.max(0,total-received))}.`,tone:'error'};return{valid:true,message:received>total?`Vuelto: ${fmt(received-total)}.`:'Monto exacto listo para cobrar.',tone:'ok'};}if(posPayM==='mixto'){const mix=_naMixedPaymentData();if(mix.cash<=0)return{valid:false,message:'Ingresa el monto pagado en efectivo.',tone:'error'};if(mix.cash>=total)return{valid:false,message:'Para pago mixto, el efectivo debe ser menor al total.',tone:'error'};if(mix.digital<=0)return{valid:false,message:'El monto digital debe ser mayor que cero.',tone:'error'};if(!_naDigitalPaymentVerified())return{valid:false,message:'Confirma que verificaste la recepción del pago digital.',tone:'error'};if(mix.reference&&ventas.some(v=>!v.anulada&&v.paymentRef===mix.reference))return{valid:false,message:'Ese número de operación ya fue registrado.',tone:'error'};return{valid:true,message:`Pago dividido: ${fmt(mix.cash)} efectivo + ${fmt(mix.digital)} digital.`,tone:'ok'};}if(posPayM==='credito'){if(!document.getElementById('mCreditoCliente')?.value)return{valid:false,message:'Selecciona el cliente del crédito.',tone:'error'};if(!document.getElementById('mCreditoVence')?.value)return{valid:false,message:'Selecciona la fecha de vencimiento.',tone:'error'};return{valid:true,message:'Crédito listo para registrar.',tone:'ok'};}if(posPayM==='yape'||posPayM==='plin'||posPayM==='transferencia'){const ref=_naClean(document.getElementById('mDigitalRef')?.value);if(!_naDigitalPaymentVerified())return{valid:false,message:'Confirma que verificaste la recepción del pago digital.',tone:'error'};if(ref&&ventas.some(v=>!v.anulada&&v.paymentRef===ref))return{valid:false,message:'Ese número de operación ya fue registrado.',tone:'error'};return{valid:true,message:'Pago digital verificado y listo para confirmar.',tone:'ok'};}return{valid:true,message:'Venta lista para confirmar.',tone:'ok'};}
function _naValidatePaymentForm(){const btn=document.getElementById('mBtnConf');if(!btn)return false;const state=_naPaymentState();btn.dataset.valid=state.valid?'true':'false';btn.classList.toggle('ready',state.valid);btn.classList.toggle('needs-data',!state.valid);btn.disabled=!!posProc;btn.textContent=posProc?'Procesando…':state.valid?'Confirmar venta':'Revisar datos';_naSetPaymentHint(state.message,state.tone);return state.valid;}
function _naQuickCashOptions(total){total=_naNumber(total);const denominations=[10,20,50,100];return denominations.filter(amount=>amount>total);}
function _naRenderCashQuickOptions(total){const inlineWrap=document.getElementById('mCashQuickInline'),advWrap=document.querySelector('#mCashAdvanced .pay-quick-row');const amounts=_naQuickCashOptions(total);if(inlineWrap){inlineWrap.innerHTML=(_naNumber(total)>0?`<button type="button" data-cash-exact="1" onclick="setMontoExacto(false)">Exacto</button>`:'')+amounts.map(amount=>`<button type="button" data-cash-inline="${amount}" onclick="setMontoRecibido(${amount},false)">S/ ${amount}</button>`).join('');inlineWrap.style.display=(amounts.length||_naNumber(total)>0)?'grid':'none';}if(advWrap){advWrap.innerHTML=amounts.map(amount=>`<button type="button" data-cash="${amount}" onclick="setMontoRecibido(${amount},true)">${amount}</button>`).join('');}}
function _naUpdateCashQuickHighlights(amount){const numeric=_naNumber(amount);document.querySelectorAll('.cash-quick-row button,[data-cash-inline]').forEach(btn=>{const data=_naNumber(btn.dataset.cash||btn.dataset.cashInline);btn.classList.toggle('active',Math.abs(data-numeric)<0.001);});}
// PC y tablet: los montos rápidos (Exacto, S/ 10, 20...) se ven siempre, sin pasar por «Otros montos». Teléfono igual que antes.
function _naCashQuickAlwaysOpen(){try{return matchMedia('(min-width:701px)').matches&&!document.body.classList.contains('na-pos-phone-device');}catch(_){return false;}}
function toggleOtherCashAmounts(open=true){const auto=!open&&_naCashQuickAlwaysOpen();if(auto)open=true;const advanced=document.getElementById('mCashAdvanced'),simple=document.getElementById('mCashSimple'),input=document.getElementById('mMontoRec');if(!advanced||!simple)return;advanced.hidden=!open;simple.hidden=open;if(open){const total=cart.reduce((a,b)=>a+_naNumber(b.precio)*_naNumber(b.qty),0);if(input&&_naNumber(input.value)<=0)input.value=total.toFixed(2);calcCambio();_naUpdateCashQuickHighlights(input?.value);if(!auto)setTimeout(()=>{input?.focus();input?.select?.();},60);}}
function setMontoExacto(collapse=false){const total=cart.reduce((a,b)=>a+_naNumber(b.precio)*_naNumber(b.qty),0),input=document.getElementById('mMontoRec');if(!input)return;input.value=total.toFixed(2);_naUpdateCashQuickHighlights(null);calcCambio();if(collapse)toggleOtherCashAmounts(false);}
function setMontoRecibido(amount,focusInput=false){const input=document.getElementById('mMontoRec');if(!input)return;input.value=_naNumber(amount).toFixed(2);_naUpdateCashQuickHighlights(amount);calcCambio();if(focusInput){input.focus();input.select?.();}}
function sumarMontoRecibido(amount){setMontoRecibido(amount,true);}
abrirCobro=function(tipo){if(!cart.length||posProc)return;if(tipo==='rapido'){_naOpenQuickPayment();return;}_naQuickPaymentActive=false;if(_naSaleUiLocked()){toast('El módulo de ventas está bloqueado en Control maestro','error');return;}if(!_naSessionOpen()){toast('Primero abre la caja del día para registrar ventas','error');goPage('pageCaja');return;}const total=cart.reduce((a,b)=>a+_naNumber(b.precio)*_naNumber(b.qty),0),btn=document.getElementById('mBtnConf'),received=document.getElementById('mMontoRec');document.getElementById('mCobroTotal').textContent=fmt(total);received.value=total.toFixed(2);document.querySelectorAll('.cash-quick-row button,[data-mixed-cash],[data-cash-inline]').forEach(btn=>btn.classList.remove('active'));_naRenderCashQuickOptions(total);document.getElementById('mCambio').textContent='S/ 0.00';document.getElementById('mDigitalRef').value='';document.getElementById('mMixedRef').value='';document.getElementById('mMixedCash').value='';document.getElementById('mMixedDigitalMethod').value='transferencia';document.getElementById('mDigitalVerified').checked=false;document.getElementById('mMixedDigitalVerified').checked=false;document.getElementById('mVentaCliente').value='';btn.textContent='Confirmar venta';posPayM='efectivo';document.querySelectorAll('.pm-btn').forEach(b=>b.classList.toggle('active',b.dataset.method==='efectivo'));document.getElementById('mEfSection').style.display='block';document.getElementById('mCreditoSection').style.display='none';document.getElementById('mDigitalSection').style.display='none';document.getElementById('mMixedSection').style.display='none';toggleOtherCashAmounts(false);_naPopulateCreditClients();document.getElementById('mCreditoVence').value=_naDatePlus((typeof _naCreditPolicy==='function'&&_naCreditPolicy().dueDays)||30);const clientDetails=document.getElementById('mClienteDetails');if(clientDetails)clientDetails.open=false;document.getElementById('mCobro').classList.add('open');document.querySelector('#mCobro .pay-modal-body')?.scrollTo(0,0);calcCambio();calcMixedPayment();_naValidatePaymentForm();};
selPM=function(btn){document.querySelectorAll('.pm-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');posPayM=btn.dataset.method;document.getElementById('mEfSection').style.display=posPayM==='efectivo'?'block':'none';document.getElementById('mCreditoSection').style.display=posPayM==='credito'?'block':'none';document.getElementById('mDigitalSection').style.display=(posPayM==='yape'||posPayM==='plin'||posPayM==='transferencia')?'block':'none';document.getElementById('mMixedSection').style.display=posPayM==='mixto'?'block':'none';document.getElementById('mDigitalLabel').textContent=posPayM==='yape'?'Número de operación Yape (opcional)':posPayM==='plin'?'Número de operación Plin (opcional)':'Número de operación o referencia bancaria (opcional)';if(posPayM==='efectivo'){setMontoExacto(true);}if(posPayM==='mixto'){const total=cart.reduce((a,b)=>a+_naNumber(b.precio)*_naNumber(b.qty),0),input=document.getElementById('mMixedCash');if(!_naNumber(input.value))input.value=(total>20?20:Math.max(.01,total/2)).toFixed(2);calcMixedPayment();setTimeout(()=>input.focus(),50);}_naValidatePaymentForm();};
calcCambio=function(){const total=cart.reduce((a,b)=>a+_naNumber(b.precio)*_naNumber(b.qty),0),received=_naNumber(document.getElementById('mMontoRec')?.value),change=(Math.round(received*100)-Math.round(total*100))/100,el=document.getElementById('mCambio'),note=document.getElementById('mCashInlineNote');if(el){el.textContent=fmt(Math.max(0,change));el.style.color=change<0?'var(--red)':'#16a34a';}if(note){note.textContent=received>total?`Recibido: ${fmt(received)} · Vuelto: ${fmt(Math.max(0,change))}`:received<total?`Falta recibir ${fmt(Math.max(0,total-received))}.`:'Monto exacto listo para cobrar.';note.style.color=received<total?'var(--red)':'#15803d';}_naValidatePaymentForm();};
document.addEventListener('keydown',event=>{if(event.key==='Enter'&&document.getElementById('mCobro')?.classList.contains('open')&&!posProc&&_naValidatePaymentForm()){event.preventDefault();confirmarVenta();}});
document.addEventListener('input',event=>{if(['mCreditoCliente','mCreditoVence','mDigitalRef','mMontoRec','mMixedCash','mMixedRef'].includes(event.target?.id))_naValidatePaymentForm();});document.addEventListener('change',event=>{if(['mCreditoCliente','mCreditoVence','mVentaCliente','mMixedDigitalMethod','mDigitalVerified','mMixedDigitalVerified'].includes(event.target?.id))_naValidatePaymentForm();});
confirmarVenta=async function(){
  if(isModuleLocked('ventas')){toast('Las ventas están bloqueadas','error');return;}if(posProc||!cart.length)return;if(!_naSessionOpen()){toast('La caja no está abierta','error');return;}
  for(const item of cart){const prod=productos.find(p=>String(p.id)===String(item.id));if(prod&&_naTracksStock(prod)){const reserved=cart.filter(x=>String(x.id)===String(item.id)).reduce((a,x)=>a+_naUnitsSold(x),0);if(reserved>prod.stock&&!_naFreeSaleCfg().allowRegisteredNoStock){toast(`Stock insuficiente para ${prod.name}: quedan ${prod.stock} unidades`,'error');return;}}}
  const cartTaxBreakdown=_naTaxBreakdownForSaleItems(cart,!!appConfig.igvActive),total=cartTaxBreakdown.totalVenta,paymentState=_naPaymentState();if(!paymentState.valid){_naSetPaymentHint(paymentState.message,'error');toast(paymentState.message,'error');_naPaymentFocusTarget()?.focus();return;}

  const mixedData=posPayM==='mixto'?_naMixedPaymentData():null,digitalPayment=_naDigitalSalePayment(),paymentRef=(posPayM==='yape'||posPayM==='plin'||posPayM==='transferencia')?_naClean(document.getElementById('mDigitalRef')?.value):posPayM==='mixto'?mixedData.reference:'';if(digitalPayment&&!_naDigitalPaymentVerified()){const message='Confirma que verificaste la recepción del pago digital.';_naSetPaymentHint(message,'error');toast(message,'error');_naDigitalVerificationControl()?.focus();return;}if(paymentRef&&ventas.some(v=>!v.anulada&&v.paymentRef===paymentRef)){toast('Ese número de operación ya fue registrado','error');return;}
  let client=clientes.find(c=>String(c.id)===String(document.getElementById('mVentaCliente')?.value))||null,creditDue=null;if(posPayM==='credito'){client=clientes.find(c=>String(c.id)===String(document.getElementById('mCreditoCliente')?.value));creditDue=document.getElementById('mCreditoVence')?.value;if(!client||!creditDue){toast('Selecciona cliente y fecha de vencimiento','error');return;}}
  const backup={productos:_naClone(productos),ventas:_naClone(ventas),clientes:_naClone(clientes),creditos:_naClone(creditos),cajMovs:_naClone(cajMovs),inventoryMovements:_naClone(inventoryMovements),cart:_naClone(cart)};posProc=true;const btn=document.getElementById('mBtnConf');btn.disabled=true;btn.textContent='Procesando…';
  try{
    const ids=ventas.map(v=>parseInt(String(v.id).replace('V-',''))||0),newId='V-'+String(Math.max(...ids,0)+1).padStart(3,'0'),now=new Date(),timestamp=now.toISOString(),fecha=obtenerHoy(),hora=nowT(),hora24=_naTime24(now),cashier=_naCashierSnapshot(cajEstado.cajeroId||cajEstado.cajero||appConfig.activeCashierId);let creditId=null,creditDraft=null;
    if(client)client.totalCompras=_naNumber(client.totalCompras)+total;if(posPayM==='credito'){creditId=Date.now();creditDraft={id:creditId,cliId:client.id,clienteId:client.id,clienteNombre:client.nombre,clienteDni:client.dni||'',tipo:'venta_credito',desc:`Venta ${newId}`,monto:total,pagado:0,saldo:total,vence:creditDue,status:diasHasta(creditDue)<0?'vencido':'vigente',estado:diasHasta(creditDue)<0?'vencido':'vigente',fecha,hora,hora24,timestamp,ventaId:newId,anulado:false,pagos:[],items:[],cajero:cashier.nombre,cajeroNombre:cashier.nombre,cajeroId:cashier.id};}
    const saleItems=cart.map(i=>{const qty=Math.max(0,_naNumber(i.qty)),price=Math.max(0,_naNumber(i.precio)),units=_naUnitsPerQty(i),mode=i.ventaModo||'unidad';return{id:i.id,productoId:i.id,sku:i.sku,barcode:i.barcode||i.codigoIngresado||'',icon:i.icon,name:i.name,nombre:i.name,qty,cantidad:qty,precio:price,precioUnitario:price,subtotal:Number((price*qty).toFixed(2)),costo:i.costo||0,imagen:i.imagen||null,unidad:i.unidad||'unidad',marca:i.marca||'',incluyeIGV:i.incluyeIGV!==false,tipoImpuesto:_naTaxType(i.tipoImpuesto),unitsPerQty:units,ventaModo:mode,modo:mode==='caja'?'mayorista':'minorista',descuento:i._descuento||0,_precioOriginal:i._precioOriginal??null,ventaLibre:!!i.ventaLibre,ventaSinStock:!!i.ventaSinStock,tipoLinea:i.tipoLinea||'',codigoIngresado:i.codigoIngresado||'',unidadesSinStock:Math.max(0,_naNumber(i.unidadesSinStock)),stockAntes:i.stockAntes===undefined?null:_naNumber(i.stockAntes)};});
    if(creditDraft){creditDraft.items=saleItems.map((item,index)=>_naNormalizeCreditItem(item,index,total));creditDraft=_naNormalizeCreditRecord(creditDraft,creditos.length);creditos.push(creditDraft);}
    const taxBreakdown=_naTaxBreakdownForSaleItems(saleItems,!!appConfig.igvActive),paymentBreakdown=posPayM==='mixto'?{efectivo:mixedData.cash,digital:mixedData.digital,digitalMethod:mixedData.digitalMethod,reference:paymentRef}:null,recibido=posPayM==='efectivo'?_naNumber(document.getElementById('mMontoRec')?.value):posPayM==='mixto'?mixedData.cash:total,vuelto=posPayM==='efectivo'?Math.max(0,Number((recibido-total).toFixed(2))):0,operation=paymentRef||String(Math.max(...ids,0)+1).padStart(8,'0'),subtotal=Number(saleItems.reduce((sum,item)=>sum+Math.max(item.precioUnitario,_naNumber(item._precioOriginal,item.precioUnitario))*item.cantidad,0).toFixed(2)),tipoVenta=_naSaleType(saleItems),estado=posPayM==='credito'?'credito':'completada';ventas.unshift({id:newId,operation,fecha,hora,hora24,timestamp,cajero:cashier.nombre,cajeroNombre:cashier.nombre,cajeroId:cashier.id,total:taxBreakdown.totalVenta,subtotal,descuentoTotal:Math.max(0,Number((subtotal-total).toFixed(2))),igvActive:taxBreakdown.taxActive,taxBreakdown,metodo:posPayM,metodoPago:posPayM,estado,tipoVenta,cantidadLineas:saleItems.length,unidadesFisicas:saleItems.reduce((sum,item)=>sum+_naUnitsSold(item),0),paymentRef,paymentBreakdown,...(digitalPayment?{paymentVerified:true}:{}),recibido,vuelto,anulada:false,clienteId:client?.id||null,clienteNombre:client?.nombre||null,clienteDni:client?.dni||null,creditId,contieneVentaLibre:saleItems.some(item=>item.ventaLibre),contieneVentaSinStock:saleItems.some(item=>item.ventaSinStock),items:saleItems});
    cajMovs.push({id:Date.now()+1,tipo:'ing',monto:total,efectivo:posPayM==='efectivo'?total:posPayM==='mixto'?mixedData.cash:0,desc:`${posPayM==='credito'?'Venta a crédito':posPayM==='mixto'?'Venta mixta':'Venta POS'} ${newId}`,cat:posPayM==='credito'?'Venta a crédito':posPayM==='mixto'?'Venta mixta':'Venta retail',metodo:posPayM,referencia:paymentRef,detallePago:paymentBreakdown,hora,hora24,timestamp,cajero:cashier.nombre,cajeroNombre:cashier.nombre,cajeroId:cashier.id,fecha,sessionId:cajEstado.sessionId||null,ventaId:newId});
    // FIX04: cada salida de stock queda en el ledger enlazada a la venta (before → delta → after).
    for(const item of cart){const prod=productos.find(p=>String(p.id)===String(item.id));if(!prod||!_naTracksStock(prod))continue;const units=_naUnitsSold(item);if(units<=0)continue;const outcome=applyInventoryMovement({productId:prod.id,type:'SALE',delta:-units,reason:`Venta ${newId}`,source:'SALE',referenceId:newId,allowNegative:_naFreeSaleCfg().allowRegisteredNoStock});if(!outcome.ok)throw new Error(outcome.message||'Movimiento de inventario bloqueado');}
    cart=[];const persistResult=await saveAllData();if(!_naWasPersisted(persistResult))throw new Error('No se pudo confirmar el guardado permanente');
    const descBadge=document.getElementById('btnDescInfo');if(descBadge)descBadge.style.display='none';posUpdateCart(false);posRender();invRender();ventasRender();cajRender();updateDashboard();cerrarModal('mCobro');document.getElementById('cartDrawer')?.classList.remove('open');document.getElementById('cartBackdrop')?.classList.remove('open');toast(`✅ Venta ${newId} registrada correctamente`,'success');globalThis.NAReceiptShare?.onSale(ventas.find(v=>v.id===newId),clientes.find(c=>String(c.id)===String(ventas.find(v=>v.id===newId)?.clienteId)),{due:creditDue});if(appConfig.printAuto){try{verTicket(newId);setTimeout(()=>imprimirTicket(),50);}catch(ticketError){console.error(ticketError);toast('La venta se registró, pero hubo un problema al abrir el ticket','error');}}
  }catch(error){console.error('[Venta] No se confirmó la operación:',error?.name||'Error');productos=backup.productos;ventas=backup.ventas;clientes=backup.clientes;creditos=backup.creditos;cajMovs=backup.cajMovs;inventoryMovements=backup.inventoryMovements;cart=backup.cart;await saveAllData();posRender();posUpdateCart();toast('No se registró la venta porque no existe guardado permanente verificado. Tus productos siguen en el carrito.','error');}finally{posProc=false;if(btn){btn.disabled=false;}_naValidatePaymentForm();}
};

// Inventario y productos
// FIX04: punto CENTRAL de mutación de stock. Contrato: ANTES → DELTA → DESPUÉS → MOTIVO → ORIGEN → FECHA/HORA.
// Valida y congela before/delta/after en un movement del ledger y aplica el stock nuevo.
// El caller persiste stock + ledger en el MISMO saveAllData y revierte AMBOS si falla (sin duplicar mutaciones).
// allowNegative solo para caminos con contrato aprobado (venta libre sin stock configurada); por defecto after<0 BLOQUEADO.
let _naInventoryLedgerSeq=0;
function applyInventoryMovement(options){
  const product=productos.find(p=>String(p.id)===String(options?.productId));
  if(!product)return{ok:false,error:'PRODUCT_NOT_FOUND',message:'Producto no encontrado'};
  if(!_naTracksStock(product))return{ok:false,error:'NOT_TRACKED',message:'El producto no controla inventario'};
  const delta=Math.round(_naNumber(options?.delta,NaN)*100)/100;
  if(!Number.isFinite(delta)||delta===0)return{ok:false,error:'INVALID_DELTA',message:'Delta de inventario inválido'};
  const reason=_naClean(options?.reason);
  if(!reason)return{ok:false,error:'REASON_REQUIRED',message:'Motivo obligatorio para el movimiento de inventario'};
  const before=_naInt(product.stock),after=before+delta;
  if(after<0&&!options?.allowNegative)return{ok:false,error:'NEGATIVE_STOCK',message:`Stock insuficiente (${before} disponibles)`};
  if(!Array.isArray(inventoryMovements))inventoryMovements=[];
  const now=new Date();_naInventoryLedgerSeq++;
  const movement={id:`IM-${now.getTime()}-${_naInventoryLedgerSeq}`,productId:product.id,type:_naClean(options?.type)||'AJUSTE',before,delta,after,reason,source:_naClean(options?.source)||'MANUAL',referenceId:options?.referenceId===undefined||options?.referenceId===null?null:String(options.referenceId),timestamp:now.toISOString(),fecha:obtenerHoy(),sessionId:_naSessionOpen()?cajEstado.sessionId||null:null};
  inventoryMovements.push(movement);product.stock=after;
  return{ok:true,movement};
}
function toggleProductCodeFields(){const enabled=!!document.getElementById('pManualCode')?.checked,wrap=document.getElementById('pCodeFields');if(wrap)wrap.hidden=!enabled;}
function setProductInventoryControl(enabled){const cb=document.getElementById('pControlInventario'),wrap=document.getElementById('pInventoryFields'),yes=document.getElementById('pInvYes'),no=document.getElementById('pInvNo');if(cb)cb.checked=!!enabled;if(wrap)wrap.hidden=!enabled;yes?.classList.toggle('active',!!enabled);no?.classList.toggle('active',!enabled);}
abrirModalProd=function(){if(isModuleLocked('productos',{canonicalProductUi:true})){toast('Módulo de productos bloqueado','error');return;}invEditId=null;imagenProducto=null;document.getElementById('mProdTitle').textContent='➕ Nuevo producto';['pNombre','pDescripcion','pSku','pBarcode','pMarca','pCosto','pPrecio','pVenc','pPrecioCaja','pUnidCaja','pFactorCompra','pCatNueva'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});renderAltBarcodeFields([]);document.getElementById('pManualCode').checked=true;toggleProductCodeFields();document.getElementById('pUnidad').value='unidad';document.getElementById('pUnidadCompra').value='unidad';document.getElementById('pFactorCompra').value='1';document.getElementById('pIncluyeIGV').checked=true;document.getElementById('pTipoImpuesto').value='gravado';document.getElementById('pImpuestoComplementario').value='';document.getElementById('pWholesaleDetails').open=false;document.getElementById('pStock').value='0';document.getElementById('pStockMin').value=String(appConfig.stockMin||5);setProductInventoryControl(true);renderCategorySelects({prodValue:'abarrotes',invValue:document.getElementById('invCat')?.value||''});toggleNewCategoryField(false);document.getElementById('pIcon').value='📦';document.getElementById('pImagen').value='';document.getElementById('imgPreview').innerHTML='📦';document.getElementById('mgVal').textContent='—';document.getElementById('mProd').classList.add('open');document.querySelector('#mProd .modal')?.scrollTo(0,0);};
previewImagen=function(){const input=document.getElementById('pImagen'),file=input.files?.[0];if(!file)return;if(!file.type.startsWith('image/')){toast('Selecciona una imagen válida','error');return;}if(file.size>12_000_000){toast('La imagen supera 12 MB','error');input.value='';return;}const reader=new FileReader();reader.onload=e=>{const img=new Image();img.onload=()=>{let max=480,quality=.72,data='';for(let attempt=0;attempt<5;attempt++){const scale=Math.min(1,max/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);data=canvas.toDataURL('image/jpeg',quality);if(data.length<120000)break;max=Math.round(max*.82);quality=Math.max(.48,quality-.08);}if(data.length>=180000){toast('La imagen sigue siendo demasiado pesada; usa una foto más pequeña','error');input.value='';return;}imagenProducto=data;document.getElementById('imgPreview').innerHTML=`<img src="${imagenProducto}" style="width:100%;height:100%;object-fit:cover;border-radius:8px">`;toast('Imagen optimizada para el almacenamiento','success');};img.onerror=()=>toast('No se pudo leer la imagen','error');img.src=e.target.result;};reader.readAsDataURL(file);};
guardarProd=async function(){
  if(isModuleLocked('productos')){toast('Módulo de productos bloqueado','error');return;}
  const btnOk=document.querySelector('#mProd .mbtn-ok'),btnText=btnOk?.textContent||'Guardar';
  if(btnOk?.disabled)return;
  if(btnOk){btnOk.disabled=true;btnOk.textContent='Procesando…';}
  try{
  const name=_naClean(document.getElementById('pNombre').value),descripcion=_naClean(document.getElementById('pDescripcion').value),cost=Math.max(0,_naNumber(document.getElementById('pCosto').value)),price=Math.max(0,_naNumber(document.getElementById('pPrecio').value)),sku=_naClean(document.getElementById('pSku').value),barcode=_naClean(document.getElementById('pBarcode').value),finalSku=sku||`PROD-${Date.now()}`,marca=_naClean(document.getElementById('pMarca').value)||'Sin marca',unidad=document.getElementById('pUnidad').value,unidadCompra=document.getElementById('pUnidadCompra').value||'unidad',factorCompraRaw=_naNumber(document.getElementById('pFactorCompra').value,1),factorCompra=unidadCompra==='unidad'?1:factorCompraRaw,controlInventario=!!document.getElementById('pControlInventario').checked,codigosAlternativos=readAltBarcodes();
  if(codigosAlternativos===null)return;
  // V2A: la edición conserva el histórico de códigos. El código que pasa a principal deja
  // de repetirse como alternativo y el principal anterior se conserva como alternativo
  // (A→B→C→A sin pérdida ni duplicados). Nunca se eliminan códigos automáticamente.
  let altCodesFinal=codigosAlternativos;
  const editingPrevious=invEditId?productos.find(x=>String(x.id)===String(invEditId)):null;
  if(editingPrevious){
    if(barcode){const newKey=barcode.toLowerCase();altCodesFinal=altCodesFinal.filter(c=>c.toLowerCase()!==newKey);}
    const prevBarcode=_naClean(editingPrevious.barcode);
    if(prevBarcode&&(!barcode||prevBarcode.toLowerCase()!==barcode.toLowerCase())&&!altCodesFinal.some(c=>c.toLowerCase()===prevBarcode.toLowerCase())){
      if(altCodesFinal.length>=NA_MAX_ALT_BARCODES){toast('Retira un código alternativo para conservar el código principal anterior','error');return;}
      altCodesFinal=[...altCodesFinal,prevBarcode];
    }
  }
  if(!name||price<=0||!unidad){toast('Nombre, unidad de medida y precio de venta son obligatorios','error');return;}
  if(unidadCompra!=='unidad'&&(!Number.isFinite(factorCompraRaw)||factorCompraRaw<=0)){toast('Las unidades por presentación deben ser mayores que cero','error');return;}
  if(appConfig.margenActive&&price<cost){toast('El precio no puede ser menor al costo mientras el control de margen esté activo','error');return;}
  const ownCodes=[finalSku,barcode,...altCodesFinal].map(_naClean).filter(Boolean),ownSeen=new Set();
  for(const code of ownCodes){const key=code.toLowerCase();if(ownSeen.has(key)){toast(`El código ${code} está repetido dentro del mismo producto`,'error');return;}ownSeen.add(key);const owner=_naFindCodeOwner(code,invEditId);if(owner){toast(`El código ${code} ya pertenece a ${owner.name}`,'error');return;}}
  const boxPrice=_naNumber(document.getElementById('pPrecioCaja').value),boxUnits=_naInt(document.getElementById('pUnidCaja').value);
  if((boxPrice>0)!==(boxUnits>0)){toast('Completa precio mayorista y unidades por caja, o deja ambos vacíos','error');return;}
  if(appConfig.margenActive&&boxPrice>0&&boxPrice<cost*boxUnits){toast('El precio por caja está por debajo del costo total','error');return;}
  const manualActive=document.getElementById('pActivo')?.value!=='false',manualVisibility=_naProductManualVisibilityPatch(editingPrevious,manualActive,Date.now());
  const data={name,descripcion,sku:finalSku,barcode,codigosAlternativos:altCodesFinal,codigoAlternativo:altCodesFinal[0]||'',unidadCompra,factorCompra,cat:document.getElementById('pCat').value,marca,unidad,icon:document.getElementById('pIcon').value||'📦',imagen:imagenProducto,costo:cost,precio:price,incluyeIGV:!!document.getElementById('pIncluyeIGV').checked,tipoImpuesto:_naTaxType(document.getElementById('pTipoImpuesto').value),impuestoComplementario:document.getElementById('pImpuestoComplementario').value,controlInventario,stock:controlInventario?(invEditId?_naInt(document.getElementById('pStock').value):Math.max(0,_naInt(document.getElementById('pStock').value))):0,stockMin:controlInventario?Math.max(0,_naInt(document.getElementById('pStockMin').value,_naInt(appConfig.stockMin,5))):0,venc:controlInventario?(document.getElementById('pVenc').readOnly&&editingPrevious?(editingPrevious.venc||null):(document.getElementById('pVenc').value||null)):null,precioCaja:boxPrice>0?boxPrice:null,unidCaja:boxUnits>0?boxUnits:null,...manualVisibility};
  // FIX04: targetStock queda separado; applyInventoryMovement es la única mutación final de stock.
  const targetStock=data.stock,{stock:_ignoredTargetStock,...persistedData}=data;
  const backup={productos:_naClone(productos),inventoryMovements:_naClone(inventoryMovements)};
  if(invEditId){const index=productos.findIndex(x=>x.id===invEditId);if(index<0)return;
    const previous=productos[index],beforeStock=_naInt(previous.stock),ledgerDelta=targetStock-beforeStock,staged={...previous,...persistedData,stock:beforeStock};
    if(ledgerDelta!==0){
      staged.controlInventario=true;productos[index]=staged;
      const outcome=applyInventoryMovement({productId:previous.id,type:'AJUSTE',delta:ledgerDelta,reason:`Edición de producto: stock fijado en ${targetStock}`,source:'PRODUCT_EDIT',referenceId:String(previous.id)});
      if(!outcome.ok){productos=backup.productos;inventoryMovements=backup.inventoryMovements;toast(outcome.message||'No se pudo ajustar el stock del producto','error');return;}
    }
    staged.controlInventario=controlInventario;productos[index]=staged;
  }
  else{const created={id:Date.now(),...persistedData,stock:0};productos.push(created);if(controlInventario&&targetStock>0){const outcome=applyInventoryMovement({productId:created.id,type:'ALTA',delta:targetStock,reason:`Alta de producto con stock inicial ${targetStock}`,source:'PRODUCT_CREATE',referenceId:String(created.id)});if(!outcome.ok){productos=backup.productos;inventoryMovements=backup.inventoryMovements;toast(outcome.message||'No se pudo registrar el stock inicial','error');return;}}}
  const persistResult=await saveAllData();if(!_naWasPersisted(persistResult)){productos=backup.productos;inventoryMovements=backup.inventoryMovements;await saveAllData();invRender();posRender();toast('No se guardó el producto porque no existe almacenamiento permanente verificado','error');return;}
  cerrarModal('mProd');invRender();posRender();toast(invEditId?'Producto actualizado':'Producto agregado','success');
  }finally{if(btnOk){btnOk.disabled=false;btnOk.textContent=btnText;}}
};
// CANON: stock in/out is saved only through canonical inventory.adjust (NuevoAmanecerCanonicalInventoryBridge), so the
// opener is a canonical product UI; user/master/read-only locks still apply (isModuleLocked + bridge.userLocked).
function _naCanonicalInventoryUi(){const bridge=globalThis.NuevoAmanecerCanonicalInventoryBridge;try{return !!(bridge&&typeof bridge.enabled==='function'&&bridge.enabled()&&typeof bridge.save==='function');}catch(_){return false;}}
abrirMovInv=function(id,tipo){if(isModuleLocked('productos',{canonicalProductUi:_naCanonicalInventoryUi()})){toast('Módulo de productos bloqueado','error');return;}invMovId=id;invMovT=tipo;const p=productos.find(x=>String(x.id)===String(id));if(!p)return;if(!_naTracksStock(p)){toast('Este producto no controla inventario','error');return;}document.getElementById('mMovIcon').textContent=p.icon;document.getElementById('mMovNombre').textContent=p.name;document.getElementById('mMovStock').textContent=`Stock actual: ${p.stock} ${_naCategoryTitle(p.unidad||'unidad').toLowerCase()}`;document.getElementById('mMovCant').value='';document.querySelectorAll('.mov-type-btn').forEach(b=>{b.classList.remove('active');if(b.dataset.type===tipo)b.classList.add('active');});document.getElementById('mMovInv').classList.add('open');};
guardarMovInv=async function(){if(isModuleLocked('productos')){toast('Módulo de productos bloqueado','error');return;}const qty=_naInt(document.getElementById('mMovCant').value);if(qty<=0){toast('Ingresa una cantidad válida','error');return;}const p=productos.find(x=>String(x.id)===String(invMovId));if(!p)return;if(invMovT==='salida'&&qty>p.stock){toast(`Stock insuficiente (${p.stock} disponibles)`,'error');return;}p.stock=invMovT==='entrada'?p.stock+qty:Math.max(0,p.stock-qty);cerrarModal('mMovInv');invRender();posRender();await _naFinalizeOperationPersistence(`${invMovT==='entrada'?'📥 Entrada':'📤 Salida'} de ${qty} unidades`,'No se pudo guardar el movimiento de inventario');};

// Clientes y créditos
let _naClientCreditIndexRef=null,_naClientCreditIndexLength=-1,_naClientCreditIndexDate='',_naClientAllCreditsIndex=new Map(),_naClientCreditsIndex=new Map(),_naClientSummaryIndex=new Map();
function _naRebuildClientCreditIndex(){
  const allByClient=new Map(),byClient=new Map(),summary=new Map(),today=obtenerHoy();
  (Array.isArray(creditos)?creditos:[]).forEach(cr=>{
    if(!cr)return;
    try{_naSyncCreditStatus(cr);}catch(_){}
    const key=String(cr.cliId??cr.clienteId??'');
    if(!key)return;
    const allList=allByClient.get(key)||[];allList.push(cr);allByClient.set(key,allList);
    if(cr.anulado||String(cr.status||cr.estado||'').toLowerCase()==='anulado')return;
    const list=byClient.get(key)||[];list.push(cr);byClient.set(key,list);
    let row=summary.get(key);if(!row){row={debt:0,status:'ninguno'};summary.set(key,row);}
    const status=String(cr.status||cr.estado||'').toLowerCase();
    if(status==='cancelado')return;
    row.debt+=Math.max(0,_naNumber(cr.monto)-_naNumber(cr.pagado));
    if(status==='vencido')row.status='vencido';
    else if(row.status!=='vencido'){const d=diasHasta(cr.vence);row.status=d!==null&&d>=0&&d<=7?'proximo':(row.status==='proximo'?'proximo':'vigente');}
  });
  _naClientCreditIndexRef=creditos;_naClientCreditIndexLength=Array.isArray(creditos)?creditos.length:0;_naClientCreditIndexDate=today;_naClientAllCreditsIndex=allByClient;_naClientCreditsIndex=byClient;_naClientSummaryIndex=summary;
}
function _naEnsureClientCreditIndex(force=false){
  if(force||_naClientCreditIndexRef!==creditos||_naClientCreditIndexLength!==(Array.isArray(creditos)?creditos.length:0)||_naClientCreditIndexDate!==obtenerHoy())_naRebuildClientCreditIndex();
}
function _naClientAllCreditsFast(clientId){_naEnsureClientCreditIndex();return(_naClientAllCreditsIndex.get(String(clientId))||[]).slice();}
function _naClientCreditsFast(clientId){_naEnsureClientCreditIndex();return(_naClientCreditsIndex.get(String(clientId))||[]).slice();}
function _naClientDebtFast(client){_naEnsureClientCreditIndex();return _naClientSummaryIndex.get(String(client?.id??client))?.debt||0;}
function _naClientStatusFast(client){_naEnsureClientCreditIndex();return _naClientSummaryIndex.get(String(client?.id??client))?.status||'ninguno';}
statusCli=function(c){return _naClientStatusFast(c);};
calcularScoreCredito=function(clienteId){const cliente=clientes.find(c=>String(c.id)===String(clienteId));if(!cliente)return{score:0,lineaMaxima:5};const totalCompras=_naNumber(cliente.totalCompras),margenEstimado=totalCompras*.5,history=creditos.filter(cr=>String(cr.cliId)===String(clienteId)&&!cr.anulado);let punctuality=0;history.forEach(cr=>{_naSyncCreditStatus(cr);if(cr.status==='cancelado')punctuality+=10;else if(cr.status==='vencido')punctuality-=20;else if(cr.pagado>0)punctuality+=5;});let score=totalCompras>=1000?30:totalCompras>=500?20:totalCompras>=100?10:0;score+=(margenEstimado>=400?20:margenEstimado>=200?10:0)+punctuality;let line=Math.max(5,margenEstimado*.05);if(punctuality>=20)line*=1.5;else if(punctuality<-10)line*=.5;line=Math.max(5,Math.min(line,Math.max(5,margenEstimado*.1)));return{score:Math.max(0,score),lineaMaxima:Math.round(line)};};
guardarCli=async function(){
  const canonicalBridge=globalThis.NuevoAmanecerCanonicalCustomerBridge;
  if(canonicalBridge&&typeof canonicalBridge.enabled==='function'&&canonicalBridge.enabled()&&typeof canonicalBridge.save==='function'){
    return await canonicalBridge.save();
  }
  if(isModuleLocked('clientes')){toast('El sistema está en modo solo lectura','error');return;}
  const btnOk=document.querySelector('#mCli .mbtn-ok'),btnText=btnOk?.textContent||'Guardar';
  if(btnOk?.disabled)return;
  if(btnOk){btnOk.disabled=true;btnOk.textContent='Procesando…';}
  try{
    const name=_naClean(document.getElementById('cNombre').value),dni=(d=>/^(\d{8}|\d{11})$/.test(d.replace(/[\s.\-]/g,''))?d.replace(/[\s.\-]/g,''):d)(_naClean(document.getElementById('cDni').value));
    const lineRaw=_naClean(document.getElementById('cLinea')?.value||'').replace(',','.'),line=lineRaw===''?null:Number(lineRaw);
    if(!name){toast('El nombre es obligatorio','error');return;}
    if(line!==null&&!(Number.isFinite(line)&&line>=0&&line<=1e6)){toast('Línea de crédito inválida (0 a S/ 1,000,000)','error');return;}
    if(dni&&clientes.some(c=>c.dni===dni)){toast('Ya existe un cliente con ese DNI','error');return;}
    const backup=_naClone(clientes);
    const record={id:Date.now(),color:clientes.length%8,nombre:name,dni,tel:_naClean(document.getElementById('cTel').value),dir:_naClean(document.getElementById('cDir').value),totalCompras:0};
    if(line!==null){const who=_naCashierSnapshot(cajEstado?.cajeroId||appConfig.activeCashierId);Object.assign(record,{lineaCreditoManualActiva:true,lineaCreditoManual:_naRoundMoney(line),lineaCreditoManualMotivo:'Línea inicial al registrar cliente',lineaCreditoManualAt:new Date().toISOString(),lineaCreditoManualPor:who.nombre||'Propietario',lineaCreditoManualPorId:who.id||''});}
    clientes.push(record);
    const persistResult=await saveAllData();
    if(!_naWasPersisted(persistResult)){clientes=backup;await saveAllData();cliRender();toast('No se guardó el cliente porque no existe almacenamiento permanente verificado','error');return;}
    cerrarModal('mCli');if(typeof _naResetClienteForm==='function')_naResetClienteForm();cliRender();toast('Cliente registrado','success');
  }finally{if(btnOk){btnOk.disabled=false;btnOk.textContent=btnText;}}
};
guardarCred=async function(){
  if(isModuleLocked('clientes')){toast('El sistema está en modo solo lectura','error');return;}
  const btnOk=document.querySelector('#mCred .mbtn-ok'),btnText=btnOk?.textContent||'Guardar';
  if(btnOk?.disabled)return;
  if(btnOk){btnOk.disabled=true;btnOk.textContent='Procesando…';}
  try{
  const desc=_naClean(document.getElementById('crDesc').value),amount=Math.max(0,_naNumber(document.getElementById('crMonto').value)),due=document.getElementById('crVence').value,client=clientes.find(c=>String(c.id)===String(cliCredId));if(!client||!desc||amount<=0||!due){toast('Completa los campos obligatorios','error');return;}const score=calcularScoreCredito(cliCredId);if(amount>score.lineaMaxima&&!confirm(`El monto supera la línea sugerida de ${fmt(score.lineaMaxima)}. ¿Registrar de todos modos?`))return;
  const backup=_naClone(creditos),now=new Date(),cashier=_naCashierSnapshot(cajEstado?.cajeroId||cajEstado?.cajero||appConfig.activeCashierId),id=Date.now(),record=_naNormalizeCreditRecord({id,cliId:client.id,clienteId:client.id,clienteNombre:client.nombre,clienteDni:client.dni||'',tipo:document.getElementById('crTipo').value,desc,monto:amount,pagado:0,saldo:amount,vence:due,status:diasHasta(due)<0?'vencido':'vigente',fecha:obtenerHoy(),hora:nowT(),hora24:_naTime24(now),timestamp:now.toISOString(),ventaId:null,anulado:false,pagos:[],items:[{itemKey:'concepto:0',productoId:null,nombre:desc,cantidad:1,precioUnitario:amount,subtotal:amount,modo:'concepto'}],cajero:cashier.nombre,cajeroNombre:cashier.nombre,cajeroId:cashier.id},creditos.length);creditos.push(record);
  const result=await saveAllData();if(!_naWasPersisted(result)){creditos=backup;cliRender();toast('No se registró el crédito porque no existe guardado permanente verificado','error');return;}cerrarModal('mCred');cliRender();toast('Crédito registrado','success');
  }finally{if(btnOk){btnOk.disabled=false;btnOk.textContent=btnText;}}
};
confirmarPago=async function(){
  if(isModuleLocked('clientes')){toast('El sistema está en modo solo lectura','error');return;}if(pagoProc)return;const cr=creditos.find(x=>String(x.id)===String(pagoCredId));if(!cr){toast('No se encontró el crédito','error');return;}_naSyncCreditStatus(cr);if(cr.anulado||cr.status==='anulado'){toast('No se pueden registrar pagos en un crédito anulado','error');return;}const pending=_naCreditOutstanding(cr),amount=Math.max(0,_naNumber(document.getElementById('pagoMonto')?.value));if(amount<=0){toast('Ingresa un monto válido','error');return;}if(amount>pending+.001){toast('El abono supera el saldo pendiente','error');return;}if(cr.status==='cancelado'||pending<=0){toast('Este crédito ya está pagado completamente','error');return;}const method=document.getElementById('pagoMetodo')?.value||'efectivo',operation=_naClean(document.getElementById('pagoOperacion')?.value);if(!['efectivo','yape','plin','transferencia'].includes(method)){toast('Método de pago inválido','error');return;}if(method==='efectivo'&&!_naSessionOpen()){toast('Abre la caja antes de registrar un cobro en efectivo','error');return;}if(method!=='efectivo'){if(operation.length<4){toast('Ingresa al menos 4 caracteres del número de operación','error');document.getElementById('pagoOperacion')?.focus();return;}if(_naCreditPaymentOperationUsed(operation)){toast('Ese número de operación ya fue registrado','error');return;}}
  const allocation=_naAllocateCreditPayment(cr,amount);if(Math.abs(allocation.total-amount)>.01||allocation.unallocated>.01){toast('No se pudo distribuir correctamente el pago entre los productos','error');return;}const backup={creditos:_naClone(creditos),cajMovs:_naClone(cajMovs)},client=clientes.find(c=>String(c.id)===String(cr.cliId)),cashier=_naCashierSnapshot(cajEstado?.cajeroId||cajEstado?.cajero||appConfig.activeCashierId),now=new Date(),before=pending,after=Math.max(0,Number((before-amount).toFixed(2))),baseId=`P-${now.getTime()}`,paymentId=creditos.some(c=>Array.isArray(c.pagos)&&c.pagos.some(p=>p.pagoId===baseId))?`${baseId}-${Math.floor(Math.random()*1000)}`:baseId,payment={id:paymentId,pagoId:paymentId,creditoId:cr.id,clienteId:cr.cliId,clienteNombre:client?.nombre||cr.clienteNombre||'Cliente',monto:amount,montoPagado:amount,saldoAnterior:before,saldoActual:after,fecha:obtenerHoy(),hora:nowT(),hora24:_naTime24(now),timestamp:now.toISOString(),diaSemana:_naCreditDayName(now),horarioPago:_naCreditSchedule(now),metodo:method,operacion:operation,numeroOperacion:operation,referencia:operation,cajero:cashier.nombre,cajeroNombre:cashier.nombre,cajeroId:cashier.id,desgloseProductos:allocation.rows};
  pagoProc=true;const btn=document.getElementById('pagoConfirmBtn');if(btn){btn.disabled=true;btn.textContent='Procesando…';}
  try{if(!Array.isArray(cr.pagos))cr.pagos=[];cr.pagos.push(payment);cr.pagado=Math.min(cr.monto,Number((_naNumber(cr.pagado)+amount).toFixed(2)));cr.saldo=_naCreditOutstanding(cr);cr.estado=_naSyncCreditStatus(cr);cajMovs.push({id:Date.now()+1,tipo:'cob',monto:amount,efectivo:method==='efectivo'?amount:0,digital:method==='efectivo'?0:amount,desc:`Abono de ${client?.nombre||'cliente'} — ${cr.desc}`,cat:'Cobro crédito',metodo:method,referencia:operation,numeroOperacion:operation,hora:payment.hora,hora24:payment.hora24,timestamp:payment.timestamp,cajero:cashier.nombre,cajeroNombre:cashier.nombre,cajeroId:cashier.id,fecha:payment.fecha,sessionId:_naSessionOpen()?cajEstado.sessionId||null:null,creditoId:cr.id,pagoId:paymentId,saldoAnterior:before,saldoActual:after,horarioPago:payment.horarioPago});const result=await saveAllData();if(!_naWasPersisted(result))throw new Error('Persistencia no verificada');cerrarModal('mPagoCred');cliRender();toast(`Pago de ${fmt(amount)} registrado · Saldo ${fmt(after)}`,'success');globalThis.NAReceiptShare?.onStoredPayment(cr,payment);}
  catch(error){creditos=backup.creditos;cajMovs=backup.cajMovs;await saveAllData();cliRender();toast('No se registró el pago porque no existe guardado permanente verificado','error');}
  finally{pagoProc=false;if(btn){btn.disabled=false;btn.textContent='✅ Confirmar';}}
};

// FIX03: reversión auditable de un pago de crédito. El pago original NUNCA se borra ni se edita su monto:
// queda marcado (status REVERTED + reversalId) y la reversión crea un movimiento de caja inverso trazable
// (reversal:true + reversalOf), mismo modelo que la anulación de ventas. Una sola reversión por pago.
let pagoRevProc=false;
function _naCreditPaymentReversalExists(cr,pay){
  const pagoId=String(pay?.pagoId??pay?.id??'');
  if(!pagoId)return false;
  if(_naClean(pay?.reversalId))return true;
  return cajMovs.some(move=>move&&move.tipo==='egr'&&move.reversal===true&&String(move.reversalOf||'')===pagoId&&move.creditoId!==undefined&&move.creditoId!==null&&String(move.creditoId)===String(cr?.id));
}
function _naIsCreditCollectionMovement(move){
  return move?.tipo==='cob';
}
function _naIsCreditPaymentReversalMovement(move){
  if(move?.tipo!=='egr'||move.reversal!==true||move.creditoId===undefined||move.creditoId===null||!_naClean(move.reversalOf)||!_naClean(move.pagoId))return false;
  const cr=creditos.find(item=>String(item?.id)===String(move.creditoId));
  const pay=Array.isArray(cr?.pagos)?cr.pagos.find(item=>String(item?.pagoId??item?.id)===String(move.reversalOf)):null;
  return !!pay&&pay.status==='REVERTED'&&String(pay.reversalId||'')===String(move.pagoId);
}
function _naCreditCollectionsNetForDate(date){
  return cajMovs.reduce((total,move)=>{
    if(move?.fecha!==date)return total;
    if(_naIsCreditCollectionMovement(move))return total+_naNumber(move.monto);
    if(_naIsCreditPaymentReversalMovement(move))return total-_naNumber(move.monto);
    return total;
  },0);
}
revertirPagoCredito=async function(creditoId,pagoId){
  if(isModuleLocked('clientes')){toast('El sistema está en modo solo lectura','error');return;}
  if(pagoRevProc)return;
  const cr=creditos.find(x=>String(x.id)===String(creditoId));
  if(!cr){toast('No se encontró el crédito','error');return;}
  if(cr.anulado||cr.status==='anulado'){toast('No se pueden revertir pagos de un crédito anulado','error');return;}
  if(!Array.isArray(cr.pagos)){toast('No se encontró el pago en este crédito','error');return;}
  const pay=cr.pagos.find(p=>String(p?.pagoId??p?.id)===String(pagoId));
  if(!pay){toast('No se encontró el pago en este crédito','error');return;}
  if(pay.creditoId!==undefined&&pay.creditoId!==null&&String(pay.creditoId)!==String(cr.id)){toast('El pago no pertenece a este crédito','error');return;}
  const amount=Math.max(0,_naNumber(pay.monto));
  if(amount<=0){toast('Ese pago no tiene monto reversible','error');return;}
  if(pay.status==='REVERTED'||_naCreditPaymentReversalExists(cr,pay)){toast('Ese pago ya fue revertido','error');return;}
  const method=['efectivo','yape','plin','transferencia'].includes(pay.metodo)?pay.metodo:'efectivo';
  if(method==='efectivo'&&!_naSessionOpen()){toast('Abre la caja antes de revertir un cobro en efectivo','error');return;}
  pagoRevProc=true;
  let backup=null;
  try{
    const reason=_naClean(typeof prompt==='function'?prompt(`Motivo de la reversión del pago ${pay.pagoId||pay.id} (opcional):`)||'':'').slice(0,200);
    if(!await _naConfirmAction(`Se revertirá el pago de ${fmt(amount)} (${pay.pagoId||pay.id}). El saldo del crédito volverá a ${fmt(_naCreditOutstanding(cr)+amount)} y el pago original permanecerá en el historial marcado como revertido.`,{title:'Revertir pago de crédito',subtitle:'Se registrará una reversión trazable; el pago original no se borra ni se edita.',icon:'↩️',danger:true,okText:'Revertir pago'}))return;
    const currentCr=creditos.find(x=>String(x.id)===String(creditoId));
    if(!currentCr){toast('No se encontró el crédito','error');return;}
    if(currentCr.anulado||currentCr.status==='anulado'){toast('No se pueden revertir pagos de un crédito anulado','error');return;}
    if(!Array.isArray(currentCr.pagos)){toast('No se encontró el pago en este crédito','error');return;}
    const currentPay=currentCr.pagos.find(p=>String(p?.pagoId??p?.id)===String(pagoId));
    if(!currentPay){toast('No se encontró el pago en este crédito','error');return;}
    if(currentPay.creditoId!==undefined&&currentPay.creditoId!==null&&String(currentPay.creditoId)!==String(currentCr.id)){toast('El pago no pertenece a este crédito','error');return;}
    if(currentPay.status==='REVERTED'||_naCreditPaymentReversalExists(currentCr,currentPay)){toast('Ese pago ya fue revertido','error');return;}
    const currentAmount=Math.max(0,_naNumber(currentPay.monto));
    if(currentAmount<=0){toast('Ese pago no tiene monto reversible','error');return;}
    const currentMethod=['efectivo','yape','plin','transferencia'].includes(currentPay.metodo)?currentPay.metodo:'efectivo';
    if(currentMethod==='efectivo'&&!_naSessionOpen()){toast('Abre la caja antes de revertir un cobro en efectivo','error');return;}
    backup={creditos:_naClone(creditos),cajMovs:_naClone(cajMovs)};
    const now=new Date(),cashier=_naCashierSnapshot(cajEstado?.cajeroId||cajEstado?.cajero||appConfig.activeCashierId),saldoAntes=_naCreditOutstanding(currentCr),paymentKey=String(currentPay.pagoId||currentPay.id);
    let reversalId=`PR-${now.getTime()}`;
    if(creditos.some(c=>Array.isArray(c.pagos)&&c.pagos.some(p=>p&&p.reversalId===reversalId))||cajMovs.some(m=>String(m?.pagoId||'')===reversalId))reversalId=`${reversalId}-${Math.floor(Math.random()*1000)}`;
    currentPay.status='REVERTED';currentPay.reversalId=reversalId;currentPay.reversalAt=now.toISOString();currentPay.reversalReason=reason;
    currentCr.pagado=Math.max(0,Number((_naNumber(currentCr.pagado)-currentAmount).toFixed(2)));
    currentCr.saldo=_naCreditOutstanding(currentCr);currentCr.estado=_naSyncCreditStatus(currentCr);
    cajMovs.push({id:Date.now()+1,tipo:'egr',monto:currentAmount,efectivo:currentMethod==='efectivo'?currentAmount:0,digital:currentMethod==='efectivo'?0:currentAmount,desc:`Reversión del pago ${paymentKey} — ${currentCr.desc}`,cat:'Devolución',metodo:currentMethod,referencia:currentPay.referencia||currentPay.operacion||'',numeroOperacion:currentPay.numeroOperacion||currentPay.operacion||'',hora:nowT(),hora24:_naTime24(now),timestamp:now.toISOString(),cajero:cashier.nombre,cajeroNombre:cashier.nombre,cajeroId:cashier.id,fecha:obtenerHoy(),sessionId:_naSessionOpen()?cajEstado.sessionId||null:null,creditoId:currentCr.id,pagoId:reversalId,reversal:true,reversalOf:paymentKey,saldoAnterior:saldoAntes,saldoActual:currentCr.saldo,horarioPago:_naCreditSchedule(now)});
    const result=await saveAllData();
    if(!_naWasPersisted(result))throw new Error('Persistencia no verificada');
    cliRender();cajRender();updateDashboard();
    if(document.getElementById('mCreditoDetalle')?.classList.contains('open'))abrirDetalleCredito(currentCr.id);
    toast(`Pago de ${fmt(currentAmount)} revertido · Saldo ${fmt(currentCr.saldo)}`,'success');
  }
  catch(error){if(backup){creditos=backup.creditos;cajMovs=backup.cajMovs;await saveAllData();cliRender();}toast('No se revertió el pago porque no existe guardado permanente verificado','error');}
  finally{pagoRevProc=false;}
};
cliRender=function(){creditos=creditos.map((cr,index)=>_naNormalizeCreditRecord(cr,index));_naRebuildClientCreditIndex();cobradoHoy=_naCreditCollectionsNetForDate(obtenerHoy());_baseCliRender();updateDashboard();};

// Caja por sesiones
function _naIsSaleIncomeMove(move){return move?.tipo==='ing'&&(move.ventaId!==undefined&&move.ventaId!==null||/\bventa\b/i.test(`${move?.cat||''} ${move?.desc||''}`));}
function _naIsSaleReversalMove(move){return move?.tipo==='egr'&&move.reversal===true&&move.ventaId!==undefined&&move.ventaId!==null&&String(move.reversalOf||'')===String(move.ventaId);}
function _naCashEconomicOut(move){return _naIsSaleReversalMove(move)&&move.metodo==='credito'?0:Math.max(0,_naNumber(move?.monto));}
cajTotales=function(){const movs=_naCajaMovsSesion(),income=movs.filter(m=>(m.tipo==='ing'&&m.metodo!=='credito')||m.tipo==='cob').reduce((a,m)=>a+_naNumber(m.monto),0),out=movs.filter(m=>m.tipo==='egr'||m.tipo==='gas').reduce((a,m)=>a+(m.tipo==='gas'?Math.max(0,_naNumber(m.monto)):_naCashEconomicOut(m)),0),salesIn=movs.filter(_naIsSaleIncomeMove).reduce((a,m)=>a+_naNumber(m.monto),0),salesOut=movs.filter(_naIsSaleReversalMove).reduce((a,m)=>a+_naNumber(m.monto),0),sales=Number((salesIn-salesOut).toFixed(2)),collections=movs.filter(m=>m.tipo==='cob').reduce((a,m)=>a+_naNumber(m.monto),0),expenses=movs.filter(m=>m.tipo==='gas').reduce((a,m)=>a+_naNumber(m.monto),0),withdrawals=movs.filter(m=>m.tipo==='egr').reduce((a,m)=>a+_naCashEconomicOut(m),0),cashIn=movs.filter(m=>m.tipo==='ing'||m.tipo==='cob').reduce((a,m)=>a+_naNumber(m.efectivo),0),cashOut=movs.filter(m=>m.tipo==='egr'||m.tipo==='gas').reduce((a,m)=>a+_naNumber(m.efectivo),0);return{ing:income,egr:out,ven:sales,cob:collections,gas:expenses,ret:withdrawals,ef:_naNumber(cajEstado?.fondo)+cashIn-cashOut};};
function abrirModalApertura(){if(isModuleLocked('caja')){toast('Módulo de caja protegido','error');return;}document.getElementById('cajFondo').value='';_naPopulateCashierSelect('cajCajero',appConfig.activeCashierId);document.getElementById('mApertura').classList.add('open');}
// Strictly increasing numeric shift ids: two openings in the same millisecond never share an id (closure id is C-<sessionId>).
// Ids de cierre únicos entre aparatos: se agrega una etiqueta del aparato. Los ids antiguos («C-<sessionId>») se siguen leyendo tal cual.
function _naClosureDeviceTag(){try{const r=window.NA_ROLES,id=r&&typeof r.deviceId==='function'?r.deviceId():null;if(id)return String(id).replace(/[^A-Za-z0-9]/g,'').slice(-8)||'dev';let t=localStorage.getItem('na_closure_device_tag');if(!t){t=(crypto?.randomUUID?.()||String(Math.random()).slice(2)+Date.now()).replace(/[^A-Za-z0-9]/g,'').slice(0,8);localStorage.setItem('na_closure_device_tag',t);}return t;}catch(_){return 'local';}}
let _naLastCashSessionId=0;
function _naNextCashSessionId(){const seen=[_naLastCashSessionId,Number(cajEstado?.sessionId)||0,...(Array.isArray(typeof cashClosures!=='undefined'?cashClosures:null)?cashClosures.map(c=>Number(c&&c.sessionId)||0):[])];_naLastCashSessionId=Math.max(Date.now(),Math.max(...seen)+1);return _naLastCashSessionId;}
abrirCaja=async function(){if(isModuleLocked('caja')){toast('Módulo de caja protegido','error');return false;}if(_naSessionOpen()){toast('La caja ya está abierta','error');return false;}const fund=Math.max(0,_naNumber(document.getElementById('cajFondo').value)),cashier=_naCashierSnapshot(document.getElementById('cajCajero').value),now=new Date();if(!cashier?.id){toast('Selecciona un cajero activo','error');return false;}const backup={cajEstado:_naClone(cajEstado),activeCashierId:appConfig.activeCashierId,businessCajero:appConfig.business.cajero};cajEstado={abierta:true,fondo:fund,cajero:cashier.nombre,cajeroNombre:cashier.nombre,cajeroId:cashier.id,hora:nowT(),hora24:_naTime24(now),fechaApertura:obtenerHoy(),timestampApertura:now.toISOString(),cerrada:false,horaCierre:null,sessionId:_naNextCashSessionId(),contado:null,esperado:null,diferencia:null};appConfig.activeCashierId=cashier.id;appConfig.business.cajero=cashier.nombre;const persistResult=await saveAllData();if(!_naWasPersisted(persistResult)){cajEstado=backup.cajEstado;appConfig.activeCashierId=backup.activeCashierId;appConfig.business.cajero=backup.businessCajero;await saveAllData();cajRender();toast('No se pudo abrir la caja porque no existe almacenamiento permanente verificado','error');return false;}cerrarModal('mApertura');cajRender();toast(`Caja abierta por ${cashier.nombre} con ${fmt(fund)}`,'success');return true;};
abrirMovCaja=function(tipo){if(isModuleLocked('caja')){toast('Módulo de caja protegido','error');return;}if(!_naSessionOpen()){toast('Abre la caja del día primero','error');return;}cajMovTipo=tipo;const color=CAJ_COL[tipo];document.getElementById('mMovCajaHead').className=`mhead ${color}`;document.getElementById('mMovCajaTit').textContent=`${CAJ_IC[tipo]} ${CAJ_LBL[tipo]}`;document.getElementById('cajMovBtn').className=`mbtn mbtn-ok ${color}`;document.getElementById('cajMovMonto').value='';document.getElementById('cajMovDesc').value='';document.getElementById('cajMovCat').innerHTML=CAJ_CATS[tipo].map(c=>`<option>${_naEsc(c)}</option>`).join('');document.getElementById('mMovCaja').classList.add('open');};
let cajMovProc=false,cajCloseProc=false;
guardarMovCaja=async function(){
  if(cajMovProc)return;
  if(isModuleLocked('caja')){toast('Módulo de caja protegido','error');return;}
  if(!_naSessionOpen()){toast('La caja no está abierta','error');return;}
  const amount=_naNumber(document.getElementById('cajMovMonto').value),desc=_naClean(document.getElementById('cajMovDesc').value);
  if(amount<=0||!desc){toast('Completa monto y concepto','error');return;}
  const button=document.getElementById('cajMovBtn'),buttonText=button?.textContent||'✅ Registrar';
  cajMovProc=true;
  if(button){button.disabled=true;button.textContent='Procesando…';}
  try{
    const method=document.getElementById('cajMovMetodo').value,now=new Date(),cashier=_naCashierSnapshot(cajEstado.cajeroId||cajEstado.cajero);
    const backup=_naClone(cajMovs);
    cajMovs.push({id:Date.now(),tipo:cajMovTipo,monto:amount,efectivo:method==='efectivo'?amount:0,desc,cat:document.getElementById('cajMovCat').value,metodo:method,hora:nowT(),hora24:_naTime24(now),timestamp:now.toISOString(),cajero:cashier.nombre,cajeroNombre:cashier.nombre,cajeroId:cashier.id,fecha:obtenerHoy(),sessionId:cajEstado.sessionId});
    const persistResult=await saveAllData();
    if(!_naWasPersisted(persistResult)){cajMovs=backup;await saveAllData();cajRender();toast('No se guardó el movimiento porque no existe almacenamiento permanente verificado','error');return;}
    cerrarModal('mMovCaja');cajRender();toast(`${CAJ_LBL[cajMovTipo]} de ${fmt(amount)} registrado`,'success');
  }finally{
    cajMovProc=false;
    if(button){button.disabled=false;button.textContent=buttonText;}
  }
};
cerrarCaja=async function(){
  if(cajCloseProc)return;
  if(isModuleLocked('caja')){toast('Módulo de caja protegido','error');return;}
  if(cajEstado.cerrada){toast('La caja ya está cerrada','error');return;}
  const counted=_naNumber(document.getElementById('cajContado').value,NaN);
  if(!Number.isFinite(counted)||counted<0){toast('Ingresa el efectivo contado','error');return;}
  const button=document.querySelector('#mCierre .mbtn-ok'),buttonText=button?.textContent||'🔒 Confirmar cierre';
  cajCloseProc=true;
  if(button){button.disabled=true;button.textContent='Procesando…';}
  try{
    const expected=cajTotales().ef,now=new Date();
    // FIX02: el respaldo cubre cajEstado Y el historial; el cierre queda congelado como registro inmutable.
    const backup={cajEstado:_naClone(cajEstado),cashClosures:_naClone(cashClosures)};
    cajEstado.cerrada=true;cajEstado.horaCierre=nowT();cajEstado.horaCierre24=_naTime24(now);cajEstado.timestampCierre=now.toISOString();cajEstado.contado=counted;cajEstado.esperado=expected;cajEstado.diferencia=Number((counted-expected).toFixed(2));
    cashClosures.push({id:`C-${_naClosureDeviceTag()}-${cajEstado.sessionId??`X${Date.now()}`}`,sessionId:cajEstado.sessionId??null,cajero:cajEstado.cajero,cajeroNombre:cajEstado.cajeroNombre,cajeroId:cajEstado.cajeroId,fechaApertura:cajEstado.fechaApertura,hora:cajEstado.hora,hora24:cajEstado.hora24,timestampApertura:cajEstado.timestampApertura,fondo:cajEstado.fondo,fechaCierre:obtenerHoy(),horaCierre:cajEstado.horaCierre,horaCierre24:cajEstado.horaCierre24,timestampCierre:cajEstado.timestampCierre,contado:cajEstado.contado,esperado:cajEstado.esperado,diferencia:cajEstado.diferencia});
    const persistResult=await saveAllData();
    if(!_naWasPersisted(persistResult)){cajEstado=backup.cajEstado;cashClosures=backup.cashClosures;await saveAllData();cajRender();toast('No se pudo guardar el cierre de caja porque no existe almacenamiento permanente verificado','error');return;}
    cerrarModal('mCierre');cajRender();toast(`Caja cerrada · diferencia ${fmt(cajEstado.diferencia)}`,Math.abs(cajEstado.diferencia)<.01?'success':'error');
  }finally{
    cajCloseProc=false;
    if(button){button.disabled=false;button.textContent=buttonText;}
  }
};
cajRender=function(){const all=cajMovs,session=_naCajaMovsSesion();cajMovs=session;try{_baseCajRender();}finally{cajMovs=all;}if(cajEstado?.cerrada){const banner=document.querySelector('#cajContent .banner-cerrada-cj');if(banner&&!banner.querySelector('.btn-abrir-cj')){const diff=Number(cajEstado.diferencia||0);banner.insertAdjacentHTML('beforeend',`${cajEstado.contado!=null?`<div style="font-size:11px;opacity:.8">Contado: ${fmt(cajEstado.contado)} · Diferencia: ${fmt(diff)}</div>`:''}<button class="btn-abrir-cj" onclick="abrirModalApertura()"><i class="na-ic na-ic-unlock" aria-hidden="true"></i> Nueva apertura</button>`);}}else if(!cajEstado?.abierta){document.querySelector('#cajContent .btn-abrir-cj')?.setAttribute('onclick','abrirModalApertura()');}updateDashboard();};

// Ventas y utilidad real
calcularGanancias=function(){const today=ventas.filter(v=>v.fecha===obtenerHoy()&&!v.anulada),sales=today.reduce((sum,v)=>sum+totalV(v),0),cost=today.reduce((sum,v)=>sum+v.items.reduce((a,i)=>{const units=_naUnitsSold(i),stored=_naNumber(i.costo,NaN),prod=productos.find(p=>String(p.id)===String(i.id))||productos.find(p=>p.name===i.name),unitCost=Number.isFinite(stored)&&stored>0?stored:_naNumber(prod?.costo);return a+unitCost*units;},0),0),operating=cajMovs.filter(m=>m.tipo==='gas'&&m.fecha===obtenerHoy()).reduce((a,m)=>a+m.monto,0),gross=sales-cost,net=gross-operating;return{ventasNetas:sales,costoMercaderia:cost,gananciaBruta:gross,gastosHoy:operating,gananciaNeta:net,margenReal:gross};};
ventasRender=function(){_baseVentasRender();const g=calcularGanancias(),k=document.getElementById('ventasKPI');if(k)k.innerHTML=`<div class="vkpi teal"><div class="vkpi-val">${fmt(g.ventasNetas)}</div><div class="vkpi-lbl">Ventas netas</div></div><div class="vkpi green"><div class="vkpi-val">${fmt(g.gananciaBruta)}</div><div class="vkpi-lbl">Ganancia bruta</div></div><div class="vkpi amber"><div class="vkpi-val">${fmt(g.gastosHoy)}</div><div class="vkpi-lbl">Gastos operativos</div></div><div class="vkpi purple"><div class="vkpi-val">${fmt(g.gananciaNeta)}</div><div class="vkpi-lbl">Ganancia neta</div></div>`;};
function _naSalePaymentParts(sale){
  const total=Math.max(0,_naNumber(totalV(sale))),breakdown=sale?.paymentBreakdown||sale?.detallePago||{};
  let cash=0,digital=0,digitalMethod='';
  if(sale?.metodo==='efectivo')cash=total;
  else if(sale?.metodo==='mixto'){
    const linkedMove=cajMovs.find(move=>move.tipo==='ing'&&String(move.ventaId)===String(sale.id));
    cash=Math.max(0,_naNumber(breakdown.efectivo,_naNumber(sale.efectivo,_naNumber(sale.recibido,_naNumber(linkedMove?.efectivo)))));
    cash=Math.min(total,cash);
    digital=Math.max(0,_naNumber(breakdown.digital,Number((total-cash).toFixed(2))));
    digitalMethod=_naClean(breakdown.digitalMethod||linkedMove?.detallePago?.digitalMethod||'transferencia');
  }else if(sale?.metodo==='yape'||sale?.metodo==='plin'||sale?.metodo==='transferencia'){
    digital=total;digitalMethod=sale.metodo;
  }
  return{total,cash:Number(cash.toFixed(2)),digital:Number(digital.toFixed(2)),digitalMethod,reference:_naClean(sale?.paymentRef||breakdown.reference||'')};
}
function _naSaleHasReversal(saleId){
  return cajMovs.some(move=>_naIsSaleReversalMove(move)&&String(move.reversalOf)===String(saleId));
}
function _naSaleHasInventoryReversal(saleId){
  return Array.isArray(inventoryMovements)&&inventoryMovements.some(move=>move?.type==='SALE_REVERSAL'&&String(move.referenceId)===String(saleId));
}
let _naSaleAnnulmentProc=false;
anularV=async function(id){
  if(isModuleLocked('ventas')){toast('Las ventas están bloqueadas','error');return;}
  if(_naSaleAnnulmentProc)return;
  const initialSale=ventas.find(x=>String(x.id)===String(id));
  if(!initialSale){toast('Venta no encontrada','error');return;}
  if(initialSale.anulada){toast('La venta ya fue anulada; no se realizaron nuevos movimientos');return;}
  if(_naSaleHasInventoryReversal(initialSale.id)){toast('La venta ya tiene una reversión de inventario; no se realizaron nuevos movimientos','error');return;}
  const linked=initialSale.creditId?creditos.find(cr=>String(cr.id)===String(initialSale.creditId)):null;
  if(linked&&_naNumber(linked.pagado)>0){toast('No se puede anular automáticamente: el crédito ya tiene pagos registrados','error');return;}
  const payment=_naSalePaymentParts(initialSale);
  if(payment.cash>0&&!_naSessionOpen()){toast('Abre la caja para registrar la devolución de la parte en efectivo','error');return;}
  _naSaleAnnulmentProc=true;
  let backup=null;
  try{
    const accepted=await _naConfirmAction(
      `Se repondrá el stock y se revertirá ${payment.cash>0?fmt(payment.cash)+' de efectivo':'el pago registrado'} de la venta ${initialSale.id}.`,
      {title:'Anular venta',subtitle:'La operación quedará en el historial y no podrá revertirse dos veces.',icon:'↩️',danger:true,okText:'Anular venta'}
    );
    if(!accepted)return;
    // FIX04: todo dato observado antes de la confirmación se revalida después del await.
    const v=ventas.find(x=>String(x.id)===String(id));
    if(!v||String(v.id)!==String(id)){toast('Venta no encontrada','error');return;}
    if(v.anulada){toast('La venta ya fue anulada; no se realizaron nuevos movimientos');return;}
    if(_naSaleHasInventoryReversal(v.id)){toast('La venta ya tiene una reversión de inventario; no se realizaron nuevos movimientos','error');return;}
    if(!Array.isArray(v.items)){toast('La venta no tiene un detalle válido para anular','error');return;}
    const currentLinked=v.creditId?creditos.find(cr=>String(cr.id)===String(v.creditId)):null;
    if(currentLinked&&_naNumber(currentLinked.pagado)>0){toast('No se puede anular automáticamente: el crédito ya tiene pagos registrados','error');return;}
    const currentPayment=_naSalePaymentParts(v);
    if(currentPayment.cash>0&&!_naSessionOpen()){toast('Abre la caja para registrar la devolución de la parte en efectivo','error');return;}
    backup={productos:_naClone(productos),ventas:_naClone(ventas),clientes:_naClone(clientes),creditos:_naClone(creditos),cajMovs:_naClone(cajMovs),inventoryMovements:_naClone(inventoryMovements)};
    const annulNow=new Date(),annulCashier=_naCashierSnapshot(cajEstado?.cajeroId||cajEstado?.cajero||appConfig.activeCashierId);v.anulada=true;v.estado='anulada';v.anuladaAt=annulNow.toISOString();v.anuladaPor=annulCashier.nombre;v.anuladaPorId=annulCashier.id;v.horaAnulacion=_naTime24(annulNow);
    for(const item of v.items){const prod=productos.find(p=>String(p.id)===String(item.id));if(!prod||!_naTracksStock(prod))continue;const units=_naUnitsSold(item);if(units<=0)continue;const outcome=applyInventoryMovement({productId:prod.id,type:'SALE_REVERSAL',delta:units,reason:`Anulación venta ${v.id}`,source:'SALE_REVERSAL',referenceId:v.id});if(!outcome.ok)throw new Error(outcome.message||'No se pudo revertir el inventario');}
    if(currentLinked){currentLinked.anulado=true;currentLinked.status='anulado';currentLinked.pagado=0;}
    const client=clientes.find(c=>String(c.id)===String(v.clienteId));
    if(client)client.totalCompras=Math.max(0,_naNumber(client.totalCompras)-currentPayment.total);
    if(!_naSaleHasReversal(v.id)){
      cajMovs.push({
        id:Date.now(),tipo:'egr',monto:currentPayment.total,efectivo:currentPayment.cash,digital:currentPayment.digital,
        desc:`Anulación venta ${v.id}`,cat:'Devolución',metodo:v.metodo,referencia:currentPayment.reference,
        detallePago:v.metodo==='mixto'?{efectivo:currentPayment.cash,digital:currentPayment.digital,digitalMethod:currentPayment.digitalMethod,reference:currentPayment.reference,reversal:true}:null,
        reversal:true,reversalOf:v.id,hora:nowT(),timestamp:new Date().toISOString(),
        cajero:annulCashier.nombre,cajeroNombre:annulCashier.nombre,cajeroId:annulCashier.id,hora24:_naTime24(annulNow),fecha:obtenerHoy(),
        sessionId:_naSessionOpen()?cajEstado.sessionId||null:null,ventaId:v.id
      });
    }
    const inventoryReversalRequired=v.items.some(item=>{const prod=productos.find(p=>String(p.id)===String(item.id));return !!prod&&_naTracksStock(prod)&&_naUnitsSold(item)>0;}),persistResult=await saveAllData();
    const persistedSale=ventas.find(x=>String(x.id)===String(id));
    if(!_naWasPersisted(persistResult)||!persistedSale?.anulada||!_naSaleHasReversal(id)||(inventoryReversalRequired&&!_naSaleHasInventoryReversal(id)))throw new Error('No se pudo verificar la anulación persistida');
    ventasRender();invRender();cajRender();updateDashboard();
    toast(currentPayment.cash>0?`Venta anulada: se revirtieron ${fmt(currentPayment.cash)} de efectivo y se repuso el stock`:'Venta anulada y stock repuesto','success');
  }catch(error){
    if(backup){productos=backup.productos;ventas=backup.ventas;clientes=backup.clientes;creditos=backup.creditos;cajMovs=backup.cajMovs;inventoryMovements=backup.inventoryMovements;await saveAllData();}
    toast('No se pudo guardar la anulación','error');
  }finally{_naSaleAnnulmentProc=false;}
};

