// Asistente del punto de venta (PROTOTIPO AISLADO, rama feature/asistente-aislado).
// Reglas:
// 1) Apagado por defecto: sin ASSISTANT_ENABLED=1 la ruta responde 404, también en producción.
// 2) La clave DEEPSEEK_API_KEY vive solo en el Worker. Nunca se devuelve ni se registra.
//    Sin clave, el asistente funciona en "modo demostración" (respuestas simuladas) para poder mostrarlo.
// 3) El modelo solo PROPONE. Ninguna herramienta se ejecuta aquí: el Worker devuelve propuestas
//    validadas y el celular las ejecuta con las funciones del POS SOLO después de «Confirmar».
// 4) Permisos: las herramientas de dueño no se ofrecen a un empleado y, si el modelo igual las pide,
//    se descartan aquí (doble barrera; el celular vuelve a revisar al confirmar).
// 5) Antes de enviar a DeepSeek se quitan DNI, RUC, teléfonos y correos del texto y del contexto.
//    El contexto solo lleva productos (id, nombre, precio, stock); nunca clientes.
// 6) Límite por aparato (minuto/día) y tope mensual para todo el negocio, contados ANTES de llamar.
import { sha256Hex } from './a5-import-core.js';
import { canDo } from './pos-permissions.js';
import { mockAssistantReply } from './pos-assistant-mock.js';

export const ASSISTANT_CHAT_PATH = '/auth/assistant/chat';
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = 'deepseek-flash';
export const ASSISTANT_LIMITS = Object.freeze({
  perMinute: 6, perDay: 120, photosPerDay: 30,
  monthlyChats: 4000, monthlyPhotos: 900,
  timeoutMs: 25000, maxBodyBytes: 2_600_000, maxImageChars: 2_200_000,
  maxHistory: 8, maxMessageChars: 1500, maxProducts: 80, maxTokens: 900
});
export const USAGE_PREFIX = 'internal:asst:';
// Herramienta -> acción de la tabla única de permisos (POS/js/config/pos-permissions.js).
export const TOOL_ACTIONS = Object.freeze({ proponer_cambio_precio: 'assistant.price.propose' });
export function toolAllowed(role, name) { const a = TOOL_ACTIONS[name]; return a ? canDo(role, a) : canDo(role, 'assistant.chat'); }
function seesCosts(role) { return canDo(role, 'purchases.costs.view'); }
const SCREEN_IDS = ['pagePOS', 'pageInventario', 'pageVentas', 'pageClientes', 'pageCaja', 'pageGastos', 'pageConfig'];
const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

// ---------- Datos sensibles ----------
const PATTERNS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[correo oculto]'],
  [/\b(?:10|15|17|20)\d{9}\b/g, '[RUC oculto]'],
  [/(?:\+?51[\s-]?)?\b9\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g, '[teléfono oculto]'],
  [/\b\d{8}\b/g, '[DNI oculto]']
];
export function redactText(value) {
  let out = String(value ?? '');
  for (const [re, label] of PATTERNS) out = out.replace(re, label);
  return out;
}
function cleanText(value, max) {
  return redactText(String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ')).slice(0, max).trim();
}
function money(v) { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) && n >= 0 && n < 100000 ? n : null; }
function qty(v) { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 9999 ? Math.round(n * 1000) / 1000 : null; }
function safeId(v) { const s = String(v ?? '').trim(); return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(s) ? s : null; }

// Solo pasan campos de producto en una lista blanca. Un empleado no ve costos.
export function sanitizeContext(raw, role) {
  const ctx = raw && typeof raw === 'object' ? raw : {};
  const products = (Array.isArray(ctx.products) ? ctx.products : []).slice(0, ASSISTANT_LIMITS.maxProducts).map((p) => {
    const id = safeId(p?.id); if (!id) return null;
    const item = { id, nombre: cleanText(p.nombre ?? p.name, 80), precio: money(p.precio ?? p.price), stock: Number.isFinite(Number(p.stock)) ? Number(p.stock) : null };
    if (seesCosts(role) && money(p.costo ?? p.cost) != null) item.costo = money(p.costo ?? p.cost);
    return item.nombre ? item : null;
  }).filter(Boolean);
  const screen = SCREEN_IDS.includes(ctx.screen) ? ctx.screen : null;
  return { screen, products };
}

