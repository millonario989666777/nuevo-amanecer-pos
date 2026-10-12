// FIX03 — REVERSIÓN SEGURA DE PAGO DE CRÉDITO
//
// T1  pago parcial → reversión restaura saldo exacto
// T2  pago total → reversión vuelve a abrir el saldo correctamente
// T3  pago original permanece en historial marcado como REVERTED (y visible en el render winner)
// T4  reversal queda enlazado al pago original (reversalId ↔ reversalOf)
// T5  efectivo → movimiento inverso de caja exactamente una vez, cob original intacto
// T6  pago digital conserva identidad/referencia sin inventar datos
// T7  doble reversión bloqueada / idempotente
// T8  fallo de persistencia → crédito, historial y caja vuelven al estado previo
// T9  pago antiguo sin campos nuevos sigue cargando y puede revertirse
// T10 tras revertir se registra el pago correcto y el saldo final es exacto
// T11 no se puede revertir un pago de otro crédito (ID inconsistente)
// T12 operación sana persiste crédito + reversal + caja en un único snapshot V9 (con round-trip de respaldo)
// T13 dos invocaciones concurrentes con confirmación demorada → exactamente una reversión
// T14 cancelar confirmación libera el lock y permite un intento posterior
// T15 cobro de crédito y reversal el mismo día → cobradoHoy neto = 0
// T16 reversals ajenos y otros egresos no reducen cobradoHoy de créditos
// T17 pago y reversal en días distintos se atribuyen a sus fechas respectivas

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPosSandbox, json } from './lib/sandbox.mjs';

function freshTab() {
  const sb = createPosSandbox();
  sb.seed();
  sb.seedData('clientes', [{
    id: 1001,
    nombre: 'Cliente Prueba',
    color: 1,
    lineaCreditoManualActiva: true,
    lineaCreditoManual: 1000,
  }]);
  return sb;
}

async function openCash(sb, fondo) {
  sb.el('cajFondo').value = String(fondo);
  sb.el('cajCajero').value = 'CAJ-001';
  return sb.run('abrirCaja()');
}

async function createCredit(sb, amount, desc = 'Crédito de prueba') {
  sb.run('cliCredId=String(clientes[0].id);');
  sb.el('crDesc').value = desc;
  sb.el('crMonto').value = String(amount);
  sb.el('crVence').value = '2099-12-31';
  sb.el('crTipo').value = 'venta';
  await sb.run('guardarCred()');
  const created = json(sb, 'creditos.length');
  assert.equal(created, 1, 'el crédito se registró');
  return json(sb, 'creditos[0]');
}

async function payCredit(sb, amount, method = 'efectivo', operation = '') {
  sb.run('pagoCredId=String(creditos[0].id);');
  sb.el('pagoMonto').value = String(amount);
  sb.el('pagoMetodo').value = method;
  sb.el('pagoOperacion').value = operation;
  await sb.run('confirmarPago()');
  // El historial se ordena por timestamp ascendente: el pago recién registrado es el último.
  return json(sb, 'creditos[0].pagos[creditos[0].pagos.length-1].pagoId');
}

async function revertPayment(sb, creditoId, pagoId) {
  await sb.run(`revertirPagoCredito(${JSON.stringify(String(creditoId))}, ${JSON.stringify(String(pagoId))})`);
}

function reversalMoves(sb) {
  return json(sb, 'cajMovs').filter((move) => move.reversal === true);
}

test('T1 — pago parcial → la reversión restaura el saldo exacto', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const pagoId = await payCredit(sb, 100);
  assert.equal(json(sb, 'creditos[0].saldo'), 100, 'saldo tras el pago');
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  assert.equal(json(sb, 'creditos[0].pagado'), 0, 'pagado vuelve a 0');
  assert.equal(json(sb, 'creditos[0].saldo'), 200, 'saldo restaurado a 200');
  assert.equal(json(sb, '_naCreditOutstanding(creditos[0])'), 200);
  assert.equal(json(sb, 'creditos[0].pagos[0].monto'), 100, 'monto histórico del pago original intacto');
  assert.equal(reversalMoves(sb).length, 1, 'existe exactamente un movimiento de reversión');
  assert.match(sb.toastText(), /revertido · Saldo/i);
});

