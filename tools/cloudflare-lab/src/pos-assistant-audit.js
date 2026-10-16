// Registro de auditoría del asistente (A20). SIN migración: reusa pos_settings con claves internas (máx. 60 caracteres).
// No se pueden escribir ni listar por /settings: SETTING_KEY no admite «:» y el listado excluye internal:%.
// Sin textos del chat, sin argumentos, sin PIN, DNI ni tokens: solo quién (aparato), rol, herramienta, tipo de tarjeta,
// resultado, id de tarjeta y operation_id.
//
// Tres cajones con tope PROPIO, así el ruido de empleados o rechazos nunca saca filas del dueño:
//   o  internal:asst:audit:o:<ISO>:<i>:<rand>              acciones del DUEÑO (propuesta, descartada, confirmada)     últimas 1000
//   r  internal:asst:audit:r:<ISO>:<i>:<rand>              empleados y confirmaciones RECHAZADAS (422/409/410/403...)   últimas 300
//   a  internal:asst:audit:a:<minuto>:<aparato>:<resultado> 429 y 403 de rol AGRUPADOS: una fila por aparato, minuto y
//                                                           resultado con `count` (se suma con upsert, no fila por intento) últimas 300
// Escribir el registro nunca rompe el chat ni el confirm: un error se avisa con console.warn (solo el código) y se cuenta
// en write_errors (contador de ESTA instancia del Worker). Una tabla propia queda para una migración aprobada.
import { sha256Hex } from './a5-import-core.js';

export const AUDIT_PATH = '/auth/assistant/audit';
export const AUDIT_PREFIX = 'internal:asst:audit:';
export const AUDIT_CAPS = Object.freeze({ o: 1000, r: 300, a: 300 });
export const AUDIT_KEEP = AUDIT_CAPS.o;
const stats = { write_errors: 0, last_write_error_at: null };
export const auditStats = () => ({ ...stats });
const s = (v, n) => (v == null ? null : String(v).slice(0, n));
const AGG_OUTCOMES = new Set(['rate_limited', 'forbidden_role', 'assistant_off', 'admin_only', 'other_device']);
export const isAggregated = (outcome) => AGG_OUTCOMES.has(String(outcome || '').replace(/^rejected:/, ''));
const bucketOf = (r) => (r.aggregate ? 'a' : (r.role === 'owner' && !String(r.outcome || '').startsWith('rejected')) ? 'o' : 'r');
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
      const val = { at, device_id: s(r.device_id, 160), role: s(r.role, 40), tool: s(r.tool, 40), type: s(r.type, 20), outcome: s(r.outcome, 40), card_id: s(r.card_id, 64), operation_id: s(r.operation_id, 64) };
      if (b === 'a') {
        const out = String(r.outcome || '').replace(/^rejected:/, '').slice(0, 14);
        const key = AUDIT_PREFIX + 'a:' + minute + ':' + (await sha256Hex(String(r.device_id || ''))).slice(0, 10) + ':' + out;
        stmts.push(db.prepare(`INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?1,?2,1,?3,?4)
          ON CONFLICT(key) DO UPDATE SET value_json=json_set(pos_settings.value_json,'$.count',COALESCE(json_extract(pos_settings.value_json,'$.count'),0)+1,'$.last_at',?3),
          revision=pos_settings.revision+1,updated_at=?3`).bind(key, JSON.stringify({ ...val, outcome: 'rejected:' + out, count: 1, minute, last_at: at }), at, s(r.device_id, 120) || 'assistant'));
      } else {
        stmts.push(db.prepare('INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?1,?2,1,?3,?4)')
          .bind(AUDIT_PREFIX + b + ':' + at + ':' + String(i).padStart(2, '0') + ':' + crypto.randomUUID().slice(0, 8), JSON.stringify(val), at, s(r.device_id, 120) || 'assistant'));
      }
    }
    // Tope por cajón: cada uno se recorta SOLO con sus propias filas.
    for (const b of used) stmts.push(db.prepare(`DELETE FROM pos_settings WHERE key LIKE ?1 AND key NOT IN (SELECT key FROM pos_settings WHERE key LIKE ?1 ORDER BY key DESC LIMIT ${AUDIT_CAPS[b]})`).bind(AUDIT_PREFIX + b + ':%'));
    if (typeof db.batch === 'function') await db.batch(stmts); else for (const st of stmts) await st.run();
    n = rows.length;
  } catch (e) { n = 0; warn(e); }
  return n;
}

// GET /auth/assistant/audit?limit=200 — solo aparato dueño (fila owner explícita). Empleado y sin rol: 403.
export async function auditRoute(request, env, auth, json, deps = {}) {
  if (String(env?.ASSISTANT_ENABLED || '') !== '1') return json({ error: 'not_found' }, 404);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const db = deps.db; if (!db) return json({ error: 'db_missing' }, 500);
  let own = null; try { own = await db.prepare('SELECT pos_role FROM pos_device_roles WHERE device_id=?1').bind(String(auth?.principalId || '')).first(); } catch { own = null; }
  if (own?.pos_role !== 'owner' || auth?.posRole !== 'owner') return json({ error: 'admin_only' }, 403);
  const limit = Math.max(1, Math.min(500, Number(new URL(request.url).searchParams.get('limit')) || 200));
  let rows = [];
  try { for (const b of Object.keys(AUDIT_CAPS)) rows.push(...((await db.prepare('SELECT value_json FROM pos_settings WHERE key LIKE ?1 ORDER BY key DESC LIMIT ?2').bind(AUDIT_PREFIX + b + ':%', limit).all())?.results || [])); } catch { rows = []; }
  const entries = rows.map((r) => { try { return JSON.parse(r.value_json); } catch { return null; } }).filter(Boolean)
    .sort((x, y) => String(y.last_at || y.at).localeCompare(String(x.last_at || x.at))).slice(0, limit);
  return json({ entries, keep: AUDIT_KEEP, caps: AUDIT_CAPS, write_errors: stats.write_errors, last_write_error_at: stats.last_write_error_at });
}
