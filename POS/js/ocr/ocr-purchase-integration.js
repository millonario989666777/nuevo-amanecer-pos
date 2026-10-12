/*
 * ocr-purchase-integration.js — integración UI del flujo de compras OCR.
 *
 * Une los módulos OCR cerrados sin duplicar sus reglas. Ningún movimiento se
 * aplica hasta que todas las propuestas hayan sido confirmadas o descartadas.
 */
(function (root) {
  'use strict';

  function byId(doc, id) {
    return doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null;
  }

  function messageFrom(error, fallback) {
    if (error && error.message) return String(error.message);
    return String(fallback || 'Error OCR desconocido.');
  }

  async function operationId(file) {
    var first = 2166136261;
    var second = 2246822519;
    if (file && typeof file.arrayBuffer === 'function') {
      var bytes = new Uint8Array(await file.arrayBuffer());
      for (var i = 0; i < bytes.length; i += 1) {
        first = Math.imul(first ^ bytes[i], 16777619) >>> 0;
        second = Math.imul(second ^ bytes[i], 3266489917) >>> 0;
      }
    } else {
      var fallback = [file && file.name, file && file.size, file && file.lastModified].join(':');
      for (var j = 0; j < fallback.length; j += 1) {
        first = Math.imul(first ^ fallback.charCodeAt(j), 16777619) >>> 0;
        second = Math.imul(second ^ fallback.charCodeAt(j), 3266489917) >>> 0;
      }
    }
    return 'OCR-PURCHASE-' + first.toString(16).padStart(8, '0')
      + second.toString(16).padStart(8, '0');
  }

  function defaultDependencies() {
    return {
      extract: root.extractPurchaseDocument || root.extractOcrText,
      process: root.processPurchaseOcrText,
      createReview: root.createPurchaseReview,
      apply: root.applyApprovedPurchaseProposals,
    };
  }

  function createPurchaseOcrIntegration(options) {
    var settings = options || {};
    var doc = settings.document || (root && root.document);
    var deps = settings.dependencies || defaultDependencies();
    var elements = settings.elements || {
      file: byId(doc, 'ocrPurchaseFile'),
      camera: byId(doc, 'ocrPurchaseCamera'),
      documentFile: byId(doc, 'ocrPurchaseDocument'),
      reviewStatus: byId(doc, 'ocrReviewStatus'),
      source: byId(doc, 'ocrPurchaseSource'),
      start: byId(doc, 'ocrPurchaseStart'),
      status: byId(doc, 'ocrPurchaseStatus'),
      modal: byId(doc, 'mOcrPurchaseReview'),
      rawText: byId(doc, 'ocrPurchaseRawText'),
      review: byId(doc, 'ocrPurchaseReviewRows'),
      apply: byId(doc, 'ocrPurchaseApply'),
      close: byId(doc, 'ocrPurchaseClose'),
    };
    var getProducts = settings.getProducts || function () {
      return typeof productos !== 'undefined' && Array.isArray(productos) ? productos : [];
    };
    var getMovements = settings.getMovements || function () {
      return typeof inventoryMovements !== 'undefined' && Array.isArray(inventoryMovements)
        ? inventoryMovements : [];
    };
    var createOperationId = settings.createOperationId || operationId;
    var refreshInventory = settings.refreshInventory || function () {
      if (typeof invRender === 'function') invRender();
      if (typeof posRender === 'function') posRender();
    };
    var selectedFile = null;
    var currentBatch = null;
    var reviewController = null;
    var reading = false;
    var applying = false;

    function setStatus(kind, message) {
      if (!elements.status) return;
      elements.status.textContent = String(message || '');
      if (elements.status.dataset) elements.status.dataset.state = kind;
      if(elements.reviewStatus) elements.reviewStatus.textContent=String(message||'');
    }

    function setBusy(button, busy) {
      if (button) button.disabled = !!busy;
    }

    function openReview() {
      if (elements.modal && elements.modal.classList) elements.modal.classList.add('open');
    }

    function closeReview() {
      if (elements.modal && elements.modal.classList) elements.modal.classList.remove('open');
    }

    var sourceUrl=null;
    function clearSource(){if(sourceUrl){URL.revokeObjectURL(sourceUrl);sourceUrl=null;}if(elements.source)elements.source.textContent='';}
    function showSource(file){
      clearSource();if(!elements.source||!doc)return;
      var label=doc.createElement('div');label.textContent=file.name||'Documento original';elements.source.appendChild(label);
      sourceUrl=URL.createObjectURL(file);
      if(file.type.indexOf('image/')===0){var img=doc.createElement('img');img.src=sourceUrl;img.alt='Documento original para verificar';img.style.maxWidth='100%';elements.source.appendChild(img);}
      else {var link=doc.createElement('a');link.href=sourceUrl;link.download=file.name;link.textContent='Abrir copia del documento original';elements.source.appendChild(link);}
    }
    function selectImage(file) {
      if (reading || applying) {
        setStatus('error', 'Espera a que termine la operación en curso.');
        return false;
      }
      currentBatch = null;
      clearSource();
      if (reviewController && typeof reviewController.destroy === 'function') reviewController.destroy();
      reviewController = null;
      closeReview();
      selectedFile = file || null;
      if (!selectedFile) {
        setBusy(elements.apply, true);
        setStatus('idle', 'Toma una foto o sube una imagen, PDF o documento.');
        return false;
      }
      var invalid = root._NA_OCR_DOCUMENT ? root._NA_OCR_DOCUMENT.validate(selectedFile) : (selectedFile.type && selectedFile.type.indexOf('image/')!==0 && !/\.(pdf|docx)$/i.test(selectedFile.name||''));
      if (invalid) {
        selectedFile = null;
        setBusy(elements.apply, true);
        setStatus('error', typeof invalid==='string'?invalid:'El archivo seleccionado no es una imagen o documento válido.');
        return false;
      }
      setBusy(elements.apply, true);
      setStatus('ready', 'Archivo listo para leer.');
      return true;
    }

    async function processSelectedImage() {
      if (reading || applying) return { ok: false, error: { code: 'OCR_BUSY', message: 'La operación ya está en curso.' } };
      if (!selectedFile) {
        setStatus('error', 'Selecciona una foto antes de iniciar la lectura.');
        return { ok: false, error: { code: 'IMAGE_REQUIRED', message: 'Imagen requerida.' } };
      }
      reading = true;
      currentBatch = null;
      clearSource();
      if (reviewController && typeof reviewController.destroy === 'function') reviewController.destroy();
      reviewController = null;
      closeReview();
      setBusy(elements.start, true);
      setBusy(elements.apply, true);
      setStatus('progress', 'Leyendo archivo…');
      try {
        var extracted = await deps.extract(selectedFile, {
          logger: function (progress) {
            if (!progress || typeof progress.progress !== 'number') return;
            setStatus('progress', (progress.status||'Leyendo archivo…')+' ' + Math.round(progress.progress * 100) + '%');
          },
        });
        if (!extracted || !extracted.ok) {
          var extractionError = extracted && extracted.error;
          setStatus('error', messageFrom(extractionError, 'No se pudo leer la imagen.'));
          return extracted || { ok: false, error: { code: 'OCR_FAILED', message: 'No se pudo leer la imagen.' } };
        }

        var processed = deps.process(extracted.rawText, { products: getProducts() });
        if (!processed || !processed.ok) {
          setStatus('error', 'No se pudieron preparar las propuestas de compra.');
          return processed || { ok: false, errors: [{ code: 'PROCESS_FAILED' }] };
        }
        if (!processed.proposals.length) {
          setStatus('error', 'No se detectaron líneas de compra en la imagen.');
          return { ok: false, errors: [{ code: 'NO_PURCHASE_LINES' }] };
        }

        if (reviewController && typeof reviewController.destroy === 'function') reviewController.destroy();
        if (elements.rawText) elements.rawText.textContent = extracted.rawText;
        showSource(selectedFile);
        reviewController = deps.createReview(elements.review, { proposals: processed.proposals }, {
          products: getProducts(),
        });
        currentBatch = {
          operationId: await createOperationId(selectedFile),
          extracted: extracted,
          processed: processed,
        };
        setBusy(elements.apply, false);
        setStatus('review', 'Verifica si los datos son correctos. Confirma o descarta cada fila antes de guardar.');
        openReview();
        return { ok: true, operationId: currentBatch.operationId, proposals: processed.proposals };
      } catch (error) {
        setStatus('error', messageFrom(error, 'El OCR falló de forma controlada.'));
        return { ok: false, error: { code: 'INTEGRATION_FAILED', message: messageFrom(error) } };
      } finally {
        reading = false;
        setBusy(elements.start, false);
      }
    }

    async function applyReviewed() {
      if (applying) return { ok: false, errors: [{ code: 'APPLY_BUSY' }] };
      if (reading) return { ok: false, errors: [{ code: 'OCR_BUSY' }] };
      if (!currentBatch || !reviewController) {
        setStatus('error', 'No hay una compra revisada para aplicar.');
        return { ok: false, errors: [{ code: 'REVIEW_REQUIRED' }] };
      }
      var reviewed = reviewController.getReviewedPurchaseProposals();
      if (reviewed.length !== currentBatch.processed.proposals.length) {
        setStatus('error', 'Confirma o descarta cada fila antes de aplicar.');
        return { ok: false, errors: [{ code: 'PENDING_HUMAN_REVIEW' }] };
      }
      var confirmed = reviewed.filter(function (row) { return row.decision === 'CONFIRMED'; });
      if (!confirmed.length) {
        setStatus('error', 'No hay filas confirmadas para aplicar.');
        return { ok: false, errors: [{ code: 'NO_CONFIRMED_ROWS' }] };
      }

      applying = true;
      setBusy(elements.apply, true);
      setStatus('progress', 'Aplicando compra confirmada…');
      try {
        var canonical = settings.canonicalInventory
          || (root && root.NuevoAmanecerCanonicalInventoryBridge) || null;
        var canonicalOn = false;
        try { canonicalOn = !!(canonical && typeof canonical.enabled === 'function' && canonical.enabled()); } catch (_) { canonicalOn = false; }
        // P0-2: in CANON the legacy local persistence is blocked by design; apply the
        // purchase through idempotent canonical inventory.adjust ENTRADA commands.
        var result = canonicalOn && typeof canonical.applyPurchase === 'function'
          ? await canonical.applyPurchase(reviewed, { operationId: currentBatch.operationId })
          : canonicalOn
            ? { ok: false, errors: [{ code: 'CANONICAL_OCR_UNAVAILABLE', message: 'La carga de compras por OCR no está disponible en CANON en esta versión. Registra cada producto con Entrada en Inventario.' }] }
            : await deps.apply(reviewed, {
          operationId: currentBatch.operationId,
          products: getProducts(),
          inventoryMovements: getMovements(),
          applyInventoryMovement: typeof applyInventoryMovement === 'function' ? applyInventoryMovement : null,
          saveAllData: typeof saveAllData === 'function' ? saveAllData : null,
          wasPersisted: typeof _naWasPersisted === 'function' ? _naWasPersisted : null,
          tracksStock: typeof _naTracksStock === 'function' ? _naTracksStock : null,
        });
        if (!result || !result.ok) {
          var errors = result && Array.isArray(result.errors) ? result.errors : [];
          var rollbackUnverified = errors.some(function (error) {
            return error && error.code === 'ROLLBACK_PERSISTENCE_NOT_VERIFIED';
          });
          var firstError = errors[0];
          if (result && result.canonical) {
            setStatus('error', messageFrom(firstError, 'No se pudo aplicar la compra en CANON.'));
            try { refreshInventory(); } catch (_) {}
            return result;
          }
          setStatus('error', rollbackUnverified
            ? 'El inventario se restauró en memoria, pero no se pudo verificar la persistencia del rollback.'
            : messageFrom(firstError, 'No se pudo aplicar la compra. El inventario fue restaurado.'));
          return result;
        }
        var appliedCount = Array.isArray(result.applied) ? result.applied.length : 0;
        var duplicateCount = Array.isArray(result.skipped) ? result.skipped.filter(function (row) {
          return row && row.reason === 'ALREADY_APPLIED';
        }).length : 0;
        setStatus('success', appliedCount
          ? 'Compra aplicada: ' + appliedCount + ' movimiento(s).'
          : (duplicateCount ? 'Esta compra ya había sido aplicada; no se duplicó inventario.' : 'No hubo movimientos para aplicar.'));
        closeReview();
        selectedFile = null;
        clearSource();
        currentBatch = null;
        if (reviewController && typeof reviewController.destroy === 'function') reviewController.destroy();
        reviewController = null;
        if (elements.review) elements.review.textContent = '';
        try { refreshInventory(); } catch (renderError) {
          setStatus('success', 'Compra guardada. Actualiza la vista para ver el inventario aplicado.');
        }
        return result;
      } catch (error) {
        setStatus('error', messageFrom(error, 'No se pudo aplicar la compra.'));
        return { ok: false, errors: [{ code: 'APPLY_FAILED', message: messageFrom(error) }] };
      } finally {
        applying = false;
        setBusy(elements.apply, false);
      }
    }

    function onFileChange(event) {
      var files = event && event.target && event.target.files;
      if(selectImage(files && files[0])) {
        if(event.target)event.target.value='';
        var chooser=byId(doc,'mOcrPurchaseSource');if(chooser)chooser.classList.remove('open');
        return processSelectedImage();
      }
    }

    function bind() {
      [elements.file,elements.camera,elements.documentFile].filter(Boolean).forEach(function(input){input.addEventListener('change',onFileChange);});
      if (elements.start) elements.start.addEventListener('click', processSelectedImage);
      if (elements.apply) elements.apply.addEventListener('click', applyReviewed);
      if (elements.close) elements.close.addEventListener('click', closeReview);
      setBusy(elements.apply, true);
      setStatus('idle', 'Toma una foto o sube una imagen, PDF o documento.');
    }

    function destroy() {
      [elements.file,elements.camera,elements.documentFile].filter(Boolean).forEach(function(input){input.removeEventListener('change',onFileChange);});
      clearSource();
      if (elements.start) elements.start.removeEventListener('click', processSelectedImage);
      if (elements.apply) elements.apply.removeEventListener('click', applyReviewed);
      if (elements.close) elements.close.removeEventListener('click', closeReview);
      if (reviewController && typeof reviewController.destroy === 'function') reviewController.destroy();
    }

    bind();
    return {
      selectImage: selectImage,
      processSelectedImage: processSelectedImage,
      applyReviewed: applyReviewed,
      closeReview: closeReview,
      destroy: destroy,
      getCurrentBatch: function () { return currentBatch; },
    };
  }

  function initPurchaseOcrIntegration() {
    var required = [
      'ocrPurchaseFile', 'ocrPurchaseStart', 'ocrPurchaseStatus', 'mOcrPurchaseReview',
      'ocrPurchaseRawText', 'ocrPurchaseReviewRows', 'ocrPurchaseApply', 'ocrPurchaseClose',
    ];
    for (var i = 0; i < required.length; i += 1) {
      if (!byId(root.document, required[i])) return null;
    }
    return createPurchaseOcrIntegration();
  }

  var api = {
    version: '1.0.0',
    createPurchaseOcrIntegration: createPurchaseOcrIntegration,
    initPurchaseOcrIntegration: initPurchaseOcrIntegration,
  };

  if (root) {
    root._NA_OCR_PURCHASE_INTEGRATION = api;
    root.createPurchaseOcrIntegration = createPurchaseOcrIntegration;
    if (root.document) {
      if (root.document.readyState === 'loading') {
        root.document.addEventListener('DOMContentLoaded', initPurchaseOcrIntegration, { once: true });
      } else initPurchaseOcrIntegration();
    }
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