// ---------- Herramientas (solo propuestas) ----------
const LINE = { type: 'object', properties: { product_id: { type: 'string' }, nombre: { type: 'string' }, cantidad: { type: 'number' } }, required: ['nombre', 'cantidad'] };
const TOOL_DEFS = [
  { name: 'explicar_pasos', description: 'Explica paso a paso cómo hacer algo en el punto de venta. No cambia nada.',
    parameters: { type: 'object', properties: { tema: { type: 'string' }, pasos: { type: 'array', items: { type: 'string' }, maxItems: 8 }, pantalla: { type: 'string', enum: SCREEN_IDS } }, required: ['tema', 'pasos'] } },
  { name: 'preparar_venta', description: 'Prepara un borrador de venta (agrega productos al carrito). No cobra: la persona revisa y pulsa Cobrar.',
    parameters: { type: 'object', properties: { lineas: { type: 'array', items: LINE, maxItems: 20 } }, required: ['lineas'] } },
  { name: 'preparar_compra', description: 'Prepara un borrador de compra a proveedor. No suma stock hasta que la persona pulse Registrar compra.',
    parameters: { type: 'object', properties: { proveedor: { type: 'string' }, documento: { type: 'string' }, lineas: { type: 'array', maxItems: 30, items: { type: 'object', properties: { product_id: { type: 'string' }, nombre: { type: 'string' }, cantidad: { type: 'number' }, costo_unitario: { type: 'number' } }, required: ['nombre', 'cantidad'] } } }, required: ['lineas'] } },
  { name: 'leer_factura_compra', description: 'Convierte la foto de una factura o boleta de compra en líneas de compra. No transcribas DNI, RUC ni teléfonos.',
    parameters: { type: 'object', properties: { proveedor: { type: 'string' }, documento: { type: 'string' }, fecha: { type: 'string' }, lineas: { type: 'array', maxItems: 30, items: { type: 'object', properties: { product_id: { type: 'string' }, nombre: { type: 'string' }, cantidad: { type: 'number' }, costo_unitario: { type: 'number' } }, required: ['nombre', 'cantidad'] } } }, required: ['lineas'] } },
  { name: 'proponer_cambio_precio', description: 'Propone cambiar el precio de venta de un producto. Solo dueño. Se abre la ficha del producto para guardar.',
    parameters: { type: 'object', properties: { product_id: { type: 'string' }, nombre: { type: 'string' }, precio_nuevo: { type: 'number' }, motivo: { type: 'string' } }, required: ['product_id', 'precio_nuevo'] } },
  { name: 'preparar_documento', description: 'Prepara la vista previa de un documento interno (nota de venta, cotización o lista de precios). Nunca es comprobante SUNAT.',
    parameters: { type: 'object', properties: { tipo: { type: 'string', enum: ['nota_venta', 'cotizacion', 'lista_precios'] }, titulo: { type: 'string' }, lineas: { type: 'array', maxItems: 40, items: { type: 'object', properties: { nombre: { type: 'string' }, cantidad: { type: 'number' }, precio: { type: 'number' } }, required: ['nombre'] } }, nota: { type: 'string' } }, required: ['tipo', 'lineas'] } }
];
export function toolsForRole(role) {
  return TOOL_DEFS.filter((t) => toolAllowed(role, t.name))
    .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function systemPrompt(role, ctx) {
  const who = role === 'owner' ? 'el DUEÑO' : 'un EMPLEADO (no puede cambiar precios, ver costos ni hacer cosas de dueño)';
  return [
    'Eres "Burbuja", el ayudante del punto de venta de la farmacia/botica Nuevo Amanecer (Perú, soles S/).',
    `Hablas con ${who}. Responde en español sencillo, frases cortas, máximo 5 líneas.`,
    'Nunca ejecutas nada: usas herramientas para PROPONER y la persona confirma con un botón. Dilo así: "Revisa y pulsa Confirmar".',
    'Usa solo productos de la lista de contexto, con su product_id. Si no está, dilo y no inventes ids ni precios.',
    'No emites comprobantes SUNAT reales: los documentos son vistas previas internas.',
    'Nunca pidas ni repitas DNI, RUC, teléfonos ni datos de clientes. Si aparecen en una foto, ignóralos.',
    'Pantallas: Venta (pagePOS), Inventario (pageInventario), Ventas/Reportes (pageVentas), Clientes (pageClientes), Caja (pageCaja), Gastos (pageGastos), Configuración (pageConfig).',
    'Guía rápida: cobrar = Venta > agregar productos > Cobrar. Abrir caja = Caja > Abrir caja. Compra = Inventario > OCR compras o Registrar compra. Abono = Clientes > ficha > Abonar.',
    `Contexto (pantalla actual: ${ctx.screen || 'desconocida'}). Productos: ${JSON.stringify(ctx.products)}`
  ].join('\n');
}

// ---------- Validación de propuestas ----------
function productIndex(ctx) { const m = new Map(); for (const p of ctx.products) m.set(p.id, p); return m; }
function matchLine(line, idx) {
  const id = safeId(line?.product_id);
  const p = id ? idx.get(id) : null;
  return { product_id: p ? p.id : null, nombre: cleanText(p?.nombre || line?.nombre, 80) };
}

// Convierte una llamada de herramienta del modelo en propuesta segura. Devuelve null si se descarta.
export function toProposal(call, role, ctx, n) {
  const name = call?.name; let args = call?.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return { dropped: 'bad_arguments', tool: name }; } }
  if (!args || typeof args !== 'object') return { dropped: 'bad_arguments', tool: name };
  if (!TOOL_DEFS.some((t) => t.name === name)) return { dropped: 'unknown_tool', tool: name };
  if (!toolAllowed(role, name)) return { dropped: 'forbidden_role', tool: name };
  const idx = productIndex(ctx), id = `p${n}-${name}`;
  if (name === 'explicar_pasos') {
    const pasos = (Array.isArray(args.pasos) ? args.pasos : []).slice(0, 8).map((s) => cleanText(s, 200)).filter(Boolean);
    if (!pasos.length) return { dropped: 'empty', tool: name };
    return { id, type: 'pasos', needsConfirm: false, title: cleanText(args.tema, 80) || 'Cómo hacerlo', pasos, pantalla: SCREEN_IDS.includes(args.pantalla) ? args.pantalla : null };
  }
  if (name === 'preparar_venta') {
    const lineas = [], faltan = [];
    for (const l of (Array.isArray(args.lineas) ? args.lineas : []).slice(0, 20)) {
      const m = matchLine(l, idx), q = qty(l?.cantidad);
      if (!q) continue;
      if (!m.product_id) { if (m.nombre) faltan.push(m.nombre); continue; }
      const p = idx.get(m.product_id);
      lineas.push({ product_id: m.product_id, nombre: p.nombre, cantidad: Math.max(1, Math.round(q)), precio: p.precio });
    }
    if (!lineas.length) return { dropped: 'no_known_products', tool: name, faltan };
    return { id, type: 'venta', needsConfirm: true, title: 'Preparar venta', lineas, faltan, total: Math.round(lineas.reduce((s, l) => s + (l.precio || 0) * l.cantidad, 0) * 100) / 100 };
  }
  if (name === 'preparar_compra' || name === 'leer_factura_compra') {
    const lineas = [];
    for (const l of (Array.isArray(args.lineas) ? args.lineas : []).slice(0, 30)) {
      const m = matchLine(l, idx), q = qty(l?.cantidad);
      if (!q || !m.nombre) continue;
      lineas.push({ product_id: m.product_id, nombre: m.nombre, cantidad: q, costo_unitario: seesCosts(role) ? money(l?.costo_unitario) : null });
    }
    if (!lineas.length) return { dropped: 'empty', tool: name };
    return { id, type: 'compra', needsConfirm: true, title: name === 'leer_factura_compra' ? 'Compra leída de la foto' : 'Preparar compra',
      proveedor: cleanText(args.proveedor, 120), documento: cleanText(args.documento, 80), fecha: cleanText(args.fecha, 20), lineas,
      sinProducto: lineas.filter((l) => !l.product_id).length };
  }
  if (name === 'proponer_cambio_precio') {
    const p = idx.get(safeId(args.product_id)); const nuevo = money(args.precio_nuevo);
    if (!p || !nuevo || nuevo <= 0) return { dropped: 'bad_price', tool: name };
    const delta = p.precio ? (nuevo - p.precio) / p.precio : null;
    return { id, type: 'precio', needsConfirm: true, requiresRole: 'owner', title: 'Cambiar precio', product_id: p.id, nombre: p.nombre,
      precio_actual: p.precio, precio_nuevo: nuevo, motivo: cleanText(args.motivo, 160), cambioGrande: delta != null && Math.abs(delta) > 0.5,
      bajoCosto: p.costo != null && nuevo < p.costo };
  }
  if (name === 'preparar_documento') {
    const tipo = ['nota_venta', 'cotizacion', 'lista_precios'].includes(args.tipo) ? args.tipo : 'nota_venta';
    const lineas = (Array.isArray(args.lineas) ? args.lineas : []).slice(0, 40).map((l) => {
      const nombre = cleanText(l?.nombre, 80); if (!nombre) return null;
      return { nombre, cantidad: qty(l?.cantidad) || 1, precio: money(l?.precio) };
    }).filter(Boolean);
    if (!lineas.length) return { dropped: 'empty', tool: name };
    return { id, type: 'documento', needsConfirm: true, title: cleanText(args.titulo, 80) || ({ nota_venta: 'Nota de venta', cotizacion: 'Cotización', lista_precios: 'Lista de precios' })[tipo],
      tipo, lineas, nota: cleanText(args.nota, 200), fiscal: false };
  }
  return { dropped: 'unknown_tool', tool: name };
}

