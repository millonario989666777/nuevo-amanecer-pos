import { canDo, PERMISSIONS } from './pos-permissions.js';
import { setCanonicalCustomerContact } from './a6-customer-contacts.js';
import { getDatabase } from './database-binding.js';
// Gateway mínimo: POS OUTBOX -> Worker -> D1 sync_operations.
// Contrato: mismo operation_id + mismo payload_hash = already_processed (idempotente);
// mismo operation_id + payload_hash distinto = conflict (409), nunca se sobrescribe.
import { A5_A4_QUARANTINE_TRANSFORM_VERSION, A5_TRANSFORM_VERSION, buildManifest, stableStringify as stableImportStringify } from './a5-import-core.js';
import { handleA6, isA6Path, canonicalRuntimeDenied } from './a6-canonical.js';
import { createCanonicalSale, createCanonicalCreditAccount, canUseCanonicalSaleFastPath, CANONICAL_CLIENT_CONTRACT } from './a6-commerce.js';
import { createCanonicalFinancial, createCanonicalPaymentBatch, FINANCIAL_COMMANDS } from './a6-financial.js';
import { createCanonicalExpense, reviseCanonicalExpense, employeeCashExpenseAllowed, EXPENSE_COMMAND } from './a6-expenses.js';
import { createCanonicalProduct, updateCanonicalProduct, PRODUCT_COMMANDS } from './a6-products.js';
import { createCanonicalCustomer, CUSTOMER_COMMANDS } from './a6-customers.js';
import { setCanonicalCustomerCreditPolicy, CUSTOMER_CREDIT_POLICY_COMMANDS } from './a6-customer-credit-policy.js';
import { adjustCanonicalInventory, INVENTORY_COMMANDS } from './a6-inventory.js';
import { PRODUCT_IMAGE_PATHS, productImagesRoute } from './pos-product-images.js';
import { saleNoteRoute, recordMetaRoute } from './pos-sale-notes.js';
import { purchasesRoute, closePartialRoute } from './pos-purchases.js';
import { cashClosesRoute } from './pos-cash-closes.js';
import { annulCanonicalSale, listSaleAnnulments, SALE_ANNUL_COMMAND } from './pos-sale-annul.js';
import { handleLabWorkspace, isLabWorkspacePath } from './lab-workspace.js';
import { dniLookupRoute, DNI_LOOKUP_PATH } from './pos-dni-lookup.js';
import { assistantChatRoute, ASSISTANT_CHAT_PATH } from './pos-assistant.js';
import { handleRoles, ownerGate, posRoleFor, ROLE_PATHS, flagSaleDiscount, flagReview } from './pos-roles.js';

const TEXT_FIELDS = ['operation_id', 'entity_type', 'entity_id', 'payload', 'payload_hash', 'created_at'];
const SHA256_HEX = /^[0-9a-f]{64}$/;
const OPERATION_PATH = /^\/sync\/operations\/([^/]+)$/;
const SALE_ITEMS_PATH = /^\/read\/sales\/([^/]+)\/items$/;
const SALE_CREATE_PATH = '/commands/sale.create';
const IMPORT_STAGE_PATH = '/commands/import.stage';
const IMPORT_PATH = /^\/imports\/([^/]+)$/;
const READ_TYPES = new Set(['sales', 'sale_items', 'inventory_movements']);
const PAYMENT_METHODS = new Set(['efectivo', 'yape', 'plin', 'transferencia', 'credito', 'mixto']);
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const RUNTIME_ENVIRONMENTS = new Set(['lab', 'staging', 'production']);

function runtimeEnvironment(env) {
  // Keep the production boundary explicit in source as a fail-closed review invariant.
  if (env.RUNTIME_ENVIRONMENT === 'production') return 'production';
  const value = String(env.RUNTIME_ENVIRONMENT || 'lab').trim().toLowerCase();
  return RUNTIME_ENVIRONMENTS.has(value) ? value : null;
}

