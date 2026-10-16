import { canDo, PERMISSIONS } from './pos-permissions.js';
// Etapa 2 (G): roles por aparato y PIN del dueño validado solo en el servidor.
// - Un aparato sin fila en pos_device_roles es del dueño (compatibilidad con el teléfono actual).
// - El PIN nunca se registra ni se devuelve; solo se guarda PBKDF2-SHA256 con sal por fila.
// - Un aparato empleado necesita una aprobación del dueño (PIN) atada a la operación.
const PIN_RE = /^\d{4,8}$/;
export const PIN_ITERATIONS = 20000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const GLOBAL_MAX_FAILURES = 20; // tope entre todos los aparatos en 15 min
const WINDOW_MS = 15 * 60 * 1000;
const APPROVAL_MS = 5 * 60 * 1000;
const PAIRING_MS = 15 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const OWNER_COMMANDS = new Set(['inventory.adjust', 'adjustment.create', 'compensation.create', 'product.update', 'customer.credit-policy.set']);
// 'product.create': CAMBIO DE SERVIDOR DEL POS (rama feature/asistente-aislado), necesita el visto bueno del jefe antes de desplegar.
// 'assistant.employee_access': asistente (rama feature/asistente-aislado), solo para aprobar el nivel del asistente de un aparato empleado. Aditivo.
const APPROVAL_ACTIONS = new Set([...OWNER_COMMANDS, 'product.create', 'settings.set', 'reset', 'discount', 'sale.annul', 'expired_lot_sale', 'assistant.employee_access']);
const SETTING_KEY = /^[a-z][a-z0-9_.-]{0,59}$/;
export { ROLE_PATHS } from './pos-permissions.js';

const now = () => new Date().toISOString();
const later = ms => new Date(Date.now() + ms).toISOString();
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
const missingTable = e => /no such table/i.test(String(e?.message || e));

