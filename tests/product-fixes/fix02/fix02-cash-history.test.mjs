// FIX02 — HISTORIAL PERMANENTE DE CIERRES DE CAJA
//
// T1  abrir → operar → cerrar            → exactamente 1 cierre histórico
// T2  abrir segunda caja                 → cierre 1 permanece valor-equivalente
// T3  cerrar segunda caja                → 2 cierres distintos
// T4  reload (carga del durable)         → ambos cierres sobreviven
// T5  contado/esperado/diferencia del 1  → inmutables tras turno 2
// T6  compatibilidad legacy              → snapshot sin campo → []; respaldo plano → [];
//                                        import con cierres los preserva (sanitizador)
// T7  fallo de persistencia al cerrar    → rollback completo (cajEstado + cashClosures), sin cierre fantasma
// T8  doble cierre                       → no duplica (guard cerrada + guard cajCloseProc concurrente)
// T9  abrir/cerrar actual                → comportamiento previo intacto
// T10 control sano                       → durable guarda cajEstado + cashClosures

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPosSandbox, json } from './lib/sandbox.mjs';

const PRODUCTO = { id: 'P1', name: 'Arroz', stock: 10, controlInventario: true, precio: 50, costo: 5, unidad: 'unidad' };

function freshTab() {
  const sb = createPosSandbox();
  sb.seed();
  sb.seedData('productos', [{ ...PRODUCTO }]);
  return sb;
}

async function openCash(sb, fondo) {
  sb.el('cajFondo').value = String(fondo);
  sb.el('cajCajero').value = 'CAJ-001';
  return sb.run('abrirCaja()');
}

async function sellCash(sb, precio, received) {
  sb.run(`cart.push({id:'P1',precio:${precio},qty:1,unitsPerQty:1,ventaModo:'unidad',costo:5,controlInventario:true,ventaLibre:false,ventaSinStock:false,unidad:'unidad'});`);
  sb.el('mMontoRec').value = String(received);
  await sb.run('confirmarVenta()');
}

async function cashMove(sb, tipo, amount, desc) {
  sb.run(`cajMovTipo='${tipo}';`);
  sb.el('cajMovMonto').value = String(amount);
  sb.el('cajMovDesc').value = desc;
  sb.el('cajMovMetodo').value = 'efectivo';
  sb.el('cajMovCat').value = tipo === 'egr' ? 'Retiro de caja' : 'Otro ingreso';
  await sb.run('guardarMovCaja()');
}

async function closeCash(sb, counted) {
  sb.el('cajContado').value = String(counted);
  await sb.run('cerrarCaja()');
}

test('T1 — abrir → vender/operar → cerrar crea EXACTAMENTE 1 cierre histórico con los datos del turno', async () => {
  const sb = freshTab();
  const openedAt = json(sb, 'obtenerHoy()');
  assert.equal(await openCash(sb, 100), true, 'la caja abre');
  const sessionId = json(sb, 'cajEstado.sessionId');
  await sellCash(sb, 50, 50);
  await cashMove(sb, 'egr', 20, 'Retiro de prueba');
  await closeCash(sb, 125);

  const closures = json(sb, 'cashClosures');
  assert.equal(closures.length, 1, 'exactamente un cierre histórico');
  const c = closures[0];
  assert.match(c.id, new RegExp(`^C-[A-Za-z0-9]+-${sessionId}$`), 'id estable derivado del sessionId del turno + etiqueta del aparato');
  assert.equal(c.sessionId, sessionId);
  assert.equal(c.cajeroId, 'CAJ-001');
  assert.equal(c.fechaApertura, openedAt, 'fecha de apertura congelada');
  assert.ok(c.timestampApertura, 'timestamp de apertura presente');
  assert.ok(c.timestampCierre, 'timestamp de cierre presente');
  assert.equal(c.fondo, 100, 'monto inicial (fondo)');
  assert.equal(c.esperado, 130, 'esperado = fondo 100 + venta 50 - retiro 20');
  assert.equal(c.contado, 125);
  assert.equal(c.diferencia, -5);
  assert.equal(json(sb, 'cajEstado.cerrada'), true, 'cajEstado queda cerrado (estado actual)');
  assert.equal(json(sb, 'cajEstado.sessionId'), sessionId, 'cajEstado sigue siendo el turno cerrado hasta nueva apertura');
});