function runtimeServiceName(environment) {
  if (environment === 'production') return 'nuevo-amanecer-pos-prod';
  if (environment === 'staging') return 'nuevo-amanecer-pos-staging';
  return 'nuevo-amanecer-sync-lab';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isRead = url.pathname.startsWith('/read/');
    const isLabWorkspace = isLabWorkspacePath(url.pathname);
    try {
      if (isLabWorkspace) {
        if (runtimeEnvironment(env) !== 'lab') return json({ error: 'not_found' }, 404);
        if (request.method === 'OPTIONS') return labCors(new Response(null, { status: 204 }));
        return await handleLabWorkspace(request, url, env, { jsonLab, authorizeRead, authorizeSession });
      }
      if (isA6Path(url.pathname)) {
        if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), isRead);
        return cors(await handleA6(request, url, env, { json, authorizeRead: authorizePermissionRead, authorizeSession }), isRead);
      }
      if (request.method === 'OPTIONS' && (url.pathname === '/health' || url.pathname.startsWith('/auth/') || url.pathname === '/settings' || url.pathname.startsWith('/commands/') || url.pathname.startsWith('/imports/') || url.pathname.startsWith('/sync/operations') || url.pathname.startsWith('/read/'))) {
        return cors(new Response(null, { status: 204 }), isRead);
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        return await health(env);
      }
      // Próximamente: server lock keyed by the stable feature id (PERMISSIONS.FEATURE_LOCKS). Locked => 403 for everyone.
      if (url.pathname.startsWith('/features/')) {
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        const id = url.pathname.split('/')[2] || '';
        if (PERMISSIONS.featureLocked(id)) return json({ error: 'feature_locked', feature: id }, 403);
        const roles = PERMISSIONS.FEATURE_ROLES[id];
        if (roles && !roles.includes(auth.posRole)) return json({ error: 'forbidden_role' }, 403);
        return json({ error: 'not_found' }, 404);
      }
      if (url.pathname === '/auth/activate') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
        return await activateSession(request, env);
      }
      // Lista de anulaciones por /auth/ (el sitio web sirve GET /commands/* como archivo estático).
      if (url.pathname === '/auth/sale-annulments' && request.method === 'GET') {
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        return await listSaleAnnulments(env, json);
      }
      // Ítem 10: nota opcional de venta (registro aparte, nunca cambia montos).
      // Ítem 11: compra con proveedor y costo en una sola llamada (permiso como ajustar inventario).
      if (url.pathname === '/auth/purchases/close-partial' && request.method === 'POST') {
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        const denied = canonicalRuntimeDenied(url, env, json);
        if (denied) return denied;
        return cors(await closePartialRoute(request, env, auth, json));
      }
      if (url.pathname === '/auth/cash-closes') {
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        return cors(await cashClosesRoute(request, env, auth, json));
      }
      if (url.pathname === '/auth/purchases') {
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        if (request.method === 'POST') {
          const denied = canonicalRuntimeDenied(url, env, json);
          if (denied) return denied;
          const gated = await ownerGate(request, env, auth, 'inventory.adjust', json, getDatabase(env));
          if (gated) return gated;
        }
        return cors(await purchasesRoute(request, env, auth, json));
      }
      // Asistente (prototipo aislado): apagado salvo ASSISTANT_ENABLED=1; responde 404 antes de autenticar.
      if (url.pathname === ASSISTANT_CHAT_PATH) {
        if (String(env.ASSISTANT_ENABLED || '') !== '1') return json({ error: 'not_found' }, 404);
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return cors(auth);
        return cors(await assistantChatRoute(request, env, auth, json, { db: getDatabase(env) }));
      }
      // Búsqueda de DNI al agregar cliente: primero clientes guardados, luego Decolecta desde el Worker.
      if (url.pathname === DNI_LOOKUP_PATH) {
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        return cors(await dniLookupRoute(request, env, auth, json, getDatabase(env)));
      }
      if (url.pathname === '/auth/record-meta' && request.method === 'GET') {
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        return cors(await recordMetaRoute(env, json));
      }
      if (url.pathname === '/auth/sale-notes') {
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        return cors(await saleNoteRoute(request, env, auth, json));
      }
      if (PRODUCT_IMAGE_PATHS.has(url.pathname)) {
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        return cors(await productImagesRoute(request, url, env, auth, json, getDatabase(env)));
      }
      if (ROLE_PATHS.has(url.pathname)) {
        return cors(await handleRoles(request, url, env, { json, authorizeSession, getDatabase }));
      }
      if (url.pathname === '/auth/session') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, OPTIONS' });
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        return json({ status: 'ok', session_id: auth.sessionId });
      }
      if (isRead) {
        if (request.method !== 'GET') return cors(json({ error: 'method_not_allowed' }, 405, { allow: 'GET, OPTIONS' }), true);
        const denied = await authorizePermissionRead(request, env);
        if (denied) return cors(denied, true);
        const frozen = await authorityFence(getDatabase(env));
        if (frozen) return cors(frozen, true);
        return cors(await readRoute(url, getDatabase(env)), true);
      }
      if (url.pathname === SALE_CREATE_PATH) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
        const canonicalBody = await canonicalSaleRequestBody(request);
        if (canonicalBody) {
          const denied = canonicalRuntimeDenied(url, env, json);
          if (denied) return denied;
          // Production Turso simple sales validate the bearer session inside the
          // same atomic DB batch as authority, stock and cash. This removes the
          // standalone auth round trip without trusting the browser.
          const auth = canUseCanonicalSaleFastPath(canonicalBody, env)
            ? await deferredSaleAuth(request, env)
            : await authorizeSession(request, env);
          if (auth instanceof Response) return auth;
          const saleResponse = await createCanonicalSale(request, env, auth, json);
          await reviewSale(request, env, auth, saleResponse, ctx);
          return saleResponse;
        }
        return await createSale(request, env);
      }
      const financialCommand = url.pathname.startsWith('/commands/') ? url.pathname.slice('/commands/'.length) : '';
      if (financialCommand === SALE_ANNUL_COMMAND) {
        if (request.method !== 'POST' && request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST, OPTIONS' });
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        if (request.method === 'GET') return await listSaleAnnulments(env, json);
        const denied = canonicalRuntimeDenied(url, env, json);
        if (denied) return denied;
        // Solo con internet y con el PIN del dueño validado aquí (también en el aparato del dueño).
        const gated = await ownerGate(request, env, auth, SALE_ANNUL_COMMAND, json, getDatabase(env), true);
        if (gated) return gated;
        return await annulCanonicalSale(request, env, auth, json);
      }
      if (PRODUCT_COMMANDS.has(financialCommand)) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
        const denied = canonicalRuntimeDenied(url, env, json);
        if (denied) return denied;
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        if (financialCommand === 'product.update') {
          const gated = await ownerGate(request, env, auth, financialCommand, json, getDatabase(env));
          if (gated) return gated;
        }
        return financialCommand === 'product.update'
          ? await updateCanonicalProduct(request, env, auth, json)
          : await createCanonicalProduct(request, env, auth, json);
      }
      if (financialCommand === 'customer.contact.set') {
        if (request.method !== 'POST') return json({error:'method_not_allowed'},405);
        const denied=canonicalRuntimeDenied(url,env,json);if(denied)return denied;
        const auth=await authorizeSession(request,env);if(auth instanceof Response)return auth;
        return await setCanonicalCustomerContact(request,env,auth,json);
      }
      if (CUSTOMER_COMMANDS.has(financialCommand)) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
        const denied = canonicalRuntimeDenied(url, env, json);
        if (denied) return denied;
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        return await createCanonicalCustomer(request, env, auth, json);
      }
      if (CUSTOMER_CREDIT_POLICY_COMMANDS.has(financialCommand)) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
        const denied = canonicalRuntimeDenied(url, env, json);
        if (denied) return denied;
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        const gated = await ownerGate(request, env, auth, financialCommand, json, getDatabase(env));
        if (gated) return gated;
        return await setCanonicalCustomerCreditPolicy(request, env, auth, json);
      }
      if (INVENTORY_COMMANDS.has(financialCommand)) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
        const denied = canonicalRuntimeDenied(url, env, json);
        if (denied) return denied;
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        const gated = await ownerGate(request, env, auth, financialCommand, json, getDatabase(env));
        if (gated) return gated;
        return await adjustCanonicalInventory(request, env, auth, json);
      }
      if (financialCommand === 'credit-account.create') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
        const denied = canonicalRuntimeDenied(url, env, json);
        if (denied) return denied;
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        return await createCanonicalCreditAccount(request, env, auth, json);
      }
      if (['expense.update','expense.void'].includes(financialCommand)) {
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
        const denied = canonicalRuntimeDenied(url, env, json);
        if (denied) return denied;
        const role = auth.posRole || await posRoleFor(getDatabase(env), auth.principalId);
        return await reviseCanonicalExpense(financialCommand, request, env, { ...auth, posRole: role }, json);
      }
      if (financialCommand === EXPENSE_COMMAND) {
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
        const denied = canonicalRuntimeDenied(url, env, json);
        if (denied) return denied;
        const role = auth.posRole || await posRoleFor(getDatabase(env), auth.principalId);
        if (!canDo(role, 'expense.create') && !canDo(role, 'cash.expense')) return json({ error: 'forbidden_role', action: 'expense.create' }, 403);
        return await createCanonicalExpense(request, env, { ...auth, posRole: role }, json);
      }
      if (financialCommand === 'payment.batch') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
        const denied = canonicalRuntimeDenied(url, env, json);
        if (denied) return denied;
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        return await createCanonicalPaymentBatch(request, env, auth, json);
      }
      if (FINANCIAL_COMMANDS.has(financialCommand)) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
        const denied = canonicalRuntimeDenied(url, env, json);
        if (denied) return denied;
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        if (financialCommand === 'adjustment.create' || financialCommand === 'compensation.create') {
          const gated = await ownerGate(request, env, auth, financialCommand, json, getDatabase(env));
          if (gated) return gated;
        }
        const closeBody = financialCommand === 'cash.close' && auth.posRole === 'empleado' ? await request.clone().json().catch(() => null) : null;
        const financialResponse = await createCanonicalFinancial(financialCommand, request, env, auth, json);
        if (closeBody) await reviewCashClose(env, auth, financialResponse, closeBody);
        return financialResponse;
      }
      if (url.pathname === IMPORT_STAGE_PATH) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
        return await stageImport(request, env);
      }
      const importMatch = url.pathname.match(IMPORT_PATH);
      if (importMatch) {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, OPTIONS' });
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
        return await readImport(decodeURIComponent(importMatch[1]), getDatabase(env));
      }
      if (url.pathname.startsWith('/sync/operations')) {
        if (request.method === 'POST' && url.pathname === '/sync/operations') {
          return await insertOperation(request, env);
        }
        const match = url.pathname.match(OPERATION_PATH);
        if (request.method === 'GET' && match) {
          const auth = await authorizeSession(request, env);
          if (auth instanceof Response) return auth;
          return await lookupOperation(decodeURIComponent(match[1]), getDatabase(env));
        }
      }
      if (sessionCredential(request)) {
        const auth = await authorizeSession(request, env);
        if (auth instanceof Response) return auth;
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      if (isLabWorkspace) return jsonLab({ error: 'internal_error' }, 500);
      if (String(error?.message).includes('authority_frozen')) return cors(json({ error: 'authority_frozen' }, 409), isRead);
      return cors(json({ error: 'internal_error' }, 500), isRead);
    }
  },
};

