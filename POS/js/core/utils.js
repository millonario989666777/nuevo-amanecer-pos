/*
 * js/core/utils.js - utilidades TRANSVERSALES compartidas del POS (ETAPA 4, work item CORE/UTILS).
 *
 * Criterio estricto de transversalidad (demostrada por dependencia de uso
 * multi-modulo o bloque UTILS original del autor):
 *   fmt(224 usos) fmtS nowT obtenerHoy(51) HOY diasHasta(17) sinTildes(38)
 *   initials COLORS colorFor _naEsc(199) _naClean _naNumber(271) _naInt
 *   _naClone(65) _naIsPlainObject(15) _naRoundMoney(10)
 * Excluidas deliberadamente (dominio unico): familia ticket (_naTk, _naTicket),
 * familia reportes (_naF8, _naF9), importacion/productos (_naImport, alt-codes,
 * category), impresion-UI (_naEsAndroid, _naEsMovil), seguridad (_naSecHash),
 * _naNewUuid (reside dentro del script V10 dormante) y un-consumidor
 * (_naTime24, _naParseTime24, _naUnitsPerQty, _naUnitsSold, _naLineKey,
 * _naDatePlus, _naCashierIdNumber, _naCsvCell).
 *
 * Extraidas byte-exacto desde POS/index.html @ 45c8c1e (FASE 7 frozen).
 * Codigo MOVIDO, no reescrito. Classic script SIN defer/async; carga antes
 * de todos los scripts inline. Sin negocio, sin storage, sin DOM, sin V10.
 */


// ===== UTILS =====
const fmt=n=>`S/ ${parseFloat(n||0).toFixed(2)}`;
const fmtS=n=>`S/${parseFloat(n||0).toFixed(0)}`;
const nowT=()=>new Date().toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
function obtenerHoy(){const ahora=new Date();const local=new Date(ahora.getTime()-(ahora.getTimezoneOffset()*60000));return local.toISOString().split('T')[0];}
const HOY=obtenerHoy;
const diasHasta=s=>{if(!s)return null;const d=new Date(String(s).slice(0,10)+'T00:00:00');if(Number.isNaN(d.getTime()))return null;const hoyD=new Date(obtenerHoy()+'T00:00:00');return Math.round((d-hoyD)/86400000);};
const sinTildes=str=>str.normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const initials=n=>n.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
const COLORS=['#00bca4','#ff7043','#a855f7','#3b82f6','#f59e0b','#ef4444','#22c55e','#64748b'];
const colorFor=i=>COLORS[i%8];
const _naEsc=value=>String(value??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
const _naClean=value=>String(value??'').replace(/[<>]/g,'').trim();
const _naNumber=(value,fallback=0)=>{if(typeof value==='number')return Number.isFinite(value)?value:fallback;let str=String(value??'').trim().replace(/\s/g,'');if(!str)return fallback;if(str.includes(',')&&str.includes('.')){if(str.lastIndexOf(',')>str.lastIndexOf('.'))str=str.replace(/\./g,'').replace(',','.');else str=str.replace(/,/g,'');}else if(str.includes(','))str=str.replace(',','.');str=str.replace(/[^0-9.-]/g,'');const n=Number(str);return Number.isFinite(n)?n:fallback;};
const _naInt=(value,fallback=0)=>{const n=Math.trunc(_naNumber(value,NaN));return Number.isFinite(n)?n:fallback;};
const _naClone=value=>{try{return structuredClone(value);}catch(error){return JSON.parse(JSON.stringify(value));}};
function _naIsPlainObject(value){if(!value||Object.prototype.toString.call(value)!=='[object Object]')return false;const proto=Object.getPrototypeOf(value);return proto===Object.prototype||proto===null;}
function _naRoundMoney(value){return Number(Math.max(0,_naNumber(value)).toFixed(2));}

// Document placeholders are storage identities, never customer document numbers.
function isPlaceholderDoc(v) { return /^SIN-DOC/i.test(String(v ?? '').trim()); }
function displayDoc(v) { const doc = String(v ?? '').trim(); return !doc || isPlaceholderDoc(doc) ? 'Sin DNI' : doc; }
function _naDocumentValue(v) { return isPlaceholderDoc(v) ? '' : String(v ?? '').trim(); }
if (typeof window !== 'undefined') window.NA_DOC = { isPlaceholderDoc, displayDoc };

// Presentation computations for Inicio; no mutation of credits or cash state.
function _naInicioMoney(v) { return 'S/ ' + _naNumber(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _naInicioCredits(records) {
  const active = records.filter(cr => {
    const states = [cr.status, cr.estado].map(v => String(v || '').toLowerCase());
    return !cr.anulado && !cr.anulada && !cr.voided && !states.some(s => ['cancelado','pagado','paid','anulado','anulada','annulled','void','voided'].includes(s)) && _naInicioBalance(cr) > 0;
  });
  return { active, debt: Number(active.reduce((sum, cr) => sum + _naInicioBalance(cr), 0).toFixed(2)) };
}
function _naInicioBalance(cr) { const computed = _naNumber(cr.monto) - _naNumber(cr.pagado); return Math.max(0, Number((cr.saldo != null && cr.saldo !== '' ? _naNumber(cr.saldo) : computed).toFixed(2))); }
function _naCriticalStock(p) {
  return p?.controlInventario !== false && p?.trackStock !== false && p?.track_stock !== false && ![p?.tipo,p?.type,p?.unidad,p?.cat].some(v => /^(servicio|service)$/i.test(String(v || ''))) && _naNumber(p?.stockMin) > 0 && _naNumber(p?.stock) <= _naNumber(p?.stockMin);
}
function _naInicioCashText(state) {
  const name = String(state?.cajeroNombre || state?.cajero || '').trim();
  let time = '';
  const stamp = state?.timestampApertura;
  if (stamp && Number.isFinite(new Date(stamp).getTime())) time = new Date(stamp).toLocaleTimeString('en-GB', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false });
  else {
    const raw = String(state?.hora24 || state?.horaApertura || state?.hora || '');
    const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?/i);
    if (match) { let hour = Number(match[1]); if (match[3]) hour = hour % 12 + (/^p/i.test(match[3]) ? 12 : 0); if (hour < 24 && Number(match[2]) < 60) time = String(hour).padStart(2,'0') + ':' + match[2]; }
  }
  return ['Abierta', name, time].filter(Boolean).join(' · ');
}
