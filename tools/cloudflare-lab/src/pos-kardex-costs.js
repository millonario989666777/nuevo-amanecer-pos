import { canDo } from './pos-permissions.js';

// Filtro de lectura únicamente: no cambia réplicas almacenadas ni operaciones.
const COST_FIELDS = new Set(['cost_cents', 'unit_cost_cents', 'total_cost_cents',
  'costo', 'unitCost', 'unitCostCents', 'averageCost', 'lastCost',
  'incomingValue', 'outgoingValue', 'balanceValue']);

export function redactKardexCostsForRole(payload, role) {
  if (canDo(role, 'purchases.costs.view')) return payload;
  function strip(value) {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !COST_FIELDS.has(key)).map(([key, child]) => [key, strip(child)]));
  }
  return strip(payload);
}
