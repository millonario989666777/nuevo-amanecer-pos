// Registro de auditoría del asistente (A20). SIN migración: reusa pos_settings con claves internas (máx. 60 caracteres).
// No se pueden escribir ni listar por /settings: SETTING_KEY no admite «:» y el listado excluye internal:%.
// Sin textos del chat, sin argumentos, sin PIN, DNI ni tokens: solo quién (aparato), rol, herramienta, tipo de tarjeta,
// resultado, id de tarjeta y operation_id.
//
// Cinco cajones con tope PROPIO. El cajón lo decide el rol que el SERVIDOR leyó para el aparato (no lo que dice el pedido):
// nada de otro teléfono puede sacar filas del dueño, ni sus acciones ni sus rechazos.
//   o   internal:asst:audit:o:<ISO>:<i>:<rand>                acciones del DUEÑO (propuesta, descartada, confirmada)        últimas 1000
//   or  internal:asst:audit:or:<ISO>:<i>:<rand>               rechazos del DUEÑO, uno por uno (422/409/410/403/400...)       últimas 300
//   oa  internal:asst:audit:oa:<minuto>:<aparato>:<c|k><res.> 429 y 403 de rol del DUEÑO agrupados por minuto con `count`    últimas 100
//   r   internal:asst:audit:r:<ISO>:<i>:<rand>                acciones de empleados (propuesta, descartada, confirmada)      últimas 300
//   a   internal:asst:audit:a:<minuto>:<aparato>:<c|k><res.>  TODO rechazo de un aparato que no es dueño (empleado o sin rol),
//                                                             agrupado por aparato, minuto, ruta y motivo con `count`       últimas 300
// Las filas agrupadas se suman con upsert (no una fila por intento). c = chat, k = confirm.
// Escribir el registro nunca rompe el chat ni el confirm: un error se avisa con console.warn (solo el código) y se cuenta
// en write_errors (contador de ESTA instancia del Worker). Una tabla propia queda para una migración aprobada.
import { sha256Hex } from './a5-import-core.js';

export const AUDIT_PATH = '/auth/assistant/audit';
export const AUDIT_PREFIX = 'internal:asst:audit:';
export const AUDIT_CAPS = Object.freeze({ o: 1000, or: 300, oa: 100, r: 300, a: 300 });
const AGG_BUCKETS = new Set(['a', 'oa']);
export const AUDIT_KEEP = AUDIT_CAPS.o;
// Rango de claves con un prefijo: key >= prefijo AND key < prefijo con la última letra +1. A diferencia de LIKE 'prefijo%', SQLite
// usa el índice de la clave primaria (no recorre toda pos_settings) y no trata «_» ni «%» como comodines (Bot 3).
export function prefixRange(prefix) { const p = String(prefix); return [p, p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1)]; }
const bucketRange = (b) => prefixRange(AUDIT_PREFIX + b + ':');
const stats = { write_errors: 0, last_write_error_at: null };
export const auditStats = () => ({ ...stats });
const s = (v, n) => (v == null ? null : String(v).slice(0, n));
const AGG_OUTCOMES = new Set(['rate_limited', 'forbidden_role', 'assistant_off', 'admin_only', 'other_device', 'forbidden_document', 'image_owner_only']);
// Nombre corto para la clave (máx. 14): mismo motivo, misma fila.
const AGG_SHORT = { forbidden_document: 'forbidden_doc', image_owner_only: 'img_owner_only' };
export const isAggregated = (outcome) => AGG_OUTCOMES.has(String(outcome || '').replace(/^rejected:/, ''));
export function bucketOf(r) {
  const owner = r.role === 'owner', rej = String(r.outcome || '').startsWith('rejected');
  if (!rej) return owner ? 'o' : 'r';
  return owner ? (r.aggregate ? 'oa' : 'or') : 'a';
}
function warn(e) {
  stats.write_errors++; stats.last_write_error_at = new Date().toISOString();
  // Sin claves, filas ni el mensaje: solo el tipo de error y su código (D1_*/SQLITE_*).
  try { console.warn('[asistente] no se pudo anotar la auditoría:', String(e?.name || 'Error'), (String(e?.message || '').match(/\b(?:D1_[A-Z_]+|SQLITE_[A-Z_]+|no such table)\b/) || ['sin_codigo'])[0]); } catch { /* nada */ }
}

