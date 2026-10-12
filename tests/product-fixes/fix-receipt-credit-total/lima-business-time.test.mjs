// Historial y Caja en hora de Lima (America/Lima, UTC-5) aunque el equipo esté en UTC.
process.env.TZ = 'UTC';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = p => readFileSync(p, 'utf8');
function fixedDate(iso) {
  const now = new Date(iso).getTime();
  return class FixedDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  };
}
function utilsAt(iso) {
  const ctx = vm.createContext({ Date: fixedDate(iso), Intl, console });
  vm.runInContext(read('POS/js/core/utils.js') + '\n;globalThis.__diasHasta=diasHasta;', ctx);
  const before = vm.runInContext('obtenerHoy()', ctx);
  vm.runInContext(read('POS/js/core/lima-time.js'), ctx);
  return { ctx, before };
}
function extract(file, startMarker, endMarker, prelude = '') {
  const src = read(file), start = src.indexOf(startMarker), end = src.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'markers found in ' + file);
  const ctx = { String, Date, Number, out: null };
  vm.runInNewContext(`${prelude}\n${src.slice(start, end)}\nout={localParts};`, ctx);
  return ctx.out.localParts;
}

test('obtenerHoy() follows the Lima calendar day on a UTC device (V-094 at 20:25 Lima = 01:25Z)', () => {
  const { ctx, before } = utilsAt('2026-10-12T01:25:00Z');
  assert.equal(before, '2026-10-12', 'precondition: old behaviour used the device (UTC) day');
  assert.equal(vm.runInContext('obtenerHoy()', ctx), '2026-10-11');
  assert.equal(vm.runInContext('NALimaTime.today()', ctx), '2026-10-11');
  assert.equal(vm.runInContext('__diasHasta("2026-10-11")', ctx), 0, 'diasHasta uses the Lima day too');
  assert.equal(vm.runInContext('NALimaTime.shortDateLabel(new Date())', ctx), 'dom, 11 oct.');
  assert.equal(vm.runInContext('NALimaTime.timeNow()', ctx), '20:25:00');
  // Next morning in Lima, still the right day.
  const morning = utilsAt('2026-10-12T13:05:00Z');
  assert.equal(vm.runInContext('obtenerHoy()', morning.ctx), '2026-10-12');
  assert.equal(vm.runInContext('NALimaTime.shortDateLabel(new Date())', morning.ctx), 'lun, 12 oct.');
});

test('Historial: canonical sale created_at in UTC is shown in Lima date and time', () => {
  const localParts = extract('POS/js/adapters/canonical-ui-adapter.js', '  function localParts(', '  function groupBy(', 'function text(v,f){return v==null||v===""?(f||""):String(v);}');
  assert.deepEqual({ ...localParts('2026-10-12T01:25:00.000Z') }, { date: '2026-10-11', time: '20:25', timestamp: '2026-10-12T01:25:00.000Z' });
  assert.equal(localParts('2026-10-11T20:25:00-05:00').time, '20:25');
  assert.equal(localParts('2026-10-11T23:59:59Z').date, '2026-10-11');
  assert.equal(localParts('2026-10-12T04:59:59Z').date, '2026-10-11');
  assert.equal(localParts('2026-10-12T05:00:00Z').date, '2026-10-12');
  // Unzoned / date-only historical values are business wall time: verbatim.
  assert.deepEqual({ ...localParts('2026-10-11T20:25:00') }, { date: '2026-10-11', time: '20:25', timestamp: '2026-10-11T20:25:00' });
  assert.equal(localParts('2026-10-11').date, '2026-10-11');
  assert.equal(localParts('').date, '');
});

test('Caja: opened_at 20:23 Lima keeps fechaApertura = Lima day, so no false "Caja de otro día"', () => {
  const localParts = extract('POS/js/adapters/canonical-ui-adapter.js', '  function localParts(', '  function groupBy(', 'function text(v,f){return v==null||v===""?(f||""):String(v);}');
  const opened = localParts('2026-10-12T01:23:00.000Z');
  assert.equal(opened.date, '2026-10-11');
  assert.equal(opened.time, '20:23');
  const { ctx } = utilsAt('2026-10-12T01:30:00Z');
  const today = vm.runInContext('obtenerHoy()', ctx);
  assert.equal(opened.date === today, true, 'same-day till is not flagged as another day');
  // Next Lima day the same till IS another day.
  const next = utilsAt('2026-10-12T14:00:00Z');
  assert.notEqual(opened.date, vm.runInContext('obtenerHoy()', next.ctx));
});

test('pending sales (outbox view) use the same Lima conversion', () => {
  const localParts = extract('POS/js/sync/canonical-sale-view.js', '  function localParts(', '  function confirmedLegacySale(');
  assert.equal(localParts('2026-10-12T01:25:00.000Z').date, '2026-10-11');
  assert.equal(localParts('2026-10-12T01:25:00.000Z').time, '20:25');
  assert.equal(localParts('2026-10-11T20:25:00').time, '20:25');
});

test('Caja header uses the Lima label; lima-time.js loads right after utils.js and is precached', () => {
  const inline = read('POS/js/legacy-inline/inline-02.js');
  assert.match(inline, /cajFechaLbl'\);if\(label\)label\.textContent=window\.NALimaTime\?NALimaTime\.shortDateLabel\(new Date\(\)\):new Date\(\)\.toLocaleDateString\('es-PE',\{timeZone:'America\/Lima'/);
  assert.doesNotMatch(inline, /new Date\(\)\.toLocaleDateString\('es-PE',\{weekday:'short',day:'numeric',month:'short'\}\)/);
  const html = read('POS/index.html');
  assert.match(html, /<script src="js\/core\/utils\.js"><\/script>\n<script src="js\/core\/lima-time\.js"><\/script>/);
  assert.match(read('POS/sw.js'), /'\.\/js\/core\/lima-time\.js',/);
});