// ---------- Límites de uso ----------
function limaDate(nowMs) { return new Date(nowMs - 5 * 3600 * 1000).toISOString().slice(0, 10); }
export function createMemoryUsageStore() {
  const map = new Map();
  return {
    async get(key) { const r = map.get(key); return r ? { value: JSON.parse(JSON.stringify(r.value)), revision: r.revision } : { value: {}, revision: 0 }; },
    async put(key, value, revision) { const r = map.get(key); if ((r?.revision || 0) !== revision) return false; map.set(key, { value, revision: revision + 1 }); return true; },
    _map: map
  };
}
// Mismo patrón que la búsqueda de DNI: pos_settings con revisión optimista.
export function createSettingsUsageStore(db) {
  return {
    async get(key) {
      const row = await db.prepare('SELECT value_json,revision FROM pos_settings WHERE key=?1').bind(key).first();
      if (!row) return { value: {}, revision: 0 };
      let value = {}; try { value = JSON.parse(row.value_json) || {}; } catch { value = {}; }
      return { value, revision: Number(row.revision || 0) };
    },
    async put(key, value, revision) {
      const res = await db.prepare(`INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?1,?2,1,?3,'assistant')
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=pos_settings.revision+1,updated_at=excluded.updated_at
        WHERE pos_settings.revision=?4`).bind(key, JSON.stringify(value), new Date().toISOString(), revision).run();
      return !(res?.meta && res.meta.changes === 0);
    }
  };
}
function capFrom(env, name, fallback) { const n = Number.parseInt(env?.[name] || '', 10); return Number.isFinite(n) && n >= 0 ? n : fallback; }

