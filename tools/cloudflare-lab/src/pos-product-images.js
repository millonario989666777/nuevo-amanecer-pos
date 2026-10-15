import { canDo } from './pos-permissions.js';
// Miniaturas internas: los fragmentos se publican antes de cambiar el manifiesto.
export { PRODUCT_IMAGE_PATHS } from './pos-permissions.js';
const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
const validId = p => typeof p === 'string' && p.length > 0 && p.length <= 160 && !/[\x00-\x1f\x7f]/.test(p);
async function productExists(db, id, strict = false) {
  let checked = 0;
  for (const table of ['products', 'canonical_live_products']) {
    try { if (await db.prepare('SELECT product_id FROM ' + table + ' WHERE product_id=?1 LIMIT 1').bind(id).first()) return true; checked++; }
    catch (e) { if (!/no such table/i.test(e.message)) throw e; }
  }
  // strict: sin ninguna tabla de catálogo legible no se puede afirmar que el producto no existe.
  if (strict && checked === 0) throw new Error('product_catalog_unavailable');
  return false;
}
export async function deleteProductImages(db, productId) {
  const h = await hash(productId);
  const old = await db.prepare('SELECT key FROM pos_settings WHERE key=?1').bind('internal:img:m:' + h).first();
  await db.prepare('DELETE FROM pos_settings WHERE key=?1 OR key LIKE ?2').bind('internal:img:m:' + h, 'internal:img:c:' + h + ':%').run();
  return !!old;
}
export async function productImagesRoute(request, url, env, auth, json, db) {
  if (request.method !== 'GET' && !(['POST', 'DELETE'].includes(request.method) && url.pathname === '/auth/product-images')) return json({ error: 'method_not_allowed' }, 405);
  if (request.method !== 'GET' && !canDo(auth.posRole, 'product-images.write')) return json({ error: 'forbidden_role' }, 403);
  try {
    // Por id se lee una sola fila (evita leer todo el manifiesto por cada miniatura).
    const direct = request.method === 'GET' && url.pathname === '/auth/product-images/item' && url.searchParams.get('product_id') !== null;
    const rows = direct
      ? [await db.prepare('SELECT value_json FROM pos_settings WHERE key=?1').bind('internal:img:m:' + await hash(url.searchParams.get('product_id'))).first()].filter(Boolean)
      : (await db.prepare("SELECT value_json FROM pos_settings WHERE key LIKE 'internal:img:m:%'").all()).results || [];
    let metas = rows.map(r => JSON.parse(r.value_json)).sort((a, b) => a.p < b.p ? -1 : a.p > b.p ? 1 : 0);
    const live = [], orphans = [];
    // Una sola lectura por tabla (no una por foto): límite de subrequests en Turso.
    const ids = new Set();
    let catalogTrusted = true;
    if (direct) { for (const m of metas) if (await productExists(db, m.p)) ids.add(m.p); }
    else for (const table of ['products', 'canonical_live_products']) {
      try { for (const r of (await db.prepare('SELECT product_id FROM ' + table).all()).results || []) ids.add(String(r.product_id)); }
      catch (e) { catalogTrusted = false; if (!/no such table/i.test(e.message)) throw e; }
    }
    // Un catálogo vacío o una lectura fallida no prueba que las fotos sean huérfanas:
    // en ese caso no se oculta ni se borra nada.
    if (!direct && ids.size === 0) catalogTrusted = false;
    for (const m of metas) (!catalogTrusted || ids.has(m.p) ? live : orphans).push(m);
    if (request.method !== 'GET' && catalogTrusted) {
      for (const m of orphans.slice(0, 50)) {
        // Confirmación individual: solo se borra si ese product_id no existe en ninguna tabla.
        let exists = true;
        try { exists = await productExists(db, m.p, true); } catch { exists = true; }
        if (!exists) await deleteProductImages(db, m.p);
      }
    }
    metas = live;
    let b;
    if (request.method === 'DELETE') b = { product_id: url.searchParams.get('product_id'), delete: true };
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
    if (!b) try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    if (!b || Array.isArray(b) || typeof b !== 'object' || !(Object.keys(b).sort().join(',') === 'codes,image,product_id' || (Object.keys(b).sort().join(',') === 'delete,product_id' && b.delete === true))) return json({ error: 'unexpected_field' }, 400);
    if (!validId(b.product_id)) return json({ error: 'invalid_identity' }, 400);
    const now = new Date().toISOString(), actor = String(auth.principalId || 'unknown');
    const put = (key, value) => db.prepare(`INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?1,?2,1,?3,?4) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=pos_settings.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).bind(key, JSON.stringify(value), now, actor);
    const rateKey = 'internal:imgrate:' + await hash(actor);
    const rateRow = await db.prepare('SELECT value_json FROM pos_settings WHERE key=?1').bind(rateKey).first();
    let rate = rateRow ? JSON.parse(rateRow.value_json) : { w: now, n: 0 };
    if (!Number.isFinite(Date.parse(rate.w)) || Date.now() - Date.parse(rate.w) >= 3600000) rate = { w: now, n: 0 };
    const limited = () => json({ error: 'image_rate_limited', retry_after_seconds: Math.max(1, Math.ceil((Date.parse(rate.w) + 3600000 - Date.now()) / 1000)) }, 429);
    if (b.delete === true) {
      if (rate.n >= (Number(env.PRODUCT_IMAGE_RATE_LIMIT) || 600)) return limited();
      const deleted = await deleteProductImages(db, b.product_id);
      if (deleted) await put(rateKey, { w: rate.w, n: rate.n + 1 }).run();
      return json({ status: deleted ? 'deleted' : 'not_found', product_id: b.product_id });
    }
    if (!Array.isArray(b.codes) || !b.codes.length || b.codes.length > 20 || b.codes.some(c => typeof c !== 'string' || !c.trim() || c.trim().length > 160)) return json({ error: 'invalid_codes' }, 400);
    const image = b.image;
    if (typeof image !== 'string' || image.length > 60000 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image) || !image.split(',')[1].startsWith(image.startsWith('data:image/png') ? 'iVBORw0KGgo' : image.startsWith('data:image/jpeg') ? '/9j/' : 'UklGR')) return json({ error: 'invalid_image' }, 400);
    if (!await productExists(db, b.product_id)) return json({ error: 'product_not_found' }, 404);
    const codes = [...new Set(b.codes.map(c => c.trim()))], etag = await hash(image), old = metas.find(m => m.p === b.product_id);
    if (old && old.e === etag && JSON.stringify(old.c) === JSON.stringify(codes)) return json({ status: 'unchanged', product_id: b.product_id, etag });
    if (!old && metas.length >= 2000) return json({ error: 'image_limit' }, 409);
    if (rate.n >= (Number(env.PRODUCT_IMAGE_RATE_LIMIT) || 600)) return limited();
    const h = await hash(b.product_id), n = Math.ceil(image.length / 7000);
    const stored = await db.prepare("SELECT COALESCE(SUM(length(value_json)),0) AS n FROM pos_settings WHERE key LIKE 'internal:img:c:%' AND key NOT LIKE ?1").bind('internal:img:c:' + h + ':%').first();
    if (Number(stored.n) + image.length + n * 2 > 40000000) return json({ error: 'image_storage_full' }, 409);
    const chunks = Array.from({ length: n }, (_, i) => put(`internal:img:c:${h}:${etag.slice(0, 8)}:${i}`, image.slice(i * 7000, (i + 1) * 7000)));
    if (typeof db.batch === 'function') await db.batch(chunks); else for (const chunk of chunks) await chunk.run();
    await put('internal:img:m:' + h, { p: b.product_id, c: codes, e: etag, n, u: now }).run();
    await db.prepare('DELETE FROM pos_settings WHERE key LIKE ?1 AND key NOT LIKE ?2').bind(`internal:img:c:${h}:%`, `internal:img:c:${h}:${etag.slice(0, 8)}:%`).run();
    await put(rateKey, { w: rate.w, n: rate.n + 1 }).run();
    return json({ status: 'ok', product_id: b.product_id, etag });
  } catch (e) {
    if (/no such table.*pos_settings/i.test(e.message)) return json({ error: 'product_images_schema_not_ready' }, 503);
    throw e;
  }
}
