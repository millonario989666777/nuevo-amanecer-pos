/*
 * ocr-purchase-review.js — revisión humana de propuestas OCR (V1.1, WP-05).
 *
 * Representa propuestas ya procesadas y conserva decisiones en memoria. No
 * ejecuta OCR, parser ni matcher; no aplica inventario ni persiste resultados.
 */
(function (root) {
  'use strict';

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function productId(product) {
    return product && product.id !== null && product.id !== undefined ? String(product.id) : '';
  }

  function addProduct(registry, product) {
    var id = productId(product);
    if (id && !registry[id]) registry[id] = product;
  }

  function productRegistry(proposals, products) {
    var registry = Object.create(null);
    if (Array.isArray(products)) {
      for (var i = 0; i < products.length; i += 1) addProduct(registry, products[i]);
    }
    for (var p = 0; p < proposals.length; p += 1) {
      var match = proposals[p] && proposals[p].match;
      addProduct(registry, match && match.product);
      var candidates = match && Array.isArray(match.candidates) ? match.candidates : [];
      for (var c = 0; c < candidates.length; c += 1) addProduct(registry, candidates[c] && candidates[c].product);
    }
    return registry;
  }

  function finitePositive(value) {
    var number = typeof value === 'number' ? value : Number(value);
    return isFinite(number) && number > 0 ? number : null;
  }

  function rowState(proposal) {
    return {
      originalProposal: proposal,
      productId: proposal && proposal.proposedProductId !== null
        && proposal.proposedProductId !== undefined ? String(proposal.proposedProductId) : '',
      quantity: proposal ? proposal.proposedQty : null,
      unitCost: proposal ? proposal.proposedUnitCost : null,
      decision: 'PENDING',
      humanEdited: false,
      humanProductSelected: false,
      validationErrors: [],
    };
  }

  function candidateProducts(proposal) {
    var match = proposal && proposal.match;
    var candidates = match && Array.isArray(match.candidates) ? match.candidates : [];
    var out = [];
    for (var i = 0; i < candidates.length; i += 1) {
      if (candidates[i] && candidates[i].product) out.push(candidates[i].product);
    }
    return out;
  }

  function appendText(doc, parent, tag, className, value) {
    var element = doc.createElement(tag);
    if (className) element.className = className;
    element.textContent = text(value);
    parent.appendChild(element);
    return element;
  }

  function setData(element, key, value) {
    if (element.dataset) element.dataset[key] = String(value);
    else element.setAttribute('data-' + key.replace(/[A-Z]/g, function (letter) {
      return '-' + letter.toLowerCase();
    }), String(value));
  }

  function createPurchaseReview(container, input, options) {
    if (!container || typeof container.appendChild !== 'function') {
      throw new Error('Se requiere un contenedor DOM para la revisión OCR.');
    }
    var doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElement !== 'function') {
      throw new Error('Document no esta disponible para la revisión OCR.');
    }

    var proposals = input && Array.isArray(input.proposals) ? input.proposals : [];
    var settings = options || {};
    var registry = productRegistry(proposals, settings.products);
    var rows = proposals.map(rowState);

    function validate(index) {
      var row = rows[index];
      var errors = [];
      if (!row || !registry[row.productId]) errors.push('PRODUCTO_REQUERIDO');
      if (finitePositive(row && row.quantity) === null) errors.push('CANTIDAD_INVALIDA');
      if (finitePositive(row && row.unitCost) === null) errors.push('COSTO_INVALIDO');
      if (row && row.originalProposal && row.originalProposal.status !== 'MATCHED_SAFE'
          && !row.humanProductSelected) errors.push('SELECCION_HUMANA_REQUERIDA');
      if (row) row.validationErrors = errors;
      return errors;
    }

    function correct(index, changes) {
      var row = rows[index];
      if (!row || row.decision === 'DISCARDED') return { ok: false, errors: ['FILA_NO_EDITABLE'] };
      var patch = changes || {};
      if (Object.prototype.hasOwnProperty.call(patch, 'productId')) {
        row.productId = text(patch.productId);
        row.humanProductSelected = true;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'quantity')) row.quantity = patch.quantity;
      if (Object.prototype.hasOwnProperty.call(patch, 'unitCost')) row.unitCost = patch.unitCost;
      row.humanEdited = true;
      row.decision = 'PENDING';
      render();
      return { ok: true, errors: [] };
    }

    function confirm(index) {
      var row = rows[index];
      if (!row || row.decision === 'DISCARDED') return { ok: false, errors: ['FILA_NO_CONFIRMABLE'] };
      var errors = validate(index);
      if (errors.length) {
        row.decision = 'PENDING';
        render();
        return { ok: false, errors: errors.slice() };
      }
      row.quantity = finitePositive(row.quantity);
      row.unitCost = finitePositive(row.unitCost);
      row.decision = 'CONFIRMED';
      render();
      return { ok: true, errors: [] };
    }

    function discard(index) {
      var row = rows[index];
      if (!row) return { ok: false, errors: ['FILA_INEXISTENTE'] };
      row.decision = 'DISCARDED';
      row.validationErrors = [];
      render();
      return { ok: true, errors: [] };
    }

    function getReviewedPurchaseProposals() {
      var reviewed = [];
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        if (row.decision === 'PENDING') continue;
        reviewed.push({
          sourceIndex: row.originalProposal.sourceIndex,
          productId: row.decision === 'CONFIRMED' ? row.productId : null,
          quantity: row.decision === 'CONFIRMED' ? row.quantity : null,
          unitCost: row.decision === 'CONFIRMED' ? row.unitCost : null,
          decision: row.decision,
          originalProposal: row.originalProposal,
          humanEdited: row.humanEdited,
          reasons: Array.isArray(row.originalProposal.reasons)
            ? row.originalProposal.reasons.slice() : [],
        });
      }
      return reviewed;
    }

    function renderRow(proposal, row, index) {
      var card = doc.createElement('section');
      card.className = 'ocr-review-row';
      setData(card, 'sourceIndex', proposal.sourceIndex);
      setData(card, 'status', proposal.status);
      setData(card, 'decision', row.decision);

      appendText(doc, card, 'h3', 'ocr-review-name', proposal.parsed && proposal.parsed.name);
      appendText(doc, card, 'div', 'ocr-review-raw', proposal.parsed && proposal.parsed.raw);
      appendText(doc, card, 'div', 'ocr-review-status', proposal.status);

      var quantityLabel = appendText(doc, card, 'label', 'ocr-review-field', 'Cantidad');
      var quantity = doc.createElement('input');
      quantity.type = 'number';
      quantity.min = '0.000001';
      quantity.step = 'any';
      quantity.value = text(row.quantity);
      setData(quantity, 'field', 'quantity');
      setData(quantity, 'index', index);
      quantityLabel.appendChild(quantity);

      var costLabel = appendText(doc, card, 'label', 'ocr-review-field', 'Costo unitario');
      var cost = doc.createElement('input');
      cost.type = 'number';
      cost.min = '0.000001';
      cost.step = 'any';
      cost.value = text(row.unitCost);
      setData(cost, 'field', 'unitCost');
      setData(cost, 'index', index);
      costLabel.appendChild(cost);

      var productLabel = appendText(doc, card, 'label', 'ocr-review-field', 'Producto POS');
      var select = doc.createElement('select');
      setData(select, 'field', 'productId');
      setData(select, 'index', index);
      var placeholder = doc.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Seleccione un producto';
      select.appendChild(placeholder);
      var ids = Object.keys(registry).sort();
      for (var p = 0; p < ids.length; p += 1) {
        var option = doc.createElement('option');
        option.value = ids[p];
        option.textContent = text(registry[ids[p]].name || ids[p]);
        option.selected = ids[p] === row.productId;
        select.appendChild(option);
      }
      select.value = row.productId;
      productLabel.appendChild(select);

      var reasonList = doc.createElement('ul');
      reasonList.className = 'ocr-review-reasons';
      var reasons = Array.isArray(proposal.reasons) ? proposal.reasons : [];
      for (var r = 0; r < reasons.length; r += 1) appendText(doc, reasonList, 'li', '', reasons[r]);
      card.appendChild(reasonList);

      var candidates = candidateProducts(proposal);
      var candidateList = doc.createElement('ul');
      candidateList.className = 'ocr-review-candidates';
      for (var c = 0; c < candidates.length; c += 1) {
        appendText(doc, candidateList, 'li', '', text(candidates[c].name || productId(candidates[c])));
      }
      card.appendChild(candidateList);

      var validation = doc.createElement('ul');
      validation.className = 'ocr-review-validation';
      for (var v = 0; v < row.validationErrors.length; v += 1) {
        appendText(doc, validation, 'li', '', row.validationErrors[v]);
      }
      card.appendChild(validation);

      var confirmButton = appendText(doc, card, 'button', 'ocr-review-confirm', 'Confirmar');
      confirmButton.type = 'button';
      setData(confirmButton, 'action', 'confirm');
      setData(confirmButton, 'index', index);
      var discardButton = appendText(doc, card, 'button', 'ocr-review-discard', 'Descartar');
      discardButton.type = 'button';
      setData(discardButton, 'action', 'discard');
      setData(discardButton, 'index', index);
      return card;
    }

    // Ítem 11: quitar el campo enfocado dispara «blur»/«change» y otro render dentro de este;
    // el render anidado intentaba quitar nodos ya quitados (error removeChild). Se encola y se hace después.
    var rendering = false, renderAgain = false;
    function render() {
      if (rendering) { renderAgain = true; return; }
      rendering = true;
      try {
        while (container.firstChild) {
          var node = container.firstChild;
          if (node.parentNode === container) container.removeChild(node); else break;
        }
        for (var i = 0; i < proposals.length; i += 1) {
          container.appendChild(renderRow(proposals[i], rows[i], i));
        }
      } finally { rendering = false; }
      if (renderAgain) { renderAgain = false; render(); }
    }

    function findActionTarget(target, key) {
      var current = target;
      while (current && current !== container) {
        if (current.dataset && current.dataset[key] !== undefined) return current;
        current = current.parentNode;
      }
      return null;
    }

    function onClick(event) {
      var target = findActionTarget(event.target, 'action');
      if (!target) return;
      var index = Number(target.dataset.index);
      if (target.dataset.action === 'confirm') confirm(index);
      else if (target.dataset.action === 'discard') discard(index);
    }

    function onChange(event) {
      var target = findActionTarget(event.target, 'field');
      if (!target) return;
      var change = {};
      change[target.dataset.field] = target.value;
      correct(Number(target.dataset.index), change);
    }

    container.addEventListener('click', onClick);
    container.addEventListener('change', onChange);
    render();

    return {
      confirm: confirm,
      correct: correct,
      discard: discard,
      getReviewedPurchaseProposals: getReviewedPurchaseProposals,
      render: render,
      destroy: function () {
        container.removeEventListener('click', onClick);
        container.removeEventListener('change', onChange);
      },
    };
  }

  var api = {
    version: '1.0.0',
    createPurchaseReview: createPurchaseReview,
  };

  if (root) {
    root._NA_OCR_PURCHASE_REVIEW = api;
    root.createPurchaseReview = createPurchaseReview;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