// Reserva un uso (se cuenta antes de llamar a DeepSeek). Devuelve { ok } o { reason, retryAfter }.
export async function reserveUsage(store, auth, env, nowMs, hasImage) {
  const day = limaDate(nowMs), month = day.slice(0, 7), minute = Math.floor(nowMs / 60000);
  const L = { perMinute: capFrom(env, 'ASSISTANT_PER_MINUTE', ASSISTANT_LIMITS.perMinute), perDay: capFrom(env, 'ASSISTANT_PER_DAY', ASSISTANT_LIMITS.perDay),
    photosPerDay: capFrom(env, 'ASSISTANT_PHOTOS_PER_DAY', ASSISTANT_LIMITS.photosPerDay), monthlyChats: capFrom(env, 'ASSISTANT_MONTHLY_CHAT_CAP', ASSISTANT_LIMITS.monthlyChats),
    monthlyPhotos: capFrom(env, 'ASSISTANT_MONTHLY_PHOTO_CAP', ASSISTANT_LIMITS.monthlyPhotos) };
  const deviceKey = USAGE_PREFIX + (await sha256Hex(String(auth.principalId || 'unknown'))).slice(0, 40);
  const monthKey = USAGE_PREFIX + 'month';
  for (let attempt = 0; attempt < 4; attempt++) {
    const [g, d] = await Promise.all([store.get(monthKey), store.get(deviceKey)]);
    const gv = g.value.m === month ? { ...g.value } : { m: month, c: 0, f: 0 };
    const dv = d.value.d === day ? { ...d.value } : { d: day, c: 0, f: 0, min: minute, mn: 0 };
    if (dv.min !== minute) { dv.min = minute; dv.mn = 0; }
    if (gv.c >= L.monthlyChats || (hasImage && gv.f >= L.monthlyPhotos)) return { reason: 'monthly_cap' };
    if (dv.mn >= L.perMinute) return { reason: 'rate_limited', retryAfter: 60 - Math.floor((nowMs % 60000) / 1000) };
    if (dv.c >= L.perDay || (hasImage && dv.f >= L.photosPerDay)) return { reason: 'daily_limit' };
    gv.c++; dv.c++; dv.mn++; if (hasImage) { gv.f++; dv.f++; }
    if (!(await store.put(monthKey, gv, g.revision))) continue;
    if (!(await store.put(deviceKey, dv, d.revision))) continue;
    return { ok: true, left: { hoy: L.perDay - dv.c, fotosHoy: L.photosPerDay - dv.f } };
  }
  return { reason: 'busy' };
}

