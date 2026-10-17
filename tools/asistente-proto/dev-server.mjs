// Servidor LOCAL del prototipo del asistente. Solo para probar en esta computadora con datos inventados.
// - Sirve POS/ como archivos estáticos.
// - Atiende /auth/assistant/chat con el MISMO código del Worker (pos-assistant.js) y un contador en memoria.
// - Las consultas leen datos INVENTADOS en memoria (demo-data.mjs); en el Worker real leen la base (canonicalReader).
// - El rol se simula con el encabezado x-proto-role (solo aquí; el Worker real usa la sesión).
// - Sin DEEPSEEK_API_KEY en el entorno funciona en modo demostración.
// Uso: node tools/asistente-proto/dev-server.mjs [puerto]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { assistantChatRoute, assistantConfirmRoute, createMemoryUsageStore } from '../cloudflare-lab/src/pos-assistant.js';
import { memoryReader } from '../cloudflare-lab/src/pos-assistant-queries.js';
import { readerData, posSeed } from './demo-data.mjs';
const reader = memoryReader(readerData);

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../POS');
const PORT = Number(process.argv[2] || process.env.PORT || 4391);
const store = createMemoryUsageStore();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const env = { ASSISTANT_OWNER_BOOTSTRAP: '1', ASSISTANT_ENABLED: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '', DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || '', ASSISTANT_PER_MINUTE: process.env.ASSISTANT_PER_MINUTE || '', ASSISTANT_CONFIRM_SECRET: randomBytes(24).toString('hex'), ASSISTANT_DEMO: '1' };
// SOLO PROTOTIPO LOCAL: aprobación del dueño de mentira (cualquier PIN de 4-8 dígitos), en memoria, ligada al operation_id y de un solo uso.
// En el Worker real la da POST /auth/owner-approval (pos-roles.js) con el PIN verdadero y se gasta con consumeApproval.
const demoApprovals = new Map();
// Aparatos de empleado inventados para la pantalla de Configuración del prototipo.
const PROTO_DEVICES = [{ device_id: 'proto-emp-1', label: 'Caja 2' }, { device_id: 'proto-emp-2', label: 'Celular de Rosa' }];
const protoLevels = new Map(PROTO_DEVICES.map((d) => [d.device_id, 'off']));
let protoOwners = [{ device_id: 'proto-device-owner', label: 'Celular de María', this_device: true, last_seen_at: '2026-10-16T08:42:00' }, { device_id: 'proto-tablet', label: 'Tablet de caja', last_seen_at: '2026-10-15T19:10:00' }];
let protoPending = [{ device_id: 'proto-new', label: 'Teléfono nuevo', requested_at: '2026-10-16T09:05:00' }], regFails = 0;
async function demoVerify(id, action, op) { const a = demoApprovals.get(id); if (!a || a.action !== action || a.op !== op || a.used) return false; a.used = op; return true; }

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/auth/owner-approval' && req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c);
      let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
      if (!b.operation_id) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"operation_id_required"}'); return; }
      if (!/^\d{4,8}$/.test(String(b.pin || '')) || String(b.pin) === '0000') { /* demo: «0000» simula PIN incorrecto */ res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"owner_pin_invalid"}'); return; }
      const id = 'apr-demo-' + randomBytes(8).toString('hex'); demoApprovals.set(id, { action: String(b.action), op: String(b.operation_id), used: null });
      res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'approved', approval_id: id, action: b.action })); return;
    }
    if (url.pathname === '/auth/assistant/chat' || url.pathname === '/auth/assistant/confirm') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
      // Empleado: el nivel sale del encabezado x-proto-level (pruebas) o de lo que el dueño guardó aquí para «Caja 2».
      const lvl = ['off', 'consultas', 'consultas_documentos'].includes(req.headers['x-proto-level']) ? req.headers['x-proto-level'] : protoLevels.get('proto-emp-1');
      const sinRol = req.headers['x-proto-role'] === 'sinrol'; // aparato sin fila de rol: el POS lo trata como dueño, el asistente no
      const role = req.headers['x-proto-role'] === 'empleado' ? 'empleado:' + lvl : sinRol ? 'sin_rol' : 'owner';
      const route = url.pathname === '/auth/assistant/chat' ? assistantChatRoute : assistantConfirmRoute;
      // En el Worker real el rol sale de la sesión (assistantRole); aquí se simula con el encabezado.
      const out = await route(request, env, { principalId: 'proto-device-' + role.split(':')[0], posRole: role === 'owner' || sinRol ? 'owner' : 'empleado' }, json, { store, reader, resolveRole: async () => role, verifyApproval: demoVerify });
      res.writeHead(out.status, { 'content-type': 'application/json' }); res.end(await out.text()); return;
    }
    // Aparatos de dueño (en memoria; en el Worker real: pos-owner-device.js detrás de ASSISTANT_OWNER_BOOTSTRAP=1).
    if (url.pathname.startsWith('/auth/assistant/owner-device')) {
      const send = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const chunks = []; for await (const c of req) chunks.push(c); let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
      const who = req.headers['x-proto-role'];
      if (url.pathname.endsWith('/register')) {
        if (who === 'empleado') return send(409, { error: 'employee_device_cannot_register' });
        if (who !== 'sinrol') return send(409, { error: 'already_owner' });
        if (regFails >= 5) return send(429, { error: 'owner_pin_locked', locked_until: new Date(Date.now() + 900000).toISOString(), message: 'Demasiados intentos. Espera 15 min.' });
        if (!/^\d{4,8}$/.test(String(b.pin || '')) || String(b.pin) === '0000') { regFails++; return send(regFails >= 5 ? 429 : 403, regFails >= 5 ? { error: 'owner_pin_locked', message: 'Demasiados intentos. Espera 15 min.' } : { error: 'owner_pin_invalid', attempts_left: 5 - regFails }); }
        if (!protoPending.find((x) => x.device_id === 'proto-device-sinrol')) protoPending.push({ device_id: 'proto-device-sinrol', label: 'Este teléfono', requested_at: new Date().toISOString() });
        return send(202, { ok: false, pending: true, status: 'esperando_aprobacion' });
      }
      if (who === 'empleado' || who === 'sinrol') return send(403, { error: 'owner_device_required' });
      if (req.method === 'GET') return send(200, { owners: protoOwners, pending: protoPending });
      const ok = await demoVerify(String(req.headers['x-owner-approval'] || ''), 'assistant.owner_device', String(b.operation_id || ''));
      if (url.pathname.endsWith('/revoke')) {
        if (!protoOwners.find((o) => o.device_id === b.device_id)) return send(409, { error: 'not_owner' });
        if (protoOwners.length <= 1) return send(409, { error: 'last_owner', code: 'last_owner' });
        if (!ok) return send(403, { error: 'owner_approval_required' });
        protoOwners = protoOwners.filter((o) => o.device_id !== b.device_id); return send(200, { ok: true });
      }
      if (url.pathname.endsWith('/approve')) {
        const p = protoPending.find((x) => x.device_id === b.device_id); if (!p) return send(409, { error: 'not_pending' });
        if (!['approve', 'reject'].includes(b.decision || 'approve')) return send(400, { error: 'bad_decision' });
        if (!ok) return send(403, { error: 'owner_approval_required' });
        protoPending = protoPending.filter((x) => x !== p);
        if ((b.decision || 'approve') === 'approve') protoOwners.push({ device_id: p.device_id, label: p.label, created_at: new Date().toISOString(), last_seen_at: null });
        return send(200, { ok: true });
      }
      return send(404, { error: 'not_found' });
    }
    // Nivel del asistente por aparato de empleado (en memoria; en el Worker real: pos-assistant-access.js con PIN real).
    if (url.pathname === '/auth/assistant/employee-access') {
      const send = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers['x-proto-role'] === 'empleado') return send(403, { error: 'admin_only' });
      if (req.method === 'GET') return send(200, { devices: PROTO_DEVICES.map((d) => ({ ...d, level: protoLevels.get(d.device_id) })), levels: ['off', 'consultas', 'consultas_documentos'] });
      const chunks = []; for await (const c of req) chunks.push(c); let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
      if (!protoLevels.has(b.device_id) || !['off', 'consultas', 'consultas_documentos'].includes(b.level)) return send(400, { error: 'bad_request' });
      if (!(await demoVerify(String(req.headers['x-owner-approval'] || ''), 'assistant.employee_access', String(b.operation_id || '')))) return send(403, { error: 'owner_approval_required' });
      protoLevels.set(b.device_id, b.level); return send(200, { ok: true, device_id: b.device_id, level: b.level, logged: false });
    }
    // Solo prototipo: los mismos datos inventados para sembrar el navegador.
    if (url.pathname === '/__demo-seed.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(posSeed)); return; }
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
  } catch (e) { res.writeHead(404).end('not found'); }
}).listen(PORT, '127.0.0.1', () => console.log(`asistente-proto en http://127.0.0.1:${PORT}/index.html?asistente=1 (modo ${env.DEEPSEEK_API_KEY ? 'deepseek' : 'demostración'})`));
