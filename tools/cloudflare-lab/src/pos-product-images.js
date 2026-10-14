// Miniaturas internas: los fragmentos se publican antes de cambiar el manifiesto.
export const PRODUCT_IMAGE_PATHS = new Set(['/auth/product-images', '/auth/product-images/item']);
const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
const validId = p => typeof p === 'string' && p.length > 0 && p.length <= 160 && !/[\x00-\x1f\x7f]/.test(p);
export async function productImagesRoute(request, url, env, auth, json, db) {
  if (request.method !== 'GET' && !(request.method === 'POST' && url.pathname === '/auth/product-images')) return json({ error: 'method_not_allowed' }, 405);
  if (request.method === 'POST' && auth.posRole !== 'owner') return json({ error: 'forbidden_role' }, 403);
  try {
    // Por id se lee una sola fila (evita leer todo el manifiesto por cada miniatura).
    const direct = request.method !== 'POST' && url.pathname === '/auth/product-images/item' && url.searchParams.get('product_id') !== null;
    const rows = direct
      ? [await db.prepare('SELECT value_json FROM pos_settings WHERE key=?1').bind('internal:img:m:' + await hash(url.searchParams.get('product_id'))).first()].filter(Boolean)
      : (await db.prepare("SELECT value_json FROM pos_settings WHERE key LIKE 'internal:img:m:%'").all()).results || [];
    const metas = rows.map(r => JSON.parse(r.value_json)).sort((a, b) => a.p < b.p ? -1 : a.p > b.p ? 1 : 0);
    if (request.method === 'GET') {
      if (url.pathname === '/auth/product-images') {
        const version = await hash(JSON.stringify(metas.map(m => m.p + '|' + m.e + '|' + m.c.join(','))));
        if (url.searchParams.get('since') === version) return json({ status: 'unchanged', version });
        return json({ status: 'ok', version, images: metas.map(m => ({ product_id: m.p, codes: m.c, etag: m.e, updated_at: m.u })) });
      }
      const id = url.searchParams.get('product_id'), code = url.searchParams.get('code');
      const found = metas.filter(m => id !== null ? m.p === id : code !== null && m.c.includes(code));
      if (!found.length) return json({ error: 'not_found' }, 404);
      if (found.length > 1) return json({ error: 'ambiguous_code' }, 409);
      const m = found[0], h = await hash(m.p); let image = '';
      for (let i = 0; i < m.n; i++) {
        const chunk = await db.prepare('SELECT value_json FROM pos_settings WHERE key=?1').bind(`internal:img:c:${h}:${m.e.slice(0, 8)}:${i}`).first();
        if (!chunk) return json({ error: 'image_incomplete' }, 409);
        image += JSON.parse(chunk.value_json);
      }
      if (await hash(image) !== m.e) return json({ error: 'image_incomplete' }, 409);
      return json({ product_id: m.p, codes: m.c, etag: m.e, image }, 200, { etag: `"${m.e}"`, ...(url.searchParams.get('v') === m.e ? { 'cache-control': 'private, max-age=31536000, immutable' } : {}) });
    }
    let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    if (!b || Array.isArray(b) || typeof b !== 'object' || Object.keys(b).some(k => !['product_id', 'codes', 'image'].includes(k))) return json({ error: 'unexpected_field' }, 400);
    if (!validId(b.product_id)) return json({ error: 'invalid_identity' }, 400);
    if (!Array.isArray(b.codes) || !b.codes.length || b.codes.length > 20 || b.codes.some(c => typeof c !== 'string' || !c.trim() || c.trim().length > 160)) return json({ error: 'invalid_codes' }, 400);
    const image = b.image;
    if (typeof image !== 'string' || image.length > 120000 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image) || !image.split(',')[1].startsWith(image.startsWith('data:image/png') ? 'iVBORw0KGgo' : image.startsWith('data:image/jpeg') ? '/9j/' : 'UklGR')) return json({ error: 'invalid_image' }, 400);
    const codes = [...new Set(b.codes.map(c => c.trim()))], etag = await hash(image), old = metas.find(m => m.p === b.product_id);
    if (old && old.e === etag && JSON.stringify(old.c) === JSON.stringify(codes)) return json({ status: 'unchanged', product_id: b.product_id, etag });
    if (!old && metas.length >= 3000) return json({ error: 'image_limit' }, 409);
    const h = await hash(b.product_id), now = new Date().toISOString(), n = Math.ceil(image.length / 7000), actor = String(auth.principalId || 'unknown');
    const put = (key, value) => db.prepare(`INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?1,?2,1,?3,?4) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=pos_settings.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).bind(key, JSON.stringify(value), now, actor);
    const chunks = Array.from({ length: n }, (_, i) => put(`internal:img:c:${h}:${etag.slice(0, 8)}:${i}`, image.slice(i * 7000, (i + 1) * 7000)));
    if (typeof db.batch === 'function') await db.batch(chunks); else for (const chunk of chunks) await chunk.run();
    await put('internal:img:m:' + h, { p: b.product_id, c: codes, e: etag, n, u: now }).run();
    await db.prepare('DELETE FROM pos_settings WHERE key LIKE ?1 AND key NOT LIKE ?2').bind(`internal:img:c:${h}:%`, `internal:img:c:${h}:${etag.slice(0, 8)}:%`).run();
    return json({ status: 'ok', product_id: b.product_id, etag });
  } catch (e) {
    if (/no such table.*pos_settings/i.test(e.message)) return json({ error: 'product_images_schema_not_ready' }, 503);
    throw e;
  }
}