// ---------- DeepSeek ----------
export function buildDeepSeekRequest({ role, ctx, history, text, image }) {
  const messages = [{ role: 'system', content: systemPrompt(role, ctx) }];
  for (const m of history) messages.push({ role: m.role, content: m.content });
  const userText = text || (image ? 'Lee esta foto de factura o producto y propone las líneas de compra.' : '');
  messages.push(image
    ? { role: 'user', content: [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: image, detail: 'auto' } }] }
    : { role: 'user', content: userText });
  return { model: DEEPSEEK_MODEL, messages, tools: toolsForRole(role), tool_choice: 'auto', thinking: { type: 'disabled' },
    temperature: 0.2, max_tokens: ASSISTANT_LIMITS.maxTokens, stream: false };
}

export async function callDeepSeek(body, env, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = String(env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL).replace(/\/+$/, '');
    const res = await fetchImpl(`${base}/chat/completions`, { method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) return { error: res.status === 429 ? 'upstream_busy' : 'upstream_error', status: res.status };
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    const calls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((c) => ({ name: c?.function?.name, arguments: c?.function?.arguments }));
    return { content: String(msg.content || ''), calls, usage: data?.usage || null };
  } catch (e) {
    return { error: e?.name === 'AbortError' ? 'upstream_timeout' : 'upstream_error' };
  } finally { clearTimeout(timer); }
}