async function canonicalSaleRequestBody(request) {
  try {
    const body = await request.clone().json();
    return body && typeof body === 'object' && !Array.isArray(body) &&
      body.client_contract === CANONICAL_CLIENT_CONTRACT && typeof body.promotion_id === 'string'
      ? body
      : null;
  } catch {
    return null;
  }
}

async function health(env) {
  const environment = runtimeEnvironment(env);
  if (!environment) return json({ ok: false, error: 'invalid_runtime_environment', d1: 'not_checked' }, 503);
  if (!getDatabase(env)) {
    return json({ ok: false, service: runtimeServiceName(environment), d1: 'binding_missing' }, 503);
  }
  const row = await getDatabase(env).prepare('SELECT 1 AS one').first();
  return json({
    ok: row?.one === 1,
    service: runtimeServiceName(environment),
    environment,
    d1: row?.one === 1 ? 'ok' : 'error'
  });
}

// A one-time activation secret issues a persistent session token.
async function activateSession(request, env) {
  const configured = String(env.POS_ACTIVATION_SECRET || '').trim();
  if (!configured) return json({ error: 'activation_not_configured' }, 503);
  const provided = String(request.headers.get('x-activation-secret') || '');
  if (!provided || provided.length > 1024 || !constantTimeEqual(provided, configured)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const sessionId = crypto.randomUUID();
  const principalId = 'session:' + sessionId;
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const db = getDatabase(env);
  await db.batch([
    db.prepare(
      `INSERT INTO devices (device_id, role, status, credential_hash, last_seen_at)
       VALUES (?1, 'writer', 'active', ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(device_id) DO UPDATE SET role='writer', status='active',
         credential_hash=excluded.credential_hash, last_seen_at=excluded.last_seen_at`
    ).bind(principalId, tokenHash),
    db.prepare(
      `INSERT INTO auth_sessions (session_id, token_hash, status, last_seen_at)
       VALUES (?1, ?2, 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    ).bind(sessionId, tokenHash),
  ]);
  return json({ status: 'activated', session_token: token });
}

function sessionCredential(request) {
  const authorization = String(request.headers.get('authorization') || '');
  const bearer = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return bearer?.[1] || String(request.headers.get('x-session-token') || '');
}

// Revisiones del dueño (G): nunca cambian la respuesta ni rechazan la operación.
async function reviewSale(request, env, auth, response, ctx) {
  if (!response || (response.status !== 200 && response.status !== 201)) return;
  let saleId = null;
  try { saleId = (await response.clone().json())?.sale_id ?? null; } catch { saleId = null; }
  if (!saleId) return;
  const run = async () => {
    try {
      let deviceId = auth.principalId, role = auth.posRole;
      if (!deviceId) { const full = await authorizeSession(request, env); if (full instanceof Response) return; deviceId = full.principalId; role = full.posRole; }
      if (role === 'owner') return;
      await flagSaleDiscount(getDatabase(env), deviceId, saleId);
    } catch (e) { console.warn('[review] sale', e?.message || e); }
  };
  if (auth.principalId) { if (auth.posRole === 'empleado') await run(); return; }
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(run());
}
async function reviewCashClose(env, auth, response, closeBody) {
  if (!response || (response.status !== 200 && response.status !== 201)) return;
  try {
    const out = await response.clone().json();
    const diff = Number(out?.difference_cents ?? out?.receipt?.difference_cents ?? 0);
    const sessionId = closeBody?.session_id ?? out?.session_id;
    if (!diff || !sessionId) return;
    await flagReview(getDatabase(env), { kind: 'cash_close_diff', ref_id: String(sessionId), device_id: auth.principalId, amount_cents: diff,
      detail: { esperado_cents: Number(closeBody.counted_cents) - diff, contado_cents: Number(closeBody.counted_cents) } });
  } catch (e) { console.warn('[review] cash.close', e?.message || e); }
}

async function deferredSaleAuth(request, env) {
  const provided = sessionCredential(request);
  if (!provided || provided.length > 1024) return json({ error: 'unauthorized' }, 401);
  if (env.READ_TOKEN && constantTimeEqual(provided, env.READ_TOKEN)) return json({ error: 'unauthorized' }, 401);
  return { sessionId: null, principalId: null, credentialHash: await sha256Hex(provided), deferredSaleAuth: true };
}

async function authorizeSession(request, env) {
  const provided = sessionCredential(request);
  if (!provided || provided.length > 1024) return json({ error: 'unauthorized' }, 401);
  if (env.READ_TOKEN && constantTimeEqual(provided, env.READ_TOKEN)) return json({ error: 'unauthorized' }, 401);
  const tokenHash = await sha256Hex(provided);
  const db = getDatabase(env);
  const sessionSql = (roleColumn) =>
    `SELECT s.session_id, s.status AS session_status, d.device_id, d.role,
            d.status AS principal_status, d.credential_hash${roleColumn}
       FROM auth_sessions s
       JOIN devices d ON d.device_id = 'session:' || s.session_id
      WHERE s.token_hash = ?1`;
  // pos_role (migration 0024) rides in the same read; before 0024 every device is the owner.
  let session;
  try {
    session = await db.prepare(sessionSql(',\n            (SELECT r.pos_role FROM pos_device_roles r WHERE r.device_id = d.device_id) AS pos_role')).bind(tokenHash).first();
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error;
    session = await db.prepare(sessionSql('')).bind(tokenHash).first();
  }
  if (!session || !constantTimeEqual(tokenHash, session.credential_hash)) return json({ error: 'unauthorized' }, 401);
  if (session.session_status !== 'active' || session.principal_status !== 'active') return json({ error: 'session_revoked' }, 403);
  if (session.role !== 'writer') return json({ error: 'read_only_session' }, 403);
  // Authorization is intentionally read-only. It must not create a write race
  // or interfere with the atomic business/canonical batch that follows.
  const role = session.pos_role === 'empleado' ? 'empleado' : 'owner';
  if (!PERMISSIONS.routeRoles(new URL(request.url).pathname, request.method).includes(role)) return json({ error: 'forbidden_role' }, 403);
  return { sessionId: session.session_id, principalId: session.device_id, credentialHash: tokenHash, posRole: role };
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function authorizePermissionRead(request, env) {
  if (request.headers.get('authorization') || request.headers.get('x-session-token')) {
    const auth = await authorizeSession(request, env);
    if (auth instanceof Response) return auth;
    const role = await posRoleFor(getDatabase(env), auth.principalId);
    if (!PERMISSIONS.routeRoles(new URL(request.url).pathname, request.method).includes(role)) return json({ error: 'forbidden_role', action: 'reports.view' }, 403);
    return null;
  }
  return authorizeRead(request, env);
}

function authorizeRead(request, env) {
  if (!env.READ_TOKEN) return json({ error: 'read_gateway_not_configured' }, 503);
  const provided = request.headers.get('x-read-token') ?? '';
  if (!constantTimeEqual(provided, env.READ_TOKEN)) return json({ error: 'unauthorized' }, 401);
  return null;
}

async function readRoute(url, db) {
  if (url.pathname === '/read/status') return readStatus(db);
  if (url.pathname === '/read/sales') return readOperations(url, db, 'sales');
  if (url.pathname === '/read/inventory-movements') return readOperations(url, db, 'inventory_movements');
  const match = url.pathname.match(SALE_ITEMS_PATH);
  if (match) return readOperations(url, db, 'sale_items', decodeURIComponent(match[1]));
  return json({ error: 'not_found' }, 404);
}

async function readStatus(db) {
  const rows = await db
    .prepare(
      `SELECT entity_type, COUNT(*) AS count, MAX(received_at) AS last_received_at
       FROM sync_operations
       WHERE entity_type IN ('sales', 'sale_items', 'inventory_movements')
       GROUP BY entity_type`,
    )
    .all();
  const counts = { sales: 0, sale_items: 0, inventory_movements: 0 };
  let lastReceivedAt = null;
  for (const row of rows.results ?? []) {
    if (!READ_TYPES.has(row.entity_type)) continue;
    counts[row.entity_type] = Number(row.count) || 0;
    if (row.last_received_at && (!lastReceivedAt || row.last_received_at > lastReceivedAt)) lastReceivedAt = row.last_received_at;
  }
  return json({ status: 'ok', counts, last_received_at: lastReceivedAt });
}

async function readOperations(url, db, entityType, saleId = null) {
  const page = parsePage(url.searchParams);
  if (page.error) return json({ error: page.error }, 400);
  const where = ['entity_type = ?1'];
  const bindings = [entityType];
  if (saleId !== null) {
    if (!saleId || saleId.length > 160) return json({ error: 'invalid_sale_id' }, 400);
    where.push(`substr(entity_id, 1, length(?${bindings.length + 1}) + 1) = ?${bindings.length + 1} || ':'`);
    bindings.push(saleId);
  }
  if (page.cursor) {
    where.push(`(received_at < ?${bindings.length + 1} OR (received_at = ?${bindings.length + 1} AND operation_id < ?${bindings.length + 2}))`);
    bindings.push(page.cursor.received_at, page.cursor.operation_id);
  }
  bindings.push(page.limit + 1);
  const limitIndex = bindings.length;
  const rows = await db
    .prepare(
      `SELECT operation_id, device_id, device_sequence, entity_type, entity_id, payload, created_at, received_at
       FROM sync_operations
       WHERE ${where.join(' AND ')}
       ORDER BY received_at DESC, operation_id DESC
       LIMIT ?${limitIndex}`,
    )
    .bind(...bindings)
    .all();
  const source = rows.results ?? [];
  const hasMore = source.length > page.limit;
  const selected = source.slice(0, page.limit);
  const items = [];
  for (const row of selected) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { return json({ error: 'invalid_stored_payload' }, 500); }
    items.push({
      operation_id: row.operation_id,
      device_id: row.device_id,
      device_sequence: row.device_sequence,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      payload,
      created_at: row.created_at,
      received_at: row.received_at,
    });
  }
  const last = selected.at(-1);
  return json({ items, next_cursor: hasMore && last ? encodeCursor(last) : null, limit: page.limit });
}

function parsePage(searchParams) {
  const rawLimit = searchParams.get('limit');
  if (rawLimit !== null && !/^\d+$/.test(rawLimit)) return { error: 'invalid_limit' };
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: 'invalid_limit' };
  const rawCursor = searchParams.get('cursor');
  if (!rawCursor) return { limit, cursor: null };
  try {
    const cursor = JSON.parse(decodeBase64Url(rawCursor));
    if (!cursor || typeof cursor.received_at !== 'string' || !Number.isFinite(Date.parse(cursor.received_at)) ||
        typeof cursor.operation_id !== 'string' || !cursor.operation_id || cursor.operation_id.length > 160) {
      return { error: 'invalid_cursor' };
    }
    return { limit, cursor };
  } catch {
    return { error: 'invalid_cursor' };
  }
}

function encodeCursor(row) {
  return encodeBase64Url(JSON.stringify({ received_at: row.received_at, operation_id: row.operation_id }));
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid cursor');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

async function insertOperation(request, env) {
  const frozen = await authorityFence(getDatabase(env));
  if (frozen) return frozen;
  const auth = await authorizeSession(request, env);
  if (auth instanceof Response) return auth;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const problem = validateOperation(body);
  if (problem) return json({ error: 'invalid_operation', message: problem }, 400);
  const db = getDatabase(env);
  const role = await posRoleFor(db, auth.principalId);
  const action = Object.prototype.hasOwnProperty.call(PERMISSIONS.SYNC_ENTITIES, body.entity_type) ? PERMISSIONS.SYNC_ENTITIES[body.entity_type] : undefined;
  let permitted = canDo(role, action);
  if (permitted && role === 'empleado' && ['expenses','cash_movements'].includes(body.entity_type)) {
    let payload; try { payload = JSON.parse(body.payload); } catch {}
    permitted = (body.entity_type !== 'cash_movements' || payload?.tipo === 'gas') &&
      !['update','delete','edit'].includes(payload?.action) && await employeeCashExpenseAllowed(db, payload, auth);
  }
  if (!permitted) return json({ error: 'forbidden_role', operation_id: body.operation_id, entity_type: body.entity_type }, 403);

  const computedHash = await sha256Hex(body.payload);
  if (computedHash !== body.payload_hash) {
    return json({ error: 'payload_hash_mismatch', computed_payload_hash: computedHash }, 400);
  }

  const result = await db
    .prepare(
      `INSERT INTO sync_operations
         (operation_id, device_id, device_sequence, entity_type, entity_id, payload, payload_hash, created_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
        WHERE EXISTS (SELECT 1 FROM devices WHERE device_id = ?2
          AND role = 'writer' AND status = 'active' AND credential_hash = ?9)
        ON CONFLICT(operation_id) DO NOTHING`,
    )
    .bind(
      body.operation_id,
      auth.principalId,
      body.device_sequence,
      body.entity_type,
      body.entity_id,
      body.payload,
      body.payload_hash,
      body.created_at,
      auth.credentialHash,
    )
    .run();

  if (result.meta.changes === 1) {
    return json({ status: 'inserted', operation_id: body.operation_id }, 201);
  }

  // A revocation/rotation may have won the race with the guarded INSERT.
  const recheck = await authorizeSession(request, env);
  if (recheck instanceof Response) return recheck;

  const existing = await db
    .prepare('SELECT payload_hash, received_at FROM sync_operations WHERE operation_id = ?1')
    .bind(body.operation_id)
    .first();
  if (!existing) {
    return json({ error: 'internal_error', message: 'insert reported no change but row is missing' }, 500);
  }
  if (existing.payload_hash === body.payload_hash) {
    return json({ status: 'already_processed', operation_id: body.operation_id, received_at: existing.received_at }, 200);
  }
  return json(
    {
      status: 'conflict',
      error: 'operation_id_conflict',
      operation_id: body.operation_id,
      stored_payload_hash: existing.payload_hash,
      received_payload_hash: body.payload_hash,
    },
    409,
  );
}

async function lookupOperation(operationId, db) {
  const row = await db.prepare('SELECT * FROM sync_operations WHERE operation_id = ?1').bind(operationId).first();
  if (!row) return json({ error: 'not_found', operation_id: operationId }, 404);
  return json({ operation: row });
}

function validateOperation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  for (const field of TEXT_FIELDS) {
    if (typeof body[field] !== 'string' || body[field].length === 0) return `${field} must be a non-empty string`;
  }
  if (!Number.isInteger(body.device_sequence) || body.device_sequence < 0) return 'device_sequence must be a non-negative integer';
  if (!SHA256_HEX.test(body.payload_hash)) return 'payload_hash must be lowercase sha256 hex';
  return null;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function createSale(request, env) {
  const frozen = await authorityFence(getDatabase(env));
  if (frozen) return frozen;
  const auth = await authorizeSession(request, env);
  if (auth instanceof Response) return auth;
  const principalId = auth.principalId;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ status: 'error', error: 'invalid_json' }, 400);
  }
  const normalized = validateSale(body);
  if (normalized.error) return json({ status: 'error', error: 'invalid_sale', message: normalized.error }, 400);

  const db = getDatabase(env);
  const payload = stableStringify(body);
  const payloadHash = await sha256Hex(payload);
  const existing = await db
    .prepare('SELECT sale_id, payload_hash FROM sales WHERE operation_id = ?1')
    .bind(body.operation_id)
    .first();
  if (existing) return saleReplay(body.operation_id, payloadHash, existing);

  // Only this batch's winning INSERT may create children. Retries never repair or append effects.
  const commitToken = crypto.randomUUID();
  const statements = [
    db.prepare(
      `INSERT INTO sales (sale_id, operation_id, payload_hash, device_id, payment_method, total_cents, created_at,
                          commit_token, payment_reference)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?9, ?10
       WHERE EXISTS (SELECT 1 FROM devices WHERE device_id = ?4
         AND role = 'writer' AND status = 'active' AND credential_hash = ?8)
       ON CONFLICT DO NOTHING`,
    ).bind(
      normalized.sale.sale_id,
      body.operation_id,
      payloadHash,
      principalId,
      normalized.sale.payment_method,
      normalized.sale.total_cents,
      normalized.sale.created_at,
      auth.credentialHash,
      commitToken,
      normalized.sale.payment.reference,
    ),
  ];

  for (const [index, item] of normalized.sale.items.entries()) {
    const lineNumber = index + 1;
    statements.push(
      db.prepare(
        `INSERT INTO sale_items
           (sale_id, line_number, operation_id, product_id, quantity, unit_price_cents, line_total_cents, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
         WHERE EXISTS (SELECT 1 FROM sales WHERE operation_id = ?3 AND commit_token = ?9)`,
      ).bind(
        normalized.sale.sale_id, lineNumber, body.operation_id, item.product_id, item.quantity,
        item.unit_price_cents, item.line_total_cents, normalized.sale.created_at, commitToken,
      ),
    );
    if (item.inventory_quantity > 0) statements.push(
      db.prepare(
        `INSERT INTO inventory_movements
           (movement_id, operation_id, sale_id, line_number, product_id, quantity, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE EXISTS (SELECT 1 FROM sales WHERE operation_id = ?2 AND commit_token = ?8)`,
      ).bind(
        `${body.operation_id}:inventory:${lineNumber}`, body.operation_id, normalized.sale.sale_id,
        lineNumber, item.product_id, -item.inventory_quantity, normalized.sale.created_at, commitToken,
      ),
    );
  }
  statements.push(
    db.prepare(
      `INSERT INTO cash_movements
         (movement_id, operation_id, sale_id, payment_method, amount_cents, cash_cents,
          digital_cents, credit_cents, digital_method, reference, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
       WHERE EXISTS (SELECT 1 FROM sales WHERE operation_id = ?2 AND commit_token = ?12)`,
    ).bind(
      `${body.operation_id}:cash`, body.operation_id, normalized.sale.sale_id,
      normalized.sale.payment_method, normalized.sale.total_cents, normalized.sale.payment.cash_cents,
      normalized.sale.payment.digital_cents, normalized.sale.payment.credit_cents,
      normalized.sale.payment.digital_method, normalized.sale.payment.reference,
      normalized.sale.created_at, commitToken,
    ),
  );

  const results = await db.batch(statements);
  if (results[0]?.meta?.changes === 1) {
    return json({ status: 'created', operation_id: body.operation_id, sale_id: normalized.sale.sale_id, idempotent: false }, 201);
  }

  // Revocation, a concurrent retry, or a conflicting operation may have won after authorization.
  const recheck = await authorizeSession(request, env);
  if (recheck instanceof Response) return recheck;
  const raced = await db.prepare('SELECT sale_id, payload_hash FROM sales WHERE operation_id = ?1').bind(body.operation_id).first();
  if (raced) return saleReplay(body.operation_id, payloadHash, raced);
  return json({ status: 'conflict', operation_id: body.operation_id, error: 'sale_not_created' }, 409);
}

function saleReplay(operationId, payloadHash, existing) {
  if (constantTimeEqual(payloadHash, existing.payload_hash)) {
    return json({ status: 'already_processed', operation_id: operationId, sale_id: existing.sale_id, idempotent: true, already_processed: true });
  }
  return json({ status: 'conflict', error: 'operation_id_conflict', operation_id: operationId }, 409);
}

function validateSale(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  if (!validId(body.operation_id)) return { error: 'operation_id must be a non-empty string of at most 160 characters' };
  if (!validId(body.sale_id)) return { error: 'sale_id must be a non-empty string of at most 160 characters' };
  if (typeof body.created_at !== 'string' || !Number.isFinite(Date.parse(body.created_at))) return { error: 'created_at must be a valid timestamp' };
  if (!PAYMENT_METHODS.has(body.payment_method)) return { error: 'payment_method is not supported' };
  if (body.payment_method === 'credito' && (!validId(body.customer_id) ||
      typeof body.credit_due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.credit_due) ||
      !Number.isFinite(Date.parse(body.credit_due)) || new Date(body.credit_due).toISOString().slice(0, 10) !== body.credit_due)) {
    return { error: 'credit requires customer_id and a valid credit_due date' };
  }
  if (!Number.isSafeInteger(body.total_cents) || body.total_cents <= 0) return { error: 'total_cents must be a positive integer' };
  const payment = validatePayment(body.payment_method, body.total_cents, body.payment);
  if (payment.error) return payment;
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 500) return { error: 'items must contain between 1 and 500 lines' };

  const items = [];
  let computedTotal = 0;
  for (const item of body.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !validId(item.product_id)) return { error: 'each product_id must be valid' };
    if (!Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > Number.MAX_SAFE_INTEGER) return { error: 'each quantity must be greater than zero and within the safe range' };
    if (!Number.isSafeInteger(item.unit_price_cents) || item.unit_price_cents < 0) return { error: 'each unit_price_cents must be a non-negative integer' };
    const exactTotal = item.quantity * item.unit_price_cents;
    const lineTotal = item.line_total_cents === undefined ? exactTotal : item.line_total_cents;
    if (item.line_total_cents !== undefined && (!Number.isSafeInteger(lineTotal) || lineTotal !== Math.round(exactTotal))) return { error: 'line_total_cents must match the rounded item total' };
    if (!Number.isSafeInteger(lineTotal) || lineTotal < 0) return { error: 'each line total must resolve to whole cents' };
    const inventoryQuantity = item.inventory_quantity === undefined ? item.quantity : item.inventory_quantity;
    if (!Number.isFinite(inventoryQuantity) || inventoryQuantity < 0 || inventoryQuantity > Number.MAX_SAFE_INTEGER) return { error: 'inventory_quantity must be non-negative and within the safe range' };
    if (!Number.isSafeInteger(computedTotal + lineTotal)) return { error: 'sale total exceeds the supported range' };
    computedTotal += lineTotal;
    items.push({ product_id: item.product_id, quantity: item.quantity, unit_price_cents: item.unit_price_cents, line_total_cents: lineTotal, inventory_quantity: inventoryQuantity });
  }
  if (computedTotal !== body.total_cents) return { error: 'total_cents does not match item totals' };
  return {
    sale: {
      sale_id: body.sale_id,
      created_at: new Date(body.created_at).toISOString(),
      payment_method: body.payment_method,
      total_cents: body.total_cents,
      payment: payment.value,
      items,
    },
  };
}

function validatePayment(method, totalCents, payment) {
  const empty = { cash_cents: 0, digital_cents: 0, credit_cents: 0, digital_method: null, reference: null };
  if (method === 'efectivo') return { value: { ...empty, cash_cents: totalCents } };
  if (method === 'credito') return { value: { ...empty, credit_cents: totalCents } };
  if (method !== 'mixto') {
    const reference = payment?.reference;
    if (reference !== undefined && (typeof reference !== 'string' || reference.length > 160 || /[\x00-\x1f\x7f]/.test(reference))) {
      return { error: 'payment reference must be a string of at most 160 characters' };
    }
    return { value: { ...empty, digital_cents: totalCents, digital_method: method, reference: reference || null } };
  }
  if (!payment || typeof payment !== 'object' || Array.isArray(payment)) return { error: 'mixed payment details are required' };
  if (!Number.isSafeInteger(payment.cash_cents) || payment.cash_cents <= 0 ||
      !Number.isSafeInteger(payment.digital_cents) || payment.digital_cents <= 0 ||
      payment.cash_cents + payment.digital_cents !== totalCents ||
      !['yape', 'plin', 'transferencia'].includes(payment.digital_method)) {
    return { error: 'mixed payment amounts and digital_method must be valid' };
  }
  if (payment.reference !== undefined && (typeof payment.reference !== 'string' || payment.reference.length > 160 || /[\x00-\x1f\x7f]/.test(payment.reference))) {
    return { error: 'payment reference must be a string of at most 160 characters' };
  }
  return {
    value: {
      ...empty,
      cash_cents: payment.cash_cents,
      digital_cents: payment.digital_cents,
      digital_method: payment.digital_method,
      reference: payment.reference || null,
    },
  };
}

async function stageImport(request, env) {
  // Role check first: employees are refused before any authority state is revealed.
  const auth = await authorizeSession(request, env);
  if (auth instanceof Response) return auth;
  const frozen = await authorityFence(getDatabase(env));
  if (frozen) return frozen;
  const deviceId = auth.principalId;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  if (!body || !validId(body.import_id) || !['start', 'rows', 'issues', 'finish'].includes(body.action)) return json({ error: 'invalid_import_request' }, 400);
  const db = getDatabase(env);
  if (body.action === 'start') return startImport(body, deviceId, auth.credentialHash, db);
  const run = await db.prepare('SELECT * FROM import_runs WHERE import_id = ?1').bind(body.import_id).first();
  if (!run) return json({ error: 'import_not_found' }, 404);
  if (run.device_id !== deviceId) return json({ error: 'import_device_mismatch' }, 403);
  if (run.status !== 'STAGING') {
    if (body.action === 'finish' && body.manifest_hash === run.manifest_hash && body.verdict === run.status && body.issue_count === JSON.parse(run.report_json).issue_count) return json({ status: run.status, import_id: body.import_id, idempotent: true, reconciliation: run.status });
    return json({ error: 'import_finalized', import_id: body.import_id }, 409);
  }
  if (body.action === 'rows') return stageImportRows(body, run, db, auth.credentialHash);
  if (body.action === 'issues') return stageImportIssues(body, run, db, auth.credentialHash);
  return finishImport(body, run, auth.credentialHash, db);
}

async function startImport(body, deviceId, credentialHash, db) {
  if (!SHA256_HEX.test(body.source_hash) || !SHA256_HEX.test(body.manifest_hash) || ![A5_TRANSFORM_VERSION, A5_A4_QUARANTINE_TRANSFORM_VERSION].includes(body.transform_version) ||
      !Number.isSafeInteger(body.source_files) || body.source_files < 1 || body.source_files > 2 ||
      !Number.isSafeInteger(body.row_count) || body.row_count < 0 || !Array.isArray(body.sources) || body.sources.length !== body.source_files ||
      typeof body.report_json !== 'string' || body.report_json.length > 1000000) {
    return json({ error: 'invalid_import_start' }, 400);
  }
  let report;
  try { report = JSON.parse(body.report_json); } catch { return json({ error: 'invalid_import_start' }, 400); }
  if (!report || !['PASS', 'FAIL'].includes(report.verdict) || !Number.isSafeInteger(report.issue_count) || report.issue_count < 0) return json({ error: 'invalid_import_start' }, 400);
  const expectedTransformVersion = report.exclusions?.policy === 'A4_TEST_TRANSACTIONS_V1' ? A5_A4_QUARANTINE_TRANSFORM_VERSION : A5_TRANSFORM_VERSION;
  if (body.transform_version !== expectedTransformVersion || (report.exclusions && report.exclusions.policy !== 'A4_TEST_TRANSACTIONS_V1')) return json({ error: 'invalid_import_start' }, 400);
  let sourcesJson;
  try { sourcesJson = stableImportStringify(body.sources); } catch { return json({ error: 'invalid_import_start' }, 400); }
  const sourceRun = await db.prepare('SELECT import_id, status FROM import_runs WHERE source_hash = ?1 AND transform_version = ?2').bind(body.source_hash, body.transform_version).first();
  if (sourceRun && sourceRun.import_id !== body.import_id) return json({ error: 'duplicate_source', import_id: sourceRun.import_id, status: sourceRun.status }, 409);
  const result = await db.prepare(
    `INSERT INTO import_runs (import_id, source_hash, manifest_hash, transform_version, device_id, status, source_files, sources_json, row_count, report_json)
     SELECT ?1, ?2, ?3, ?4, ?5, 'STAGING', ?6, ?7, ?8, ?9
     WHERE EXISTS (SELECT 1 FROM devices WHERE device_id = ?5 AND role = 'writer' AND status = 'active' AND credential_hash = ?10)
     ON CONFLICT DO NOTHING`,
  ).bind(body.import_id, body.source_hash, body.manifest_hash, body.transform_version, deviceId, body.source_files, sourcesJson, body.row_count, body.report_json, credentialHash).run();
  if (result.meta.changes === 1) return json({ status: 'STAGING', import_id: body.import_id, idempotent: false }, 201);
  const existing = await db.prepare('SELECT source_hash, manifest_hash, transform_version, source_files, sources_json, row_count, report_json, status, device_id FROM import_runs WHERE import_id = ?1').bind(body.import_id).first();
  if (existing && existing.source_hash === body.source_hash && existing.manifest_hash === body.manifest_hash && existing.transform_version === body.transform_version &&
      existing.device_id === deviceId && Number(existing.source_files) === body.source_files && existing.sources_json === sourcesJson && Number(existing.row_count) === body.row_count && existing.report_json === body.report_json) {
    return json({ status: existing.status, import_id: body.import_id, idempotent: true });
  }
  return json({ error: 'import_id_conflict', import_id: body.import_id }, 409);
}

async function stageImportRows(body, run, db, credentialHash) {
  if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 50) return json({ error: 'invalid_import_rows' }, 400);
  const statements = [];
  for (const row of body.rows) {
    if (!row || !['products', 'sales', 'customers', 'credits', 'credit_payments', 'expenses', 'cash_movements', 'cash_closures', 'inventory_movements'].includes(row.entity_type) ||
        !validSourceKey(row.source_key) || typeof row.source_name !== 'string' || !row.source_name || row.source_name.length > 240 ||
        !Number.isSafeInteger(row.source_row) || row.source_row < 1 ||
        typeof row.payload_json !== 'string' || row.payload_json.length > 1000000 || !SHA256_HEX.test(row.payload_hash) || !['VALID', 'REVIEW'].includes(row.validation_status) ||
        await sha256Hex(row.payload_json) !== row.payload_hash) return json({ error: 'invalid_import_row' }, 400);
    statements.push(db.prepare(
      `INSERT INTO import_staging (import_id, entity_type, source_key, source_name, source_row, payload_json, payload_hash, validation_status)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE EXISTS (SELECT 1 FROM import_runs r JOIN devices d ON d.device_id = r.device_id
         WHERE r.import_id = ?1 AND r.status = 'STAGING' AND d.role = 'writer' AND d.status = 'active' AND d.credential_hash = ?9)
       ON CONFLICT(import_id, entity_type, source_name, source_row, source_key) DO NOTHING`,
    ).bind(body.import_id, row.entity_type, row.source_key, row.source_name, row.source_row, row.payload_json, row.payload_hash, row.validation_status, credentialHash));
  }
  await db.batch(statements);
  for (const row of body.rows) {
    const stored = await db.prepare('SELECT payload_hash, payload_json, validation_status FROM import_staging WHERE import_id = ?1 AND entity_type = ?2 AND source_name = ?3 AND source_row = ?4 AND source_key = ?5').bind(body.import_id, row.entity_type, row.source_name, row.source_row, row.source_key).first();
    if (!stored || stored.payload_hash !== row.payload_hash || stored.payload_json !== row.payload_json || stored.validation_status !== row.validation_status) return json({ error: 'staging_row_conflict', entity_type: row.entity_type, source_key: row.source_key }, 409);
  }
  return json({ status: 'STAGING', import_id: run.import_id, accepted: body.rows.length });
}

async function stageImportIssues(body, run, db, credentialHash) {
  if (!Array.isArray(body.issues) || body.issues.length < 1 || body.issues.length > 50) return json({ error: 'invalid_import_issues' }, 400);
  const statements = [];
  for (const entry of body.issues) {
    if (!entry || !Number.isSafeInteger(entry.issue_number) || entry.issue_number < 1 || !['ERROR', 'DIFFERENCE'].includes(entry.severity) ||
        typeof entry.code !== 'string' || !entry.code || entry.code.length > 120 || (entry.entity_type !== null && entry.entity_type !== undefined && typeof entry.entity_type !== 'string') ||
        (entry.source_key !== null && entry.source_key !== undefined && !validSourceKey(entry.source_key)) || typeof entry.details_json !== 'string' || entry.details_json.length > 100000) return json({ error: 'invalid_import_issue' }, 400);
    statements.push(db.prepare(
      `INSERT INTO import_issues (import_id, issue_number, severity, code, entity_type, source_key, details_json)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE EXISTS (SELECT 1 FROM import_runs r JOIN devices d ON d.device_id = r.device_id
         WHERE r.import_id = ?1 AND r.status = 'STAGING' AND d.role = 'writer' AND d.status = 'active' AND d.credential_hash = ?8)
       ON CONFLICT(import_id, issue_number) DO NOTHING`,
    ).bind(body.import_id, entry.issue_number, entry.severity, entry.code, entry.entity_type ?? null, entry.source_key ?? null, entry.details_json, credentialHash));
  }
  await db.batch(statements);
  for (const entry of body.issues) {
    const stored = await db.prepare('SELECT severity, code, entity_type, source_key, details_json FROM import_issues WHERE import_id = ?1 AND issue_number = ?2').bind(body.import_id, entry.issue_number).first();
    if (!stored || stableStringify(stored) !== stableStringify({ severity: entry.severity, code: entry.code, entity_type: entry.entity_type ?? null, source_key: entry.source_key ?? null, details_json: entry.details_json })) return json({ error: 'staging_issue_conflict', issue_number: entry.issue_number }, 409);
  }
  return json({ status: 'STAGING', import_id: run.import_id, accepted: body.issues.length });
}

async function finishImport(body, run, credentialHash, db) {
  if (body.manifest_hash !== run.manifest_hash || !['PASS', 'FAIL'].includes(body.verdict) || !Number.isSafeInteger(body.issue_count) || body.issue_count < 0) return json({ error: 'invalid_import_finish' }, 400);
  let report;
  try { report = JSON.parse(run.report_json); } catch { return json({ error: 'invalid_stored_report' }, 500); }
  if (report.verdict !== body.verdict || report.issue_count !== body.issue_count) return json({ error: 'report_mismatch' }, 409);
  const staged = await db.prepare('SELECT entity_type, source_key, source_name, source_row, payload_json, payload_hash, validation_status FROM import_staging WHERE import_id = ?1 ORDER BY entity_type, source_key, source_name, source_row').bind(run.import_id).all();
  const storedIssues = await db.prepare('SELECT issue_number, severity, code, entity_type, source_key, details_json FROM import_issues WHERE import_id = ?1 ORDER BY issue_number').bind(run.import_id).all();
  const rows = staged.results ?? [];
  const issues = storedIssues.results ?? [];
  if (rows.length !== Number(run.row_count) || issues.length !== body.issue_count) return json({ error: 'reconciliation_incomplete', expected_rows: run.row_count, staged_rows: rows.length, expected_issues: body.issue_count, staged_issues: issues.length }, 409);
  let rebuilt;
  try {
    rebuilt = await buildManifest({ importId: run.import_id, sources: JSON.parse(run.sources_json), rows: rows.map((row) => ({ entity_type: row.entity_type, source_key: row.source_key, source_name: row.source_name, source_row: Number(row.source_row), payload: JSON.parse(row.payload_json) })), exclusions: report.exclusions ?? null });
  } catch { return json({ error: 'manifest_integrity_mismatch' }, 409); }
  const expectedIssues = rebuilt.report.issues.map((entry, index) => ({ issue_number: index + 1, severity: entry.severity, code: entry.code, entity_type: entry.entity_type, source_key: entry.source_key, details_json: JSON.stringify(entry.details) }));
  const rowStatusesMatch = rows.every((row) => rebuilt.rows.some((expected) => expected.entity_type === row.entity_type && expected.source_key === row.source_key && expected.source_name === row.source_name && expected.source_row === Number(row.source_row) && expected.payload_hash === row.payload_hash && expected.validation_status === row.validation_status));
  if (rebuilt.transform_version !== run.transform_version || rebuilt.source_hash !== run.source_hash || rebuilt.manifest_hash !== run.manifest_hash || stableImportStringify(rebuilt.report) !== stableImportStringify(report) ||
      stableImportStringify(expectedIssues) !== stableImportStringify(issues) || !rowStatusesMatch) return json({ error: 'manifest_integrity_mismatch' }, 409);
  const result = await db.prepare(
    `UPDATE import_runs SET status = ?1
     WHERE import_id = ?2 AND status = 'STAGING' AND revision = ?5 AND EXISTS
       (SELECT 1 FROM devices WHERE device_id = ?3 AND role = 'writer' AND status = 'active' AND credential_hash = ?4)`,
  ).bind(body.verdict, run.import_id, run.device_id, credentialHash, run.revision).run();
  if (result.meta.changes !== 1) return json({ error: 'import_not_finalized' }, 409);
  return json({ status: body.verdict, import_id: run.import_id, row_count: rows.length, issue_count: issues.length, reconciliation: body.verdict });
}

async function readImport(importId, db) {
  if (!validId(importId)) return json({ error: 'invalid_import_id' }, 400);
  const run = await db.prepare('SELECT import_id, source_hash, manifest_hash, transform_version, status, source_files, row_count, report_json, created_at FROM import_runs WHERE import_id = ?1').bind(importId).first();
  if (!run) return json({ error: 'import_not_found' }, 404);
  const counts = await db.prepare('SELECT entity_type, validation_status, COUNT(*) AS count FROM import_staging WHERE import_id = ?1 GROUP BY entity_type, validation_status ORDER BY entity_type, validation_status').bind(importId).all();
  return json({ ...run, report: JSON.parse(run.report_json), report_json: undefined, staged_counts: counts.results ?? [] });
}

function validSourceKey(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 240 && !/[\x00-\x1f\x7f]/.test(value);
}

async function authorityFence(db) {
  // A missing migration is an error, never permission to accept legacy writes.
  const control = await db.prepare('SELECT mode FROM canonical_control WHERE id=1').first();
  return control?.mode === 'LEGACY' ? null : json({ error: 'authority_frozen' }, 409);
}

function validId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function constantTimeEqual(a, b) {
  const bytesA = new TextEncoder().encode(a);
  const bytesB = new TextEncoder().encode(b);
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

function cors(response, isRead = false) {
  response.headers.set('access-control-allow-origin', '*');
  response.headers.set('access-control-allow-methods', isRead ? 'GET, OPTIONS' : 'GET, POST, OPTIONS');
  response.headers.set('access-control-allow-headers',
    isRead
      ? 'authorization, x-read-token, x-session-token'
      : 'authorization, content-type, x-activation-secret, x-session-token, x-owner-approval');
  response.headers.set('access-control-max-age', '600');
  return response;
}

function labCors(response) {
  response.headers.set('access-control-allow-origin', '*');
  response.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.headers.set('access-control-allow-headers', 'authorization, content-type, x-activation-secret, x-read-token, x-session-token');
  response.headers.set('access-control-max-age', '600');
  return response;
}

function jsonLab(data, status = 200, headers = {}) {
  return labCors(new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  }));
}

function json(data, status = 200, headers = {}) {
  return cors(new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  }));
}
