(function (root) {
  'use strict';

  var VERSION = 1;

  function text(value, fallback) {
    if (value === undefined || value === null) return fallback === undefined ? '' : String(fallback);
    var out = String(value).trim();
    return out || (fallback === undefined ? '' : String(fallback));
  }

  function number(value, fallback) {
    var out = Number(value);
    return Number.isFinite(out) ? out : (fallback === undefined ? 0 : Number(fallback) || 0);
  }

  function integer(value, fallback) {
    return Math.trunc(number(value, fallback));
  }

  function cents(value) {
    return number(value, 0) / 100;
  }

  function safeArrayJson(value) {
    if (Array.isArray(value)) return value.slice();
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
      var parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function uniqueCodes(raw, legacy) {
    var seen = new Set(), out = [];
    safeArrayJson(raw).concat(legacy ? [legacy] : []).forEach(function (value) {
      var code = text(value);
      if (!code || seen.has(code)) return;
      seen.add(code); out.push(code);
    });
    return out.slice(0, 10);
  }

  function uiProduct(p) {
    p = p && typeof p === 'object' ? p : {};
    var name = text(p.name, 'PRODUCTO');
    var barcode = text(p.barcode);
    var category = text(p.category).toLowerCase();
    var icon = text(p.icon, '📦');
    var unitsPerBox = integer(p.units_per_box, 0);
    var purchaseFactor = number(p.purchase_factor, unitsPerBox > 0 ? unitsPerBox : 1);
    if (!(purchaseFactor > 0)) purchaseFactor = unitsPerBox > 0 ? unitsPerBox : 1;
    var tracks = p.tracks_inventory !== 0 && p.tracks_inventory !== false;
    var altCodes = uniqueCodes(p.alternate_codes_json, p.legacy_alternate_code);
    var boxPrice = number(p.box_price_cents, 0);
    return {
      id: p.product_id,
      product_id: p.product_id,
      name: name,
      nombre: name,
      sku: text(p.sku),
      barcode: barcode,
      codigo: barcode,
      codigosAlternativos: altCodes,
      codigoAlternativo: altCodes[0] || '',
      cat: category,
      categoria: category,
      marca: text(p.brand, 'Sin marca'),
      descripcion: text(p.description),
      icon: icon,
      icono: icon,
      imagen: p.image || null,
      unidad: text(p.unit, 'unidad'),
      unidadCompra: text(p.purchase_unit, unitsPerBox > 1 ? 'caja' : 'unidad'),
      factorCompra: purchaseFactor,
      costo: cents(p.cost_cents),
      precio: cents(p.price_cents),
      precioCaja: boxPrice > 0 ? boxPrice / 100 : null,
      unidCaja: unitsPerBox > 0 ? unitsPerBox : null,
      stock: number(p.current_stock_quantity, 0),
      stockRevision: integer(p.stock_revision, 0),
      metadataRevision: integer(p.metadata_revision, 0),
      stockMin: number(p.stock_min_quantity, 0),
      venc: text(p.expiry_date),
      incluyeIGV: p.includes_igv !== 0 && p.includes_igv !== false,
      tipoImpuesto: text(p.tax_type),
      impuestoComplementario: text(p.complementary_tax),
      controlInventario: tracks,
      controlaStock: tracks,
      canonical: true
    };
  }

  function accountMap(accounts) {
    var byCustomer = new Map();
    (Array.isArray(accounts) ? accounts : []).forEach(function (account) {
      if (!account || account.customer_id === undefined || account.customer_id === null) return;
      var key = String(account.customer_id), list = byCustomer.get(key) || [];
      list.push({
        id: account.account_id,
        name: text(account.name, 'Categoría'),
        mode: account.mode === 'separate' ? 'separate' : 'accumulated',
        createdAt: account.created_at || null
      });
      byCustomer.set(key, list);
    });
    return byCustomer;
  }

  function uiCustomer(c, index, accountsByCustomer) {
    c = c && typeof c === 'object' ? c : {};
    var id = c.customer_id;
    var name = text(c.name, 'Cliente');
    var policyMode = text(c.credit_policy_mode).toUpperCase();
    var manual = policyMode === 'MANUAL';
    return {
      id: id,
      customer_id: id,
      nombre: name,
      name: name,
      dni: text(c.document),
      document: text(c.document),
      tel: text(c.phone),
      phone: text(c.phone),
      contactRevision: integer(c.contact_revision,0),
      dir: text(c.address),
      address: text(c.address),
      color: Number.isFinite(Number(c.color)) ? Number(c.color) : (Number(index) || 0) % 8,
      totalCompras: cents(c.total_purchases_cents),
      creditCategories: (accountsByCustomer.get(String(id)) || []).slice(),
      lineaCreditoPolicyRevision: integer(c.credit_policy_revision, 0),
      lineaCreditoManualActiva: manual,
      lineaCreditoManual: manual ? cents(c.credit_policy_manual_limit_cents) : 0,
      lineaCreditoManualMotivo: manual ? text(c.credit_policy_reason) : '',
      lineaCreditoManualAt: manual ? text(c.credit_policy_updated_at) : '',
      lineaCreditoManualPor: manual ? text(c.credit_policy_administrator_name) : '',
      lineaCreditoManualPorId: manual ? text(c.credit_policy_administrator_id) : '',
      canonical: true
    };
  }

  function uiPayment(p, credit) {
    p = p && typeof p === 'object' ? p : {};
    credit = credit && typeof credit === 'object' ? credit : {};
    var known = !!p.payment_date_known;
    var operation = text(p.source_operation_reference);
    var seller = text(p.seller, 'Histórico');
    return {
      id: p.payment_id,
      pagoId: p.payment_id,
      creditoId: credit.credit_id !== undefined ? credit.credit_id : p.credit_id,
      clienteId: credit.customer_id,
      monto: cents(p.amount_cents),
      montoPagado: cents(p.amount_cents),
      saldoDespues: p.source_balance_after_cents==null?null:cents(p.source_balance_after_cents),
      saldoAntes: p.source_balance_after_cents==null?null:cents(Number(p.source_balance_after_cents)+Number(p.amount_cents)),
      fecha: known ? localDateOf(p.payment_timestamp, p.payment_date) : '',
      timestamp: known ? (p.payment_timestamp || p.payment_date || null) : null,
      canonicalDateKnown: known,
      datePrecision: p.date_precision,
      metodo: text(p.method || p.source_method, 'efectivo'),
      operacion: operation,
      numeroOperacion: operation,
      referencia: operation,
      cajero: seller,
      cajeroNombre: seller,
      canonical: true
    };
  }

  function safeInstallments(value) {
    return safeArrayJson(value).map(function (row, index) {
      row = row && typeof row === 'object' ? row : {};
      return {
        number: Number(row.number) || index + 1,
        due: text(row.due_date || row.due).slice(0, 10),
        amount: cents(row.amount_cents !== undefined ? row.amount_cents : number(row.amount, 0) * 100)
      };
    }).filter(function (row) { return row.number > 0; });
  }

  function uiCredit(c, customerById, paymentsByCredit) {
    c = c && typeof c === 'object' ? c : {};
    var issued = typeof c.issued_value === 'string' ? c.issued_value : (typeof c.created_at === 'string' ? c.created_at : '');
    var due = typeof c.due_value === 'string' ? c.due_value : (typeof c.due_date === 'string' ? c.due_date : '');
    var client = customerById.get(String(c.customer_id));
    var amount = cents(c.original_amount_cents);
    var balance = cents(c.current_balance_cents);
    var paid = Math.max(0, amount - balance);
    var seller = text(c.seller, 'Histórico');
    var description = text(c.concept || c.document_number || c.reference, 'Crédito histórico');
    var account = c.account_id ? {
      version: 2,
      categoryId: String(c.account_id),
      categoryName: text(c.account_name, 'Categoría'),
      mode: c.account_mode === 'separate' ? 'separate' : 'accumulated',
      source: 'canonical'
    } : null;
    var payments = (paymentsByCredit.get(String(c.credit_id)) || []).map(function (p) { return uiPayment(p, c); });
    return {
      id: c.credit_id,
      credit_id: c.credit_id,
      cliId: c.customer_id,
      clienteId: c.customer_id,
      customer_id: c.customer_id,
      ventaId: c.sale_id || null,
      sale_id: c.sale_id || null,
      clienteNombre: client && client.nombre || String(c.customer_id || ''),
      clienteDni: client && client.dni || '',
      desc: description,
      monto: amount,
      pagado: paid,
      saldo: balance,
      vence: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : '',
      canonicalDueKnown: /^\d{4}-\d{2}-\d{2}$/.test(due),
      fecha: /^\d{4}-\d{2}-\d{2}/.test(issued) ? localDateOf(issued, issued.slice(0, 10)) : '',
      timestamp: /^\d{4}-\d{2}-\d{2}T/.test(issued) ? issued : null,
      cajero: seller,
      cajeroNombre: seller,
      status: text(c.source_status || c.status),
      estado: text(c.source_status || c.status),
      anulado: false,
      pagos: payments,
      creditAccount: account,
      installments: safeInstallments(c.installments_json),
      items: [{
        itemKey: 'canonical:' + String(c.credit_id || ''),
        productoId: null,
        nombre: description,
        cantidad: 1,
        precioUnitario: amount,
        subtotal: amount,
        modo: 'concepto'
      }],
      canonical: true
    };
  }


  // P1-3: the Worker stores UTC instants (2026-10-11T01:46:00Z is 20:46 of 10-10 in
  // Lima). A zoned instant is shown on the business-local calendar day, exactly like
  // Caja (localParts); date-only/unzoned historical values are kept verbatim.
  function localDateOf(timestamp, fallback) {
    var raw = text(timestamp);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
      var local = localParts(raw).date;
      if (local) return local;
    }
    return text(fallback);
  }

  function localParts(value) {
    var raw = text(value);
    var parsed = raw ? new Date(raw) : null;
    if (!parsed || !Number.isFinite(parsed.getTime())) {
      return { date: /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '', time: /^\d{4}-\d{2}-\d{2}T/.test(raw) ? raw.slice(11, 16) : '', timestamp: raw || null };
    }
    function pad(v) { return String(v).padStart(2, '0'); }
    return {
      date: parsed.getFullYear() + '-' + pad(parsed.getMonth() + 1) + '-' + pad(parsed.getDate()),
      time: pad(parsed.getHours()) + ':' + pad(parsed.getMinutes()),
      timestamp: raw
    };
  }

  function groupBy(rows, keyName) {
    var out = new Map();
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || row[keyName] === undefined || row[keyName] === null) return;
      var key = String(row[keyName]), list = out.get(key) || [];
      list.push(row); out.set(key, list);
    });
    return out;
  }

  function uiSaleItem(row, productById) {
    row = row && typeof row === 'object' ? row : {};
    var generic = text(row.line_type).toUpperCase() === 'GENERIC';
    var product = generic ? {} : (productById.get(String(row.product_id)) || {});
    var qty = number(row.quantity, 0);
    var price = cents(row.unit_price_cents);
    var name = generic ? text(row.generic_name, 'VARIOS') : text(product.name || product.nombre, 'Producto');
    var code = generic ? text(row.generic_code) : text(product.sku || product.barcode);
    return {
      id: row.product_id,
      product_id: row.product_id,
      name: name,
      nombre: name,
      sku: code,
      barcode: code,
      codigoIngresado: code,
      icon: generic ? '📋' : text(product.icon || product.icono, '📦'),
      qty: qty,
      cantidad: qty,
      precio: price,
      precioUnitario: price,
      subtotal: cents(row.line_total_cents),
      costo: generic ? 0 : number(product.costo, 0),
      tipoImpuesto: generic ? '' : text(product.tipoImpuesto),
      incluyeIGV: generic ? true : product.incluyeIGV !== false,
      ventaLibre: generic,
      tipoLinea: generic ? 'venta_libre' : 'producto',
      controlInventario: generic ? false : product.controlInventario,
      canonical: true
    };
  }

  function uiSale(row, itemsBySale, productById, customerById, cashBySale) {
    row = row && typeof row === 'object' ? row : {};
    var when = localParts(row.created_at);
    var items = (itemsBySale.get(String(row.sale_id)) || []).slice().sort(function (a, b) {
      return integer(a.line_number, 0) - integer(b.line_number, 0);
    }).map(function (item) { return uiSaleItem(item, productById); });
    var customer = customerById.get(String(row.customer_id));
    var cash = cashBySale.get(String(row.sale_id)) || {};
    var method = text(row.payment_method, 'efectivo');
    var breakdown = null;
    if (method === 'mixto') {
      breakdown = {
        efectivo: cents(cash.cash_cents),
        digital: cents(cash.digital_cents),
        digitalMethod: text(cash.digital_method),
        reference: text(cash.reference || row.payment_reference)
      };
    }
    return {
      id: row.sale_id,
      sale_id: row.sale_id,
      operation_id: row.operation_id,
      operation: row.operation_id,
      fecha: when.date,
      hora: when.time,
      hora24: when.time,
      timestamp: when.timestamp,
      total: cents(row.total_cents),
      metodo: method,
      metodoPago: method,
      estado: method === 'credito' ? 'credito' : 'completada',
      paymentRef: text(row.payment_reference || cash.reference),
      paymentBreakdown: breakdown,
      anulada: false,
      clienteId: row.customer_id || null,
      customer_id: row.customer_id || null,
      clienteNombre: customer ? customer.nombre : (row.customer_id ? String(row.customer_id) : 'Consumidor final'),
      clienteDni: customer ? customer.dni : '',
      cantidadLineas: items.length,
      unidadesFisicas: items.reduce(function (sum, item) { return sum + number(item.qty, 0); }, 0),
      items: items,
      canonical: true,
      canonicalReadOnly: true
    };
  }

  function uiInventoryMovement(row) {
    row = row && typeof row === 'object' ? row : {};
    var when = localParts(row.created_at);
    var kind = text(row.movement_type, 'SALE').toUpperCase();
    var manual = text(row.movement_source).toUpperCase() === 'MANUAL' || kind === 'ENTRADA' || kind === 'SALIDA';
    return {
      id: row.movement_id,
      movementId: row.movement_id,
      operationId: row.operation_id,
      productId: row.product_id,
      type: kind,
      delta: number(row.quantity, 0),
      quantity: number(row.quantity, 0),
      reason: text(row.reason),
      source: manual ? 'INVENTORY_MOVE' : 'CANONICAL',
      referenceId: row.sale_id || row.product_id || null,
      saleId: row.sale_id || null,
      lineNumber: row.line_number == null ? 0 : integer(row.line_number, 0),
      fecha: when.date,
      hora: when.time,
      hora24: when.time,
      timestamp: when.timestamp,
      canonical: true
    };
  }

  function uiSaleCashMovement(row) {
    row = row && typeof row === 'object' ? row : {};
    var when = localParts(row.created_at);
    return {
      id: row.movement_id,
      operationId: row.operation_id,
      tipo: 'ing',
      monto: cents(row.amount_cents),
      efectivo: cents(row.cash_cents),
      digital: cents(row.digital_cents),
      credito: cents(row.credit_cents),
      desc: 'Venta ' + text(row.sale_id),
      cat: 'Venta',
      metodo: text(row.payment_method, 'efectivo'),
      referencia: text(row.reference),
      numeroOperacion: text(row.reference),
      hora: when.time,
      hora24: when.time,
      timestamp: when.timestamp,
      fecha: when.date,
      sessionId: row.session_id || null,
      ventaId: row.sale_id || null,
      digitalMethod: text(row.digital_method),
      canonical: true
    };
  }

  function uiFinancialMovement(event) {
    event = event && typeof event === 'object' ? event : {};
    var when = localParts(event.created_at);
    var kind = text(event.event_type);
    var cashDelta = number(event.cash_delta_cents, 0);
    var creditDelta = number(event.credit_delta_cents, 0);
    var method = text(event.payment_method, 'efectivo');
    var type = kind === 'PAYMENT' ? 'cob' : (cashDelta >= 0 ? 'ing' : 'egr');
    var amount = kind === 'PAYMENT' ? Math.abs(creditDelta) / 100 : Math.abs(cashDelta) / 100;
    var isCash = method === 'efectivo';
    return {
      id: event.event_id,
      operationId: event.operation_id,
      tipo: type,
      monto: amount,
      efectivo: isCash ? Math.abs(cashDelta) / 100 : 0,
      digital: kind === 'PAYMENT' && !isCash ? amount : 0,
      desc: kind === 'PAYMENT' ? 'Cobro de crédito' : (kind === 'ADJUSTMENT' ? text(event.reason, 'Ajuste de caja') : text(event.reason, 'Compensación')),
      cat: kind === 'PAYMENT' ? 'Cobro' : (kind === 'ADJUSTMENT' ? 'Ajuste' : 'Compensación'),
      metodo: method,
      referencia: text(event.reference),
      numeroOperacion: text(event.reference),
      hora: when.time,
      hora24: when.time,
      timestamp: when.timestamp,
      fecha: when.date,
      sessionId: event.session_id || null,
      creditoId: event.credit_id || null,
      reversal: kind === 'COMPENSATION',
      reversalOf: event.compensates_operation_id || null,
      canonical: true
    };
  }

  function uiExpense(row) {
    row = row && typeof row === 'object' ? row : {};
    var when = localParts(row.created_at);
    return {
      id: row.expense_id,
      expenseId: row.expense_id,
      operationId: row.operation_id,
      desc: text(row.concept),
      monto: cents(row.amount_cents),
      cat: text(row.category),
      metodo: text(row.payment_method),
      fecha: text(row.expense_date),
      nota: text(row.note),
      sessionId: row.session_id || null,
      timestamp: when.timestamp,
      canonical: true,
      canonicalReadOnly: true
    };
  }

  function uiExpenseCashMovement(row) {
    if (!row || !row.session_id) return null;
    var when = localParts(row.created_at);
    var amount = cents(row.amount_cents);
    return {
      id: 'expense:' + text(row.expense_id),
      operationId: row.operation_id,
      tipo: 'gas',
      monto: amount,
      efectivo: row.payment_method === 'efectivo' ? amount : 0,
      digital: row.payment_method === 'efectivo' ? 0 : amount,
      desc: text(row.concept),
      cat: text(row.category),
      metodo: text(row.payment_method),
      hora: when.time,
      hora24: when.time,
      timestamp: when.timestamp,
      fecha: text(row.expense_date),
      sessionId: row.session_id,
      expenseId: row.expense_id,
      canonical: true
    };
  }

  function uiCashState(sessions) {
    var rows = (Array.isArray(sessions) ? sessions : []).filter(Boolean).slice();
    var open = rows.filter(function (row) { return row.status === 'OPEN'; });
    var selected = open.length === 1 ? open[0] : rows.sort(function (a, b) {
      return text(b.closed_at || b.opened_at).localeCompare(text(a.closed_at || a.opened_at));
    })[0];
    if (!selected) {
      return { abierta: false, cerrada: false, fondo: 0, cajero: '', cajeroNombre: '', cajeroId: null, hora: '', hora24: '', fechaApertura: '', cerradaAt: null, horaCierre: null, horaCierre24: null, sessionId: null, contado: null, esperado: null, diferencia: null, canonical: true };
    }
    var opened = localParts(selected.opened_at), closed = localParts(selected.closed_at);
    var isOpen = selected.status === 'OPEN';
    return {
      abierta: isOpen,
      cerrada: !isOpen,
      fondo: cents(selected.opening_cents),
      cajero: '',
      cajeroNombre: '',
      cajeroId: null,
      hora: opened.time,
      hora24: opened.time,
      fechaApertura: opened.date,
      timestampApertura: opened.timestamp,
      horaCierre: closed.time || null,
      horaCierre24: closed.time || null,
      timestampCierre: closed.timestamp,
      sessionId: selected.session_id || null,
      contado: selected.counted_cents == null ? null : cents(selected.counted_cents),
      esperado: selected.expected_cents == null ? null : cents(selected.expected_cents),
      diferencia: selected.difference_cents == null ? null : cents(selected.difference_cents),
      revision: integer(selected.revision, 0),
      canonical: true
    };
  }

  function snapshot(data) {
    if (!data || data.authority !== 'canonical') throw new Error('CANONICAL_SNAPSHOT_UNAVAILABLE');
    var accountsByCustomer = accountMap(data.creditAccounts);
    var customers = (Array.isArray(data.customers) ? data.customers : []).map(function (c, index) {
      return uiCustomer(c, index, accountsByCustomer);
    });
    var customerById = new Map(customers.map(function (c) { return [String(c.id), c]; }));
    var paymentsByCredit = new Map();
    (Array.isArray(data.payments) ? data.payments : []).forEach(function (p) {
      if (!p) return;
      var key = String(p.credit_id), list = paymentsByCredit.get(key) || [];
      list.push(p); paymentsByCredit.set(key, list);
    });
    var credits = (Array.isArray(data.credits) ? data.credits : []).map(function (c) {
      return uiCredit(c, customerById, paymentsByCredit);
    });
    var creditById = new Map(credits.map(function (c) { return [String(c.id), c]; }));
    var products = (Array.isArray(data.products) ? data.products : []).map(uiProduct);
    var productById = new Map(products.map(function (p) { return [String(p.id), p]; }));
    var itemsBySale = groupBy(data.saleItems, 'sale_id');
    var cashBySale = new Map();
    (Array.isArray(data.cashMovements) ? data.cashMovements : []).forEach(function (row) {
      if (row && row.sale_id != null) cashBySale.set(String(row.sale_id), row);
    });
    var sales = (Array.isArray(data.sales) ? data.sales : []).map(function (row) {
      return uiSale(row, itemsBySale, productById, customerById, cashBySale);
    });
    var expenses = (Array.isArray(data.expenses) ? data.expenses : []).map(uiExpense);
    var expenseCashMovements = (Array.isArray(data.expenses) ? data.expenses : []).map(uiExpenseCashMovement).filter(Boolean);
    var cashMovements = (Array.isArray(data.cashMovements) ? data.cashMovements : []).map(uiSaleCashMovement)
      .concat((Array.isArray(data.financialEvents) ? data.financialEvents : []).map(function (event) {
        // Un cobro apunta a un crédito; se muestra a qué cliente pertenece (antes la fila salía sin cliente).
        var movement = uiFinancialMovement(event);
        if (movement.creditoId != null) {
          var credit = creditById.get(String(movement.creditoId));
          if (credit && credit.clienteNombre) {
            movement.clienteId = credit.clienteId;
            movement.clienteNombre = credit.clienteNombre;
            if (movement.tipo === 'cob') movement.desc = 'Cobro de crédito · ' + credit.clienteNombre;
          }
        }
        return movement;
      }))
      .concat(expenseCashMovements)
      .sort(function (a, b) { return text(a.timestamp).localeCompare(text(b.timestamp)); });
    return {
      products: products,
      customers: customers,
      credits: credits,
      payments: (Array.isArray(data.payments) ? data.payments : []).slice(),
      sales: sales,
      expenses: expenses,
      cashState: uiCashState(data.cashSessions),
      cashMovements: cashMovements,
      inventoryMovements: (Array.isArray(data.inventoryMovements) ? data.inventoryMovements : []).map(uiInventoryMovement),
      mode: data.mode,
      promotion_id: data.promotion_id,
      authority_epoch: data.authority_epoch,
      revision: data.revision,
      financial_revision: data.financial_revision,
      read_only: data.read_only
    };
  }

  // Explicit boundary to the classic-script lexical runtime. Never mirror these
  // let/const bindings onto window: readers and writers must share one state.
  var runtime = Object.freeze({
    products: function () { try { if (typeof productos !== 'undefined') return productos; } catch (_) {} return root.productos || []; },
    sales: function () { try { if (typeof ventas !== 'undefined') return ventas; } catch (_) {} return root.ventas || []; },
    customers: function () { try { if (typeof clientes !== 'undefined') return clientes; } catch (_) {} return root.clientes || []; },
    cart: function () { try { if (typeof cart !== 'undefined') return cart; } catch (_) {} return root.cart || []; },
    paymentMethod: function () { try { if (typeof posPayM !== 'undefined') return posPayM; } catch (_) {} return root.posPayM; },
    processing: function () { try { if (typeof posProc !== 'undefined') return !!posProc; } catch (_) {} return !!root.posProc; },
    setProcessing: function (value) { if (typeof posProc !== 'undefined') posProc = value; else root.posProc = value; },
    clearCart: function () { if (typeof cart !== 'undefined') cart = []; else root.cart = []; },
    movementType: function () { try { if (typeof cajMovTipo !== 'undefined') return cajMovTipo; } catch (_) {} return root.cajMovTipo; },
    setMovementType: function (value) { if (typeof cajMovTipo !== 'undefined') cajMovTipo = value; else root.cajMovTipo = value; },
    setProducts: function (value) { if (typeof productos !== 'undefined') productos = value; else root.productos = value; },
    setSales: function (value) { if (typeof ventas !== 'undefined') ventas = value; else root.ventas = value; },
    renderSales: function () { var fn; try { if (typeof ventasRender === 'function') fn = ventasRender; } catch (_) {} if (!fn) fn = root.ventasRender; if (typeof fn === 'function') return fn(); },
    notify: function (message, tone) { var fn; try { if (typeof toast === 'function') fn = toast; } catch (_) {} if (!fn) fn = root.toast; if (typeof fn === 'function') fn(message, tone); },
    closeModal: function (id) { var fn; try { if (typeof cerrarModal === 'function') fn = cerrarModal; } catch (_) {} if (!fn) fn = root.cerrarModal; if (typeof fn === 'function') fn(id); }
  });

  root.NuevoAmanecerCanonicalUIAdapter = Object.freeze({
    VERSION: VERSION,
    runtime: runtime,
    product: uiProduct,
    customer: uiCustomer,
    credit: uiCredit,
    payment: uiPayment,
    sale: uiSale,
    expense: uiExpense,
    cashState: uiCashState,
    snapshot: snapshot
  });
})(globalThis);