export async function auditWrite(db, rows) {
  if (!db || !rows || !rows.length) return 0;
  const at = new Date().toISOString(), minute = Math.floor(Date.now() / 60000); let n = 0;
  try {
    const stmts = [], used = new Set();
    for (const [i, r] of rows.entries()) {
      const b = bucketOf(r); used.add(b);
      const val = { at, device_id: s(r.device_id, 160), role: s(r.role, 40), tool: s(r.tool, 40), type: s(r.type, 20), outcome: s(r.outcome, 40), card_id: s(r.card_id, 64), operation_id: s(r.operation_id, 64), ...(r.src ? { src: s(r.src, 10) } : {}) };
      if (AGG_BUCKETS.has(b)) {
        const full = String(r.outcome || '').replace(/^rejected:/, ''), out = (AGG_SHORT[full] || full).slice(0, 14);
        // c = chat, k = confirm: el mismo motivo en rutas distintas son filas distintas. Clave <= 58 caracteres.
        const key = AUDIT_PREFIX + b + ':' + minute + ':' + (await sha256Hex(String(r.device_id || ''))).slice(0, 10) + ':' + (r.src === 'chat' ? 'c' : 'k') + out;
        stmts.push(db.prepare(`INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?1,?2,1,?3,?4)
          ON CONFLICT(key) DO UPDATE SET value_json=json_set(pos_settings.value_json,'$.count',COALESCE(json_extract(pos_settings.value_json,'$.count'),0)+1,'$.last_at',?3),
          revision=pos_settings.revision+1,updated_at=?3`).bind(key, JSON.stringify({ ...val, outcome: 'rejected:' + full.slice(0, 31), src: r.src === 'chat' ? 'chat' : 'confirm', count: 1, minute, last_at: at }), at, s(r.device_id, 120) || 'assistant'));
      } else {
        stmts.push(db.prepare('INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?1,?2,1,?3,?4)')
          .bind(AUDIT_PREFIX + b + ':' + at + ':' + String(i).padStart(2, '0') + ':' + crypto.randomUUID().slice(0, 8), JSON.stringify(val), at, s(r.device_id, 120) || 'assistant'));
      }
    }
    // Tope por cajón: cada uno se recorta SOLO con sus propias filas.
    for (const b of used) stmts.push(db.prepare(`DELETE FROM pos_settings WHERE key >= ?1 AND key < ?2 AND key NOT IN (SELECT key FROM pos_settings WHERE key >= ?1 AND key < ?2 ORDER BY key DESC LIMIT ${AUDIT_CAPS[b]})`).bind(...bucketRange(b)));
    if (typeof db.batch === 'function') await db.batch(stmts); else for (const st of stmts) await st.run();
    n = rows.length;
  } catch (e) { n = 0; warn(e); }
  return n;
}

// GET /auth/assistant/audit?limit=200[&grupo=o|or|oa|r|a] — solo aparato dueño (fila owner explícita). Empleado y sin rol: 403.
// Sin grupo: `entries` trae PRIMERO las acciones del dueño (o), luego sus rechazos (or, oa) y al final empleados (r, a), cada parte de la más nueva a la
// más vieja; así una inundación de rechazos nunca tapa las filas del dueño. `grupos` dice cuántas filas guarda cada cajón.
// Con grupo: solo ese cajón (para ver los rechazos aunque el dueño tenga muchas filas).
export async function auditRoute(request, env, auth, json, deps = {}) {
  if (String(env?.ASSISTANT_ENABLED || '') !== '1') return json({ error: 'not_found' }, 404);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const db = deps.db; if (!db) return json({ error: 'db_missing' }, 500);
  let own = null; try { own = await db.prepare('SELECT pos_role FROM pos_device_roles WHERE device_id=?1').bind(String(auth?.principalId || '')).first(); } catch { own = null; }
  if (own?.pos_role !== 'owner' || auth?.posRole !== 'owner') return json({ error: 'admin_only' }, 403);
  const qs = new URL(request.url).searchParams;
  const limit = Math.max(1, Math.min(500, Number(qs.get('limit')) || 200));
  const grupo = qs.get('grupo') || qs.get('bucket') || '';
  if (grupo && !Object.prototype.hasOwnProperty.call(AUDIT_CAPS, grupo)) return json({ error: 'bad_grupo', grupos: Object.keys(AUDIT_CAPS) }, 400);
  const order = (list) => list.sort((x, y) => String(y.last_at || y.at).localeCompare(String(x.last_at || x.at)));
  const parse = (rows, b) => rows.map((r) => { try { return { ...JSON.parse(r.value_json), grupo: b }; } catch { return null; } }).filter(Boolean);
  const by = {}, grupos = {};
  try {
    for (const b of (grupo ? [grupo] : Object.keys(AUDIT_CAPS))) {
      by[b] = parse((await db.prepare('SELECT value_json FROM pos_settings WHERE key >= ?1 AND key < ?2 ORDER BY key DESC LIMIT ?3').bind(...bucketRange(b), limit).all())?.results || [], b);
      grupos[b] = Number((await db.prepare('SELECT COUNT(*) AS n FROM pos_settings WHERE key >= ?1 AND key < ?2').bind(...bucketRange(b)).first())?.n || 0);
    }
  } catch { for (const b of Object.keys(by)) by[b] = []; }
  const entries = grupo ? order(by[grupo] || []).slice(0, limit)
    : [...order(by.o || []), ...order([...(by.or || []), ...(by.oa || [])]), ...order([...(by.r || []), ...(by.a || [])])].slice(0, limit);
  return json({ entries, grupo: grupo || null, grupos, keep: AUDIT_KEEP, caps: AUDIT_CAPS, write_errors: stats.write_errors, last_write_error_at: stats.last_write_error_at });
}
