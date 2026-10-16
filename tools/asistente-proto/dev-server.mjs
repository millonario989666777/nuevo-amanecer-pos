// Servidor LOCAL del prototipo del asistente. Solo para probar en esta computadora con datos inventados.
// - Sirve POS/ como archivos estáticos.
// - Atiende /auth/assistant/chat con el MISMO código del Worker (pos-assistant.js) y un contador en memoria.
// - El rol se simula con el encabezado x-proto-role (solo aquí; el Worker real usa la sesión).
// - Sin DEEPSEEK_API_KEY en el entorno funciona en modo demostración.
// Uso: node tools/asistente-proto/dev-server.mjs [puerto]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { assistantChatRoute, assistantConfirmRoute, createMemoryUsageStore } from '../cloudflare-lab/src/pos-assistant.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../POS');
const PORT = Number(process.argv[2] || process.env.PORT || 4391);
const store = createMemoryUsageStore();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const env = { ASSISTANT_ENABLED: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '', DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || '', ASSISTANT_PER_MINUTE: process.env.ASSISTANT_PER_MINUTE || '', ASSISTANT_CONFIRM_SECRET: randomBytes(24).toString('hex'), ASSISTANT_DEMO: '1' };
// SOLO PROTOTIPO LOCAL: aprobación del dueño de mentira (cualquier PIN de 4-8 dígitos), en memoria, ligada al operation_id y de un solo uso.
// En el Worker real la da POST /auth/owner-approval (pos-roles.js) con el PIN verdadero y se gasta con consumeApproval.
const demoApprovals = new Map();
async function demoVerify(id, action, op) { const a = demoApprovals.get(id); if (!a || a.action !== action || a.op !== op) return false; if (a.used && a.used !== op) return false; a.used = op; return true; }

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/auth/owner-approval' && req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c);
      let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
      if (req.headers['x-proto-role'] === 'empleado') { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"owner_only"}'); return; }
      if (!b.operation_id) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"operation_id_required"}'); return; }
      if (!/^\d{4,8}$/.test(String(b.pin || ''))) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"owner_pin_invalid"}'); return; }
      const id = 'apr-demo-' + randomBytes(8).toString('hex'); demoApprovals.set(id, { action: String(b.action), op: String(b.operation_id), used: null });
      res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'approved', approval_id: id, action: b.action })); return;
    }
    if (url.pathname === '/auth/assistant/chat' || url.pathname === '/auth/assistant/confirm') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
      const role = req.headers['x-proto-role'] === 'empleado' ? 'empleado' : 'owner';
      const route = url.pathname === '/auth/assistant/chat' ? assistantChatRoute : assistantConfirmRoute;
      // En el Worker real el rol sale de la sesión (assistantRole); aquí se simula con el encabezado.
      const out = await route(request, env, { principalId: 'proto-device-' + role, posRole: role }, json, { store, resolveRole: async () => role, verifyApproval: demoVerify });
      res.writeHead(out.status, { 'content-type': 'application/json' }); res.end(await out.text()); return;
    }
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
  } catch (e) { res.writeHead(404).end('not found'); }
}).listen(PORT, '127.0.0.1', () => console.log(`asistente-proto en http://127.0.0.1:${PORT}/index.html?asistente=1 (modo ${env.DEEPSEEK_API_KEY ? 'deepseek' : 'demostración'})`));
