import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { boundedJson } from './weather';

export interface OwnerConfiguration { teamDomain: string; audience: string; email: string; }

export function validOwnerConfiguration(config: OwnerConfiguration): boolean {
  return /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/.test(config.teamDomain) &&
    /^[a-f0-9]{64}$/.test(config.audience) && config.email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email);
}

interface OwnerDependencies {
  fetcher?: typeof fetch;
  cache?: Pick<Cache, 'match' | 'put'>;
  now?: Date;
}

/** Verify an Access application JWT, not a forwarded email or client-supplied issuer. */
export async function verifyOwner(request: Request, config: OwnerConfiguration, dependencies: OwnerDependencies = {}): Promise<boolean> {
  if (!validOwnerConfiguration(config)) return false;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 8192) return false;
  const certUrl = new URL(`${config.teamDomain}/cdn-cgi/access/certs`);
  const fetcher = dependencies.fetcher || fetch.bind(globalThis);
  try {
    const keys = createRemoteJWKSet(certUrl, {
      timeoutDuration: 5000,
      [customFetch]: async (input) => {
        if (String(input) !== certUrl.href) throw new Error('invalid_key_origin');
        const cacheKey = new Request(certUrl);
        if (dependencies.cache) {
          try {
            const cached = await dependencies.cache.match(cacheKey);
            if (cached) {
              const value = await boundedJson(cached, 32768);
              return Response.json(value);
            }
          } catch {
            // Only public certificates are cached. Cache failure must not grant identity.
          }
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetcher(certUrl.href, {
            method: 'GET', redirect: 'manual',
            headers: { Accept: 'application/json' }, signal: controller.signal,
          });
          if (response.status !== 200 || response.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
            await response.body?.cancel().catch(() => undefined);
            throw new Error('key_service_unavailable');
          }
          const value = await boundedJson(response, 32768);
          const result = Response.json(value, { headers: { 'Cache-Control': 'public, max-age=300' } });
          if (dependencies.cache) {
            try { await dependencies.cache.put(cacheKey, result.clone()); } catch { /* Certificates can be fetched without the optional public cache. */ }
          }
          return result;
        } finally {
          clearTimeout(timeout);
        }
      },
    });
    const now = dependencies.now || new Date();
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.teamDomain, audience: config.audience, algorithms: ['RS256'],
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'email', 'type'],
      currentDate: now, clockTolerance: 0,
    });
    return payload.type === 'app' && typeof payload.sub === 'string' && payload.sub.length > 0 &&
      payload.sub.length <= 256 && typeof payload.iat === 'number' && payload.iat <= now.getTime() / 1000 &&
      typeof payload.email === 'string' && payload.email.toLowerCase() === config.email.toLowerCase();
  } catch {
    // Tokens, provider URLs, claims and cryptographic exceptions never enter logs/errors.
    return false;
  }
}
