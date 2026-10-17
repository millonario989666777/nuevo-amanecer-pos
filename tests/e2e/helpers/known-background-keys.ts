export const KNOWN_BACKGROUND_KEYS: readonly string[] = [
  // Caché de /settings que config-g.js actualiza en segundo plano; no es una escritura de la página.
  'na_pos_settings_cache_v1',
];

export function stripKnownBackgroundKeys<T>(storage: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(storage).filter(([key]) => !KNOWN_BACKGROUND_KEYS.includes(key)));
}
