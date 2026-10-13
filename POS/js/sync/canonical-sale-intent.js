(function (root) {
  'use strict';

  var VERSION = 1;
  var METHODS = ['efectivo', 'yape', 'plin', 'transferencia', 'credito', 'mixto'];
  var DIGITAL = ['yape', 'plin', 'transferencia'];

  function fail(code) {
    var error = new Error(code);
    error.code = code;
    throw error;
  }

  function nonEmptyString(value, code) {
    if (typeof value !== 'string' || !value.trim()) fail(code);
    return value.trim();
  }

  function stableId(value, prefix, code) {
    return value === undefined || value === null || value === ''
      ? prefix + root.crypto.randomUUID()
      : nonEmptyString(value, code);
  }

  function boundedText(value, max, code, optional) {
    if (value === undefined || value === null || String(value).trim() === '') {
      if (optional) return '';
      fail(code);
    }
    var out = String(value).trim().replace(/\s+/g, ' ');
    if (out.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(out)) fail(code);
    return out;
  }

  function cents(value, code) {
    if (!Number.isSafeInteger(value) || value < 0) fail(code);
    return value;
  }

  // Local POS prices are expressed in soles. Accept them only when they map
  // exactly to integer cents; never use rounding to repair ambiguous values.
  function solesToCents(value, code) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(code);
    // Comparing with the canonical two-decimal representation avoids binary
    // floating point artifacts such as 1.15 * 100 becoming 114.999999999.
    var twoDecimals = Number(value.toFixed(2));
    if (twoDecimals !== value) fail(code);
    var scaled = Number(twoDecimals.toFixed(2).replace('.', ''));
    if (!Number.isSafeInteger(scaled)) fail(code);
    return scaled;
  }

  function amount(source, centsKey, solesKey, code) {
    if (Object.prototype.hasOwnProperty.call(source, centsKey)) return cents(source[centsKey], code);
    if (Object.prototype.hasOwnProperty.call(source, solesKey)) return solesToCents(source[solesKey], code);
    fail(code);
  }

  function validDue(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var d = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }

  function build(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INPUT_INVALID');
    if (input.ventaLibre === true) fail('VENTA_LIBRE_UNSUPPORTED');
    if (input.ventaModo === 'caja') fail('VENTA_MODO_CAJA_UNSUPPORTED');
    if (input.ventaSinStock === true) fail('VENTA_SIN_STOCK');
    if (input.unidadesSinStock !== undefined && Number(input.unidadesSinStock) > 0) fail('STOCK_NEGATIVO');

    var itemsInput = input.items || input.carrito;
    if (!Array.isArray(itemsInput) || itemsInput.length === 0) fail('ITEMS_INVALID');
    var seen = new Set();
    var items = itemsInput.map(function (item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('ITEM_INVALID');
      if (item.ventaModo === 'caja' || item.modo === 'mayorista') fail('VENTA_MODO_CAJA_UNSUPPORTED');
      if (item.unitsPerQty !== undefined && item.unitsPerQty !== 1) fail('UNITS_PER_QTY_UNSUPPORTED');
      if (item.ventaSinStock === true) fail('VENTA_SIN_STOCK');
      if (item.unidadesSinStock !== undefined && Number(item.unidadesSinStock) > 0) fail('STOCK_NEGATIVO');
      if (item.generic_line !== undefined && (!item.generic_line || typeof item.generic_line !== 'object' || Array.isArray(item.generic_line))) fail('GENERIC_LINE_INVALID');
      var generic = item.ventaLibre === true || item.generic_line !== undefined;
      var productId = generic
        ? stableId(item.generic_product_id !== undefined ? item.generic_product_id :
            (item.canonicalGenericId !== undefined ? item.canonicalGenericId : item.product_id), 'GENERIC:', 'GENERIC_ID_INVALID')
        : nonEmptyString(item.product_id !== undefined ? item.product_id : item.productId, 'PRODUCT_ID_INVALID');
      if (generic && (productId.length > 160 || productId.slice(0, 8) !== 'GENERIC:' || /[\u0000-\u001f\u007f-\u009f]/.test(productId))) fail('GENERIC_ID_INVALID');
      seen.add(productId);
      var quantity = item.quantity !== undefined ? item.quantity : item.cantidad;
      if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) fail('QUANTITY_INVALID');
      if (generic && (!Number.isSafeInteger(quantity) || quantity > 9999)) fail('GENERIC_QUANTITY_INVALID');
      var unitPrice;
      if (Object.prototype.hasOwnProperty.call(item, 'unit_price_cents') || Object.prototype.hasOwnProperty.call(item, 'unit_price')) {
        unitPrice = amount(item, 'unit_price_cents', 'unit_price', 'PRICE_INVALID');
      } else {
        // Local cart rows may carry their effective price as precio/precioUnitario (soles).
        unitPrice = solesToCents(item.precio !== undefined ? item.precio : item.precioUnitario, 'PRICE_INVALID');
      }
      if (generic && unitPrice <= 0) fail('PRICE_INVALID');
      var rawLine = quantity * unitPrice;
      if (!Number.isSafeInteger(rawLine)) fail('TOTAL_UNSAFE');
      var lineTotal = item.line_total_cents === undefined ? rawLine : cents(item.line_total_cents, 'TOTAL_UNSAFE');
      if (lineTotal !== rawLine) fail('LINE_TOTAL_MISMATCH');
      var out = { product_id: productId, quantity: quantity, unit_price_cents: unitPrice, line_total_cents: lineTotal };
      if (generic) {
        var genericMeta = item.generic_line || null;
        out.generic_line = {
          name: boundedText(genericMeta ? genericMeta.name : (item.name !== undefined ? item.name : item.nombre), 240, 'GENERIC_NAME_INVALID', false),
          code: boundedText(genericMeta ? genericMeta.code : (item.codigoIngresado !== undefined ? item.codigoIngresado : (item.barcode !== undefined ? item.barcode : item.sku)), 160, 'GENERIC_CODE_INVALID', true)
        };
      }
      return out;
    });
    // Mismo producto en dos líneas: el servidor solo acepta una línea por producto. Si ambas tienen el
    // mismo precio unitario se unen en una sola (cantidad sumada; el stock baja una vez por el total).
    // Si el precio (o descuento ya aplicado al precio) difiere, no se adivina un precio: se rechaza
    // con PRODUCT_ID_DUPLICATE_PRICE para que el cajero lo corrija; ninguna línea se pierde.
    if (seen.size !== items.length) {
      var byId = new Map(), merged = [];
      items.forEach(function (item) {
        var prev = byId.get(item.product_id);
        if (!prev) { byId.set(item.product_id, item); merged.push(item); return; }
        if (prev.unit_price_cents !== item.unit_price_cents) fail('PRODUCT_ID_DUPLICATE_PRICE');
        if (prev.generic_line || item.generic_line) {
          if (JSON.stringify(prev.generic_line || null) !== JSON.stringify(item.generic_line || null)) fail('PRODUCT_ID_DUPLICATE');
          if (!Number.isSafeInteger(prev.quantity + item.quantity) || prev.quantity + item.quantity > 9999) fail('GENERIC_QUANTITY_INVALID');
        }
        var qty = Math.round((prev.quantity + item.quantity) * 1000) / 1000;
        var line = prev.line_total_cents + item.line_total_cents;
        if (!Number.isSafeInteger(line)) fail('TOTAL_UNSAFE');
        prev.quantity = qty; prev.line_total_cents = line;
      });
      items = merged;
    }

    var total = items.reduce(function (sum, item) {
      var next = sum + item.line_total_cents;
      if (!Number.isSafeInteger(next)) fail('TOTAL_UNSAFE');
      return next;
    }, 0);
    if (input.total_cents !== undefined && cents(input.total_cents, 'TOTAL_UNSAFE') !== total) fail('TOTAL_MISMATCH');
    if (input.total !== undefined && solesToCents(input.total, 'TOTAL_UNSAFE') !== total) fail('TOTAL_MISMATCH');

    var method = input.payment_method;
    if (METHODS.indexOf(method) === -1) fail('PAYMENT_METHOD_INVALID');
    var sourcePayment = input.payment && typeof input.payment === 'object' ? input.payment : {};
    var cash = 0, digital = 0, credit = 0, digitalMethod = null;
    if (method === 'efectivo') cash = total;
    else if (DIGITAL.indexOf(method) !== -1) { digital = total; digitalMethod = method; }
    else if (method === 'credito') credit = total;
    else {
      cash = cents(sourcePayment.cash_cents, 'MIXED_PAYMENT_INVALID');
      digital = cents(sourcePayment.digital_cents, 'MIXED_PAYMENT_INVALID');
      digitalMethod = sourcePayment.digital_method;
      if (DIGITAL.indexOf(digitalMethod) === -1 || !Number.isSafeInteger(cash + digital) || cash + digital !== total) fail('MIXED_PAYMENT_INVALID');
    }
    var reference = sourcePayment.reference === undefined ? '' : sourcePayment.reference;
    if (typeof reference !== 'string' || reference.length > 160 || /[\u0000-\u001f\u007f-\u009f]/.test(reference)) fail('REFERENCE_INVALID');
    if (method === 'credito' && (!input.customer_id || !validDue(input.credit_due))) fail('CREDIT_CUSTOMER_OR_DUE_REQUIRED');
    var creditAccount = null, installments = [];
    if (method === 'credito') {
      if (input.credit_account !== undefined) {
        var account = input.credit_account;
        if (!account || typeof account !== 'object' || Array.isArray(account) ||
            typeof account.account_id !== 'string' || !account.account_id || account.account_id.length > 160 ||
            typeof account.name !== 'string' || !account.name.trim() || account.name.trim().length > 60 ||
            !['accumulated','separate'].includes(account.mode)) fail('CREDIT_ACCOUNT_INVALID');
        creditAccount = { account_id: account.account_id, name: account.name.trim().replace(/\s+/g,' '), mode: account.mode };
      }
      if (input.installment_dates !== undefined) {
        if (!Array.isArray(input.installment_dates) || input.installment_dates.length < 1 || input.installment_dates.length > 60 ||
            input.installment_dates.some(function (date) { return !validDue(date); })) fail('INSTALLMENTS_INVALID');
        var baseAmount = Math.floor(total / input.installment_dates.length);
        var remainder = total - baseAmount * input.installment_dates.length;
        installments = input.installment_dates.map(function (date, index) {
          return { number:index + 1, due_date:date, amount_cents:baseAmount + (index < remainder ? 1 : 0) };
        });
      } else if (input.installments !== undefined) {
        if (!Array.isArray(input.installments) || input.installments.length < 1 || input.installments.length > 60) fail('INSTALLMENTS_INVALID');
        var installmentTotal = 0;
        installments = input.installments.map(function (row, index) {
          if (!row || typeof row !== 'object' || Array.isArray(row) || row.number !== index + 1 || !validDue(row.due_date) ||
              !Number.isSafeInteger(row.amount_cents) || row.amount_cents <= 0) fail('INSTALLMENTS_INVALID');
          installmentTotal += row.amount_cents;
          if (!Number.isSafeInteger(installmentTotal)) fail('INSTALLMENTS_INVALID');
          return { number: row.number, due_date: row.due_date, amount_cents: row.amount_cents };
        });
        if (installmentTotal !== total) fail('INSTALLMENTS_TOTAL_MISMATCH');
      }
    }

    var intent = {
      version: VERSION,
      operation_id: stableId(input.operation_id, '', 'OPERATION_ID_INVALID'),
      sale_id: stableId(input.sale_id, '', 'SALE_ID_INVALID'),
      created_at: input.created_at === undefined ? new Date().toISOString() : nonEmptyString(input.created_at, 'CREATED_AT_INVALID'),
      payment_method: method,
      total_cents: total,
      payment: { cash_cents: cash, digital_cents: digital, credit_cents: credit, digital_method: digitalMethod, reference: reference },
      items: items
    };
    if (input.customer_id !== undefined && input.customer_id !== null && input.customer_id !== '') intent.customer_id = nonEmptyString(input.customer_id, 'CUSTOMER_ID_INVALID');
    if (input.credit_due !== undefined && input.credit_due !== null && input.credit_due !== '') intent.credit_due = input.credit_due;
    if (creditAccount) intent.credit_account = creditAccount;
    if (installments.length) intent.installments = installments;
    // Optional binding to the open till where the cash was received.
    if (input.session_id !== undefined && input.session_id !== null && input.session_id !== '') {
      if (cash <= 0) fail('SESSION_ID_WITHOUT_CASH');
      var sessionId = nonEmptyString(input.session_id, 'SESSION_ID_INVALID');
      if (sessionId.length > 160 || /[\u0000-\u001f\u007f-\u009f]/.test(sessionId)) fail('SESSION_ID_INVALID');
      intent.session_id = sessionId;
    }
    return intent;
  }

  root.NuevoAmanecerCanonicalSaleIntent = Object.freeze({ VERSION: VERSION, build: build });
})(globalThis);