test('T2 — pago total → la reversión vuelve a abrir el saldo correctamente', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const pagoId = await payCredit(sb, 200);
  assert.equal(json(sb, 'creditos[0].status'), 'cancelado', 'crédito quedó pagado');
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  assert.equal(json(sb, 'creditos[0].pagado'), 0);
  assert.equal(json(sb, 'creditos[0].saldo'), 200, 'saldo reabierto en 200');
  assert.equal(json(sb, '_naSyncCreditStatus(creditos[0])'), 'vigente', 'el crédito deja de estar cancelado');
  assert.equal(json(sb, '_naCreditOutstanding(creditos[0])'), 200);
});

test('T3 — el pago original permanece en el historial, marcado y sin botón de reversión', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const pagoId = await payCredit(sb, 100);
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  const pagos = json(sb, 'creditos[0].pagos');
  assert.equal(pagos.length, 1, 'no se agregó una segunda fuente de verdad al historial de pagos');
  assert.equal(pagos[0].pagoId, pagoId, 'el pago original sigue siendo el mismo registro');
  assert.equal(pagos[0].monto, 100, 'el monto histórico no se editó');
  assert.equal(pagos[0].status, 'REVERTED');
  assert.ok(pagos[0].reversalId, 'el pago original queda enlazado a su reversión');
  assert.equal(json(sb, 'creditos[0].pagos[0].status'), 'REVERTED');
  // El render winner (abrirDetalleCredito de inline-12) muestra la marca y NO ofrece revertir de nuevo.
  sb.run('abrirDetalleCredito(String(creditos[0].id))');
  const text = sb.renderText();
  assert.match(text, /REVERTIDO/, 'el historial renderizado marca el pago como revertido');
  assert.doesNotMatch(text, /Revertir pago/, 'no se ofrece revertir un pago ya revertido');
});

test('T4 — la reversión queda enlazada al pago original (reversalId ↔ reversalOf)', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const pagoId = await payCredit(sb, 100);
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  const [reversal] = reversalMoves(sb);
  assert.ok(reversal, 'existe el movimiento de reversión');
  assert.equal(reversal.reversalOf, pagoId, 'reversalOf apunta al pagoId original');
  assert.equal(reversal.tipo, 'egr');
  assert.equal(reversal.creditoId, json(sb, 'creditos[0].id'), 'enlazada al crédito correcto');
  assert.equal(json(sb, 'creditos[0].pagos[0].reversalId'), reversal.pagoId, 'el pago original referencia a la reversión');
  assert.ok(reversal.timestamp, 'la reversión lleva timestamp');
});

test('T5 — efectivo: movimiento inverso de caja exactamente una vez, cob original intacto', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const pagoId = await payCredit(sb, 100, 'efectivo');
  const cobBefore = json(sb, 'cajMovs').find((move) => move.tipo === 'cob' && move.pagoId === pagoId);
  assert.ok(cobBefore, 'el cobro original está en caja');
  assert.equal(json(sb, 'cajTotales().ef'), 200, 'efectivo esperado tras el pago');
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  const moves = reversalMoves(sb);
  assert.equal(moves.length, 1, 'exactamente una reversión de caja');
  assert.equal(moves[0].monto, 100);
  assert.equal(moves[0].efectivo, 100, 'la reversión de efectivo sale en efectivo');
  assert.equal(moves[0].digital, 0);
  assert.equal(moves[0].tipo, 'egr');
  const cobAfter = json(sb, 'cajMovs').find((move) => move.tipo === 'cob' && move.pagoId === pagoId);
  assert.deepEqual(cobAfter, cobBefore, 'el movimiento original de cobro NO se tocó');
  assert.equal(json(sb, 'cajTotales().ef'), 100, 'el efectivo esperado vuelve al fondo inicial');
});

