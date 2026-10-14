// Búsqueda de DNI al agregar cliente.
// 1) Primero busca en los clientes ya guardados: si el DNI existe, devuelve esa ficha y NO gasta consulta.
// 2) Si no existe, el Worker (nunca el celular) consulta Decolecta con el secreto DECOLECTA_API_TOKEN.
// 3) Tiempo máximo corto; ante error el cajero escribe el nombre a mano.
// 4) Límite por minuto y por día para el rol empleado, y tope mensual para todo el negocio (plan gratis).
// Solo se devuelven nombre y apellidos. El token nunca se registra ni se devuelve.
import { sha256Hex } from './a5-import-core.js';

export const DNI_LOOKUP_PATH = '/auth/dni-lookup';
export const DECOLECTA_URL = 'https://api.decolecta.com/v1/reniec/dni';
const DNI = /^\d{8}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export const LIMITS = { employeePerMinute: 3, employeePerDay: 20, monthlyDefault: 95, timeoutMs: 2500 };
const RECENT_FAIL = new Map();
const FAIL_COOLDOWN_MS = 30000;
export const USAGE_PREFIX = 'internal:dni:'; // pos_settings.key admite 60 caracteres

function limaDate(nowMs) { return new Date(nowMs - 5 * 3600 * 1000).toISOString().slice(0, 10); }
function cleanName(v) { return String(v ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 120); }
function missingTable(e) { return /no such table/i.test(String(e?.message || e)); }

async function existingCustomer(db, dni, promotionId) {
  const where = promotionId ? 'promotion_id=?2 AND ' : '';
  // Las dos tablas a la vez: en el celular cada viaje a la base cuenta para los 3 s.
  const rows = await Promise.all(['canonical_live_customers', 'customers'].map(async (table) => {
    try {
      const stmt = db.prepare(`SELECT customer_id,name FROM ${table} WHERE ${where}trim(COALESCE(document,''))=?1 LIMIT 1`);
      return await (promotionId ? stmt.bind(dni, promotionId) : stmt.bind(dni)).first();
    } catch (e) { if (!missingTable(e)) throw e; return null; }
  }));
  return rows[0] || rows[1] || null;
}

async function readUsage(db, key) {
  const row = await db.prepare('SELECT value_json,revision FROM pos_settings WHERE key=?1').bind(key).first();
  if (!row) return { value: {}, revision: 0 };
  let value = {}; try { value = JSON.parse(row.value_json) || {}; } catch { value = {}; }
  return { value, revision: Number(row.revision || 0) };
}
async function writeUsage(db, key, value, revision, by, nowIso) {
  const res = await db.prepare(`INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?1,?2,1,?3,?4)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=pos_settings.revision+1,
      updated_at=excluded.updated_at,updated_by=excluded.updated_by WHERE pos_settings.revision=?5`)
    .bind(key, JSON.stringify(value), nowIso, by, revision).run();
  return !(res?.meta && res.meta.changes === 0);
}

// Reserva una consulta (cuenta antes de llamar para que nunca se pase del plan). Devuelve null o el motivo.
export async function reserveLookup(db, auth, env, nowMs) {
  const day = limaDate(nowMs), month = day.slice(0, 7), minute = Math.floor(nowMs / 60000);
  const monthlyCap = Number.parseInt(env.DNI_LOOKUP_MONTHLY_CAP || '', 10) || LIMITS.monthlyDefault;
  const nowIso = new Date(nowMs).toISOString();
  let deviceKeyCache = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (auth.posRole === 'empleado' && !deviceKeyCache) deviceKeyCache = USAGE_PREFIX + (await sha256Hex(String(auth.principalId))).slice(0, 40);
    const [g, dEarly] = await Promise.all([readUsage(db, USAGE_PREFIX + 'month'), deviceKeyCache ? readUsage(db, deviceKeyCache) : null]);
    const gv = g.value.m === month ? g.value : { m: month, n: 0 };
    if (gv.n >= monthlyCap) return 'monthly_limit';
    let d = null, dv = null, deviceKey = null;
    if (auth.posRole === 'empleado') {
      deviceKey = deviceKeyCache;
      d = dEarly;
      dv = d.value.d === day ? { ...d.value } : { d: day, n: 0, min: minute, mn: 0 };
      if (dv.min !== minute) { dv.min = minute; dv.mn = 0; }
      if (dv.n >= LIMITS.employeePerDay) return 'daily_limit';
      if (dv.mn >= LIMITS.employeePerMinute) return 'minute_limit';
      dv.n += 1; dv.mn += 1;
    }
    if (!(await writeUsage(db, USAGE_PREFIX + 'month', { m: month, n: gv.n + 1 }, g.revision, auth.principalId, nowIso))) continue;
    if (d && !(await writeUsage(db, deviceKey, dv, d.revision, auth.principalId, nowIso))) {
      // Rara carrera en el mismo aparato: se cuenta igual en el mes y se rechaza para no pasar el límite.
      return 'minute_limit';
    }
    return null;
  }
  return 'busy';
}

