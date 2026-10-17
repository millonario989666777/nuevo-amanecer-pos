export const KNOWN_BACKGROUND_KEYS: readonly string[] = [
  // Caché de /settings que config-g.js actualiza en segundo plano; no es una escritura de la página.
  'na_pos_settings_cache_v1',
];

// TODO(fix B, seguimiento en PR #809): temporal: se borra cuando se arregle el POST de settings sin cambios .
export const KNOWN_BACKGROUND_WRITES = [
  { method: 'POST', pathname: '/settings' },
];

export function isKnownBackgroundWrite(method: string, url: string): boolean {
  const parsed = new URL(url);
  return KNOWN_BACKGROUND_WRITES.some(entry => method.toUpperCase() === entry.method && parsed.pathname === entry.pathname);
}

export function stripKnownBackgroundKeys<T>(storage: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(storage).filter(([key]) => !KNOWN_BACKGROUND_KEYS.includes(key)));
}
