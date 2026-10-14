function withNoStore(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function canonicalBackendOrigin(env) {
  const raw = String(env.CANON_API_ORIGIN || '').replace(/\/+$/, '');
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.origin !== raw || url.username || url.password || url.search || url.hash) return '';
    return raw;
  } catch {
    return '';
  }
}

function isCanonicalApiPath(pathname) {
  return pathname === '/health' ||
    pathname === '/settings' ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/read/') ||
    pathname.startsWith('/commands/') ||
    pathname.startsWith('/imports/') ||
    pathname === '/sync/operations' ||
    pathname.startsWith('/sync/operations/');
}

async function proxyCanonical(request, env) {
  const backend = canonicalBackendOrigin(env);
  const service = env.CANON_BACKEND;
  if (!backend || !service || typeof service.fetch !== 'function') {
    return withNoStore(new Response(JSON.stringify({ error: 'canonical_proxy_not_configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }));
  }
  return withNoStore(await service.fetch(request));
}

function runtimeConfig(request, env) {
  const environment = String(env.HOSTED_ENVIRONMENT || '');
  const backendOrigin = canonicalBackendOrigin(env);
  const hostedOrigin = new URL(request.url).origin;
  const valid = ['production', 'staging'].includes(environment) && !!backendOrigin &&
    env.CANON_BACKEND && typeof env.CANON_BACKEND.fetch === 'function';

  if (!valid) {
    return withNoStore(new Response(
      "throw new Error('NA_HOSTED_CONFIG_INVALID');\n",
      { status: 503, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } }
    ));
  }

  const hostedHost = new URL(request.url).hostname;
  const body = 'globalThis.NA_HOSTED_CONFIG=Object.freeze(' +
    JSON.stringify({ environment, apiOrigin: hostedOrigin, hostedHost }) + ');\n';
  return withNoStore(new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
  }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/runtime-config.js') return runtimeConfig(request, env);
    if (isCanonicalApiPath(url.pathname)) return proxyCanonical(request, env);
    if (url.pathname === '/') {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = '/index.html';
      return withNoStore(await env.ASSETS.fetch(new Request(assetUrl, request)));
    }
    if (url.pathname === '/app' || url.pathname === '/app/') {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = '/app/index.html';
      return withNoStore(await env.ASSETS.fetch(new Request(assetUrl, request)));
    }
    const response = await env.ASSETS.fetch(request);
    return (url.pathname.startsWith('/app/') || url.pathname === '/activate.js' || url.pathname === '/index.html')
      ? withNoStore(response)
      : response;
  },
};
