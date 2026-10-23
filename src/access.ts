import { boundedJson } from './weather';
import { describeBrowser } from './display-metadata';

interface EnrollmentRow {
  id: string;
  display_id: string;
  status: string;
}

interface CountRow {
  count: number;
}

interface DisplayRow {
  id: string;
  name: string | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  deviceType: string;
  browserLabel: string | null;
  osLabel: string | null;
  lastSeenAt: number | null;
  weatherLocation: string | null;
  weatherTimeZone: string | null;
  weatherLocationAt: number | null;
}

const PENDING_COOKIE = '__Host-sabio_pending';
const DISPLAY_COOKIE = '__Host-sabio_display';
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_LENGTH = 10;
const MAX_BODY_BYTES = 512;
const ENROLLMENT_SECONDS = 10 * 60;
// A display session stays valid while it keeps checking in. Renewal is a sliding
// idle window: seven days without an authenticated request requires pairing again.
const SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_RENEW_SECONDS = 24 * 60 * 60;
const RATE_MINUTE_SECONDS = 60;
const RATE_HOUR_SECONDS = 60 * 60;

function json(value: object, status = 200, headers: HeadersInit = {}, setCookies: string[] = []): Response {
  const responseHeaders = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  new Headers(headers).forEach((headerValue, name) => responseHeaders.set(name, headerValue));
  for (const value of setCookies) responseHeaders.append('Set-Cookie', value);
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
}

function errorResponse(status: number, error: string, headers: HeadersInit = {}): Response {
  return json({ error }, status, headers);
}

function validCanonicalOrigin(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isAccessPath(path: string): boolean {
  return path === '/api/enrollment'
    || path.startsWith('/api/enrollment/')
    || path === '/api/admin'
    || path.startsWith('/api/admin/')
    || path === '/api/display'
    || path.startsWith('/api/display/');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function opaqueToken(): string {
  return hex(randomBytes(32));
}

function pairingCode(): string {
  let code = '';
  while (code.length < PAIRING_LENGTH) {
    for (const byte of randomBytes(16)) {
      // Reject the top 32 values so reducing a byte to 5 bits is unbiased.
      if (byte >= 224) continue;
      code += PAIRING_ALPHABET[byte & 31];
      if (code.length === PAIRING_LENGTH) break;
    }
  }
  return code;
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  let found: string | null = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    if (found !== null) return null;
    const value = part.slice(separator + 1).trim();
    if (!/^[a-f0-9]{64}$/.test(value)) return null;
    found = value;
  }
  return found;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

function deletedCookie(name: string): string {
  return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

async function readEmptyJson(request: Request): Promise<boolean> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim())) return false;
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return false;
  if (!request.body) return false;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
  } catch {
    return false;
  }

  try {
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

async function readAdminBody(request: Request): Promise<Record<string, string> | null> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim())) return null;
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  try {
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const object = parsed as Record<string, unknown>;
    if (Object.keys(object).length !== 1) return null;
    const [key] = Object.keys(object);
    if (typeof object[key] !== 'string') return null;
    return { [key]: object[key] as string };
  } catch {
    return null;
  }
}

async function readDisplayNameBody(request: Request): Promise<{ id: string; name: string | null } | null> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim())) return null;
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return null;
  if (!request.body) return null;
  let value: unknown;
  try {
    value = await boundedJson(request, MAX_BODY_BYTES);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 2 || Object.keys(object).some((key) => !['id', 'name'].includes(key)) ||
      typeof object.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(object.id) ||
      typeof object.name !== 'string' || object.name.length > 80 || /[<>\u0000-\u001f\u007f]/.test(object.name)) return null;
  const name = object.name.trim();
  return { id: object.id, name: name ? name : null };
}

/**
 * Bounded housekeeping batch. Every statement deletes at most 25/50 rows and every
 * caller must be an admitted request or the scheduled handler, never an
 * unauthenticated or rejected request.
 */