test('T6 — pago digital: conserva identidad/referencia sin inventar datos', async () => {
  const sb = freshTab();
  await createCredit(sb, 200);
  const operation = 'OP-998877';
  const pagoId = await payCredit(sb, 60, 'yape', operation);
  const cobBefore = json(sb, 'cajMovs').find((move) => move.tipo === 'cob' && move.pagoId === pagoId);
  assert.ok(cobBefore, 'el cobro digital original está en caja');
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  const [reversal] = reversalMoves(sb);
  assert.ok(reversal, 'existe la reversión de caja para el pago digital');
  assert.equal(reversal.monto, 60);
  assert.equal(reversal.efectivo, 0, 'una reversión digital no inventa efectivo');
  assert.equal(reversal.digital, 60);
  assert.equal(reversal.metodo, 'yape');
  assert.equal(reversal.referencia, operation, 'la referencia es la misma operación del pago original');
  assert.equal(reversal.numeroOperacion, operation);
  const cobAfter = json(sb, 'cajMovs').find((move) => move.tipo === 'cob' && move.pagoId === pagoId);
  assert.deepEqual(cobAfter, cobBefore, 'el cobro digital original permanece intacto');
  assert.equal(json(sb, 'creditos[0].saldo'), 200);
});

test('T7 — doble reversión bloqueada / idempotente', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const pagoId = await payCredit(sb, 100);
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  const pagosBefore = json(sb, 'creditos[0].pagos');
  const movesBefore = json(sb, 'cajMovs');
  const saldoBefore = json(sb, 'creditos[0].saldo');
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  assert.match(sb.toastText(), /ya fue revertido/i, 'la segunda operación se bloquea con mensaje explícito');
  assert.deepEqual(json(sb, 'creditos[0].pagos'), pagosBefore, 'el historial no cambia');
  assert.deepEqual(json(sb, 'cajMovs'), movesBefore, 'caja no se duplica');
  assert.equal(json(sb, 'creditos[0].saldo'), saldoBefore, 'el saldo no cambia');
  assert.equal(reversalMoves(sb).length, 1, 'no hay segunda reversión');
});

test('T8 — fallo de persistencia → rollback completo de crédito, historial y caja', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const pagoId = await payCredit(sb, 100);
  await sb.run('saveAllData()');
  const memoryBefore = sb.memoryState();
  const durableBefore = sb.durableSnapshot();
  sb.breakPersistent();
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  sb.restorePersistent();
  const memoryAfter = sb.memoryState();
  assert.deepEqual(memoryAfter.creditos, memoryBefore.creditos, 'el crédito vuelve al estado previo');
  assert.deepEqual(memoryAfter.cajMovs, memoryBefore.cajMovs, 'caja vuelve al estado previo');
  assert.equal(memoryAfter.creditos[0].pagos[0].status, undefined, 'sin marca REVERTED residual en memoria');
  const durableAfter = sb.durableSnapshot();
  assert.deepEqual(durableAfter.data, durableBefore.data, 'el durable (sección data) es idéntico al previo');
  assert.match(sb.toastText(), /No se revertió el pago/i, 'fallo informado');
  // Sin residuos: con persistencia sana la reversión procede una sola vez.
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  assert.equal(json(sb, 'creditos[0].saldo'), 200, 'tras reintento sano el saldo queda restaurado');
  assert.equal(reversalMoves(sb).length, 1, 'existe exactamente una reversión tras el reintento');
});

