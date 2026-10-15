import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createPosSandbox, json } from '../../release-invariants/lib/sandbox.mjs';
import { docHelpers } from '../../helpers/doc-helpers.mjs';

const PRODUCT = {
  id: 'P1', name: 'Arroz', sku: 'ARR-1', stock: 10, stockMin: 2,
  controlInventario: true, precio: 10, costo: 5, unidad: 'unidad',
};

function freshSale() {
  const sb = createPosSandbox();
  sb.seed();
  sb.seedData('productos', [{ ...PRODUCT }]);
  sb.run(`cart.push({
    id:'P1',name:'Arroz',sku:'ARR-1',precio:10,costo:5,qty:1,
    unitsPerQty:1,ventaModo:'unidad',unidad:'unidad',controlInventario:true,
    ventaLibre:false,ventaSinStock:false
  });`);
  return sb;
}

function countPersistence(sb) {
  sb.run(`
    globalThis._fix01PersistenceCalls=0;
    globalThis._fix01BaseSaveAllData=saveAllData;
    saveAllData=async function(...args){
      globalThis._fix01PersistenceCalls+=1;
      return await globalThis._fix01BaseSaveAllData.apply(this,args);
    };
  `);
}

function selectTransfer(sb, { verified = false, reference = '' } = {}) {
  sb.run(`posPayM='transferencia';`);
  sb.el('mDigitalVerified').checked = verified;
  sb.el('mDigitalRef').value = reference;
}

test('T1 — transferencia rápida no verificada queda bloqueada', async () => {
  const sb = freshSale();
  countPersistence(sb);
  sb.el('mQuickDigitalVerified').checked = false;
  await sb.run(`confirmarPagoRapido('transferencia')`);
  assert.equal(json(sb, 'ventas.length'), 0);
  assert.equal(json(sb, 'cajMovs.length'), 0);
  assert.equal(json(sb, '_fix01PersistenceCalls'), 0);
  assert.match(sb.toastText(), /verificar.*pago|pago.*verific/i);
});

test('T2 — el bloqueo no modifica ventas, stock, caja, carrito ni persistencia', async () => {
  const sb = freshSale();
  countPersistence(sb);
  selectTransfer(sb);
  await sb.run('confirmarVenta()');
  const state = sb.memoryState();
  assert.equal(state.ventas.length, 0);
  assert.equal(state.productos[0].stock, 10);
  assert.equal(state.cajMovs.length, 0);
  assert.equal(state.cart.length, 1);
  assert.equal(json(sb, '_fix01PersistenceCalls'), 0);
  assert.equal(sb.durableRaw(), null);
});

test('T3 — transferencia verificada sin número de operación es válida', async () => {
  const sb = freshSale();
  selectTransfer(sb, { verified: true });
  await sb.run('confirmarVenta()');
  const state = sb.memoryState();
  assert.equal(state.ventas.length, 1);
  assert.equal(state.ventas[0].paymentRef, '');
  assert.equal(state.ventas[0].paymentVerified, true);
  assert.equal(state.productos[0].stock, 9);
  assert.equal(state.cajMovs.length, 1);
});

test('T4 — transferencia verificada preserva el número de operación', async () => {
  const sb = freshSale();
  selectTransfer(sb, { verified: true, reference: 'OP-778899' });
  await sb.run('confirmarVenta()');
  const sale = sb.memoryState().ventas[0];
  assert.equal(sale.paymentRef, 'OP-778899');
  assert.equal(sale.operation, 'OP-778899');
});

test('T5 — paymentVerified persiste como true solo en la venta digital válida', async () => {
  const sb = freshSale();
  selectTransfer(sb, { verified: true });
  await sb.run('confirmarVenta()');
  const durable = sb.durableSnapshot();
  assert.equal(durable?.data?.ventas?.[0]?.paymentVerified, true);
  assert.equal(durable?.data?.ventas?.[0]?.paymentRef, '');
});

test('T6 — efectivo funciona sin confirmación digital y no inventa paymentVerified', async () => {
  const sb = freshSale();
  sb.run(`posPayM='efectivo';`);
  sb.el('mMontoRec').value = '10';
  sb.el('mDigitalVerified').checked = false;
  sb.el('mMixedDigitalVerified').checked = false;
  await sb.run('confirmarVenta()');
  const sale = sb.memoryState().ventas[0];
  assert.equal(sale.metodo, 'efectivo');
  assert.equal(Object.hasOwn(sale, 'paymentVerified'), false);
});

