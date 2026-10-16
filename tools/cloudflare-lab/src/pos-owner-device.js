// Registro del aparato del dueño para el asistente (rama feature/asistente-aislado).
// DETRÁS DE BANDERA: ASSISTANT_OWNER_BOOTSTRAP=1 (además de ASSISTANT_ENABLED=1). Sin la bandera todas las rutas responden 404.
// No está aplicado en ningún lado; necesita el visto bueno del jefe (y la migración 0035 con respaldo R2 antes).
//
// Rutas (contrato de Bot 5, registro_owner; el GET se agregó para la pantalla «Pendiente de aprobar» de las maquetas v2):
//   POST /auth/assistant/owner-device/register {pin}                        teléfono SIN fila de rol: «Registrar este teléfono como dueño»
//   GET  /auth/assistant/owner-device                                       (dueño) aparatos dueño + pendientes de aprobar
//   POST /auth/assistant/owner-device/approve {device_id, operation_id, decision:'approve'|'reject'}  (dueño + aprobación estricta)
//   POST /auth/assistant/owner-device/revoke  {device_id, operation_id}    (dueño + aprobación estricta) quita el rol dueño (queda 'empleado')
// Reglas:
//   - Nunca automático: botón explícito + PIN del dueño, con el límite por aparato que ya existe (verifyOwnerPin: 5 fallos -> 15 min).
//   - Solo un aparato SIN fila en pos_device_roles. Un aparato empleado nunca sube a dueño por aquí (409, sin gastar intentos).
//   - Con 0 aparatos dueño, el primero queda dueño (INSERT atómico). Si ya hay dueño, queda «esperando aprobación» (202).
//   - approve (aprobar o rechazar) y revoke piden aprobación del dueño ESTRICTA: x-owner-approval de la acción 'assistant.owner_device',
//     ligada al operation_id y gastada con UPDATE ... operation_id=? AND used_at IS NULL (changes===1). Un PIN suelto no basta.
//   - Nunca se quita el ÚLTIMO aparato dueño: 409 { error:'last_owner', code:'last_owner' }.
//   - El aparato es siempre el de la sesión: rol o aparato en cabeceras o cuerpo se ignoran.
//   - Cada registro, pedido, aprobación, rechazo y revocación se anota en pos_owner_device_log. Sin esa tabla (migración 0035,
//     NO aplicada) las rutas fallan cerrado (503): no se registra nada sin bitácora.
import { sha256Hex } from './a5-import-core.js';
import { verifyOwnerPin } from './pos-roles.js';
import { verifyOwnerApproval } from './pos-assistant-access.js';

export const OWNER_DEVICE_BASE = '/auth/assistant/owner-device';
export const OWNER_DEVICE_PATHS = Object.freeze({ register: OWNER_DEVICE_BASE + '/register', approve: OWNER_DEVICE_BASE + '/approve', revoke: OWNER_DEVICE_BASE + '/revoke' });
export const OWNER_DEVICE_APPROVAL_ACTION = 'assistant.owner_device';
export const isOwnerDevicePath = (p) => p === OWNER_DEVICE_BASE || Object.values(OWNER_DEVICE_PATHS).includes(p);
const PENDING_MS = 24 * 60 * 60 * 1000, PREFIX = 'internal:asst:odev:';
const pendingKey = async (deviceId) => PREFIX + (await sha256Hex(String(deviceId))).slice(0, 32);
const nowIso = () => new Date().toISOString();

