import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Un crédito anulado solo por source_status o por status en mayúsculas (sin anulado:true) no suma en deudaT (inline-01),
// en el puntaje de historial (inline-04, _naCreditHistoryMetrics) ni en el «Por cobrar» de Inicio (utils.js). Datos sintéticos.
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const utils = read('POS/js/core/utils.js'), inline01 = read('POS/js/legacy-inline/inline-01.js');
const inline02 = read('POS/js/legacy-inline/inline-02.js'), inline04 = read('POS/js/legacy-inline/inline-04.js');
const grab = (src, re) => { const m = src.match(re); assert.ok(m, 'fragmento no encontrado: ' + re); return m[0]; };
const between = (src, from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return src.slice(a, b); };

function sandbox({ withHelper = true } = {}) {
  const ctx = { creditos:[], obtenerHoy:() => '2026-10-15',
    diasHasta:day => day ? Math.round((Date.parse(day) - Date.parse('2026-10-15')) / 864e5) : null };
  vm.createContext(ctx);
  const code = [
    grab(utils, /const _naNumber=[^\n]+/), grab(utils, /function _naRoundMoney\([^\n]+/),
    withHelper ? grab(utils, /function _naIsCreditVoided\(cr\)\{[^\n]+/) : '',
    between(utils, 'function _naInicioCredits(records)', '// Crítico'),
    // inline-02 siempre carga después de utils; sin helper solo se prueban los respaldos de inline-01/04.
    withHelper ? grab(inline02, /const _naSyncCreditStatus=[^\n]+/) : "const _naSyncCreditStatus=cr=>cr.status;", grab(inline02, /function _naCreditOutstanding\(cr\)\{[^\n]+/),
    grab(inline01, /const deudaT=[^\n]+/),
    grab(inline04, /function _naCreditCompletionDate\(cr\)\{[^\n]+/),
    between(inline04, 'function _naCreditHistoryMetrics(clientId){', 'function _naCreditBehaviorLabel'),
    'this.deudaT = deudaT;'
  ].join('\n');
  vm.runInContext(code, ctx);
  return { ctx, run:src => vm.runInContext(src, ctx) };
}
const credit = (id, monto, pagado, extra = {}) => ({ id, cliId:7, clienteId:7, monto, pagado, saldo:monto - pagado, fecha:'2026-09-01',
  vence:'2026-11-30', status:'vigente', estado:'vigente', anulado:false, pagos:[], ...extra });
const live = () => [credit(1, 100, 40), credit(2, 50, 0, { vence:'2026-10-01' }), credit(3, 30, 30)];
const VOIDED = [['source_status', 'ANULADO'], ['source_status', 'anulado'], ['source_status', ' Anulada '], ['status', 'ANULADO'], ['status', 'ANULADA']];
const sums = h => ({ deudaT:h.ctx.deudaT({ id:7 }), score:h.run('_naCreditHistoryMetrics(7)').debt, total:h.run('_naCreditHistoryMetrics(7)').total,
  porCobrar:h.run('_naInicioCredits(creditos)').debt });

test('base sin anulados: deudaT, puntaje y «Por cobrar» = 110 (60 + 50)', () => {
  const h = sandbox(); h.ctx.creditos = live();
  assert.deepEqual(sums(h), { deudaT:110, score:110, total:3, porCobrar:110 });
});

for (const [field, value] of VOIDED) {
  test(`${field}=${JSON.stringify(value)} sin anulado:true no suma en deudaT, puntaje ni «Por cobrar»`, () => {
    const h = sandbox();
    h.ctx.creditos = [...live(), credit(9, 70, 0, { [field]:value, ...(field === 'status' ? { estado:'vigente' } : {}) })];
    const voided = JSON.stringify(h.ctx.creditos[3]);
    assert.deepEqual(sums(h), { deudaT:110, score:110, total:3, porCobrar:110 });
    assert.equal(JSON.stringify(h.ctx.creditos[3]), voided, 'el crédito anulado no se modifica');
  });
}

test('LIVE / RECONCILED y "no anulado" siguen sumando (el helper no los toma como anulados)', () => {
  const h = sandbox();
  h.ctx.creditos = [...live(), credit(9, 70, 0, { status:'LIVE', source_status:'VIGENTE' }), credit(10, 5, 0, { status:'RECONCILED', estado:'no anulado' })];
  assert.deepEqual(sums(h), { deudaT:185, score:185, total:5, porCobrar:185 });
});

test('respaldo sin helper (inline-01/04): vuelve al chequeo anterior, sin romper', () => {
  const h = sandbox({ withHelper:false });
  h.ctx.creditos = [...live(), credit(9, 70, 0, { anulado:true, status:'anulado' })];
  assert.equal(h.ctx.deudaT({ id:7 }), 110);
  assert.equal(h.run('_naCreditHistoryMetrics(7)').debt, 110);
});
