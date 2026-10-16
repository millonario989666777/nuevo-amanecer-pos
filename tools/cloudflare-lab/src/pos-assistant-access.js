// Permiso del asistente por aparato de empleado (prototipo aislado, rama feature/asistente-aislado).
// Tres niveles: 'off' (por defecto), 'consultas' (stock, por reponer, precios de venta; sin costos ni márgenes)
// y 'consultas_documentos' (lo anterior + lista de precios y lista de pedido imprimibles, sin costos).
// Contrato de Bot 5 (permiso_empleado): también se acepta enabled:true|false (true = consultas, false = off).
// - Se guarda en la tabla EXISTENTE pos_settings con clave interna (internal:asst:lvl:<hash del aparato>): sin cambio de esquema.
//   La lista pública de ajustes (/auth/settings) ya excluye las claves internal:%.
// - El servidor lo lee en CADA pedido de chat y de confirmación (sin caché): quitar el permiso aplica al instante.
// - Cambiarlo exige aparato dueño (fila pos_role='owner' explícita) + aprobación del dueño con PIN (POST /auth/owner-approval,
//   acción 'assistant.employee_access', ligada al operation_id del cambio y gastada de forma estricta: changes===1).
//   Compatibilidad: también vale el PIN en el cuerpo (verifyOwnerPin, con su límite de intentos por aparato).
// - Cada cambio se anota en pos_assistant_access_log SI la tabla existe (migración 0034, escrita y NO aplicada).
// - Las herramientas que cambian algo piden SIEMPRE el PIN del dueño en una tarjeta de un solo uso, en cualquier nivel.
import { sha256Hex } from './a5-import-core.js';
import { verifyOwnerPin } from './pos-roles.js';

export const ACCESS_LEVELS = Object.freeze(['off', 'consultas', 'consultas_documentos']);
export const ACCESS_APPROVAL_ACTION = 'assistant.employee_access';
export const ACCESS_PATH = '/auth/assistant/employee-access';
// Consumo estricto de aprobaciones del asistente (también lo usan las tarjetas en pos-assistant.js).
export const STRICT_APPROVAL_SQL = 'UPDATE pos_owner_approvals SET used_at=? WHERE approval_id=? AND device_id=? AND action=? AND expires_at>? AND operation_id=? AND used_at IS NULL';
const levelKey = async (deviceId) => 'internal:asst:lvl:' + (await sha256Hex(String(deviceId))).slice(0, 32);

export async function employeeLevel(db, deviceId) {
  if (!db || !deviceId) return 'off';
  try {
    const row = await db.prepare('SELECT value_json FROM pos_settings WHERE key=?1').bind(await levelKey(deviceId)).first();
    const v = row ? JSON.parse(row.value_json) : null;
    return ACCESS_LEVELS.includes(v?.level) ? v.level : 'off';
  } catch { return 'off'; } // sin tabla o error: apagado (falla cerrado)
}

// Rol del asistente: 'owner' (fila owner explícita) o 'empleado:<nivel>'. Se calcula en cada pedido.
export async function assistantAccess(db, auth) {
  if (!db || !auth?.principalId) return 'empleado:off';
  let row = null;
  try { row = await db.prepare('SELECT pos_role FROM pos_device_roles WHERE device_id=?1').bind(String(auth.principalId)).first(); } catch { return 'empleado:off'; }
  if (row?.pos_role === 'owner' && auth.posRole === 'owner') return 'owner';
  // Solo un aparato empleado vinculado (fila 'empleado') puede tener nivel; sin fila no hay asistente.
  if (row?.pos_role !== 'empleado') return 'empleado:off';
  return 'empleado:' + (await employeeLevel(db, auth.principalId));
}
export function accessLevel(role) { return role === 'owner' ? 'dueno' : String(role || '').split(':')[1] || 'off'; }
export function accessOn(role) { return role === 'owner' || role === 'empleado:consultas' || role === 'empleado:consultas_documentos'; }

