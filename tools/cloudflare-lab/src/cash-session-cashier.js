// Cache successful probes per database; missing columns are re-probed after deployment.
const available = new WeakMap();
export async function cashSessionCashierAvailable(db, table) {
  let tables = available.get(db);
  if (!tables) { tables = new Set(); available.set(db, tables); }
  if (tables.has(table)) return true;
  const prefix = table === 'canonical_cash_sessions' ? 'opened' : 'closed';
  const rows = (await db.prepare('SELECT name,type,"notnull",dflt_value FROM pragma_table_info(?1)').bind(table).all()).results || [];
  const ready = ['_by_user_id', '_by_name'].every(suffix => rows.some(r =>
    r.name === prefix + suffix && String(r.type).toUpperCase() === 'TEXT' && Number(r.notnull) === 0 && r.dflt_value === null));
  if (ready) tables.add(table);
  return ready;
}

export async function authenticatedCashier(db, auth) {
  let label = null;
  try {
    const row = await db.prepare('SELECT label FROM pos_device_roles WHERE device_id=?1').bind(auth.principalId).first();
    label = row?.label?.trim() || null;
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error;
  }
  return { userId: auth.principalId, name: label || (auth.posRole === 'empleado' ? 'Empleado' : 'Dueño') };
}
