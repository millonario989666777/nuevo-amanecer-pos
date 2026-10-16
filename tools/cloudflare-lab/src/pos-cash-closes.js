import { getDatabase } from './database-binding.js';
import { posRoleFor } from './pos-roles.js';
import { canDo } from './pos-permissions.js';
import { cashSessionCashierAvailable } from './cash-session-cashier.js';

const DAY_MS = 86400000;
function dayStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return NaN;
  const ms = Date.parse(value + 'T05:00:00.000Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : NaN;
}

export const CASH_CLOSE_LIMIT = 2000;
export async function cashClosesRoute(request, env, auth, json) {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, OPTIONS' });
  const db = getDatabase(env);
  const role = auth.posRole === 'empleado' ? 'empleado' : await posRoleFor(db, auth.principalId);
  if (!canDo(role, 'cash.closes.view')) return json({ error: 'forbidden_role' }, 403);
  const params = new URL(request.url).searchParams;
  const desde = params.get('desde'), hasta = params.get('hasta');
  const start = dayStart(desde), last = dayStart(hasta);
  if (!Number.isFinite(start) || !Number.isFinite(last) || start > last || (last - start) / DAY_MS + 1 > 366)
    return json({ error: 'invalid_range' }, 400);

  // canonical_cash_state is a view; probe its dependencies without creating schema.
  const required = ['canonical_control', 'canonical_cash_state', 'canonical_cash_sessions', 'canonical_cash_closures'];
  const schema = (await db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(required)).all()).results || [];
  if (schema.length !== required.length) return json({ cash_closes: [], ready: false });
  const control = await db.prepare('SELECT active_promotion_id FROM canonical_control WHERE id=1').first();
  if (!control?.active_promotion_id) return json({ cash_closes: [], ready: false });
  const openedReady = await cashSessionCashierAvailable(db, 'canonical_cash_sessions');
  const closedReady = await cashSessionCashierAvailable(db, 'canonical_cash_closures');
  let rows;
  try {
    rows = (await db.prepare(`SELECT s.session_id,s.status,s.opened_at,s.closed_at,s.opening_cents,
    s.expected_cents,s.counted_cents,s.difference_cents,
    ${openedReady ? 'o.opened_by_name' : 'NULL AS opened_by_name'},
    ${closedReady ? 'c.closed_by_name' : 'NULL AS closed_by_name'}
    FROM canonical_cash_state s
    LEFT JOIN canonical_cash_sessions o ON o.session_id=s.session_id
    LEFT JOIN canonical_cash_closures c ON c.session_id=s.session_id
    WHERE s.promotion_id=?1 AND s.status='CLOSED'
      AND julianday(s.closed_at)>=julianday(?2) AND julianday(s.closed_at)<julianday(?3)
    ORDER BY s.closed_at DESC LIMIT ${CASH_CLOSE_LIMIT + 1}`)
      .bind(control.active_promotion_id, new Date(start).toISOString(), new Date(last + DAY_MS).toISOString()).all()).results || [];
  } catch (error) {
    // View dependencies vary by deployed schema (e.g. canonical_expenses).
    if (!/no such table/i.test(String(error?.message || error))) throw error;
    return json({ cash_closes: [], ready: false });
  }
  // Se pide una fila de más solo para saber si hubo corte; se devuelven como máximo CASH_CLOSE_LIMIT.
  const truncated = rows.length > CASH_CLOSE_LIMIT;
  return json({ cash_closes: truncated ? rows.slice(0, CASH_CLOSE_LIMIT) : rows, truncated, range: { desde, hasta } });
}
