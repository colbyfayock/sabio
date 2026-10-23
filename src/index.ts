import { getWeatherForZip, requestZip, WeatherError } from './weather';
import {
  cleanupExpired,
  getDisplaySession,
  handleAccessRequest,
  limitDisplayBootstrap,
  limitDisplayWeather,
  refreshDisplaySession,
  type DisplaySessionNotice,
} from './access';
import { validOwnerConfiguration, verifyOwner } from './owner';
import { recordDisplayCheckIn, recordDisplayWeatherArea } from './display-metadata';
import { notifyNewDisplay } from './notifications';

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
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

function localPreview(request: Request, env: Env): boolean {
  return (env.APP_MODE || 'preview') === 'preview' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(request.url).hostname);
}

function managedOrigins(env: Env): string[] {
  const configured = env.APP_ALLOWED_ORIGINS?.trim()
    ? env.APP_ALLOWED_ORIGINS.split(',').map((value) => value.trim())
    : [env.APP_ORIGIN];
  if (configured.length < 1 || configured.length > 4 || configured.some((value) => {
    try {
      const url = new URL(value);
      return url.protocol !== 'https:' || url.origin !== value || url.pathname !== '/'
        || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '';
    } catch {
      return true;
    }
  })) return [];
  const unique = Array.from(new Set(configured));
  return unique.length === configured.length ? unique : [];
}

function isManagedOrigin(request: Request, env: Env): boolean {
  try {
    return managedOrigins(env).includes(new URL(request.url).origin);
  } catch {
    return false;
  }
}

function managedConfiguration(env: Env): boolean {
  try {
    const url = new URL(env.APP_ORIGIN);
    return env.APP_MODE === 'managed' && url.protocol === 'https:' && url.origin === env.APP_ORIGIN &&
      url.pathname === '/' && !url.search && !url.hash && managedOrigins(env).includes(env.APP_ORIGIN) && Boolean(env.DB) &&
      validOwnerConfiguration({ teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUDIENCE, email: env.OWNER_EMAIL });
  } catch { return false; }
}

function secure(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  headers.set('Cache-Control', 'no-store');
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
}

async function owner(request: Request, env: Env): Promise<boolean> {
  return verifyOwner(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUDIENCE, email: env.OWNER_EMAIL }, {
    cache: typeof caches === 'undefined' ? undefined : caches.default,
  });
}