export async function cleanupExpired(db: D1Database, now: number = nowSeconds()): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM access_enrollments
      WHERE id IN (SELECT id FROM access_enrollments
        WHERE status = 'pending' AND expires_at <= ? LIMIT 25)`).bind(now),
    db.prepare(`UPDATE access_enrollments SET pending_hash = NULL
      WHERE id IN (SELECT id FROM access_enrollments
        WHERE status = 'approved' AND expires_at <= ? AND pending_hash IS NOT NULL LIMIT 25)`).bind(now),
    db.prepare(`DELETE FROM access_display_sessions
      WHERE token_hash IN (SELECT s.token_hash FROM access_display_sessions s
        JOIN access_displays d ON d.id = s.display_id
        WHERE s.expires_at <= ? OR d.expires_at <= ? LIMIT 25)`).bind(now, now),
    db.prepare(`DELETE FROM access_displays
      WHERE id IN (SELECT d.id FROM access_displays d WHERE d.expires_at <= ?
        AND NOT EXISTS (SELECT 1 FROM access_display_sessions s WHERE s.display_id = d.id) LIMIT 25)`).bind(now),
    db.prepare(`DELETE FROM access_enrollments
      WHERE id IN (SELECT e.id FROM access_enrollments e WHERE e.expires_at <= ?
        AND NOT EXISTS (SELECT 1 FROM access_displays d WHERE d.enrollment_id = e.id) LIMIT 25)`).bind(now),
    db.prepare(`DELETE FROM access_rate_limits
      WHERE (bucket_key, window_start) IN (
        SELECT bucket_key, window_start FROM access_rate_limits WHERE expires_at <= ? LIMIT 50
      )`).bind(now),
  ]);
}

/**
 * Housekeeping for requests that already passed admission and authorization.
 * Failures are swallowed so housekeeping can never change an admitted response.
 */
async function admittedCleanup(db: D1Database, now: number): Promise<void> {
  try {
    await cleanupExpired(db, now);
  } catch {
    // Retention is best effort on request paths; the scheduled handler retries.
  }
}

async function takeRateLimit(
  db: D1Database,
  key: string,
  now: number,
  windowSeconds: number,
  limit: number,
): Promise<boolean> {
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const row = await db.prepare(`INSERT INTO access_rate_limits (bucket_key, window_start, count, expires_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT (bucket_key, window_start) DO UPDATE SET
      count = access_rate_limits.count + 1
    WHERE access_rate_limits.count < ?
    RETURNING count`).bind(key, windowStart, windowStart + windowSeconds, limit).first<CountRow>();
  return row !== null && row.count <= limit;
}

async function hasRateBudget(db: D1Database, key: string, now: number, windowSeconds: number, limit: number): Promise<boolean> {
  const row = await db.prepare('SELECT count FROM access_rate_limits WHERE bucket_key = ? AND window_start = ?')
    .bind(key, Math.floor(now / windowSeconds) * windowSeconds).first<CountRow>();
  return row === null || row.count < limit;
}

function validIp(value: string): { value: string; loopback: boolean } | null {
  const ip = value.trim();
  if (!ip || ip !== value || ip.includes(',') || /[^0-9a-fA-F:.]/.test(ip)) return null;
  if (ip.includes(':')) {
    try {
      const parsed = new URL(`https://[${ip}]/`);
      if (!parsed.hostname.startsWith('[')) return null;
      return { value: ip.toLowerCase(), loopback: ip.toLowerCase() === '::1' };
    } catch {
      return null;
    }
  }
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  const normalized = parts.map(Number).join('.');
  return { value: normalized, loopback: Number(parts[0]) === 127 };
}

function routeMethod(request: Request, expected: string): Response | null {
  if (request.method === expected) return null;
  return errorResponse(405, 'method_not_allowed', { Allow: expected });
}

function databaseError(): Response {
  return errorResponse(503, 'temporarily_unavailable');
}

/** Handle only access routes. Unrelated requests return null for the caller to route. */
export interface DisplaySessionNotice {
  displayId: string;
  at: number;
  browser: string | null;
  os: string | null;
  location: string | null;
}

/**
 * Coarse, non-persistent location from Cloudflare's request metadata. City, region
 * and country only; never carry IP, postal code or coordinates into the notification.
 */
function requestLocation(request: Request): string | null {
  const cf = (request as Request & { cf?: { city?: unknown; region?: unknown; country?: unknown } }).cf;
  if (!cf) return null;
  const parts = [cf.city, cf.region, cf.country]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().slice(0, 80));
  return parts.length > 0 ? parts.join(', ') : null;
}