test('T2 — abrir una segunda caja NO toca el cierre 1 (valor-equivalente)', async () => {
  const sb = freshTab();
  await openCash(sb, 100);
  await closeCash(sb, 100);
  const closure1Before = json(sb, 'cashClosures[0]');
  assert.equal(await openCash(sb, 50), true, 'segunda caja abre');
  const closures = json(sb, 'cashClosures');
  assert.equal(closures.length, 1, 'el historial no creció al abrir');
  assert.equal(JSON.stringify(closures[0]), JSON.stringify(closure1Before), 'cierre 1 valor-equivalente byte a byte');
  assert.notEqual(json(sb, 'cajEstado.sessionId'), closure1Before.sessionId, 'cajEstado es un turno nuevo');
});

test('T3 — cerrar la segunda caja produce 2 cierres distintos', async () => {
  const sb = freshTab();
  await openCash(sb, 100);
  await closeCash(sb, 125);
  await openCash(sb, 50);
  const sessionId2 = json(sb, 'cajEstado.sessionId');
  await closeCash(sb, 50);
  const closures = json(sb, 'cashClosures');
  assert.equal(closures.length, 2, 'existen 2 cierres');
  assert.notEqual(closures[0].id, closures[1].id, 'ids distintos');
  assert.match(closures[1].id, new RegExp(`^C-[A-Za-z0-9]+-${sessionId2}$`));
  assert.equal(closures[1].fondo, 50);
  assert.equal(closures[1].esperado, 50);
  assert.equal(closures[1].diferencia, 0);
});

test('T4 — RELOAD: ambos cierres sobreviven a la carga del snapshot durable', async () => {
  const sb = freshTab();
  await openCash(sb, 100);
  await closeCash(sb, 125);
  await openCash(sb, 50);
  await closeCash(sb, 50);
  const memoryBefore = json(sb, 'cashClosures');
  assert.equal(await sb.run('saveAllData()').then(() => true), true);
  // Recarga por el mecanismo real de recuperación (durable → _naApplySnapshot).
  const loaded = sb.run('_naApplySnapshot(_naParseStoredSnapshot(storage.readPersistent(_NA_LOCAL_KEY)))');
  assert.equal(loaded, true, 'el snapshot durable carga normalmente');
  assert.equal(json(sb, 'cashClosures.length'), 2, 'ambos cierres sobreviven');
  assert.equal(JSON.stringify(json(sb, 'cashClosures')), JSON.stringify(memoryBefore), 'cierres idénticos tras reload');
  assert.equal(json(sb, 'cajEstado.cerrada'), true, 'el estado del último turno también sobrevive');
});

test('T5 — contado/esperado/diferencia del cierre 1 NO cambian después del turno 2', async () => {
  const sb = freshTab();
  await openCash(sb, 100);
  await sellCash(sb, 50, 50);
  await cashMove(sb, 'egr', 20, 'Retiro');
  await closeCash(sb, 125);
  const closure1 = json(sb, 'cashClosures[0]');
  await openCash(sb, 30);
  await sellCash(sb, 50, 50);
  await closeCash(sb, 80);
  const closure1After = json(sb, 'cashClosures[0]');
  assert.equal(closure1After.contado, 125, 'contado inmutable');
  assert.equal(closure1After.esperado, 130, 'esperado inmutable');
  assert.equal(closure1After.diferencia, -5, 'diferencia inmutable');
  assert.equal(JSON.stringify(closure1After), JSON.stringify(closure1), 'registro completo inmutable');
  assert.equal(json(sb, 'cashClosures.length'), 2);
});

test('T6 — compatibilidad legacy (snapshot sin campo, respaldo plano, import con cierres)', async () => {
  // 6a: snapshot V9 antiguo SIN cashClosures carga como []
  let sb = freshTab();
  sb.seedData('clientes', [{ id: 'C1', nombre: 'Cliente', color: 0 }]);
  await sb.run('saveAllData()');
  const legacy = sb.durableSnapshot();
  delete legacy.data.cashClosures;
  const applied = sb.run(`_naApplySnapshot(${JSON.stringify(legacy)})`);
  assert.equal(applied, true, 'snapshot legacy carga normalmente');
  assert.deepEqual(json(sb, 'cashClosures'), [], 'cashClosures se inicializa como []');
  assert.equal(json(sb, 'clientes.length'), 1, 'los datos legacy se cargan');

  // 6b: respaldo plano antiguo (v8) sin cashClosures → canónico con []
  const preparedFlat = sb.run('_naPrepareBackupSnapshot({version:8,productos:[],ventas:[],appConfig:{}})');
  assert.deepEqual(json(sb, `(${JSON.stringify(preparedFlat.snapshot.data.cashClosures)})`), [], 'respaldo plano → cashClosures []');

  // 6c: importar un respaldo CON cierres los preserva vía _naApplySnapshot.
  // Nota: el sanitizador reconstruye los objetos (orden de claves puede variar);
  // la equivalencia exigida aquí es de VALORES (deepEqual), la byte-fiel se
  // garantiza en el camino durable (T2/T4/T5).
  await openCash(sb, 100);
  await closeCash(sb, 110);
  await openCash(sb, 40);
  await closeCash(sb, 45);
  const exported = sb.durableSnapshot();
  assert.equal(exported.data.cashClosures.length, 2);
  const prepared = sb.run(`_naPrepareBackupSnapshot(${JSON.stringify(exported)})`);
  assert.equal(prepared.snapshot.data.cashClosures.length, 2, 'el sanitizador reconoce cashClosures');
  assert.equal(prepared.counts.cashClosures, 2);
  sb.run(`_naApplySnapshot(${JSON.stringify(prepared.snapshot)})`);
  assert.deepEqual(json(sb, 'cashClosures'), exported.data.cashClosures, 'import preserva los cierres (valor-equivalente)');
});