async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
function randomHex(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return hex(b); }
function equalHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}
export async function hashPin(pin, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations }, key, 256));
}
function pairingCode() {
  const b = new Uint8Array(10); crypto.getRandomValues(b);
  const s = [...b].map(x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
  return s.slice(0, 5) + '-' + s.slice(5);
}
const normalizeCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cleanLabel = l => { const s = String(l ?? '').trim().slice(0, 60); return s || null; };

export async function posRoleFor(db, deviceId) {
  try {
    const row = await db.prepare('SELECT pos_role FROM pos_device_roles WHERE device_id=?1').bind(deviceId).first();
    return row?.pos_role === 'empleado' ? 'empleado' : 'owner';
  } catch (e) {
    if (missingTable(e)) return 'owner'; // migración 0024 aún no aplicada: comportamiento previo
    throw e;
  }
}

async function pinRow(db) {
  return db.prepare('SELECT salt_hex,hash_hex,iterations,failed_count,locked_until FROM pos_owner_pin WHERE id=1').first();
}

// Devuelve null si el PIN es correcto, o {error,status,...}.
// Fallos por aparato (5 = 15 min) y tope global de 20 fallos en 15 min: un empleado no puede
// bloquear el PIN del dueño en los demás aparatos. Sin la migración 0025 se usa el conteo antiguo.
export async function verifyOwnerPin(db, pin, deviceId) {
  const row = await pinRow(db);
  if (!row) return { error: 'owner_pin_not_set', status: 409 };
  let perDevice = true, dev = null;
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  try {
    const g = await db.prepare('SELECT COALESCE(SUM(failed_count),0) AS n FROM pos_pin_failures WHERE window_start>?1').bind(since).first();
    if (Number(g?.n || 0) >= GLOBAL_MAX_FAILURES) return { error: 'owner_pin_locked', status: 429, scope: 'global' };
    dev = await db.prepare('SELECT failed_count,window_start,locked_until FROM pos_pin_failures WHERE device_id=?1').bind(String(deviceId || 'unknown')).first();
  } catch (e) { if (!missingTable(e)) throw e; perDevice = false; }
  if (!perDevice && row.locked_until && row.locked_until > now()) return { error: 'owner_pin_locked', status: 429, locked_until: row.locked_until };
  if (dev?.locked_until && dev.locked_until > now()) return { error: 'owner_pin_locked', status: 429, locked_until: dev.locked_until };
  if (!PIN_RE.test(String(pin ?? ''))) return { error: 'owner_pin_invalid', status: 403 };
  const ok = equalHex(await hashPin(String(pin), row.salt_hex, Number(row.iterations)), row.hash_hex);
  if (ok) {
    if (perDevice) { if (dev) await db.prepare('DELETE FROM pos_pin_failures WHERE device_id=?1').bind(String(deviceId || 'unknown')).run(); }
    else if (Number(row.failed_count) || row.locked_until) await db.prepare('UPDATE pos_owner_pin SET failed_count=0,locked_until=NULL WHERE id=1').run();
    return null;
  }
  if (perDevice) {
    const fresh = !dev || dev.window_start <= since;
    const failures = fresh ? 1 : Number(dev.failed_count) + 1;
    const until = failures >= MAX_FAILURES ? later(LOCK_MS) : null;
    await db.prepare(`INSERT INTO pos_pin_failures(device_id,failed_count,window_start,locked_until) VALUES(?1,?2,?3,?4)
      ON CONFLICT(device_id) DO UPDATE SET failed_count=excluded.failed_count,window_start=CASE WHEN ?5 THEN excluded.window_start ELSE pos_pin_failures.window_start END,locked_until=excluded.locked_until`)
      .bind(String(deviceId || 'unknown'), failures, now(), until, fresh ? 1 : 0).run();
    if (until) return { error: 'owner_pin_locked', status: 429, locked_until: until };
    return { error: 'owner_pin_invalid', status: 403, attempts_left: MAX_FAILURES - failures };
  }
  const failures = Number(row.failed_count) + 1;
  if (failures >= MAX_FAILURES) {
    const until = later(LOCK_MS);
    await db.prepare('UPDATE pos_owner_pin SET failed_count=0,locked_until=?1 WHERE id=1').bind(until).run();
    return { error: 'owner_pin_locked', status: 429, locked_until: until };
  }
  await db.prepare('UPDATE pos_owner_pin SET failed_count=?1 WHERE id=1').bind(failures).run();
  return { error: 'owner_pin_invalid', status: 403, attempts_left: MAX_FAILURES - failures };
}

// Revisiones del dueño. Nunca editan la venta ni la caja: solo dejan constancia.
export async function flagReview(db, flag) {
  try {
    await db.prepare(`INSERT OR IGNORE INTO pos_review_flags(flag_id,kind,ref_id,device_id,amount_cents,detail_json,status,created_at)
      VALUES(?1,?2,?3,?4,?5,?6,'pendiente',?7)`).bind(flag.kind + ':' + flag.ref_id, flag.kind, flag.ref_id, flag.device_id,
      Math.trunc(Number(flag.amount_cents) || 0), JSON.stringify(flag.detail || {}).slice(0, 4000), now()).run();
    return true;
  } catch (e) { if (missingTable(e)) return false; throw e; }
}
// Venta de un aparato empleado por debajo del precio del catálogo: nunca se rechaza (las ventas
// sin internet no se pierden); queda «descuento por autorizar» para el dueño.
export async function flagSaleDiscount(db, deviceId, saleId) {
  if (!saleId || (await posRoleFor(db, deviceId)) !== 'empleado') return false;
  // Precio vigente = última revisión (product.update) o el del producto importado / creado en vivo.
  const field = (col, rev) => `COALESCE(${rev ? `(SELECT r.${col} FROM canonical_product_revisions r WHERE r.product_id=i.product_id ORDER BY r.revision DESC LIMIT 1),` : ''}
      (SELECT p.${col} FROM products p WHERE p.product_id=i.product_id),(SELECT l.${col} FROM canonical_live_products l WHERE l.product_id=i.product_id))`;
  const query = rev => `SELECT i.line_number,i.product_id,i.quantity,i.unit_price_cents,i.line_total_cents,
      ${field('price_cents', rev)} AS price_cents,${field('box_price_cents', rev)} AS box_price_cents,${field('name', rev)} AS name,
      (SELECT -SUM(m.quantity) FROM inventory_movements m WHERE m.sale_id=i.sale_id AND m.line_number=i.line_number) AS inv_qty
    FROM sale_items i WHERE i.sale_id=?1 AND i.product_id IS NOT NULL`;
  let rows;
  try { rows = (await db.prepare(query(true)).bind(saleId).all()).results || []; }
  catch (e) { if (!missingTable(e)) throw e; rows = (await db.prepare(query(false)).bind(saleId).all()).results || []; }
  rows = rows.filter(r => r.price_cents != null);
  const lines = [];
  let total = 0;
  for (const r of rows) {
    const units = Number(r.inv_qty) > 0 ? Number(r.inv_qty) : Number(r.quantity);
    const unitCatalog = Number(r.price_cents) * units;
    const boxCatalog = r.box_price_cents != null ? Number(r.box_price_cents) * Number(r.quantity) : null;
    const catalog = boxCatalog != null && units !== Number(r.quantity) ? Math.min(unitCatalog, boxCatalog) : unitCatalog;
    const charged = Number(r.line_total_cents);
    if (Number.isFinite(catalog) && charged < catalog) { lines.push({ linea: r.line_number, producto: r.name, catalogo_cents: catalog, cobrado_cents: charged }); total += catalog - charged; }
  }
  if (!lines.length) return false;
  return flagReview(db, { kind: 'discount', ref_id: saleId, device_id: deviceId, amount_cents: total, detail: { lineas: lines.slice(0, 20) } });
}

async function body(request) {
  try { const b = await request.json(); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; } catch { return {}; }
}
function pinFailure(json, failure) {
  const { status, ...rest } = failure; return json(rest, status);
}
// Si ya hay PIN, una acción sensible del dueño lo exige; sin PIN el aparato dueño sigue permitido.
async function requirePinIfSet(db, pin, deviceId) {
  const row = await pinRow(db);
  if (!row) return null;
  return verifyOwnerPin(db, pin, deviceId);
}

export async function consumeApproval(db, deviceId, approvalId, action, operationId) {
  if (typeof approvalId !== 'string' || !approvalId.length || approvalId.length > 80) return false;
  const t = now();
  try {
    const row = await db.prepare(`SELECT used_at FROM pos_owner_approvals WHERE approval_id=?1 AND device_id=?2 AND action=?3
      AND expires_at>?4 AND (used_at IS NULL OR operation_id=?5)`).bind(approvalId, deviceId, action, t, operationId).first();
    if (!row) return false;
    if (row.used_at) return true;
    await db.prepare('UPDATE pos_owner_approvals SET used_at=?2,operation_id=?3 WHERE approval_id=?1 AND used_at IS NULL').bind(approvalId, t, operationId).run();
    return !!(await db.prepare('SELECT approval_id FROM pos_owner_approvals WHERE approval_id=?1 AND operation_id=?2').bind(approvalId, operationId).first());
  } catch (e) { if (missingTable(e)) return false; throw e; }
}

const EXPIRED_REQUIRED_ACTION='expired_lot_required';
async function expiredMarkerId(operationId){return 'xreq:'+(await sha256Hex(String(operationId))).slice(0,64);}
export async function expiredApprovalRequired(db, operationId) {
  try { return !!await db.prepare('SELECT 1 FROM pos_owner_approvals WHERE approval_id=?1 AND action=?2').bind(await expiredMarkerId(operationId),EXPIRED_REQUIRED_ACTION).first(); }
  catch (e) { if (/no such table/i.test(String(e?.message||e))) return false; throw e; }
}
export async function markExpiredApprovalRequired(db, auth, operationId) {
  const t=new Date().toISOString();
  try { await db.prepare(`INSERT OR IGNORE INTO pos_owner_approvals(approval_id,device_id,action,operation_id,created_at,expires_at,used_at)
    VALUES(?1,?2,?3,?4,?5,'9999-12-31T00:00:00.000Z',?5)`).bind(await expiredMarkerId(operationId),auth.principalId,EXPIRED_REQUIRED_ACTION,operationId,t).run(); }
  catch (e) { if (!/no such table/i.test(String(e?.message||e))) throw e; }
}
// Puerta para comandos del dueño. null = permitido.
export async function ownerGate(request, env, auth, action, json, db, always = false) {
  const role = auth.posRole || await posRoleFor(db, auth.principalId);
  // always: la acción pide el PIN del dueño también en su propio aparato (anular venta).
  if (role === 'owner' && !always) return null;
  const approvalId = String(request.headers.get('x-owner-approval') || '');
  let operationId = null;
  try { operationId = (await request.clone().json())?.operation_id ?? null; } catch { operationId = null; }
  if (approvalId && approvalId.length <= 80 && typeof operationId === 'string') {
    const row = await db.prepare(
      `SELECT approval_id, used_at, operation_id FROM pos_owner_approvals
        WHERE approval_id=?1 AND device_id=?2 AND action=?3 AND operation_id=?4 AND expires_at>?5`
    ).bind(approvalId, auth.principalId, action, operationId, now()).first();
    if (row) {
      if (!row.used_at) await db.prepare('UPDATE pos_owner_approvals SET used_at=?2 WHERE approval_id=?1 AND used_at IS NULL').bind(approvalId, now()).run();
      return null; // reintento idempotente de la misma operación aprobada
    }
  }
  return json({ error: 'owner_approval_required', action, pos_role: role === 'owner' ? 'owner' : 'empleado' }, 403);
}

export async function handleRoles(request, url, env, { json, authorizeSession, getDatabase }) {
  const db = getDatabase(env);
  const path = url.pathname;
  try {
    if (path === '/auth/pair') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return await pair(request, db, json);
    }
    const auth = await authorizeSession(request, env);
    if (auth instanceof Response) return auth;
    const role = auth.posRole || await posRoleFor(db, auth.principalId);
    if (path === '/auth/me' && request.method === 'GET') {
      let pinSet = false, label = null;
      try {
        pinSet = !!(await pinRow(db));
        label = (await db.prepare('SELECT label FROM pos_device_roles WHERE device_id=?1').bind(auth.principalId).first())?.label ?? null;
      } catch (e) { if (!missingTable(e)) throw e; return json({ pos_role: role, owner_pin_set: false, roles_ready: false, device_id: auth.principalId }); }
      return json({ pos_role: role, owner_pin_set: pinSet, roles_ready: true, device_id: auth.principalId, label });
    }
    if (path === '/settings' && request.method === 'GET') {
      const rows = (await db.prepare('SELECT key,value_json,revision,updated_at FROM pos_settings WHERE key NOT LIKE \'internal:%\' ORDER BY key').all()).results || [];
      return json({ settings: rows.map(r => ({ key: r.key, value: JSON.parse(r.value_json), revision: Number(r.revision), updated_at: r.updated_at })) });
    }
    if (path === '/auth/reviews' && request.method === 'GET') {
      // Todos ven lo pendiente (aviso «Cierre pendiente de aprobación del dueño»); el dueño ve también lo resuelto.
      const all = role === 'owner' && url.searchParams.get('status') === 'todos';
      const rows = (await db.prepare(`SELECT flag_id,kind,ref_id,device_id,amount_cents,detail_json,status,shortage_cents,note,created_at,resolved_at
        FROM pos_review_flags ${all ? '' : "WHERE status='pendiente'"} ORDER BY created_at DESC LIMIT 200`).all()).results || [];
      return json({ reviews: rows.map(r => ({ ...r, detail: JSON.parse(r.detail_json), detail_json: undefined })) });
    }
    const route = PERMISSIONS.API_ROUTES.find(r => r.path === path && r.action && r.methods.includes(request.method));
    if (route && !canDo(role, route.action)) return json({ error: 'owner_only' }, 403);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const b = await body(request);
    if (path === '/auth/owner-approval') {
      const action = String(b.action || '');
      if (!APPROVAL_ACTIONS.has(action)) return json({ error: 'invalid_action' }, 400);
      const operationId = b.operation_id == null ? null : String(b.operation_id);
      if (OWNER_COMMANDS.has(action) && (!operationId || operationId.length > 200)) return json({ error: 'operation_id_required' }, 400);
      const failure = await verifyOwnerPin(db, b.pin, auth.principalId);
      if (failure) return pinFailure(json, failure);
      const approvalId = 'apr-' + randomHex(16);
      const expires = later(APPROVAL_MS);
      await db.prepare('INSERT INTO pos_owner_approvals(approval_id,device_id,action,operation_id,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6)')
        .bind(approvalId, auth.principalId, action, operationId, now(), expires).run();
      return json({ status: 'approved', approval_id: approvalId, action, expires_at: expires }, 201);
    }
    if (!PERMISSIONS.routeRoles(path, request.method).includes(role)) return json({ error: 'owner_only' }, 403);
    if (path === '/auth/owner-pin') {
      const next = String(b.new_pin ?? '');
      if (!PIN_RE.test(next)) return json({ error: 'pin_format', detail: 'PIN de 4 a 8 dígitos' }, 400);
      const failure = await requirePinIfSet(db, b.current_pin, auth.principalId);
      if (failure) return pinFailure(json, failure);
      const salt = randomHex(16);
      const hash = await hashPin(next, salt, PIN_ITERATIONS);
      await db.prepare(`INSERT INTO pos_owner_pin(id,salt_hex,hash_hex,iterations,failed_count,locked_until,updated_at,updated_by)
        VALUES(1,?1,?2,?3,0,NULL,?4,?5) ON CONFLICT(id) DO UPDATE SET salt_hex=excluded.salt_hex,hash_hex=excluded.hash_hex,
        iterations=excluded.iterations,failed_count=0,locked_until=NULL,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
        .bind(salt, hash, PIN_ITERATIONS, now(), auth.principalId).run();
      return json({ status: 'pin_saved' });
    }
    if (path === '/auth/pairing-code') {
      const failure = await requirePinIfSet(db, b.pin, auth.principalId);
      if (failure) return pinFailure(json, failure);
      const code = pairingCode();
      const expires = later(PAIRING_MS);
      await db.prepare('INSERT INTO pos_pairing_codes(code_hash,pos_role,label,created_by,created_at,expires_at) VALUES(?1,\'empleado\',?2,?3,?4,?5)')
        .bind(await sha256Hex(normalizeCode(code)), cleanLabel(b.label), auth.principalId, now(), expires).run();
      return json({ status: 'created', code, pos_role: 'empleado', expires_at: expires }, 201);
    }
    if (path === '/auth/devices') {
      const rows = (await db.prepare(`SELECT d.device_id,d.status,d.created_at,d.last_seen_at,r.pos_role,r.label
          FROM devices d LEFT JOIN pos_device_roles r ON r.device_id=d.device_id
         WHERE d.device_id LIKE 'session:%' ORDER BY d.status, d.created_at DESC LIMIT 100`).all()).results || [];
      return json({ devices: rows.map(r => ({ device_id: r.device_id, status: r.status, created_at: r.created_at, last_seen_at: r.last_seen_at,
        pos_role: r.pos_role === 'empleado' ? 'empleado' : 'owner', label: r.label ?? null, current: r.device_id === auth.principalId })) });
    }
    if (path === '/auth/devices/revoke') {
      const target = String(b.device_id || '');
      if (!/^session:[^\s]{1,152}$/.test(target)) return json({ error: 'invalid_device' }, 400);
      if (target === auth.principalId) return json({ error: 'cannot_revoke_self' }, 409);
      const failure = await requirePinIfSet(db, b.pin, auth.principalId);
      if (failure) return pinFailure(json, failure);
      const sessionId = target.slice('session:'.length);
      await db.batch([
        db.prepare("UPDATE devices SET status='revoked' WHERE device_id=?1").bind(target),
        db.prepare("UPDATE auth_sessions SET status='revoked' WHERE session_id=?1").bind(sessionId),
      ]);
      return json({ status: 'revoked', device_id: target });
    }
    if (path === '/auth/reviews/resolve') {
      const flagId = String(b.flag_id || '');
      const decision = b.decision === 'aprobado' ? 'aprobado' : b.decision === 'rechazado' ? 'rechazado' : null;
      if (!flagId || flagId.length > 200 || !decision) return json({ error: 'invalid_review' }, 400);
      const flag = await db.prepare('SELECT kind,amount_cents,status FROM pos_review_flags WHERE flag_id=?1').bind(flagId).first();
      if (!flag) return json({ error: 'not_found' }, 404);
      if (flag.status !== 'pendiente') return json({ status: flag.status, flag_id: flagId, idempotent: true });
      // Rechazar un descuento deja el faltante del cajero; la venta nunca se cambia.
      const shortage = decision === 'rechazado' && flag.kind === 'discount' ? Math.max(0, Number(flag.amount_cents)) : 0;
      await db.prepare(`UPDATE pos_review_flags SET status=?2,shortage_cents=?3,note=?4,resolved_at=?5,resolved_by=?6 WHERE flag_id=?1 AND status='pendiente'`)
        .bind(flagId, decision, shortage, b.note ? String(b.note).slice(0, 200) : null, now(), auth.principalId).run();
      return json({ status: decision, flag_id: flagId, shortage_cents: shortage });
    }
    if (path === '/settings') {
      const key = String(b.key || '');
      if (!SETTING_KEY.test(key)) return json({ error: 'invalid_key' }, 400);
      const value = JSON.stringify(b.value ?? null);
      if (value.length > 8000) return json({ error: 'value_too_large' }, 413);
      const current = await db.prepare('SELECT revision FROM pos_settings WHERE key=?1').bind(key).first();
      const rev = Number(current?.revision || 0);
      if (b.expected_revision != null && Number(b.expected_revision) !== rev) return json({ error: 'revision_conflict', revision: rev }, 409);
      const res = await db.prepare(`INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?1,?2,1,?3,?4)
          ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=pos_settings.revision+1,
          updated_at=excluded.updated_at,updated_by=excluded.updated_by WHERE pos_settings.revision=?5`)
        .bind(key, value, now(), auth.principalId, rev).run();
      if (res?.meta && res.meta.changes === 0) return json({ error: 'revision_conflict' }, 409);
      return json({ status: 'saved', key, revision: rev + 1 });
    }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    if (missingTable(e)) return json({ error: 'roles_not_ready' }, 503);
    throw e;
  }
}

async function pair(request, db, json) {
  const b = await body(request);
  const code = normalizeCode(b.code);
  if (code.length !== 10) return json({ error: 'invalid_code' }, 401);
  const codeHash = await sha256Hex(code);
  const sessionId = crypto.randomUUID();
  const principal = 'session:' + sessionId;
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const t = now();
  // Un solo lote atómico: el código se marca usado por este aparato y solo entonces se crea la sesión.
  await db.batch([
    db.prepare('UPDATE pos_pairing_codes SET used_at=?2,used_by=?3 WHERE code_hash=?1 AND used_at IS NULL AND expires_at>?2').bind(codeHash, t, principal),
    db.prepare(`INSERT INTO devices(device_id,role,status,credential_hash,last_seen_at)
       SELECT ?1,'writer','active',?2,?3 WHERE EXISTS(SELECT 1 FROM pos_pairing_codes WHERE code_hash=?4 AND used_by=?1)`).bind(principal, tokenHash, t, codeHash),
    db.prepare(`INSERT INTO auth_sessions(session_id,token_hash,status,last_seen_at)
       SELECT ?1,?2,'active',?3 WHERE EXISTS(SELECT 1 FROM pos_pairing_codes WHERE code_hash=?4 AND used_by=?5)`).bind(sessionId, tokenHash, t, codeHash, principal),
    db.prepare(`INSERT INTO pos_device_roles(device_id,pos_role,label,created_by,created_at)
       SELECT ?1,pos_role,COALESCE(?2,label),created_by,?3 FROM pos_pairing_codes WHERE code_hash=?4 AND used_by=?1`).bind(principal, cleanLabel(b.label), t, codeHash),
  ]);
  const ok = await db.prepare('SELECT 1 AS ok FROM pos_device_roles WHERE device_id=?1').bind(principal).first();
  if (!ok) return json({ error: 'invalid_code' }, 401);
  return json({ status: 'paired', session_token: token, pos_role: 'empleado' }, 201);
}