/** All requests enter the Worker first; only explicitly listed static assets escape API routing. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return json(request, { error: 'invalid_path' }, 400);
    }

    if (path === '/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json(request, { error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD' });
      }
      return json(request, { status: 'ok', mode: env.APP_MODE === 'managed' ? 'managed' : 'preview', authentication: managedConfiguration(env) ? 'required' : 'not_configured' });
    }

    if (path === '/api/bootstrap') {
      if (request.method !== 'GET') return json(request, { error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      if (localPreview(request, env)) return json(request, { mode: 'preview' });
      if (!managedConfiguration(env)) return json(request, { error: 'access_not_configured' }, 503);
      if (!isManagedOrigin(request, env)) return json(request, { error: 'origin_not_allowed' }, 403);
      try {
        const session = await getDisplaySession(request, env.DB);
        if (!session) return json(request, { mode: 'managed', enrolled: false });
        if (!await limitDisplayBootstrap(request, env.DB, session.id)) {
          return json(request, { error: 'rate_limited' }, 429, { 'Retry-After': '60' });
        }
        const refreshedCookie = await refreshDisplaySession(request, env.DB, session);
        await recordDisplayCheckIn(request, env.DB, session.id);
        return json(request, { mode: 'managed', enrolled: true }, 200,
          refreshedCookie ? { 'Set-Cookie': refreshedCookie } : {});
      } catch { return json(request, { error: 'access_unavailable' }, 503); }
    }

    if (['/api/enrollment', '/api/admin', '/api/display'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      if (env.APP_MODE === 'managed') {
        if (!managedConfiguration(env)) return json(request, { error: 'access_not_configured' }, 503);
        if (!isManagedOrigin(request, env)) return json(request, { error: 'origin_not_allowed' }, 403);
        const requestOrigin = new URL(request.url).origin;
        const notifyDisplay = (notice: DisplaySessionNotice): Promise<void> => {
          // Notification is optional: preview and unconfigured deployments stay silent.
          if (!env.EMAIL || !env.NOTIFY_FROM_EMAIL) return Promise.resolve();
          const delivery = notifyNewDisplay({
            email: env.EMAIL,
            ownerEmail: env.OWNER_EMAIL,
            fromEmail: env.NOTIFY_FROM_EMAIL,
            adminUrl: `${requestOrigin}/admin`,
          }, notice).then((sent) => {
            if (!sent) console.warn(JSON.stringify({ event: 'display_notification_failed' }));
          });
          if (typeof ctx?.waitUntil === 'function') {
            ctx.waitUntil(delivery);
            return Promise.resolve();
          }
          return delivery;
        };
        const response = await handleAccessRequest(request, env.DB, (candidate) => owner(candidate, env), requestOrigin, notifyDisplay);
        return secure(request, response || json(request, { error: 'not_found' }, 404));
      }
      if (path === '/api/display' || path.startsWith('/api/display/')) return json(request, { error: 'display_access_unavailable' }, 401);
      return json(request, { error: 'not_implemented' }, 503);
    }

    if (path === '/api/weather') {
      if (request.method !== 'POST') return json(request, { error: 'method_not_allowed' }, 405, { Allow: 'POST' });
      const url = new URL(request.url);
      if (url.search) return json(request, { error: 'invalid_request' }, 400);
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return json(request, { error: 'origin_not_allowed' }, 403);
      try {
        const zipCode = await requestZip(request);
        let displayId: string | null = null;
        if (!localPreview(request, env)) {
          if (!managedConfiguration(env)) return json(request, { error: 'access_not_configured' }, 503);
          if (!isManagedOrigin(request, env) || origin !== url.origin) return json(request, { error: 'origin_not_allowed' }, 403);
          const session = await getDisplaySession(request, env.DB);
          if (!session) return json(request, { error: 'display_access_required' }, 401);
          if (!await limitDisplayWeather(request, env.DB, session.id)) return json(request, { error: 'rate_limited' }, 429, { 'Retry-After': '60' });
          displayId = session.id;
        }
        const weather = await getWeatherForZip(zipCode, {
          cache: typeof caches === 'undefined' ? undefined : caches.default,
          origin: url.origin,
        });
        if (displayId) {
          try { await recordDisplayWeatherArea(env.DB, displayId, weather.locationLabel, weather.timeZone); }
          catch { /* Optional admin descriptions must not hide a valid weather response. */ }
        }
        return json(request, weather);
      } catch (error) {
        if (error instanceof WeatherError) {
          return json(request, { error: error.code }, error.status,
            error.status === 429 ? { 'Retry-After': '600' } : {});
        }
        return json(request, { error: 'weather_unavailable' }, 502);
      }
    }

    if (path === '/admin') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(request, { error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD' });
      if (!managedConfiguration(env)) return json(request, { error: 'not_implemented' }, 503);
      if (!isManagedOrigin(request, env)) return json(request, { error: 'origin_not_allowed' }, 403);
      try {
        // Reuse the API's bounded owner-verification path before serving the admin shell.
        const requestOrigin = new URL(request.url).origin;
        const check = new Request(new URL('/api/admin/displays', requestOrigin), { headers: request.headers });
        const approval = await handleAccessRequest(check, env.DB, (candidate) => owner(candidate, env), requestOrigin);
        if (!approval || approval.status !== 200) return secure(request, approval || json(request, { error: 'owner_access_required' }, 403));
        const url = new URL('/admin.html', requestOrigin);
        return secure(request, await env.ASSETS.fetch(new Request(url, { method: request.method })));
      } catch { return json(request, { error: 'admin_unavailable' }, 503); }
    }
    if (['/admin', '/auth'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      return json(request, { error: 'not_implemented' }, 503);
    }
    if (path === '/api' || path.startsWith('/api/')) {
      return json(request, { error: 'not_found' }, 404);
    }

    if (!['/', '/index.html', '/styles.css', '/app.js', '/admin.js', '/favicon.svg'].includes(path)) {
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

  /**
   * Bounded retention independent of request traffic. Expired rows are already denied
   * by every authorization query, so this only reclaims storage.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (!env.DB) return;
    try {
      await cleanupExpired(env.DB);
    } catch {
      console.error(JSON.stringify({ event: 'scheduled_cleanup_failed' }));
    }
  },
} satisfies ExportedHandler<Env>;
