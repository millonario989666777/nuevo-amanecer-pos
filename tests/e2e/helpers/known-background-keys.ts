import { expect, type Page } from '@playwright/test';

export const KNOWN_BACKGROUND_KEYS: readonly string[] = [
  // Caché de /settings que config-g.js actualiza en segundo plano; no es una escritura de la página.
  'na_pos_settings_cache_v1',
];

// TODO(fix B, seguimiento en PR #809): temporal: se borra cuando se arregle el POST de settings sin cambios
export const KNOWN_BACKGROUND_WRITES = [
  { method: 'POST', url: 'https://permissions.test/settings' },
] as const;

// Una sincronización como máximo por cada clave de SHARED en POS/js/config/config-g.js.
export const KNOWN_BACKGROUND_SETTING_KEYS = ['pos.business', 'pos.flags', 'pos.credit', 'pos.lots', 'pos.ticket'] as const;
export const MAX_KNOWN_BACKGROUND_WRITES = KNOWN_BACKGROUND_SETTING_KEYS.length;
type SharedSettingKey = typeof KNOWN_BACKGROUND_SETTING_KEYS[number];
type SharedSettings = Record<SharedSettingKey, unknown>;

export type KnownBackgroundWrite = { method: string; url: string; postData: unknown };

export function isKnownBackgroundWrite(method: string, url: string): boolean {
  return KNOWN_BACKGROUND_WRITES.some(entry => method === entry.method && url === entry.url);
}

export async function captureKnownBackgroundSettings(page: Page): Promise<SharedSettings> {
  return page.evaluate(() => {
    const w = window as any;
    const c = w.eval('appConfig');
    const b = c.business || {};
    let allowExpiredLots = false;
    try { allowExpiredLots = w._naGetSecurityPath('rules.allowExpiredLots') === true; } catch (_) {}
    // Misma proyección que SHARED[k].get; JSON refleja el cuerpo enviado por la API.
    return JSON.parse(JSON.stringify({
      'pos.business': { nombre: b.nombre || '', ruc: b.ruc || '', direccion: b.direccion || '', telefono: b.telefono || '' },
      'pos.flags': { igvActive: !!c.igvActive, margenActive: !!c.margenActive, stockAlertActive: !!c.stockAlertActive,
        printAuto: !!c.printAuto, mayoristaActive: !!c.mayoristaActive, alertsEnabled: c.alertsEnabled !== false, stockMin: c.stockMin },
      'pos.credit': Object.assign({}, c.creditPolicy || {}),
      'pos.lots': { allowExpiredLots },
      'pos.ticket': Object.assign({}, c.ticket || {}),
    }));
  });
}

export function assertKnownBackgroundWrites(writes: KnownBackgroundWrite[], before: SharedSettings): void {
  expect(writes.length).toBeLessThanOrEqual(MAX_KNOWN_BACKGROUND_WRITES);
  const seen = new Set<SharedSettingKey>();
  for (const write of writes) {
    expect(isKnownBackgroundWrite(write.method, write.url), `${write.method} ${write.url}`).toBe(true);
    expect(write.postData).toHaveProperty('key');
    expect(write.postData).toHaveProperty('value');
    const body = write.postData as { key: SharedSettingKey; value: unknown };
    expect(KNOWN_BACKGROUND_SETTING_KEYS).toContain(body.key);
    expect(seen.has(body.key), `POST de settings repetido: ${body.key}`).toBe(false);
    seen.add(body.key);
    expect(body.value, `POST de settings debe sincronizar el valor previo: ${body.key}`).toEqual(before[body.key]);
  }
}

export function stripKnownBackgroundKeys<T>(storage: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(storage).filter(([key]) => !KNOWN_BACKGROUND_KEYS.includes(key)));
}