export async function queryDecolecta(dni, token, fetchImpl = fetch, timeoutMs = LIMITS.timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${DECOLECTA_URL}?numero=${dni}`, {
      method: 'GET', signal: ctrl.signal, redirect: 'manual', // Workers no admite 'error': lanzaba TypeError y todo caía en «nombre a mano»
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (r.status === 404 || r.status === 422 || r.status === 400) return { status: 'not_found' };
    if (r.status === 401 || r.status === 403) return { status: 'provider_auth' };
    if (r.status === 429) return { status: 'provider_limit' };
    if (r.status >= 300 && r.status < 400) return { status: 'provider_error' };
    if (!r.ok) return { status: 'provider_error' };
    let data = {}; try { data = await r.json(); } catch { return { status: 'provider_error' }; }
    const first = cleanName(data.first_name ?? data.nombres);
    const last1 = cleanName(data.first_last_name ?? data.apellidoPaterno ?? data.apellido_paterno);
    const last2 = cleanName(data.second_last_name ?? data.apellidoMaterno ?? data.apellido_materno);
    const full = cleanName([first, last1, last2].filter(Boolean).join(' ')) || cleanName(data.full_name ?? data.nombre_completo);
    if (!full) return { status: 'not_found' };
    return { status: 'found', name: full, first_name: first, last_names: cleanName([last1, last2].filter(Boolean).join(' ')) };
  } catch (e) {
    return { status: e?.name === 'AbortError' ? 'timeout' : 'provider_error' };
  } finally { clearTimeout(timer); }
}

export async function dniLookupRoute(request, env, auth, json, db, deps = {}) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
  let body = {}; try { body = await request.json(); } catch { body = {}; }
  const dni = String(body?.dni ?? '').trim();
  if (!DNI.test(dni)) return json({ error: 'invalid_dni' }, 400);
  const promotionId = SAFE_ID.test(String(body?.promotion_id || '')) ? String(body.promotion_id) : null;
  const existing = await existingCustomer(db, dni, promotionId);
  if (existing) return json({ status: 'existing', customer_id: existing.customer_id, name: cleanName(existing.name) });
  const token = env.DECOLECTA_API_TOKEN;
  if (!token) return json({ status: 'manual', reason: 'not_configured' }, 200);
  // El servidor tampoco insiste: tras un error/tiempo agotado del proveedor, ese DNI espera 30 s (por instancia).
  const nowMs = (deps.now || Date.now)();
  const failAt = RECENT_FAIL.get(dni);
  if (failAt && nowMs - failAt < FAIL_COOLDOWN_MS) return json({ status: 'manual', reason: 'cooldown', retry_after: Math.max(1, Math.ceil((FAIL_COOLDOWN_MS - (nowMs - failAt)) / 1000)) });
  let denied;
  try { denied = await reserveLookup(db, auth, env, (deps.now || Date.now)()); }
  catch (e) { if (missingTable(e)) return json({ status: 'manual', reason: 'not_ready' }); throw e; }
  if (denied) return json({ status: 'manual', reason: denied }, 429);
  const out = await queryDecolecta(dni, token, deps.fetch || fetch, deps.timeoutMs);
  if (out.status === 'timeout' || out.status === 'provider_error' || out.status === 'provider_limit') { RECENT_FAIL.set(dni, nowMs); if (RECENT_FAIL.size > 500) RECENT_FAIL.clear(); }
  if (out.status === 'found') return json(out);
  const failed = out.status === 'timeout' || out.status === 'provider_error' || out.status === 'provider_limit';
  return json(failed ? { status: 'manual', reason: out.status, retry_after: FAIL_COOLDOWN_MS / 1000 } : { status: 'manual', reason: out.status });
}
