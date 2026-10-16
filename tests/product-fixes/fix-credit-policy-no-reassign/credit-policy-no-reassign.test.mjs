import test from 'node:test';
import assert from 'node:assert/strict';
import { createPosSandbox } from '../../release-invariants/lib/sandbox.mjs';

// Referencia: _naCreditPolicy anterior (inline-04.js:6-16 en 7a446ae8), que reemplazaba
// appConfig.creditPolicy en cada llamada. Sirve para comparar resultados, no se ejecuta en producción.
const OLD_POLICY = `function _naCreditPolicyOld(){
  const raw=appConfig?.creditPolicy||{},cfg={..._NA_CREDIT_POLICY_DEFAULTS,...raw};
  cfg.enabled=cfg.enabled!==false;
  cfg.minPurchases=Math.max(0,Math.min(100000,_naNumber(cfg.minPurchases,1000)));
  cfg.minProfit=Math.max(0,Math.min(100000,_naNumber(cfg.minProfit,400)));
  cfg.initialLine=Math.max(0,Math.min(100000,_naNumber(cfg.initialLine,5)));
  cfg.punctualRate=Math.max(0,Math.min(100,_naNumber(cfg.punctualRate,10)));
  cfg.lateRate=Math.max(0,Math.min(100,_naNumber(cfg.lateRate,5)));
  cfg.dueDays=Math.max(1,Math.min(365,Math.round(_naNumber(cfg.dueDays,30))||30));
  appConfig.creditPolicy=cfg;return cfg;
}`;

function sandbox() {
  const sb = createPosSandbox();
  sb.run(OLD_POLICY + ';globalThis.__naCreditPolicyNew=_naCreditPolicy;');
  return sb;
}

test('una política ya normalizada no se reemplaza al evaluar ni al abrir la ficha', () => {
  const sb = sandbox();
  sb.run(`appConfig.creditPolicy={enabled:true,minPurchases:1000,minProfit:400,initialLine:5,punctualRate:10,lateRate:5,dueDays:30};
    globalThis.__ref=appConfig.creditPolicy;clientes=[{id:1,nombre:'Sintético',totalCompras:0}];ventas=[];creditos=[];`);
  sb.run('_naCreditPolicy();_naEvaluateClientCredit(1);_naEvaluateClientCredit(1);_naCreditPolicy();');
  assert.equal(sb.run('appConfig.creditPolicy===__ref'), true, 'la referencia guardada se conserva');
  assert.equal(sb.run('_naCreditPolicy()===appConfig.creditPolicy'), true, 'devuelve la política guardada');
});

test('falta, inválida o sin normalizar: se normaliza una sola vez y luego queda estable', () => {
  for (const raw of ['undefined', 'null', "'texto'", '[]', '{}', "{minPurchases:'500',dueDays:12.6,enabled:0}", '{minProfit:-5,lateRate:500,extra:1}']) {
    const sb = sandbox();
    sb.run(`appConfig.creditPolicy=${raw};`);
    const first = sb.run('JSON.stringify(_naCreditPolicy())');
    sb.run('globalThis.__ref=appConfig.creditPolicy;');
    assert.equal(sb.run('typeof appConfig.creditPolicy==="object"&&!Array.isArray(appConfig.creditPolicy)'), true, raw);
    sb.run('_naCreditPolicy();_naCreditPolicy();');
    assert.equal(sb.run('appConfig.creditPolicy===__ref'), true, raw + ': segunda llamada no reemplaza');
    assert.equal(sb.run('JSON.stringify(_naCreditPolicy())'), first, raw);
  }
});

test('equivalencia: política y evaluación idénticas a la versión anterior en 300 casos aleatorios', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const value = () => pick([undefined, null, 0, 1, 5, 12.6, 400, 1000, 100001, -3, '250', 'abc', true, false]);
  const sb = sandbox();
  assert.notEqual(sb.run('String(__naCreditPolicyNew)'), sb.run('String(_naCreditPolicyOld)').replace('_naCreditPolicyOld', '_naCreditPolicy'), 'compara dos implementaciones distintas');
  for (let i = 0; i < 300; i++) {
    const policy = rnd() < 0.1 ? pick([undefined, null, [], 'x']) : Object.fromEntries(
      ['enabled', 'minPurchases', 'minProfit', 'initialLine', 'punctualRate', 'lateRate', 'dueDays'].filter(() => rnd() < 0.8).map(k => [k, value()]));
    const clientes = Array.from({ length:4 }, (_, n) => ({ id:n + 1, nombre:'Sintético ' + n, totalCompras:Math.round(rnd() * 3000) }));
    const ventas = Array.from({ length:12 }, (_, n) => ({ id:'v' + n, clienteId:1 + Math.floor(rnd() * 4), total:100, anulada:rnd() < 0.1, fecha:'2026-09-0' + (1 + n % 9),
      metodo:pick(['efectivo', 'credito']), items:[{ id:'p' + n, qty:1 + Math.floor(rnd() * 5), precio:Math.round(rnd() * 300), costo:Math.round(rnd() * 150) }] }));
    const creditos = ventas.filter(v => v.metodo === 'credito').map((v, n) => ({ id:'c' + n, ventaId:v.id, cliId:v.clienteId, monto:v.items[0].precio * v.items[0].qty,
      pagado:pick([0, 10, 1e6]), vence:pick(['2026-01-01', '2027-01-01']), fecha:v.fecha, pagos:[] }));
    const setup = JSON.stringify({ policy:policy === undefined ? null : policy, clientes, ventas, creditos, undef:policy === undefined });
    const runWith = fn => sb.run(`(()=>{const d=${setup};appConfig.creditPolicy=d.undef?undefined:d.policy;clientes=d.clientes;ventas=d.ventas;creditos=d.creditos;
      _naCreditPolicy=${fn};const out=[];for(let k=0;k<3;k++)out.push(_naCreditPolicy(),clientes.map(c=>_naEvaluateClientCredit(c.id)));
      out.push(appConfig.creditPolicy);_naCreditPolicy=__naCreditPolicyNew;return JSON.stringify(out);})()`);
    assert.equal(runWith('__naCreditPolicyNew'), runWith('_naCreditPolicyOld'), 'caso ' + i);
  }
});