test('T7 — pago mixto exige verificación digital y luego conserva su flujo', async () => {
  const sb = freshSale();
  sb.run(`posPayM='mixto';`);
  sb.el('mMixedCash').value = '4';
  sb.el('mMixedDigitalMethod').value = 'yape';
  sb.el('mMixedRef').value = '';
  sb.el('mMixedDigitalVerified').checked = false;
  await sb.run('confirmarVenta()');
  assert.equal(json(sb, 'ventas.length'), 0);
  assert.equal(sb.memoryState().productos[0].stock, 10);

  sb.el('mMixedDigitalVerified').checked = true;
  await sb.run('confirmarVenta()');
  const sale = sb.memoryState().ventas[0];
  assert.equal(sale.metodo, 'mixto');
  assert.equal(sale.paymentVerified, true);
  assert.equal(sale.paymentRef, '');
  assert.deepEqual(sale.paymentBreakdown, {
    efectivo: 4, digital: 6, digitalMethod: 'yape', reference: '',
  });
});

test('T8 — un intento bloqueado no abre ni imprime comprobante', async () => {
  const sb = freshSale();
  selectTransfer(sb);
  sb.run(`
    appConfig.printAuto=true;
    globalThis._fix01TicketOpens=0;
    globalThis._fix01Prints=0;
    globalThis.verTicket=()=>{globalThis._fix01TicketOpens+=1;};
    globalThis.imprimirTicket=()=>{globalThis._fix01Prints+=1;};
  `);
  await sb.run('confirmarVenta()');
  assert.equal(json(sb, '_fix01TicketOpens'), 0);
  assert.equal(json(sb, '_fix01Prints'), 0);
});

test('T9 — el ticket no presenta un ID interno como operación bancaria', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const moduleSource = name => readFileSync(path.join(root, 'POS', 'js', 'modules', 'ticket', name), 'utf8');
  const context = vm.createContext({ ...docHelpers,
    appConfig: {
      igvActive: false,
      ticket: {
        ancho: '58mm', layoutMode: 'auto', pie: 'GRACIAS POR SU COMPRA',
        showLogo: true, showNum: true, showOperation: true, showIGV: false,
        showCurrency: true, showUnitPrice: true, showPayment: true,
        showReceived: true, showSep: true,
      },
      printer: {},
    },
    _naDefaults: { ticket: {} },
    _naSaveTicketSettings() {},
    _naHydrateTicket() {},
    _naGetBusiness: () => ({ nombre: 'NUEVO AMANECER', ruc: '', direccion: '', telefono: '' }),
    obtenerHoy: () => '2026-08-28',
    nowT: () => '10:30',
    totalV: sale => (sale.items || []).reduce((sum, item) => sum + Number(item.qty) * Number(item.precio), 0),
    desglosarIGV: total => ({ subtotal: total / 1.18, igv: total - total / 1.18 }),
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelectorAll() { return []; },
    },
    navigator: { userAgent: '', serial: null },
    console,
  });
  for (const name of ['legacy.js', 'overrides.js', 'zones.js', 'secure-print.js']) {
    new vm.Script(moduleSource(name), { filename: name }).runInContext(context);
  }
  const withoutReference = JSON.parse(vm.runInContext(`JSON.stringify(_naBuildThermalTicket({
    id:'V-42',operation:'00000042',paymentRef:'',fecha:'2026-08-28',hora:'10:30',
    cajero:'Eliser',metodo:'transferencia',items:[{name:'Arroz',qty:1,precio:10}]
  },false))`, context));
  assert.equal(vm.runInContext(`_naTkOperation({id:'V-42',operation:'00000042',paymentRef:''})`, context), '');
  assert.equal(withoutReference.text.includes('00000042'), false);

  const withReference = JSON.parse(vm.runInContext(`JSON.stringify(_naBuildThermalTicket({
    id:'V-43',operation:'BANK-43',paymentRef:'BANK-43',fecha:'2026-08-28',hora:'10:30',
    cajero:'Eliser',metodo:'transferencia',items:[{name:'Arroz',qty:1,precio:10}]
  },false))`, context));
  assert.match(withReference.text, /BANK-43/);
});

test('T10 — una transferencia rápida verificada persiste exactamente una vez', async () => {
  const sb = freshSale();
  countPersistence(sb);
  sb.el('mQuickDigitalVerified').checked = true;
  await sb.run(`confirmarPagoRapido('transferencia')`);
  assert.equal(json(sb, 'ventas.length'), 1);
  assert.equal(json(sb, 'cajMovs.length'), 1);
  assert.equal(json(sb, '_fix01PersistenceCalls'), 1);
  assert.equal(sb.memoryState().ventas[0].paymentVerified, true);
});
