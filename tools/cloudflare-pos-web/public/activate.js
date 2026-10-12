(() => {
  'use strict';

  const CONFIG = globalThis.NA_HOSTED_CONFIG || null;
  const API = CONFIG && typeof CONFIG.apiOrigin === 'string' ? CONFIG.apiOrigin.replace(/\/+$/, '') : '';
  const ENVIRONMENT = CONFIG && CONFIG.environment;
  const HOSTED_HOST = CONFIG && CONFIG.hostedHost;
  const BINDING_KEY = 'na_canonical_binding';
  const CREDENTIALS_KEY = 'na_cloud_sync_credentials';
  const status = document.getElementById('status');
  const panel = document.getElementById('activatePanel');
  const input = document.getElementById('activationSecret');
  const activateButton = document.getElementById('activateButton');
  const openPos = document.getElementById('openPos');
  const retryButton = document.getElementById('retryButton');
  const pairPanel = document.getElementById('pairPanel');
  const pairCode = document.getElementById('pairCode');
  const pairButton = document.getElementById('pairButton');

  async function refreshShellOnly() {
    panel.hidden = true;
    openPos.hidden = true;
    retryButton.hidden = true;
    setStatus('Actualizando la interfaz del POS…');

    try {
      if ('serviceWorker' in navigator && typeof navigator.serviceWorker.getRegistrations === 'function') {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations
          .filter(registration => typeof registration.scope === 'string' &&
            registration.scope.startsWith(window.location.origin + '/app/'))
          .map(registration => registration.unregister()));
      }

      // Unregistering does not release workers controlling other open tabs.
      // Keep their shell files until the replacement worker activates safely.

      setStatus('Interfaz actualizada. Abriendo el POS con archivos nuevos…', 'ok');
      const nonce = Date.now().toString(36);
      window.location.replace('/app/?shell_refresh=' + encodeURIComponent(nonce));
    } catch (error) {
      console.warn('No se pudo refrescar el shell del POS.', error);
      setStatus('No se pudo actualizar la interfaz automáticamente. Vuelve a intentarlo.', 'error');
      retryButton.hidden = false;
    }
  }

  function validRuntimeConfig() {
    if (!CONFIG || !['production', 'staging'].includes(ENVIRONMENT) || typeof HOSTED_HOST !== 'string' || HOSTED_HOST !== window.location.hostname) return false;
    try {
      const url = new URL(API);
      return url.protocol === 'https:' && url.origin === API && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }

  function environmentName() {
    return ENVIRONMENT === 'staging' ? 'STAGING CANON' : 'CANON producción';
  }

  function setStatus(message, state = '') {
    status.textContent = message;
    status.dataset.state = state;
  }

  function clearSession() {
    localStorage.removeItem(BINDING_KEY);
    localStorage.removeItem(CREDENTIALS_KEY);
    localStorage.removeItem('na_pos_role_v1');
  }

  function showActivation(message) {
    setStatus(message, message.includes('incorrecta') || message.includes('falló') ? 'error' : '');
    panel.hidden = false;
    if (pairPanel) pairPanel.hidden = false;
    openPos.hidden = true;
    retryButton.hidden = false;
    input.focus();
  }

  function saveSession(token, authority) {
    const binding = {
      endpoint: API,
      promotion_id: authority.promotion_id,
      authority_epoch: authority.authority_epoch,
      revision: authority.revision,
    };
    localStorage.setItem(BINDING_KEY, JSON.stringify(binding));
    localStorage.setItem(CREDENTIALS_KEY, JSON.stringify({ endpoint: API, token }));
  }

  async function fetchAuthority(token) {
    const sessionResponse = await fetch(API + '/auth/session', {
      headers: { authorization: 'Bearer ' + token },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    if (!sessionResponse.ok) throw new Error('SESSION_INVALID');

    const response = await fetch(API + '/read/canonical/status', {
      headers: { authorization: 'Bearer ' + token },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.authority !== 'canonical' || body.mode !== 'ACTIVE' ||
        typeof body.promotion_id !== 'string' || !body.promotion_id ||
        !Number.isSafeInteger(body.authority_epoch) || !Number.isSafeInteger(body.revision)) {
      throw new Error('AUTHORITY_NOT_READY');
    }
    return body;
  }

  async function checkExisting() {
    panel.hidden = true;
    if (pairPanel) pairPanel.hidden = true;
    openPos.hidden = true;
    retryButton.hidden = true;
    setStatus('Comprobando sesión de este navegador…');

    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(CREDENTIALS_KEY) || 'null');
    } catch {
      saved = null;
    }
    if (!saved || saved.endpoint !== API || typeof saved.token !== 'string' || !saved.token) {
      clearSession();
      showActivation('Este navegador todavía no está activado.');
      return;
    }

    try {
      const authority = await fetchAuthority(saved.token);
      saveSession(saved.token, authority);
      setStatus(environmentName() + ' está activo. Puedes abrir el punto de venta.', 'ok');
      openPos.hidden = false;
    } catch {
      clearSession();
      showActivation('La sesión guardada ya no es válida. Activa este navegador nuevamente.');
    }
  }

  async function activate() {
    const secret = input.value;
    if (!secret || /[\r\n]/.test(secret)) {
      showActivation('Ingresa una clave de activación válida.');
      return;
    }
    activateButton.disabled = true;
    input.disabled = true;
    setStatus('Activando sesión segura…');
    try {
      const response = await fetch(API + '/auth/activate', {
        method: 'POST',
        headers: { 'x-activation-secret': secret },
        credentials: 'omit',
        redirect: 'error',
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        showActivation('La clave de activación es incorrecta.');
        return;
      }
      if (!response.ok || typeof body.session_token !== 'string' || !body.session_token) {
        showActivation('La activación falló. Vuelve a intentarlo.');
        return;
      }
      const authority = await fetchAuthority(body.session_token);
      saveSession(body.session_token, authority);
      localStorage.removeItem('na_pos_role_v1');
      input.value = '';
      panel.hidden = true;
      retryButton.hidden = true;
      setStatus('Activación correcta. ' + environmentName() + ' está listo.', 'ok');
      openPos.hidden = false;
    } catch {
      showActivation('No se pudo conectar con ' + environmentName() + '. Comprueba internet y vuelve a intentar.');
    } finally {
      activateButton.disabled = false;
      input.disabled = false;
      input.value = '';
    }
  }

  // Etapa 2 (G): un aparato de empleado se vincula con un código de un solo uso creado por el dueño.
  async function pair() {
    const code = String(pairCode.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 10) { showActivation('Escribe el código completo (10 letras y números).'); return; }
    pairButton.disabled = true; pairCode.disabled = true;
    setStatus('Vinculando este aparato…');
    try {
      const response = await fetch(API + '/auth/pair', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', redirect: 'error',
        body: JSON.stringify({ code }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) { showActivation('El código es incorrecto o ya venció. Pide uno nuevo al dueño.'); return; }
      if (!response.ok || typeof body.session_token !== 'string' || !body.session_token) { showActivation('La vinculación falló. Vuelve a intentarlo.'); return; }
      const authority = await fetchAuthority(body.session_token);
      saveSession(body.session_token, authority);
      try { localStorage.setItem('na_pos_role_v1', JSON.stringify({ role: 'empleado', at: Date.now() })); } catch {}
      panel.hidden = true; if (pairPanel) pairPanel.hidden = true; retryButton.hidden = true;
      setStatus('Aparato de empleado vinculado. ' + environmentName() + ' está listo.', 'ok');
      openPos.hidden = false;
    } catch {
      showActivation('No se pudo conectar con ' + environmentName() + '. Comprueba internet y vuelve a intentar.');
    } finally {
      pairButton.disabled = false; pairCode.disabled = false; pairCode.value = '';
    }
  }
  if (pairButton) {
    pairButton.addEventListener('click', pair);
    pairCode.addEventListener('keydown', event => { if (event.key === 'Enter') pair(); });
  }
  activateButton.addEventListener('click', activate);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') activate();
  });
  retryButton.addEventListener('click', checkExisting);
  const params = new URLSearchParams(window.location.search);
  if (!validRuntimeConfig()) {
    clearSession();
    panel.hidden = true;
    openPos.hidden = true;
    retryButton.hidden = true;
    input.disabled = true;
    activateButton.disabled = true;
    setStatus('Configuración segura del entorno no disponible. El POS permanece bloqueado.', 'error');
  } else if (params.get('refresh-shell') === '1') refreshShellOnly();
  else checkExisting();
})();