test('T7 — fallo inducido de persistencia al cerrar → rollback completo sin cierre fantasma', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await sb.run('saveAllData()');
  const durableBefore = sb.durableSnapshot();
  sb.breakPersistent();
  await closeCash(sb, 80);
  sb.restorePersistent();
  const mem = sb.memoryState();
  assert.equal(mem.cashClosures.length, 0, 'sin cierre fantasma en memoria');
  assert.equal(mem.cajEstado.cerrada, false, 'cajEstado volvió a abierto');
  assert.equal(mem.cajEstado.contado, null, 'contado revertido');
  assert.equal(mem.cajEstado.horaCierre, null, 'horaCierre revertido');
  const durableAfter = sb.durableSnapshot();
  assert.equal(durableAfter.data.cashClosures.length, 0, 'sin cierre fantasma en durable');
  assert.equal(durableAfter.data.cajEstado.cerrada, false, 'durable conserva el turno abierto');
  assert.equal(
    JSON.stringify(durableAfter.data),
    JSON.stringify(durableBefore.data),
    'durable completo == estado previo al cierre fallido'
  );
  assert.deepEqual(mem.cajEstado, durableAfter.data.cajEstado, 'memoria == durable tras rollback');
  assert.match(sb.toastText(), /No se pudo guardar el cierre/i, 'fallo informado');
  // Sin estado residual: con persistencia sana el cierre procede una sola vez.
  await closeCash(sb, 80);
  assert.equal(json(sb, 'cashClosures.length'), 1, 'tras reintento sano existe exactamente 1 cierre');
});

test('T8 — doble cierre / repetición accidental NO duplica el historial', async () => {
  // 8a: cierre repetido después de éxito (guard cajEstado.cerrada)
  let sb = freshTab();
  await openCash(sb, 100);
  await closeCash(sb, 100);
  await closeCash(sb, 100);
  assert.equal(json(sb, 'cashClosures.length'), 1, 'segundo cierre ignorado');
  assert.match(sb.toastText(), /ya está cerrada/i);

  // 8b: doble invocación concurrente (guard cajCloseProc del wrapper winner)
  sb = freshTab();
  await openCash(sb, 100);
  sb.el('cajContado').value = '100';
  sb.run(`
    const __realSave=saveAllData;
    globalThis.__realSave=__realSave;
    saveAllData=function(){return new Promise(r=>{globalThis.__releaseSave=r;});};
  `);
  const p1 = sb.run('cerrarCaja()');
  assert.equal(json(sb, 'cashClosures.length'), 1, 'el cierre en vuelo ya registró el historial');
  const p2 = sb.run('cerrarCaja()');
  await p2;
  assert.equal(json(sb, 'cashClosures.length'), 1, 'la segunda llamada concurrente fue ignorada');
  sb.run('globalThis.__releaseSave({ok:true,durable:true,verified:true,storage:"indexedDB"});');
  await p1;
  sb.run('saveAllData=globalThis.__realSave;');
  assert.equal(json(sb, 'cashClosures.length'), 1, 'un solo cierre histórico total');
  assert.equal(json(sb, 'cajEstado.cerrada'), true);
});