test('T9 — pago antiguo sin campos nuevos sigue cargando y puede revertirse', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  // Simula un crédito con pago registrado por una versión anterior: sin status/reversalId/reversalAt/reversalReason.
  const legacyTimestamp = '2026-01-10T10:00:00.000Z';
  const legacyCredit = {
    id: 2001,
    cliId: 1001,
    clienteId: 1001,
    clienteNombre: 'Cliente Prueba',
    desc: 'Crédito legacy',
    monto: 200,
    pagado: 80,
    saldo: 120,
    vence: '2099-12-31',
    fecha: '2026-01-10',
    hora: '10:00',
    hora24: '10:00',
    timestamp: legacyTimestamp,
    anulado: false,
    status: 'vigente',
    pagos: [{
      id: 'P-LEGACY-1',
      pagoId: 'P-LEGACY-1',
      creditoId: 2001,
      clienteId: 1001,
      clienteNombre: 'Cliente Prueba',
      monto: 80,
      montoPagado: 80,
      saldoAnterior: 200,
      saldoActual: 120,
      fecha: '2026-01-10',
      hora: '10:00',
      hora24: '10:00',
      timestamp: legacyTimestamp,
      metodo: 'efectivo',
      operacion: '',
      numeroOperacion: '',
      referencia: '',
      cajero: 'Frank',
      cajeroNombre: 'Frank',
      cajeroId: 'CAJ-001',
    }],
    items: [{ itemKey: 'concepto:0', productoId: null, nombre: 'Crédito legacy', cantidad: 1, precioUnitario: 200, subtotal: 200, modo: 'concepto' }],
  };
  sb.seedData('creditos', [legacyCredit]);
  await sb.run('saveAllData()');
  assert.equal(sb.run('_naApplySnapshot(_naParseStoredSnapshot(storage.readPersistent(_NA_LOCAL_KEY)))'), true, 'el snapshot con pago legacy carga');
  assert.equal(json(sb, 'creditos[0].pagado'), 80, 'el pago legacy sigue contando');
  assert.equal(sb.run('creditos[0].pagos[0].status===undefined'), true, 'sin campos nuevos');
  sb.run('cliRender()');
  assert.equal(json(sb, 'creditos[0].pagado'), 80, 'normalize no altera el pago legacy');
  await revertPayment(sb, '2001', 'P-LEGACY-1');
  assert.equal(json(sb, 'creditos[0].saldo'), 200, 'la reversión del pago legacy restaura el saldo');
  assert.equal(json(sb, 'creditos[0].pagos[0].status'), 'REVERTED', 'el pago legacy queda marcado');
  assert.equal(reversalMoves(sb).length, 1, 'reversión de caja única para el pago legacy');
});

test('T10 — tras revertir puede registrarse el pago correcto y el saldo final es exacto', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const wrongPagoId = await payCredit(sb, 100);
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), wrongPagoId);
  assert.equal(json(sb, 'creditos[0].saldo'), 200);
  const correctPagoId = await payCredit(sb, 60, 'efectivo');
  assert.equal(json(sb, 'creditos[0].pagado'), 60, 'solo el pago correcto cuenta');
  assert.equal(json(sb, 'creditos[0].saldo'), 140, 'saldo final exacto: 200 - 60');
  const pagos = json(sb, 'creditos[0].pagos');
  assert.equal(pagos.length, 2);
  assert.equal(pagos[0].status, 'REVERTED');
  assert.equal(pagos[0].monto, 100, 'el pago incorrecto conserva su monto histórico');
  assert.equal(pagos[1].pagoId, correctPagoId);
  assert.equal(pagos[1].monto, 60);
  assert.ok(Array.isArray(pagos[1].desgloseProductos) && pagos[1].desgloseProductos.length, 'el pago correcto tiene desglose');
  assert.equal(reversalMoves(sb).length, 1, 'una sola reversión en caja');
  // El render winner ofrece revertir solo el pago activo y mantiene la marca del revertido.
  sb.run('abrirDetalleCredito(String(creditos[0].id))');
  const text = sb.renderText();
  assert.match(text, /REVERTIDO/);
  assert.match(text, /Revertir pago/, 'el pago vigente puede revertirse desde el historial');
  sb.run('cliRender()');
  assert.equal(json(sb, 'creditos[0].pagado'), 60, 'normalize mantiene el estado tras re-render');
  assert.equal(json(sb, 'creditos[0].saldo'), 140);
});

