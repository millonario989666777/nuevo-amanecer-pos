export const EXPORT_PATH = (accountId, databaseId) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`;

export function requireEnv(env) {
  for (const name of ['ACCOUNT_ID', 'DATABASE_ID', 'D1_REST_API_TOKEN']) {
    if (typeof env[name] !== 'string' || !env[name]) throw new Error(`Missing Cloudflare secret ${name}`);
  }
  if (env.DATABASE_ID !== 'cf2c83d3-f187-472e-967b-0ad24be969eb') throw new Error('Backup database identity mismatch');
  if (!/^[a-f0-9]{32}$/.test(env.ACCOUNT_ID)) throw new Error('Invalid Cloudflare account identity');
}

export async function apiResult(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true || !body.result) {
    throw new Error(`D1 export API failed (${response.status})`);
  }
  if (body.result.status === 'error') throw new Error('D1 export job failed');
  return body.result;
}

export async function sha256Hex(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function backupKey(timestamp, suffix) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid backup timestamp');
  return `nuevo-amanecer-prod-v2/${date.toISOString().replaceAll(':', '-')}.${suffix}`;
}

export function manifest({ timestamp, databaseId, bookmark, sqlKey, size, sha256, status }) {
  return {
    format: 'nuevo-amanecer-d1-backup-v1',
    timestamp: new Date(timestamp).toISOString(),
    database_id: databaseId,
    bookmark: bookmark || null,
    sql_key: sqlKey || null,
    size_bytes: size ?? null,
    sha256: sha256 || null,
    status,
  };
}

// Las miniaturas de producto (internal:img:*) y sus contadores (internal:imgrate:*) son
// caché regenerable: igual que backup-select.mjs, no se incluyen en el respaldo SQL.
// El export de D1 emite una sentencia INSERT por línea; solo se descartan esas filas.
const INTERNAL_IMAGE_ROW = /^\s*INSERT\s+INTO\s+"?pos_settings"?\s*(?:\([^)]*\)\s*)?VALUES\s*\(\s*'internal:img(?::|rate:)/i;
export function stripInternalImageRows(sql) {
  return String(sql).split('\n').filter(line => !INTERNAL_IMAGE_ROW.test(line)).join('\n');
}
