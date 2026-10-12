/*
 * js/core/lima-time.js - hora de negocio (America/Lima).
 *
 * Nuevo Amanecer opera en Lima (UTC-5, sin horario de verano). Las fechas que
 * ve el dueño (Historial de ventas, encabezado de Caja, "Caja de otro día") se
 * calculan en ese huso aunque el teléfono o la PC tengan otra zona horaria
 * configurada (por ejemplo UTC). Solo presentación: no escribe datos.
 */
(function(root){
  'use strict';
  var OFFSET_MS=5*60*60*1000;
  var DAYS=['dom','lun','mar','mié','jue','vie','sáb'];
  var MONTHS=['ene','feb','mar','abr','may','jun','jul','ago','set','oct','nov','dic'];
  function pad(v){return String(v).padStart(2,'0');}
  function toDate(value){
    if(value===undefined||value===null||value==='')return null;
    var d=value instanceof Date?value:new Date(value);
    return Number.isFinite(d.getTime())?d:null;
  }
  // Instant -> calendar parts in Lima. Fixed UTC-5 (Peru has no DST since 1994),
  // so the result does not depend on the device time zone or on ICU data.
  function parts(value){
    var d=value===undefined?new Date():toDate(value);if(!d)return null;
    var l=new Date(d.getTime()-OFFSET_MS);
    return{date:l.getUTCFullYear()+'-'+pad(l.getUTCMonth()+1)+'-'+pad(l.getUTCDate()),time:pad(l.getUTCHours())+':'+pad(l.getUTCMinutes()),seconds:pad(l.getUTCSeconds()),weekday:l.getUTCDay(),day:l.getUTCDate(),month:l.getUTCMonth(),year:l.getUTCFullYear()};
  }
  function today(){return parts(new Date()).date;}
  function timeNow(){var p=parts(new Date());return p.time+':'+p.seconds;}
  // "lun, 12 oct." like es-PE, but always on the Lima calendar day.
  function shortDateLabel(value){var p=parts(value);if(!p)return'';return DAYS[p.weekday]+', '+p.day+' '+MONTHS[p.month]+'.';}
  function dateTimeLabel(value){var p=parts(value);return p?p.date+' '+p.time:'';}
  var api=Object.freeze({TIME_ZONE:'America/Lima',parts:parts,today:today,timeNow:timeNow,shortDateLabel:shortDateLabel,dateTimeLabel:dateTimeLabel});
  root.NALimaTime=api;
  // obtenerHoy() (utils.js) used the device zone: on a phone/PC set to UTC, a till
  // opened at 20:23 in Lima looked like "otro día" after 19:00. Same contract
  // (YYYY-MM-DD string), now on the business calendar.
  if(typeof root.obtenerHoy==='function')root.obtenerHoy=today;
})(globalThis);