export async function handleAccessRequest(
  request: Request,
  db: D1Database,
  verifyAdmin: (request: Request) => Promise<boolean>,
  origin: string,
  notifyDisplay?: (notice: DisplaySessionNotice) => Promise<void>,
): Promise<Response | null> {
  let url: URL;
  let decodedPath: string;
  try {
    url = new URL(request.url);
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (!isAccessPath(decodedPath)) return null;

  const canonical = validCanonicalOrigin(origin);
  if (!canonical || url.origin !== canonical.origin) return errorResponse(403, 'origin_not_allowed');
  const requestOrigin = request.headers.get('Origin');
  if (requestOrigin !== null && requestOrigin !== canonical.origin) return errorResponse(403, 'origin_not_allowed');
  if (url.search || url.href.includes('?') || url.hash) return errorResponse(400, 'invalid_request');
  if (decodedPath !== url.pathname) return errorResponse(400, 'invalid_request');

  const route = decodedPath;
  const isMutation = request.method === 'POST'
    && ['/api/enrollment', '/api/enrollment/complete', '/api/admin/approve', '/api/admin/revoke', '/api/admin/label'].includes(route);
  if (isMutation && request.headers.get('Origin') !== canonical.origin) {
    return errorResponse(403, 'origin_not_allowed');
  }

  const knownRoutes: Record<string, string> = {
    '/api/enrollment': 'POST',
    '/api/enrollment/complete': 'POST',
    '/api/admin/displays': 'GET',
    '/api/admin/approve': 'POST',
    '/api/admin/revoke': 'POST',
    '/api/admin/label': 'POST',
    '/api/display': 'GET',
  };
  const expectedMethod = knownRoutes[route];
  if (!expectedMethod) return errorResponse(404, 'not_found');
  const methodError = routeMethod(request, expectedMethod);
  if (methodError) return methodError;

  if (route === '/api/display') {
    try {
      const session = await readDisplaySession(request, db);
      return session
        ? json({ displayId: session.id, expiresAt: session.expiresAt })
        : errorResponse(401, 'display_access_denied');
    } catch {
      return databaseError();
    }
  }

  try {
    const now = nowSeconds();

    if (route === '/api/enrollment') {
      if (!await readEmptyJson(request)) return errorResponse(400, 'invalid_request');
      const ipHeader = request.headers.get('CF-Connecting-IP');
      const ip = ipHeader === null ? null : validIp(ipHeader);
      if (!ip) return errorResponse(403, 'origin_not_allowed');
      const ipHash = await hash(`access-ip:${ip.value}`);
      // Reject a full global budget before creating IP rows; only admitted IP attempts
      // consume the global quota, so one blocked client cannot drain it repeatedly.
      if (!await hasRateBudget(db, 'enrollment-global', now, RATE_HOUR_SECONDS, 50)
        || !await takeRateLimit(db, `enrollment-ip:${ipHash}`, now, RATE_HOUR_SECONDS, 5)
        || !await takeRateLimit(db, 'enrollment-global', now, RATE_HOUR_SECONDS, 50)) {
        return errorResponse(429, 'rate_limited', { 'Retry-After': String(RATE_HOUR_SECONDS) });
      }

      const pendingToken = opaqueToken();
      const pendingHash = await hash(`pending:${pendingToken}`);
      let code = '';
      let codeHash = '';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        code = pairingCode();
        codeHash = await hash(`pairing:${code}`);
        const existing = await db.prepare('SELECT id FROM access_enrollments WHERE code_hash = ? LIMIT 1')
          .bind(codeHash).first<{ id: string }>();
        if (!existing) break;
        code = '';
      }
      if (!code) return databaseError();
      const displayId = crypto.randomUUID();
      const enrollmentId = crypto.randomUUID();
      const expiresAt = now + ENROLLMENT_SECONDS;
      await db.prepare(`INSERT INTO access_enrollments
        (id, display_id, pending_hash, code_hash, created_at, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
        .bind(enrollmentId, displayId, pendingHash, codeHash, now, expiresAt).run();
      // Housekeeping runs only for an admitted, rate-limited enrollment request.
      await admittedCleanup(db, now);
      return json({ code, expiresAt }, 201, {}, [cookie(PENDING_COOKIE, pendingToken, ENROLLMENT_SECONDS)]);
    }

    if (route === '/api/enrollment/complete') {
      if (!await readEmptyJson(request)) return errorResponse(400, 'invalid_request');
      const pendingToken = readCookie(request, PENDING_COOKIE);
      if (!pendingToken) return errorResponse(401, 'enrollment_access_denied');
      const pendingHash = await hash(`pending:${pendingToken}`);
      const enrollment = await db.prepare(`SELECT id, display_id, status FROM access_enrollments
        WHERE pending_hash = ? AND expires_at > ? LIMIT 1`).bind(pendingHash, now).first<EnrollmentRow>();
      if (!enrollment) return errorResponse(401, 'enrollment_access_denied');
      const pollKey = await hash(`pending-poll:${pendingHash}`);
      if (!await takeRateLimit(db, `poll:${pollKey}`, now, RATE_MINUTE_SECONDS, 60)) {
        return errorResponse(429, 'rate_limited', { 'Retry-After': String(RATE_MINUTE_SECONDS) });
      }
      if (enrollment.status === 'pending') {
        return json({ status: 'pending' }, 202);
      }
      if (enrollment.status !== 'approved') return errorResponse(401, 'enrollment_access_denied');

      const sessionToken = opaqueToken();
      const sessionHash = await hash(`session:${sessionToken}`);
      const claim = crypto.randomUUID();
      const batch = await db.batch<Record<string, unknown>>([
        db.prepare(`INSERT INTO access_display_sessions (token_hash, display_id, issued_at, expires_at)
          SELECT ?, d.id, ?, d.expires_at FROM access_displays d
          JOIN access_enrollments e ON e.id = d.enrollment_id
          WHERE e.pending_hash = ? AND e.status = 'approved' AND e.expires_at > ?
            AND d.revoked_at IS NULL AND d.expires_at > ?
            AND NOT EXISTS (SELECT 1 FROM access_display_sessions s WHERE s.display_id = d.id)
          RETURNING token_hash, expires_at`).bind(sessionHash, now, pendingHash, now, now),
        db.prepare(`UPDATE access_enrollments SET status = 'consumed', consumed_at = ?, consume_claim = ?, pending_hash = NULL
          WHERE pending_hash = ? AND status = 'approved' AND expires_at > ?
            AND EXISTS (SELECT 1 FROM access_display_sessions s JOIN access_displays d ON d.id = s.display_id
              WHERE s.token_hash = ? AND s.display_id = access_enrollments.display_id
                AND s.expires_at > ? AND d.revoked_at IS NULL AND d.expires_at > ?)
          RETURNING id, display_id`).bind(now, claim, pendingHash, now, sessionHash, now, now),
      ]);
      const issuedSession = batch[0]?.results?.[0];
      const sessionExpiresAt = issuedSession?.expires_at;
      if (!issuedSession || typeof sessionExpiresAt !== 'number' || !Number.isSafeInteger(sessionExpiresAt)
        || batch[1]?.results?.length !== 1) {
        return errorResponse(401, 'enrollment_access_denied');
      }
      if (notifyDisplay) {
        const consumed = batch[1]?.results?.[0];
        const displayId = consumed && typeof consumed.display_id === 'string' ? consumed.display_id : null;
        if (displayId) {
          const description = describeBrowser(request.headers.get('User-Agent'));
          try {
            await notifyDisplay({
              displayId,
              at: now,
              browser: description.browser,
              os: description.os,
              location: requestLocation(request),
            });
          } catch {
            // A notification failure must never undo an issued session.
          }
        }
      }
      return json({ status: 'approved' }, 200, {}, [
        cookie(DISPLAY_COOKIE, sessionToken, sessionExpiresAt - now),
        deletedCookie(PENDING_COOKIE),
      ]);
    }

    const adminIpHeader = request.headers.get('CF-Connecting-IP');
    const adminIp = adminIpHeader === null ? null : validIp(adminIpHeader);
    if (!adminIp) return errorResponse(403, 'origin_not_allowed');
    const adminIpHash = await hash(`access-ip:${adminIp.value}`);
    if (!await hasRateBudget(db, 'admin-verify-global', now, RATE_MINUTE_SECONDS, 200)
      || !await takeRateLimit(db, `admin-verify-ip:${adminIpHash}`, now, RATE_MINUTE_SECONDS, 30)
      || !await takeRateLimit(db, 'admin-verify-global', now, RATE_MINUTE_SECONDS, 200)) {
      return errorResponse(429, 'rate_limited', { 'Retry-After': String(RATE_MINUTE_SECONDS) });
    }

    let isAdmin = false;
    try {
      isAdmin = await verifyAdmin(request);
    } catch {
      return databaseError();
    }
    if (!isAdmin) return errorResponse(401, 'admin_access_denied');

    // Owner-authenticated traffic is bounded by the verification budget above.
    await admittedCleanup(db, now);

    if (route === '/api/admin/displays') {
      const result = await db.prepare(`SELECT d.id AS id, d.display_name AS name, d.created_at AS createdAt,
        d.expires_at AS expiresAt, d.revoked_at AS revokedAt,
        d.device_type AS deviceType, d.browser_label AS browserLabel, d.os_label AS osLabel,
        d.last_seen_at AS lastSeenAt, d.weather_location AS weatherLocation,
        d.weather_time_zone AS weatherTimeZone, d.weather_location_at AS weatherLocationAt
        FROM access_displays d ORDER BY d.created_at DESC LIMIT 100`).all<DisplayRow>();
      return json({ displays: result.results.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        revoked: row.revokedAt !== null,
        revokedAt: row.revokedAt,
        device: { type: row.deviceType, browser: row.browserLabel, os: row.osLabel },
        lastSeenAt: row.lastSeenAt,
        weatherArea: row.weatherLocation ? { label: row.weatherLocation, timeZone: row.weatherTimeZone, updatedAt: row.weatherLocationAt } : null,
      })) });
    }

    const ownerKey = 'admin-owner';
    if (!await takeRateLimit(db, ownerKey, now, RATE_MINUTE_SECONDS, 30)) {
      return errorResponse(429, 'rate_limited', { 'Retry-After': String(RATE_MINUTE_SECONDS) });
    }

    if (route === '/api/admin/label') {
      const body = await readDisplayNameBody(request);
      if (!body) return errorResponse(400, 'invalid_request');
      const updated = await db.prepare(`UPDATE access_displays SET display_name = ?
        WHERE id = ? AND revoked_at IS NULL AND expires_at > ? RETURNING id`)
        .bind(body.name, body.id, now).first<{ id: string }>();
      if (!updated) return errorResponse(404, 'display_not_found');
      return json({ status: 'updated', name: body.name });
    }

    const body = await readAdminBody(request);
    if (!body) return errorResponse(400, 'invalid_request');

    if (route === '/api/admin/approve') {
      const code = body.code;
      if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/.test(code)) return errorResponse(400, 'invalid_request');
      const codeHash = await hash(`pairing:${code}`);
      const claim = crypto.randomUUID();
      const expiresAt = now + SESSION_IDLE_SECONDS;
      const batch = await db.batch([
        db.prepare(`UPDATE access_enrollments SET status = 'approved', approved_at = ?, approval_claim = ?, code_hash = NULL
          WHERE code_hash = ? AND status = 'pending' AND expires_at > ?
          RETURNING id, display_id`).bind(now, claim, codeHash, now),
        db.prepare(`INSERT INTO access_displays (id, enrollment_id, created_at, expires_at)
          SELECT display_id, id, ?, ? FROM access_enrollments
          WHERE status = 'approved' AND approval_claim = ?
          RETURNING id`).bind(now, expiresAt, claim),
      ]);
      if (!batch[1]?.results || batch[1].results.length !== 1) return errorResponse(404, 'enrollment_not_found');
      return json({ status: 'approved' });
    }

    const id = body.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return errorResponse(400, 'invalid_request');
    }
    const update = await db.prepare(`UPDATE access_displays SET revoked_at = ?
      WHERE id = ? AND revoked_at IS NULL RETURNING id`).bind(now, id).all<{ id: string }>();
    if (update.results.length === 0) {
      const exists = await db.prepare('SELECT id FROM access_displays WHERE id = ? LIMIT 1').bind(id).first<{ id: string }>();
      if (!exists) return errorResponse(404, 'display_not_found');
    }
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return databaseError();
  }
}

async function readDisplaySession(
  request: Request,
  db: D1Database,
): Promise<{ id: string; expiresAt: number } | null> {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.search || url.hash) return null;
  const token = readCookie(request, DISPLAY_COOKIE);
  if (!token) return null;
  const now = nowSeconds();
  const tokenHash = await hash(`session:${token}`);
  const row = await db.prepare(`SELECT s.display_id AS id, s.expires_at AS expiresAt
    FROM access_display_sessions s JOIN access_displays d ON d.id = s.display_id
    JOIN access_enrollments e ON e.display_id = d.id
    WHERE s.token_hash = ? AND s.expires_at > ? AND d.expires_at > ?
      AND d.revoked_at IS NULL AND e.status = 'consumed' LIMIT 1`)
    .bind(tokenHash, now, now).first<{ id: string; expiresAt: number }>();
  return row && Number.isSafeInteger(row.expiresAt) && row.expiresAt > now
    ? { id: row.id, expiresAt: row.expiresAt }
    : null;
}

/** Resolve a valid display cookie to its server-side display scope; storage errors deny access. */
export async function getDisplaySession(
  request: Request,
  db: D1Database,
): Promise<{ id: string; expiresAt: number } | null> {
  try {
    return await readDisplaySession(request, db);
  } catch {
    return null;
  }
}

/**
 * Slide an active display session forward and return a replacement Set-Cookie value.
 * Renewal is limited to once per SESSION_RENEW_SECONDS so normal polling does not
 * become a D1 write on every request. Invalid, revoked or expired sessions never renew.
 */
export async function refreshDisplaySession(
  request: Request,
  db: D1Database,
  session: { id: string; expiresAt: number },
): Promise<string | null> {
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.search || url.hash) return null;
    if (!/^[0-9a-f-]{36}$/i.test(session.id)) return null;
    if (!Number.isSafeInteger(session.expiresAt)) return null;
    const token = readCookie(request, DISPLAY_COOKIE);
    if (!token) return null;
    const now = nowSeconds();
    if (session.expiresAt <= now) return null;
    // Freshly renewed sessions skip the write; this caps renewal at once per day.
    if (session.expiresAt - now > SESSION_IDLE_SECONDS - SESSION_RENEW_SECONDS) return null;

    const expiresAt = now + SESSION_IDLE_SECONDS;
    const batch = await db.batch([
      db.prepare(`UPDATE access_displays SET expires_at = ?
        WHERE id = ? AND revoked_at IS NULL AND expires_at > ? RETURNING id`)
        .bind(expiresAt, session.id, now),
      db.prepare(`UPDATE access_display_sessions SET expires_at = ?
        WHERE display_id = ? AND expires_at > ?
          AND EXISTS (SELECT 1 FROM access_displays d
            WHERE d.id = ? AND d.revoked_at IS NULL AND d.expires_at > ?)
        RETURNING token_hash`)
        .bind(expiresAt, session.id, now, session.id, now),
    ]);
    if (batch[0]?.results?.length !== 1 || batch[1]?.results?.length !== 1) return null;
    return cookie(DISPLAY_COOKIE, token, SESSION_IDLE_SECONDS);
  } catch {
    return null;
  }
}

/** Consume the per-display weather budget. Pass only an id returned by getDisplaySession. */
export async function limitDisplayWeather(
  request: Request,
  db: D1Database,
  sessionId: string,
): Promise<boolean> {
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || !/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
    const now = nowSeconds();
    const sessionHash = await hash(`weather-session:${sessionId}`);
    return await takeRateLimit(db, `weather:${sessionHash}`, now, RATE_MINUTE_SECONDS, 6);
  } catch {
    return false;
  }
}

/**
 * Bound authenticated bootstrap polling so one stolen display cookie cannot drive
 * unbounded D1 reads. Normal clients poll once a minute; reloads fit comfortably.
 */
export async function limitDisplayBootstrap(
  request: Request,
  db: D1Database,
  sessionId: string,
): Promise<boolean> {
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || !/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
    const now = nowSeconds();
    const sessionHash = await hash(`bootstrap-session:${sessionId}`);
    return await takeRateLimit(db, `bootstrap:${sessionHash}`, now, RATE_MINUTE_SECONDS, 12);
  } catch {
    return false;
  }
}
