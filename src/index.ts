import { createDemoDashboard } from './demo';

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function json(request: Request, value: object, status = 200, extraHeaders = {}): Response {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(value), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

/** All requests enter the Worker first; only explicitly listed static assets escape API routing. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return json(request, { error: 'invalid_path' }, 400);
    }

    if (path === '/api/demo' || path === '/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json(request, { error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD' });
      }
      return json(request, path === '/health'
        ? { status: 'ok', mode: 'demo', authentication: 'not_implemented' }
        : createDemoDashboard());
    }

    // No cookie, query string, or forged identity header enables private access in this milestone.
    if (path === '/api/display' || path.startsWith('/api/display/')) {
      return json(request, { error: 'display_access_unavailable', message: 'Display authentication is not implemented.' }, 401);
    }
    if (['/api/enrollment', '/api/admin', '/admin', '/auth'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      return json(request, { error: 'not_implemented' }, 503);
    }
    if (path === '/api' || path.startsWith('/api/')) {
      return json(request, { error: 'not_found' }, 404);
    }

    if (!['/', '/index.html', '/styles.css', '/app.js', '/favicon.svg'].includes(path)) {
      return json(request, { error: 'not_found' }, 404);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(request, { error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD' });
    }

    try {
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
      headers.set('Cache-Control', 'no-store');
      return new Response(request.method === 'HEAD' ? null : asset.body, {
        status: asset.status,
        statusText: asset.statusText,
        headers,
      });
    } catch {
      // Never log untrusted request URLs, headers, response bodies, or runtime exception contents.
      console.error(JSON.stringify({ event: 'asset_fetch_failed' }));
      return json(request, { error: 'temporarily_unavailable' }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