async function roleOf(db, deviceId) { const r = await db.prepare('SELECT pos_role FROM pos_device_roles WHERE device_id=?1').bind(String(deviceId)).first(); return r?.pos_role || null; }
async function ownerCount(db) { return Number((await db.prepare("SELECT COUNT(*) AS n FROM pos_device_roles WHERE pos_role='owner'").first())?.n || 0); }
async function logReady(db) { try { await db.prepare('SELECT 1 FROM pos_owner_device_log LIMIT 1').all(); return true; } catch { return false; } }
async function log(db, event, deviceId, by) {
  await db.prepare('INSERT INTO pos_owner_device_log(event_id,event,device_id,actor_device_id,created_at) VALUES(?1,?2,?3,?4,?5)')
    .bind(crypto.randomUUID(), event, String(deviceId).slice(0, 160), String(by).slice(0, 160), nowIso()).run();
}
async function pending(db) {
  const rows = (await db.prepare('SELECT key,value_json FROM pos_settings WHERE key LIKE ?1').bind(PREFIX + '%').all())?.results || [];
  return rows.map((r) => { try { return { key: r.key, ...JSON.parse(r.value_json) }; } catch { return null; } }).filter((x) => x && x.device_id && x.exp > Date.now());
}

export async function ownerDeviceRoute(request, env, auth, json, deps = {}) {
  if (String(env?.ASSISTANT_OWNER_BOOTSTRAP || '') !== '1') return json({ error: 'not_found' }, 404);
  const path = new URL(request.url).pathname;
  if (!isOwnerDevicePath(path)) return json({ error: 'not_found' }, 404);
  const db = deps.db; if (!db) return json({ error: 'db_missing' }, 500);
  const me = String(auth?.principalId || ''); if (!me) return json({ error: 'unauthorized' }, 401);
  if (!(await logReady(db))) return json({ error: 'owner_device_log_missing', message: 'Falta la bitácora (migración 0035). No se registra nada sin bitácora.' }, 503);
  const isOwner = async () => (await roleOf(db, me)) === 'owner' && auth.posRole === 'owner';

  if (path === OWNER_DEVICE_BASE) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (!(await isOwner())) return json({ error: 'owner_device_required' }, 403);
    const owners = (await db.prepare("SELECT r.device_id,r.label,r.created_at,d.last_seen_at FROM pos_device_roles r LEFT JOIN devices d ON d.device_id=r.device_id WHERE r.pos_role='owner' ORDER BY r.created_at").all().catch(() => db.prepare("SELECT device_id,label,created_at FROM pos_device_roles WHERE pos_role='owner' ORDER BY created_at").all()))?.results || [];
    return json({ owners: owners.map((o) => ({ ...o, this_device: o.device_id === me })), pending: (await pending(db)).map((p) => ({ device_id: p.device_id, label: p.label || null, requested_at: p.at })) });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let body; try { body = JSON.parse((await request.text()).slice(0, 4000) || '{}'); } catch { return json({ error: 'bad_request' }, 400); }

  if (path === OWNER_DEVICE_PATHS.register) {
    const mine = await roleOf(db, me); // antes del PIN: un aparato con fila nunca pasa ni gasta intentos
    if (mine === 'empleado') return json({ error: 'employee_device_cannot_register' }, 409);
    if (mine === 'owner') return json({ error: 'already_owner' }, 409);
    if (body.pin == null || body.pin === '') return json({ error: 'owner_pin_required' }, 403);
    const e = await (deps.verifyPin || verifyOwnerPin)(db, body.pin, me);
    if (e) return json({ error: e.error, attempts_left: e.attempts_left, locked_until: e.locked_until, message: e.status === 429 ? 'Demasiados intentos. Espera 15 min.' : undefined }, e.status || 403);
    if ((await ownerCount(db)) === 0) {
      const ins = await db.prepare("INSERT INTO pos_device_roles(device_id,pos_role,label,created_by,created_at) SELECT ?1,'owner',NULL,'owner-bootstrap',?2 WHERE NOT EXISTS (SELECT 1 FROM pos_device_roles WHERE pos_role='owner') AND NOT EXISTS (SELECT 1 FROM pos_device_roles WHERE device_id=?1)")
        .bind(me, nowIso()).run();
      if (Number(ins?.meta?.changes) === 1) { await log(db, 'register_first', me, me); return json({ ok: true, device_id: me, pos_role: 'owner', via: 'first_owner' }); }
    }
    // Ya hay dueño: queda pendiente. El dueño lo aprueba o rechaza desde Configuración > Usuarios y Aparatos.
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) || null : null;
    await db.prepare(`INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?1,?2,1,?3,?4)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=pos_settings.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(await pendingKey(me), JSON.stringify({ device_id: me, label, at: nowIso(), exp: Date.now() + PENDING_MS }), nowIso(), me.slice(0, 120)).run();
    await log(db, 'request', me, me);
    return json({ ok: false, pending: true, status: 'esperando_aprobacion', message: 'Esperando aprobación desde el teléfono del dueño.' }, 202);
  }

  // approve (decision approve|reject) / revoke: aparato dueño + aprobación estricta ligada al operation_id.
  if (!(await isOwner())) return json({ error: 'owner_device_required' }, 403);
  const target = typeof body.device_id === 'string' ? body.device_id.slice(0, 160) : '';
  const opId = typeof body.operation_id === 'string' ? body.operation_id.slice(0, 120) : '';
  if (!target || target === me && path !== OWNER_DEVICE_PATHS.revoke) return json({ error: 'bad_request' }, 400);
  if (!opId) return json({ error: 'operation_id_required' }, 400);
  const decision = body.decision == null ? 'approve' : body.decision;
  if (path === OWNER_DEVICE_PATHS.approve && decision !== 'approve' && decision !== 'reject') return json({ error: 'bad_decision' }, 400);
  // Revisiones que no gastan la aprobación.
  if (path === OWNER_DEVICE_PATHS.revoke) {
    const r = await roleOf(db, target);
    if (r !== 'owner') return json({ error: 'not_owner' }, 409);
    if ((await ownerCount(db)) <= 1) return json({ error: 'last_owner', code: 'last_owner', message: 'Es el único aparato dueño. Registra otro antes de quitarlo.' }, 409);
  } else {
    const key = await pendingKey(target), row = (await pending(db)).find((p) => p.key === key);
    if (!row) return json({ error: 'not_pending' }, 409);
  }
  const approvalId = String(request.headers.get('x-owner-approval') || '');
  const ok = await (deps.verifyApproval || ((id, action, op) => verifyOwnerApproval(db, me, id, action, op)))(approvalId, OWNER_DEVICE_APPROVAL_ACTION, opId);
  if (!ok) return json({ error: 'owner_approval_required', action: OWNER_DEVICE_APPROVAL_ACTION, operation_id: opId }, 403);

  if (path === OWNER_DEVICE_PATHS.revoke) {
    // Atómico: nunca deja 0 dueños aunque lleguen dos revocaciones a la vez.
    const up = await db.prepare("UPDATE pos_device_roles SET pos_role='empleado' WHERE device_id=?1 AND pos_role='owner' AND (SELECT COUNT(*) FROM pos_device_roles WHERE pos_role='owner')>1").bind(target).run();
    if (Number(up?.meta?.changes) !== 1) return json({ error: 'last_owner', code: 'last_owner' }, 409);
    await log(db, 'revoke', target, me);
    return json({ ok: true, device_id: target, pos_role: 'empleado' });
  }
  const key = await pendingKey(target);
  const del = await db.prepare('DELETE FROM pos_settings WHERE key=?1').bind(key).run();
  if (Number(del?.meta?.changes) !== 1) return json({ error: 'not_pending' }, 409);
  if (decision === 'reject') { await log(db, 'reject', target, me); return json({ ok: true, device_id: target, rejected: true }); }
  const ins = await db.prepare("INSERT INTO pos_device_roles(device_id,pos_role,label,created_by,created_at) SELECT ?1,'owner',NULL,?2,?3 WHERE NOT EXISTS (SELECT 1 FROM pos_device_roles WHERE device_id=?1)")
    .bind(target, 'owner-approval:' + me.slice(0, 120), nowIso()).run();
  if (Number(ins?.meta?.changes) !== 1) return json({ error: 'device_has_role' }, 409);
  await log(db, 'approve', target, me);
  return json({ ok: true, device_id: target, pos_role: 'owner' });
}