test('T11 — no se puede revertir un pago de otro crédito por ID inconsistente', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200, 'Crédito A');
  const pagoIdA = await payCredit(sb, 100);
  // Crédito B sin pagos.
  sb.run('clientes.push({id:1002,nombre:"Cliente Dos",color:2,lineaCreditoManualActiva:true,lineaCreditoManual:1000})');
  sb.run('cliCredId="1002";');
  sb.el('crDesc').value = 'Crédito B';
  sb.el('crMonto').value = '150';
  sb.el('crVence').value = '2099-12-31';
  sb.el('crTipo').value = 'venta';
  await sb.run('guardarCred()');
  assert.equal(json(sb, 'creditos.length'), 2);
  const creditoAId = json(sb, 'String(creditos[0].id)');
  const creditoBId = json(sb, 'String(creditos[1].id)');
  const movesBefore = json(sb, 'cajMovs');
  // Revertir el pago del crédito A usando el ID del crédito B → bloqueado.
  await revertPayment(sb, creditoBId, pagoIdA);
  assert.match(sb.toastText(), /No se encontró el pago en este crédito/i);
  assert.deepEqual(json(sb, 'cajMovs'), movesBefore, 'caja intacta');
  assert.equal(json(sb, 'creditos[1].pagos.length'), 0, 'el crédito B sigue sin pagos');
  // Relación inconsistente: un pago cuyo creditoId apunta a otro crédito.
  sb.run(`creditos[1].pagos.push({id:'P-FOREIGN',pagoId:'P-FOREIGN',creditoId:'OTRO-CREDITO',clienteId:1002,clienteNombre:'Cliente Dos',monto:50,montoPagado:50,saldoAnterior:150,saldoActual:100,fecha:obtenerHoy(),hora:nowT(),hora24:_naTime24(new Date()),timestamp:new Date().toISOString(),metodo:'efectivo',operacion:'',numeroOperacion:'',referencia:'',cajero:'Frank',cajeroNombre:'Frank',cajeroId:'CAJ-001'});`);
  await revertPayment(sb, creditoBId, 'P-FOREIGN');
  assert.match(sb.toastText(), /no pertenece a este crédito/i, 'la relación crédito↔pago se valida');
  assert.equal(sb.run('creditos[1].pagos[0].status===undefined'), true, 'el pago inconsistente no fue marcado');
  assert.equal(json(sb, 'creditos[0].pagos[0].pagoId'), pagoIdA, 'el pago del crédito A sigue intacto');
});

test('T12 — operación sana persiste crédito + reversal + caja en un único snapshot V9', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const pagoId = await payCredit(sb, 100);
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  assert.equal(await sb.run('saveAllData()').then(() => true), true);
  const durable = sb.durableSnapshot();
  assert.ok(durable, 'existe snapshot durable');
  assert.equal(durable.version, 9, 'snapshot V9 único');
  const persistedPayment = durable.data.creditos[0].pagos[0];
  assert.equal(persistedPayment.status, 'REVERTED', 'la marca persiste en el snapshot');
  assert.ok(persistedPayment.reversalId, 'el enlace de reversión persiste');
  const persistedReversal = durable.data.cajMovs.find((move) => move.reversal === true);
  assert.ok(persistedReversal, 'la reversión de caja persiste en el snapshot');
  assert.equal(persistedReversal.reversalOf, pagoId);
  assert.equal(persistedPayment.reversalId, persistedReversal.pagoId);
  assert.equal(durable.data.creditos[0].pagado, 0, 'el saldo restaurado persiste');
  // Round-trip de respaldo: el sanitizador V9 preserva la reversión y recarga consistente.
  const prepared = sb.run(`_naPrepareBackupSnapshot(${JSON.stringify(durable)})`);
  const backupPayment = prepared.snapshot.data.creditos[0].pagos[0];
  assert.equal(backupPayment.status, 'REVERTED', 'el respaldo conserva status REVERTED');
  assert.equal(backupPayment.reversalId, persistedPayment.reversalId, 'el respaldo conserva el reversalId');
  const backupReversal = prepared.snapshot.data.cajMovs.find((move) => move.reversal === true);
  assert.ok(backupReversal && backupReversal.reversalOf === pagoId, 'el respaldo conserva el movimiento de reversión');
  assert.equal(sb.run(`_naApplySnapshot(${JSON.stringify(prepared.snapshot)})`), true, 'el respaldo con reversión recarga');
  assert.equal(json(sb, 'creditos[0].pagos[0].status'), 'REVERTED', 'tras recargar la marca sigue');
  assert.equal(json(sb, 'creditos[0].saldo'), 200, 'tras recargar el saldo sigue restaurado');
  sb.run('cliRender()');
  assert.equal(json(sb, 'creditos[0].pagado'), 0, 'normalize no revive pagos revertidos');
  assert.equal(json(sb, 'creditos[0].saldo'), 200);
});