test('T9 — abrir/cerrar la caja actual sigue comportándose como antes', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  const state = json(sb, 'cajEstado');
  assert.equal(state.abierta, true);
  assert.equal(state.cerrada, false);
  assert.equal(state.fondo, 100);
  assert.equal(state.cajeroId, 'CAJ-001');
  assert.equal(Number.isFinite(state.sessionId), true);
  assert.equal(await openCash(sb, 999), false, 'apertura doble sigue bloqueada');
  assert.match(sb.toastText(), /ya está abierta/i);
  await sellCash(sb, 50, 50);
  await cashMove(sb, 'egr', 20, 'Retiro');
  const totals = json(sb, 'cajTotales()');
  assert.equal(totals.ven, 50, 'ventas de sesión intactas');
  assert.equal(totals.ret, 20, 'retiros de sesión intactos');
  assert.equal(totals.ef, 130, 'efectivo esperado intacto');
  await closeCash(sb, 125);
  const closed = json(sb, 'cajEstado');
  assert.equal(closed.cerrada, true);
  assert.equal(closed.contado, 125);
  assert.equal(closed.esperado, 130);
  assert.equal(closed.diferencia, -5);
  assert.match(sb.toastText(), /Caja cerrada · diferencia/i, 'toast de cierre intacto');
});

test('T10 — control sano: la persistencia válida guarda cajEstado Y cashClosures (una sola fuente de verdad)', async () => {
  const sb = freshTab();
  await openCash(sb, 100);
  await closeCash(sb, 110);
  await openCash(sb, 40);
  await closeCash(sb, 45);
  await sb.run('saveAllData()');
  const durable = sb.durableSnapshot();
  const mem = sb.memoryState();
  assert.ok(durable, 'existe snapshot durable');
  assert.equal(durable.data.cashClosures.length, 2);
  assert.equal(JSON.stringify(durable.data.cashClosures), JSON.stringify(mem.cashClosures), 'cashClosures durable == memoria');
  assert.equal(JSON.stringify(durable.data.cajEstado), JSON.stringify(mem.cajEstado), 'cajEstado durable == memoria');
  assert.equal(durable.data.cajEstado.cerrada, true);
});

test('T11 — resetModule(\'caja\') preserva el historial permanente', async () => {
  const sb = freshTab();
  await openCash(sb, 100);
  await closeCash(sb, 95);
  const closuresBefore = json(sb, 'cashClosures');
  assert.equal(closuresBefore.length, 1);

  await sb.run(`_naSecOriginalResetModule('caja')`);

  assert.deepEqual(json(sb, 'cashClosures'), closuresBefore, 'reset de caja no borra cierres históricos');
  assert.deepEqual(sb.durableSnapshot().data.cashClosures, closuresBefore, 'el durable conserva el historial');
  assert.equal(json(sb, 'cajMovs.length'), 0, 'los movimientos de la caja actual sí se limpian');
  assert.equal(json(sb, 'cajEstado.cerrada'), true, 'la caja operativa queda reiniciada');
});

test('T12 — reset total explícito sí puede borrar cashClosures', async () => {
  const sb = freshTab();
  await openCash(sb, 100);
  await closeCash(sb, 100);
  assert.equal(json(sb, 'cashClosures.length'), 1);

  await sb.run(`_naSecOriginalResetModule('todo')`);

  assert.deepEqual(json(sb, 'cashClosures'), []);
  assert.deepEqual(sb.durableSnapshot().data.cashClosures, []);
});

test('T13 — snapshot legacy sin cashClosures sigue siendo válido y carga []', async () => {
  const sb = freshTab();
  sb.seedData('clientes', [{ id: 'C1', nombre: 'Cliente Legacy', color: 0 }]);
  await sb.run('saveAllData()');
  const legacy = sb.durableSnapshot();
  delete legacy.data.cashClosures;

  const prepared = sb.run(`_naPrepareBackupSnapshot(${JSON.stringify(legacy)})`);
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.snapshot.data.cashClosures)), []);
  assert.equal(sb.run(`_naApplySnapshot(${JSON.stringify(prepared.snapshot)})`), true);
  assert.deepEqual(json(sb, 'cashClosures'), []);
  assert.equal(json(sb, 'clientes[0].nombre'), 'Cliente Legacy');
});

test('T14 — cashClosures presente pero no-array rechaza el backup', async () => {
  const sb = freshTab();
  await sb.run('saveAllData()');
  const invalid = sb.durableSnapshot();
  invalid.data.cashClosures = { corrupto: true };

  assert.throws(
    () => sb.run(`_naPrepareBackupSnapshot(${JSON.stringify(invalid)})`),
    /cashClosures: se esperaba una lista/i
  );

  const invalidFlat = {
    version: 8,
    exportedAt: invalid.updatedAt,
    productos: invalid.data.productos,
    ventas: invalid.data.ventas,
    clientes: invalid.data.clientes,
    creditos: invalid.data.creditos,
    gastos: invalid.data.gastos,
    cajMovs: invalid.data.cajMovs,
    cajEstado: invalid.data.cajEstado,
    cashClosures: { corrupto: true }
  };
  assert.throws(
    () => sb.run(`_naPrepareBackupSnapshot(${JSON.stringify(invalidFlat)})`),
    /cashClosures: se esperaba una lista/i,
    'el respaldo plano tampoco puede ocultar un cashClosures inválido'
  );
});

