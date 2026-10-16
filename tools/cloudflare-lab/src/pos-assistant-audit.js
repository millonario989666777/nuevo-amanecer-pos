// Registro de auditoría del asistente (A20). SIN migración: reusa pos_settings con claves internas
// `internal:asst:audit:<fecha ISO>:<aleatorio>` (no se pueden escribir ni listar por /settings: SETTING_KEY no admite «:» y el listado excluye internal:%).
// Una fila por llamada a herramienta (propuesta, descartada) y por confirmación. Sin textos del chat, sin argumentos, sin PIN, DNI ni tokens:
// solo quién (aparato), rol, herramienta, tipo de tarjeta, resultado, id de tarjeta y operation_id. Se guardan las últimas 300
// (bajado de 1000: estas filas viajan en el respaldo de pos_settings y alargan el recorrido de GET /settings, que filtra internal:%).
// Escribir el registro nunca rompe el chat ni el confirm: un error se avisa con console.warn (sin datos) y se cuenta;
// GET /auth/assistant/audit lo muestra en write_errors (contador de ESTA instancia del Worker, se reinicia al reciclarla).
// Si se quiere una tabla propia, queda para una migración aprobada.
export const AUDIT_PATH = '/auth/assistant/audit';
export const AUDIT_PREFIX = 'internal:asst:audit:';
export const AUDIT_KEEP = 300;
const stats = { write_errors: 0, last_write_error_at: null };
export const auditStats = () => ({ ...stats });
const s = (v, n) => (v == null ? null : String(v).slice(0, n));

export async function auditWrite(db, rows) {
  if (!db || !rows || !rows.length) return 0;
  const at = new Date().toISOString(); let n = 0;
  try {
    const stmts = rows.map((r, i) => db.prepare('INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?1,?2,1,?3,?4)')
      .bind(AUDIT_PREFIX + at + ':' + String(i).padStart(2, '0') + ':' + crypto.randomUUID().slice(0, 8), JSON.stringify({
        at, device_id: s(r.device_id, 160), role: s(r.role, 40), tool: s(r.tool, 40), type: s(r.type, 20), outcome: s(r.outcome, 40), card_id: s(r.card_id, 64), operation_id: s(r.operation_id, 64),
      }), at, s(r.device_id, 120) || 'assistant'));
    stmts.push(db.prepare(`DELETE FROM pos_settings WHERE key LIKE ?1 AND key NOT IN (SELECT key FROM pos_settings WHERE key LIKE ?1 ORDER BY key DESC LIMIT ${AUDIT_KEEP})`).bind(AUDIT_PREFIX + '%'));
    if (typeof db.batch === 'function') await db.batch(stmts); else for (const st of stmts) await st.run();
    n = rows.length;
  } catch (e) {
    n = 0; stats.write_errors++; stats.last_write_error_at = new Date().toISOString();
    // Sin claves, filas ni el mensaje: solo el tipo de error y su código (D1_*/SQLITE_*).
    try { console.warn('[asistente] no se pudo anotar la auditoría:', String(e?.name || 'Error'), (String(e?.message || '').match(/\b(?:D1_[A-Z_]+|SQLITE_[A-Z_]+|no such table)\b/) || ['sin_codigo'])[0]); } catch { /* nada */ }
  }
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
  let rows = []; try { rows = (await db.prepare('SELECT value_json FROM pos_settings WHERE key LIKE ?1 ORDER BY key DESC LIMIT ?2').bind(AUDIT_PREFIX + '%', limit).all())?.results || []; } catch { rows = []; }
  const entries = rows.map((r) => { try { return JSON.parse(r.value_json); } catch { return null; } }).filter(Boolean);
  return json({ entries, keep: AUDIT_KEEP, write_errors: stats.write_errors, last_write_error_at: stats.last_write_error_at });
}