test('T13 — dos invocaciones concurrentes con confirmación demorada crean exactamente una reversión', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const pagoId = await payCredit(sb, 100);
  const creditoId = json(sb, 'String(creditos[0].id)');
  sb.run(`
    globalThis.__fix03ConfirmCalls=0;
    globalThis.__fix03ResolveConfirm=null;
    _naConfirmAction=()=>{
      globalThis.__fix03ConfirmCalls++;
      return new Promise(resolve=>{globalThis.__fix03ResolveConfirm=resolve;});
    };
  `);

  const first = sb.run(`revertirPagoCredito(${JSON.stringify(creditoId)},${JSON.stringify(pagoId)})`);
  assert.equal(sb.run('__fix03ConfirmCalls'), 1, 'el primer intento abrió una confirmación');
  assert.equal(sb.run('pagoRevProc'), true, 'el lock ya está tomado mientras espera confirmación');
  const second = sb.run(`revertirPagoCredito(${JSON.stringify(creditoId)},${JSON.stringify(pagoId)})`);
  assert.equal(sb.run('__fix03ConfirmCalls'), 1, 'el segundo intento no abre otra confirmación');
  sb.run('__fix03ResolveConfirm(true)');
  await Promise.all([first, second]);

  const reversals = reversalMoves(sb);
  assert.equal(reversals.length, 1, 'solo existe una reversión');
  assert.equal(json(sb, 'cajTotales().ef'), 100, 'caja recibió un único efecto inverso');
  assert.equal(json(sb, 'creditos[0].pagado'), 0);
  assert.equal(json(sb, 'creditos[0].saldo'), 200, 'saldo exacto tras una sola reversión');
  const reversalIds = json(sb, 'creditos[0].pagos.map(pay=>pay.reversalId).filter(Boolean)');
  assert.deepEqual(reversalIds, [reversals[0].pagoId], 'hay un solo reversalId y enlaza el único movimiento');
  const durable = sb.durableSnapshot();
  assert.equal(durable.data.creditos[0].saldo, 200, 'durable conserva el saldo correcto');
  assert.equal(durable.data.creditos[0].pagos[0].reversalId, reversals[0].pagoId, 'durable conserva un solo enlace');
  assert.equal(durable.data.cajMovs.filter((move) => move.reversal === true).length, 1, 'durable conserva una sola reversión');
  assert.equal(sb.run('pagoRevProc'), false, 'el lock queda liberado al finalizar');
});