async function isOwnerDevice(db, auth) {
  try { const r = await db.prepare('SELECT pos_role FROM pos_device_roles WHERE device_id=?1').bind(String(auth.principalId)).first(); return r?.pos_role === 'owner' && auth.posRole === 'owner'; } catch { return false; }
}
// Mismo consumo estricto que las tarjetas: UPDATE ... operation_id=? AND used_at IS NULL, válido solo con changes===1.
async function verifyOwnerApproval(db, deviceId, approvalId, action, operationId) {
  if (!approvalId || approvalId.length > 80 || !operationId) return false;
  const t = new Date().toISOString();
  try { const r = await db.prepare(STRICT_APPROVAL_SQL).bind(t, approvalId, String(deviceId || ''), action, t, operationId).run(); return Number(r?.meta?.changes) === 1; } catch { return false; }
}
async function logChange(db, row) {
  try {
    await db.prepare('INSERT INTO pos_assistant_access_log(event_id,device_id,level,changed_by,created_at) VALUES(?1,?2,?3,?4,?5)')
      .bind(crypto.randomUUID(), row.device_id, row.level, row.changed_by, new Date().toISOString()).run();
    return true;
  } catch { return false; } // sin la migración 0034 no se anota (documentado en PLAN.md)
}

// GET  /auth/assistant/employee-access            -> niveles de los aparatos empleado (solo aparato dueño)
// POST /auth/assistant/employee-access {device_id, level|enabled, operation_id} + x-owner-approval -> cambia el nivel (dueño + aprobación)
export async function employeeAccessRoute(request, env, auth, json, deps = {}) {
  if (String(env?.ASSISTANT_ENABLED || '') !== '1') return json({ error: 'not_found' }, 404);
  const db = deps.db;
  if (!db) return json({ error: 'db_missing' }, 500);
  if (!(await isOwnerDevice(db, auth))) return json({ error: 'admin_only' }, 403);
  if (request.method === 'GET') {
    let rows = [];
    try { rows = (await db.prepare("SELECT device_id,label FROM pos_device_roles WHERE pos_role='empleado' ORDER BY device_id").all()).results || []; } catch { rows = []; }
    const devices = [];
    for (const r of rows) devices.push({ device_id: r.device_id, label: r.label || null, level: await employeeLevel(db, r.device_id) });
    return json({ devices, levels: ACCESS_LEVELS });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let body; try { body = JSON.parse((await request.text()).slice(0, 4000)); } catch { return json({ error: 'bad_request' }, 400); }
  const deviceId = typeof body?.device_id === 'string' ? body.device_id.slice(0, 160) : '';
  const level = ACCESS_LEVELS.includes(body?.level) ? body.level : body?.level == null && typeof body?.enabled === 'boolean' ? (body.enabled ? 'consultas' : 'off') : null;
  if (!deviceId || !level) return json({ error: 'bad_request' }, 400);
  // Aprobación del dueño ligada a ESTE cambio (operation_id) y gastada una sola vez; o el PIN en el cuerpo.
  const approvalId = String(request.headers.get('x-owner-approval') || body.approval_id || '');
  const opId = typeof body.operation_id === 'string' ? body.operation_id.slice(0, 120) : '';
  if (approvalId) {
    if (!opId) return json({ error: 'operation_id_required' }, 400);
    const ok = await (deps.verifyApproval || ((id, action, op) => verifyOwnerApproval(db, auth.principalId, id, action, op)))(approvalId, ACCESS_APPROVAL_ACTION, opId);
    if (!ok) return json({ error: 'owner_approval_required', action: ACCESS_APPROVAL_ACTION, operation_id: opId }, 403);
  } else {
    if (body.pin == null || body.pin === '') return json({ error: 'owner_approval_required', action: ACCESS_APPROVAL_ACTION }, 403);
    const pinErr = await (deps.verifyPin || verifyOwnerPin)(db, body.pin, auth.principalId);
    if (pinErr) return json({ error: pinErr.error, attempts_left: pinErr.attempts_left, locked_until: pinErr.locked_until }, pinErr.status || 403);
  }
  let target = null;
  try { target = await db.prepare('SELECT pos_role FROM pos_device_roles WHERE device_id=?1').bind(deviceId).first(); } catch { target = null; }
  if (target?.pos_role !== 'empleado') return json({ error: 'not_employee_device' }, 409);
  await db.prepare(`INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?1,?2,1,?3,?4)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=pos_settings.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .bind(await levelKey(deviceId), JSON.stringify({ level }), new Date().toISOString(), String(auth.principalId).slice(0, 120)).run();
  const logged = await logChange(db, { device_id: deviceId, level, changed_by: String(auth.principalId) });
  return json({ ok: true, device_id: deviceId, level, logged });
}