// ---------- Ruta ----------
const ERR_STATUS = { upstream_busy: 503, upstream_error: 502, upstream_timeout: 504 };
export function parseChatBody(body) {
  if (!body || typeof body !== 'object') return { error: 'bad_request' };
  const text = cleanText(body.text, ASSISTANT_LIMITS.maxMessageChars);
  let image = null;
  if (body.image != null) {
    if (typeof body.image !== 'string' || body.image.length > ASSISTANT_LIMITS.maxImageChars) return { error: 'image_too_large' };
    if (!IMAGE_DATA_URL.test(body.image)) return { error: 'bad_image' };
    image = body.image;
  }
  if (!text && !image) return { error: 'empty_message' };
  const history = (Array.isArray(body.history) ? body.history : []).slice(-ASSISTANT_LIMITS.maxHistory)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: cleanText(m.content, ASSISTANT_LIMITS.maxMessageChars) })).filter((m) => m.content);
  return { text, image, history, context: body.context };
}

export async function assistantChatRoute(request, env, auth, json, deps = {}) {
  if (String(env?.ASSISTANT_ENABLED || '') !== '1') return json({ error: 'not_found' }, 404);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const role = auth?.posRole === 'owner' ? 'owner' : 'empleado';
  const len = Number(request.headers.get('content-length') || 0);
  if (len > ASSISTANT_LIMITS.maxBodyBytes) return json({ error: 'payload_too_large' }, 413);
  let raw; try { raw = await request.text(); } catch { return json({ error: 'bad_request' }, 400); }
  if (raw.length > ASSISTANT_LIMITS.maxBodyBytes) return json({ error: 'payload_too_large' }, 413);
  let body; try { body = JSON.parse(raw); } catch { return json({ error: 'bad_request' }, 400); }
  const parsed = parseChatBody(body);
  if (parsed.error) return json({ error: parsed.error }, parsed.error === 'image_too_large' ? 413 : 400);
  const ctx = sanitizeContext(parsed.context, role);
  const store = deps.store || (deps.db ? createSettingsUsageStore(deps.db) : null);
  if (!store) return json({ error: 'usage_store_missing' }, 500);
  const quota = await reserveUsage(store, auth, env, (deps.now || Date.now)(), !!parsed.image);
  if (!quota.ok) return json({ error: quota.reason, retry_after_s: quota.retryAfter || null }, quota.reason === 'busy' ? 503 : 429);

  const mode = env.DEEPSEEK_API_KEY ? 'deepseek' : 'mock';
  let result;
  if (mode === 'mock') result = mockAssistantReply({ role, ctx, text: parsed.text, image: !!parsed.image });
  else {
    const req = buildDeepSeekRequest({ role, ctx, history: parsed.history, text: parsed.text, image: parsed.image });
    result = await callDeepSeek(req, env, deps.fetch || fetch, deps.timeoutMs || ASSISTANT_LIMITS.timeoutMs);
    if (result.error) return json({ error: result.error, mode }, ERR_STATUS[result.error] || 502);
  }
  const proposals = [], dropped = [];
  result.calls.forEach((c, i) => { const p = toProposal(c, role, ctx, i + 1); if (p?.dropped) dropped.push(p); else if (p) proposals.push(p); });
  let reply = cleanText(result.content, 1200);
  if (!reply && dropped.some((d) => d.dropped === 'forbidden_role')) reply = 'Eso solo lo puede hacer el dueño.';
  if (!reply && proposals.length) reply = 'Listo. Revisa y pulsa Confirmar.';
  if (!reply) reply = 'No entendí bien. ¿Me lo dices de otra forma?';
  return json({ ok: true, mode, role, reply, proposals, dropped: dropped.map((d) => ({ tool: d.tool, reason: d.dropped })), left: quota.left,
    usage: result.usage ? { prompt_tokens: result.usage.prompt_tokens || 0, completion_tokens: result.usage.completion_tokens || 0 } : null });
}