test('T15 — contado, esperado o diferencia null/no-numérico rechazan el cierre importado', async () => {
  const sb = freshTab();
  await openCash(sb, 100);
  await closeCash(sb, 90);
  const valid = sb.durableSnapshot();

  for (const field of ['contado', 'esperado', 'diferencia']) {
    for (const invalidValue of [null, 'no-numero']) {
      const invalid = structuredClone(valid);
      invalid.data.cashClosures[0][field] = invalidValue;
      assert.throws(
        () => sb.run(`_naPrepareBackupSnapshot(${JSON.stringify(invalid)})`),
        new RegExp(`cashClosures\\[0\\]\\.${field}`),
        `${field}=${String(invalidValue)} debe rechazarse`
      );
    }
  }
});

test('T16 — id duplicado se omite al preparar el backup (dedupe)', async () => {
  const sb = freshTab();
  await openCash(sb, 100);
  await closeCash(sb, 100);
  await openCash(sb, 50);
  await closeCash(sb, 50);
  const invalid = sb.durableSnapshot();
  invalid.data.cashClosures[1].id = invalid.data.cashClosures[0].id;
  const prepared = sb.run(`_naPrepareBackupSnapshot(${JSON.stringify(invalid)})`);
  assert.equal(prepared.snapshot.data.cashClosures.length, 1);
});

test('T17 — mismo sessionId + mismo aparato se omite; distinto aparato se conserva', async () => {
  const sb = freshTab();
  await openCash(sb, 100);
  await closeCash(sb, 100);
  await openCash(sb, 50);
  await closeCash(sb, 50);
  const sameDevice = sb.durableSnapshot();
  sameDevice.data.cashClosures[1].sessionId = sameDevice.data.cashClosures[0].sessionId;
  sameDevice.data.cashClosures[0].deviceId = 'devA';
  sameDevice.data.cashClosures[1].deviceId = 'devA';
  const preparedSame = sb.run(`_naPrepareBackupSnapshot(${JSON.stringify(sameDevice)})`);
  assert.equal(preparedSame.snapshot.data.cashClosures.length, 1, 'mismo aparato + sessionId');
  const cross = sb.durableSnapshot();
  cross.data.cashClosures[1].sessionId = cross.data.cashClosures[0].sessionId;
  cross.data.cashClosures[0].deviceId = 'devA';
  cross.data.cashClosures[1].deviceId = 'devB';
  const preparedCross = sb.run(`_naPrepareBackupSnapshot(${JSON.stringify(cross)})`);
  assert.equal(preparedCross.snapshot.data.cashClosures.length, 2, 'distinto aparato, mismo sessionId');
});

test('T18 — import inválido no altera memoria, durable ni cashClosures actuales', async () => {
  const sb = freshTab();
  await openCash(sb, 100);
  await closeCash(sb, 105);
  const memoryBefore = sb.memoryState();
  const durableBefore = sb.durableSnapshot();
  const invalid = structuredClone(durableBefore);
  invalid.data.cashClosures = { corrupto: true };
  const raw = JSON.stringify(invalid);
  sb.run(`document.getElementById('backupFile').files=[{
    name:'respaldo-invalido.json',size:${raw.length},text:async()=>${JSON.stringify(raw)}
  }];`);

  await sb.run('_naSecOriginalImportBackup()');

  assert.deepEqual(sb.memoryState(), memoryBefore, 'memoria intacta');
  assert.deepEqual(sb.durableSnapshot(), durableBefore, 'durable intacto');
  assert.deepEqual(sb.memoryState().cashClosures, memoryBefore.cashClosures, 'historial intacto');
  assert.match(sb.toastText(), /cashClosures: se esperaba una lista/i, 'error explícito');
});

test('T11 — sessionId de caja estrictamente creciente aunque coincida el milisegundo', () => {
  const sb = freshTab();
  const ids = sb.run('(()=>{const realNow=Date.now;Date.now=()=>1700000000000;try{return [_naNextCashSessionId(),_naNextCashSessionId(),_naNextCashSessionId()];}finally{Date.now=realNow;}})()');
  assert.equal(new Set(Array.from(ids)).size, 3);
  assert.ok(ids[0] < ids[1] && ids[1] < ids[2]);
});