test('T14 — cancelar la primera confirmación libera el lock y permite una reversión posterior', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const pagoId = await payCredit(sb, 100);
  const creditoId = json(sb, 'String(creditos[0].id)');
  const before = sb.memoryState();
  sb.run('_naConfirmAction=async()=>false');
  await revertPayment(sb, creditoId, pagoId);
  assert.equal(sb.run('pagoRevProc'), false, 'cancelar libera el lock');
  assert.deepEqual(sb.memoryState().creditos, before.creditos, 'cancelar no muta el crédito');
  assert.deepEqual(sb.memoryState().cajMovs, before.cajMovs, 'cancelar no muta caja');
  assert.equal(reversalMoves(sb).length, 0);

  sb.run('_naConfirmAction=async()=>true');
  await revertPayment(sb, creditoId, pagoId);
  assert.equal(reversalMoves(sb).length, 1, 'un intento posterior normal sí puede revertir');
  assert.equal(json(sb, 'creditos[0].saldo'), 200);
  assert.equal(sb.run('pagoRevProc'), false);
});

test('T15 — cobro de crédito y reversal el mismo día dejan cobradoHoy neto en 0', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const pagoId = await payCredit(sb, 100);
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  sb.run('cliRender()');
  assert.equal(json(sb, 'cobradoHoy'), 0, 'el flujo diario suma +100 y -100');
  assert.equal(sb.el('cliS3').textContent, 'S/0.00', 'el winner visible muestra el neto');
  assert.equal(json(sb, 'cajMovs.filter(move=>move.tipo==="cob").length'), 1, 'el cobro original sigue trazable');
});

test('T16 — reversal de venta y otros egresos no reducen cobradoHoy de créditos', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  await payCredit(sb, 100);
  sb.run(`
    cajMovs.push(
      {id:'SALE-REV-1',tipo:'egr',monto:100,efectivo:100,fecha:obtenerHoy(),reversal:true,reversalOf:'SALE-1',ventaId:'SALE-1',pagoId:'SALE-REV-1'},
      {id:'EGR-OTHER-1',tipo:'egr',monto:25,efectivo:25,fecha:obtenerHoy(),cat:'Retiro',pagoId:'EGR-OTHER-1'}
    );
    cliRender();
  `);
  assert.equal(json(sb, 'cobradoHoy'), 100, 'solo cuenta el cobro de crédito; no descuenta movimientos ajenos');
  assert.equal(sb.el('cliS3').textContent, 'S/100.00');
});

test('T17 — pago y reversal en fechas distintas afectan solo el día correspondiente', async () => {
  const sb = freshTab();
  assert.equal(await openCash(sb, 100), true);
  await createCredit(sb, 200);
  const pagoId = await payCredit(sb, 100);
  const pastDate = '2026-01-10';
  const pastTimestamp = '2026-01-10T10:00:00.000Z';
  sb.run(`
    creditos[0].pagos[0].fecha=${JSON.stringify(pastDate)};
    creditos[0].pagos[0].timestamp=${JSON.stringify(pastTimestamp)};
    const original=cajMovs.find(move=>move.tipo==='cob'&&move.pagoId===${JSON.stringify(pagoId)});
    original.fecha=${JSON.stringify(pastDate)};
    original.timestamp=${JSON.stringify(pastTimestamp)};
  `);
  await revertPayment(sb, json(sb, 'String(creditos[0].id)'), pagoId);
  const today = json(sb, 'obtenerHoy()');
  assert.notEqual(today, pastDate, 'la fecha histórica usada por el test es distinta de hoy');
  sb.run('cliRender()');
  assert.equal(json(sb, `_naCreditCollectionsNetForDate(${JSON.stringify(pastDate)})`), 100, 'el día original conserva su cobro');
  assert.equal(json(sb, `_naCreditCollectionsNetForDate(${JSON.stringify(today)})`), -100, 'el día del reversal recibe el efecto inverso');
  assert.equal(json(sb, 'cobradoHoy'), -100, 'el winner actual refleja únicamente el flujo de hoy');
  const original = json(sb, `cajMovs.find(move=>move.tipo==='cob'&&move.pagoId===${JSON.stringify(pagoId)})`);
  assert.equal(original.fecha, pastDate, 'el movimiento histórico no cambia de fecha');
  assert.equal(original.monto, 100, 'el monto histórico permanece intacto');
});
