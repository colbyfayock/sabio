import { boundedJson } from './weather';
import { MAX_IMPORT_PHOTOS } from '../shared/photo-limits';

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PICKER_API = 'https://photospicker.googleapis.com/v1';
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_STORAGE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_PHOTOS = 100;
const OAUTH_STATE_SECONDS = 10 * 60;
const MAX_BODY_BYTES = 1024;

interface PhotoRow {
  id: string;
  object_key: string;
  source_hash: string;
  content_type: string;
  size_bytes: number;
  position: number;
  created_at: number;
}

interface ImportRow {
  id: string;
  google_session_ciphertext: string;
  access_token_ciphertext: string;
  picker_uri_ciphertext: string;
  status: 'picking' | 'importing';
  locked_until: number | null;
  created_at: number;
  expires_at: number;
}

interface GooglePhotoConnectionRow {
  refresh_token_ciphertext: string;
}

interface PickedItem {
  id: string;
  mediaFile: { baseUrl: string; mimeType: string };
}

function json(value: object, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...new Headers(headers),
    },
  });
}

function error(status: number, code: string): Response {
  return json({ error: code }, status);
}

function configured(env: Env): boolean {
  return Boolean(env.PHOTO_BUCKET && env.GOOGLE_PHOTOS_CLIENT_ID && env.GOOGLE_PHOTOS_CLIENT_SECRET &&
    env.PHOTO_ENCRYPTION_KEY && /^[a-f0-9]{64}$/i.test(env.PHOTO_ENCRYPTION_KEY));
}

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function keyBytes(env: Env): Uint8Array {
  const value = env.PHOTO_ENCRYPTION_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('photo_configuration');
  return Uint8Array.from(value.match(/.{2}/g) || [], (byte) => Number.parseInt(byte, 16));
}

async function cryptoKey(env: Env, usage: Array<'encrypt' | 'decrypt'>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyBytes(env), 'AES-GCM', false, usage);
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encrypt(env: Env, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(env, ['encrypt']), new TextEncoder().encode(value));
  return `${encodeBase64(iv)}.${encodeBase64(new Uint8Array(ciphertext))}`;
}

async function decrypt(env: Env, value: string): Promise<string> {
  const [ivValue, ciphertextValue, extra] = value.split('.');
  if (!ivValue || !ciphertextValue || extra !== undefined) throw new Error('photo_credential');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64(ivValue) },
    await cryptoKey(env, ['decrypt']),
    decodeBase64(ciphertextValue),
  );
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext);
}

async function readBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) return null;
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return null;
  try {
    const value = await boundedJson(request, maxBytes);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

class GoogleApiError extends Error {
  constructor(readonly status: number, readonly providerCode: string) {
    super('google_api_error');
  }
}

class PickerSessionError extends Error {
  constructor(readonly publicCode: string) {
    super('picker_session_failure');
  }
}

const GOOGLE_ERROR_CODES = new Set([
  'FAILED_PRECONDITION', 'INVALID_ARGUMENT', 'INVALID_GRANT', 'NOT_FOUND',
  'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'SERVICE_DISABLED', 'UNAUTHENTICATED',
]);

async function googleProviderError(response: Response): Promise<GoogleApiError> {
  let code = '';
  try {
    const value = await boundedJson(response, 8192);
    if (value && typeof value === 'object' && !Array.isArray(value) && 'error' in value) {
      const detail = value.error;
      if (typeof detail === 'string') code = detail.toUpperCase();
      else if (detail && typeof detail === 'object' && !Array.isArray(detail) && 'status' in detail && typeof detail.status === 'string') {
        code = detail.status.toUpperCase();
      }
    }
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }
  return new GoogleApiError(response.status, GOOGLE_ERROR_CODES.has(code) ? code : 'UNKNOWN');
}

async function googleJson(url: string, token?: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['accounts.google.com', 'oauth2.googleapis.com', 'photospicker.googleapis.com'].includes(parsed.hostname)) {
    throw new Error('google_request');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    if (response.status < 200 || response.status >= 300) throw await googleProviderError(response);
    if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('google_response');
    }
    const value = await boundedJson(response, 32768);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('google_response');
    return value as Record<string, unknown>;
  } finally { clearTimeout(timeout); }
}

async function googleDelete(sessionId: string, token: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${PICKER_API}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // Google sessions also expire; cleanup is best-effort and never logs credentials.
  } finally { clearTimeout(timeout); }
}

async function consumeOAuthState(env: Env, state: string, now: number): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(state)) return false;
  const result = await env.DB.prepare(`DELETE FROM photo_oauth_states
    WHERE state_hash = ? AND expires_at > ? RETURNING state_hash`).bind(await hash(`photos-oauth:${state}`), now)
    .first<{ state_hash: string }>();
  return Boolean(result);
}

function callbackRedirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function googleConnection(env: Env): Promise<GooglePhotoConnectionRow | null> {
  return env.DB.prepare(`SELECT refresh_token_ciphertext FROM google_photo_connections WHERE id = 1`)
    .first<GooglePhotoConnectionRow>();
}

async function refreshGoogleAccessToken(env: Env, refreshToken: string): Promise<{ token: string; expiresIn: number }> {
  const form = new URLSearchParams({
    client_id: env.GOOGLE_PHOTOS_CLIENT_ID || '',
    client_secret: env.GOOGLE_PHOTOS_CLIENT_SECRET || '',
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const result = await googleJson(GOOGLE_TOKEN_URL, undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const token = typeof result.access_token === 'string' && result.access_token.length <= 8192 ? result.access_token : '';
  const expiresIn = typeof result.expires_in === 'number' && Number.isFinite(result.expires_in)
    ? Math.min(Math.floor(result.expires_in), 3600) : 0;
  if (!token || expiresIn < 60 || (result.token_type !== undefined && result.token_type !== 'Bearer')) {
    throw new Error('google_refresh_failed');
  }
  return { token, expiresIn };
}

async function createPickerSession(env: Env, accessToken: string, expiresIn: number, now: number): Promise<string> {
  let session: Record<string, unknown>;
  try {
    session = await googleJson(`${PICKER_API}/sessions`, accessToken, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pickingConfig: { maxItemCount: String(MAX_IMPORT_PHOTOS) } }),
    });
  } catch (cause) {
    if (cause instanceof GoogleApiError) throw cause;
    throw new PickerSessionError(cause instanceof Error && cause.message === 'google_response'
      ? 'google_picker_response_invalid' : 'google_picker_network_unavailable');
  }
  const sessionId = typeof session.id === 'string' && session.id.length <= 512 ? session.id : '';
  const pickerUri = typeof session.pickerUri === 'string' && session.pickerUri.length <= 2048 ? session.pickerUri : '';
  let pickerUrl: URL;
  try { pickerUrl = new URL(pickerUri); } catch { throw new PickerSessionError('google_picker_response_invalid'); }
  if (!sessionId || pickerUrl.protocol !== 'https:' || pickerUrl.hostname !== 'photos.google.com' || pickerUrl.username || pickerUrl.password) {
    throw new PickerSessionError('google_picker_response_invalid');
  }

  await env.DB.prepare('DELETE FROM photo_imports WHERE expires_at <= ?').bind(now).run();
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO photo_imports
      (id, google_session_ciphertext, access_token_ciphertext, picker_uri_ciphertext, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'picking', ?, ?)`)
      .bind(id, await encrypt(env, sessionId), await encrypt(env, accessToken), await encrypt(env, pickerUri), now, now + expiresIn)
      .run();
  } catch (cause) {
    await googleDelete(sessionId, accessToken);
    throw new PickerSessionError('picker_session_storage_failed');
  }
  return id;
}

function pickerSessionFailure(cause: unknown): string {
  if (cause instanceof PickerSessionError) return cause.publicCode;
  if (!(cause instanceof GoogleApiError)) return 'picker_session_unavailable';
  if (cause.providerCode === 'FAILED_PRECONDITION') return 'google_photos_account_unavailable';
  if (cause.providerCode === 'SERVICE_DISABLED' || cause.providerCode === 'PERMISSION_DENIED' || cause.status === 403) {
    return 'google_photos_api_unavailable';
  }
  if (cause.providerCode === 'RESOURCE_EXHAUSTED' || cause.status === 429) return 'picker_rate_limited';
  if (cause.providerCode === 'UNAUTHENTICATED' || cause.providerCode === 'INVALID_GRANT') return 'google_reconnect_required';
  return `google_picker_http_${cause.status}`;
}

async function revokeGoogleRefreshToken(refreshToken: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 200;
  } catch {
    return false;
  } finally { clearTimeout(timeout); }
}

async function startOAuth(request: Request, env: Env, now: number): Promise<Response> {
  if (!configured(env)) return error(503, 'photos_not_configured');
  const body = await readBody(request);
  if (!body || Object.keys(body).some((key) => key !== 'reauthorize') ||
    (body.reauthorize !== undefined && body.reauthorize !== true)) return error(400, 'invalid_request');
  if (await activeImport(env, now)) return error(409, 'active_import');
  const reauthorize = body.reauthorize === true;
  if (!reauthorize) {
    const connection = await googleConnection(env);
    if (connection) {
      let refreshToken: string;
      try {
        refreshToken = await decrypt(env, connection.refresh_token_ciphertext);
      } catch { return error(503, 'google_connection_unavailable'); }
      let refreshed: { token: string; expiresIn: number };
      try { refreshed = await refreshGoogleAccessToken(env, refreshToken); }
      catch (cause) {
        if (cause instanceof GoogleApiError && ['INVALID_GRANT', 'UNAUTHENTICATED'].includes(cause.providerCode)) {
          return error(409, 'google_reconnect_required');
        }
        return error(502, 'google_refresh_unavailable');
      }
      try { await createPickerSession(env, refreshed.token, refreshed.expiresIn, now); }
      catch (cause) {
        const failure = pickerSessionFailure(cause);
        return error(failure === 'google_reconnect_required' ? 409 : 502, failure);
      }
      return json({ status: 'picker_ready' });
    }
  }
  const state = randomToken();
  await env.DB.prepare(`DELETE FROM photo_oauth_states WHERE state_hash IN
    (SELECT state_hash FROM photo_oauth_states WHERE expires_at <= ? LIMIT 25)`).bind(now).run();
  await env.DB.prepare('INSERT INTO photo_oauth_states (state_hash, expires_at) VALUES (?, ?)')
    .bind(await hash(`photos-oauth:${state}`), now + OAUTH_STATE_SECONDS).run();
  const redirectUri = new URL('/api/admin/photos/callback', env.APP_ORIGIN).href;
  const authorize = new URL(GOOGLE_AUTH_URL);
  authorize.searchParams.set('client_id', env.GOOGLE_PHOTOS_CLIENT_ID || '');
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', GOOGLE_SCOPE);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('access_type', 'offline');
  authorize.searchParams.set('prompt', 'consent');
  return json({ authorizationUrl: authorize.href });
}

async function handleOAuthCallback(request: Request, env: Env, now: number): Promise<Response> {
  if (!configured(env)) return callbackRedirect('/admin?photos=unavailable');
  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  if (!await consumeOAuthState(env, state, now)) return callbackRedirect('/admin?photos=expired');
  if (url.searchParams.has('error') || !url.searchParams.has('code')) return callbackRedirect('/admin?photos=cancelled');
  const code = url.searchParams.get('code') || '';
  if (!code || code.length > 4096) return callbackRedirect('/admin?photos=failed');

  let connectionSaved = false;
  try {
    const redirectUri = new URL('/api/admin/photos/callback', env.APP_ORIGIN).href;
    const form = new URLSearchParams({
      code,
      client_id: env.GOOGLE_PHOTOS_CLIENT_ID || '',
      client_secret: env.GOOGLE_PHOTOS_CLIENT_SECRET || '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const tokenResponse = await googleJson(GOOGLE_TOKEN_URL, undefined, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const accessToken = typeof tokenResponse.access_token === 'string' && tokenResponse.access_token.length <= 8192
      ? tokenResponse.access_token : '';
    if (tokenResponse.token_type !== undefined && tokenResponse.token_type !== 'Bearer') return callbackRedirect('/admin?photos=failed');
    const expiresIn = typeof tokenResponse.expires_in === 'number' && Number.isFinite(tokenResponse.expires_in)
      ? Math.min(Math.max(Math.floor(tokenResponse.expires_in), 60), 3600) : 0;
    if (!accessToken || expiresIn < 60) return callbackRedirect('/admin?photos=failed');

    const connection = await googleConnection(env);
    const refreshToken = typeof tokenResponse.refresh_token === 'string' && tokenResponse.refresh_token.length <= 8192
      ? tokenResponse.refresh_token : '';
    if (refreshToken) {
      await env.DB.prepare(`INSERT INTO google_photo_connections (id, refresh_token_ciphertext, created_at, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET refresh_token_ciphertext = excluded.refresh_token_ciphertext,
          updated_at = excluded.updated_at`)
        .bind(await encrypt(env, refreshToken), now, now).run();
      connectionSaved = true;
    } else if (!connection) {
      return callbackRedirect('/admin?photos=failed');
    } else {
      connectionSaved = true;
    }

    try { await createPickerSession(env, accessToken, expiresIn, now); }
    catch (cause) { return callbackRedirect(`/admin?photos=${pickerSessionFailure(cause)}`); }
    return callbackRedirect('/admin?photos=connected');
  } catch {
    return callbackRedirect(connectionSaved ? '/admin?photos=picker-failed' : '/admin?photos=failed');
  }
}

async function activeImport(env: Env, now: number): Promise<ImportRow | null> {
  await env.DB.prepare(`DELETE FROM photo_imports WHERE id IN
    (SELECT id FROM photo_imports WHERE expires_at <= ? LIMIT 1)`).bind(now).run();
  return env.DB.prepare(`SELECT id, google_session_ciphertext, access_token_ciphertext, picker_uri_ciphertext,
    status, created_at, expires_at FROM photo_imports ORDER BY created_at DESC LIMIT 1`).first<ImportRow>();
}

async function photosList(env: Env, now: number): Promise<Response> {
  const result = await env.DB.prepare(`SELECT id, content_type, size_bytes, position, created_at
    FROM photo_items ORDER BY position, created_at LIMIT ?`).bind(MAX_PHOTOS).all<PhotoRow>();
  const job = await activeImport(env, now);
  const connection = await googleConnection(env);
  let pending: object | null = null;
  if (job) {
    try {
      pending = { id: job.id, pickerUri: await decrypt(env, job.picker_uri_ciphertext), createdAt: job.created_at, status: job.status };
    } catch { return error(503, 'photos_temporarily_unavailable'); }
  }
  return json({
    photos: result.results.map((photo) => ({ id: photo.id, contentType: photo.content_type, sizeBytes: photo.size_bytes, position: photo.position, createdAt: photo.created_at })),
    activeImport: pending,
    googleConnected: Boolean(connection),
    limits: { maxPhotos: MAX_PHOTOS, maxPhotoBytes: MAX_PHOTO_BYTES, maxStorageBytes: MAX_STORAGE_BYTES },
  });
}

async function importStatus(request: Request, env: Env, now: number): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return error(400, 'invalid_request');
  const job = await env.DB.prepare(`SELECT id, google_session_ciphertext, access_token_ciphertext,
    picker_uri_ciphertext, status, created_at, expires_at FROM photo_imports WHERE id = ? AND expires_at > ?`)
    .bind(id, now).first<ImportRow>();
  if (!job) return error(404, 'import_not_found');
  try {
    const token = await decrypt(env, job.access_token_ciphertext);
    const sessionId = await decrypt(env, job.google_session_ciphertext);
    const session = await googleJson(`${PICKER_API}/sessions/${encodeURIComponent(sessionId)}`, token);
    return json({
      id,
      status: session.mediaItemsSet === true ? 'ready' : job.status,
      mediaItemsSet: session.mediaItemsSet === true,
      pollAfterSeconds: 5,
    });
  } catch { return error(502, 'picker_status_unavailable'); }
}

async function selectedItems(sessionId: string, token: string): Promise<PickedItem[]> {
  const items: PickedItem[] = [];
  let pageToken = '';
  do {
    const url = new URL(`${PICKER_API}/mediaItems`);
    url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('pageSize', '20');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await googleJson(url.href, token);
    if (!Array.isArray(page.mediaItems)) throw new Error('picker_response');
    for (const value of page.mediaItems) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('picker_response');
      const item = value as Record<string, unknown>;
      const mediaFile = item.mediaFile;
      if (typeof item.id !== 'string' || item.id.length < 1 || item.id.length > 512 ||
        !mediaFile || typeof mediaFile !== 'object' || Array.isArray(mediaFile)) throw new Error('picker_response');
      const file = mediaFile as Record<string, unknown>;
      if (typeof file.mimeType !== 'string' || typeof file.baseUrl !== 'string' || file.baseUrl.length > 4096) throw new Error('picker_response');
      const sourceType = file.mimeType.toLowerCase();
      if (!sourceType.startsWith('image/') || ['image/gif', 'image/svg+xml'].includes(sourceType)) throw new Error('unsupported_media');
      items.push({ id: item.id, mediaFile: { mimeType: sourceType, baseUrl: file.baseUrl } });
      if (items.length > MAX_IMPORT_PHOTOS) throw new Error('too_many_photos');
    }
    pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : '';
    if (pageToken && items.length >= MAX_IMPORT_PHOTOS) throw new Error('too_many_photos');
  } while (pageToken);
  if (items.length === 0) throw new Error('no_photos_selected');
  return items;
}

function concatenate(parts: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

/** Remove common EXIF, XMP, IPTC and text metadata before objects enter app storage. */
function sanitizeImage(contentType: string, bytes: Uint8Array): Uint8Array | null {
  if (contentType === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const parts = [bytes.subarray(0, 2)];
    let outputLength = 2;
    let offset = 2;
    let markers = 0;
    let sawImageData = false;
    let sawEnd = false;
    while (offset < bytes.length && markers < 4096) {
      const start = offset;
      if (bytes[offset] !== 0xff) return null;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return null;
      const marker = bytes[offset++];
      markers += 1;
      if (marker === 0xda) {
        if (offset + 2 > bytes.length) return null;
        const segmentLength = bytes[offset] * 256 + bytes[offset + 1];
        const end = offset + segmentLength;
        if (segmentLength < 2 || end > bytes.length) return null;
        parts.push(bytes.subarray(start));
        outputLength += bytes.length - start;
        sawImageData = true;
        offset = bytes.length;
        break;
      }
      if (marker === 0xd9) {
        parts.push(bytes.subarray(start, offset));
        outputLength += offset - start;
        sawEnd = true;
        if (offset !== bytes.length) return null;
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        parts.push(bytes.subarray(start, offset));
        outputLength += offset - start;
        continue;
      }
      if (offset + 2 > bytes.length) return null;
      const segmentLength = bytes[offset] * 256 + bytes[offset + 1];
      const end = offset + segmentLength;
      if (segmentLength < 2 || end > bytes.length) return null;
      const isPrivateMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
      if (!isPrivateMetadata) {
        parts.push(bytes.subarray(start, end));
        outputLength += end - start;
      }
      offset = end;
    }
    if (offset !== bytes.length || markers >= 4096 || (!sawImageData && !sawEnd)) return null;
    return concatenate(parts, outputLength);
  }

  if (contentType === 'image/png') {
    if (bytes.length < 20 || bytes.slice(0, 8).join(',') !== '137,80,78,71,13,10,26,10') return null;
    const parts = [bytes.subarray(0, 8)];
    let outputLength = 8;
    let offset = 8;
    let chunks = 0;
    let sawEnd = false;
    while (offset + 12 <= bytes.length && chunks < 10000) {
      const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
      const end = offset + 12 + size;
      if (end > bytes.length) return null;
      const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (!['eXIf', 'tEXt', 'iTXt', 'zTXt'].includes(kind)) {
        parts.push(bytes.subarray(offset, end));
        outputLength += end - offset;
      }
      offset = end;
      chunks += 1;
      if (kind === 'IEND') { sawEnd = true; break; }
    }
    if (!sawEnd || offset !== bytes.length || chunks >= 10000) return null;
    return concatenate(parts, outputLength);
  }

  if (contentType === 'image/webp') {
    if (bytes.length < 20 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
      String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') return null;
    if (new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true) !== bytes.length - 8) return null;
    const parts = [bytes.subarray(0, 12)];
    let outputLength = 12;
    let offset = 12;
    let chunks = 0;
    while (offset + 8 <= bytes.length && chunks < 10000) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4);
      const size = view.getUint32(0, true);
      const paddedSize = size + (size & 1);
      const end = offset + 8 + paddedSize;
      if (end > bytes.length) return null;
      const kind = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      if (kind !== 'EXIF' && kind !== 'XMP ') {
        const chunk = bytes.slice(offset, end);
        if (kind === 'VP8X' && chunk.length >= 10) chunk[8] &= 0xf3;
        parts.push(chunk);
        outputLength += chunk.length;
      }
      offset = end;
      chunks += 1;
    }
    if (offset !== bytes.length || chunks === 0 || chunks >= 10000) return null;
    const output = concatenate(parts, outputLength);
    new DataView(output.buffer).setUint32(4, output.length - 8, true);
    return output;
  }
  return null;
}

async function downloadPhoto(item: PickedItem, token: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  let base: URL;
  try { base = new URL(item.mediaFile.baseUrl); } catch { throw new Error('photo_download'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
    !(base.hostname === 'googleusercontent.com' || base.hostname.endsWith('.googleusercontent.com'))) throw new Error('photo_download');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${base.href}=w2048-h1280`, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'image/jpeg,image/png,image/webp' },
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('photo_download');
    }
    const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    const length = response.headers.get('Content-Length');
    if (!/^image\/(?:jpeg|png|webp)$/.test(contentType) ||
      (length && (!/^\d+$/.test(length) || Number(length) > MAX_PHOTO_BYTES))) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('unsupported_media');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('photo_download');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_PHOTO_BYTES) {
        await reader.cancel();
        throw new Error('unsupported_media');
      }
      chunks.push(chunk.value);
    }
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    const sanitized = buffer.byteLength > 0 && buffer.byteLength <= MAX_PHOTO_BYTES ? sanitizeImage(contentType, buffer) : null;
    if (!sanitized) {
      throw new Error('unsupported_media');
    }
    return { bytes: sanitized, contentType };
  } finally { clearTimeout(timeout); }
}

async function finishImport(env: Env, job: ImportRow, token: string, sessionId: string): Promise<Response> {
  await googleDelete(sessionId, token);
  await env.DB.prepare('DELETE FROM photo_imports WHERE id = ?').bind(job.id).run();
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM photo_items').first<{ count: number }>();
  return json({ done: true, importedCount: count?.count || 0 });
}

async function importNext(env: Env, jobId: string, now: number): Promise<Response> {
  if (!configured(env)) return error(503, 'photos_not_configured');
  const job = await env.DB.prepare(`SELECT id, google_session_ciphertext, access_token_ciphertext,
    picker_uri_ciphertext, status, locked_until, created_at, expires_at FROM photo_imports WHERE id = ? AND expires_at > ?`)
    .bind(jobId, now).first<ImportRow>();
  if (!job) return error(404, 'import_not_found');
  const lock = await env.DB.prepare(`UPDATE photo_imports SET locked_until = ?
    WHERE id = ? AND expires_at > ? AND (locked_until IS NULL OR locked_until <= ?) RETURNING id`)
    .bind(now + 30, jobId, now, now).first<{ id: string }>();
  if (!lock) return error(409, 'import_in_progress');

  try {
    const token = await decrypt(env, job.access_token_ciphertext);
    const sessionId = await decrypt(env, job.google_session_ciphertext);
    const session = await googleJson(`${PICKER_API}/sessions/${encodeURIComponent(sessionId)}`, token);
    if (session.mediaItemsSet !== true) return error(409, 'selection_pending');
    const items = await selectedItems(sessionId, token);
    const known = await env.DB.prepare('SELECT source_hash FROM photo_items').all<{ source_hash: string }>();
    const existing = new Set(known.results.map((row) => row.source_hash));
    const next: { item: PickedItem; sourceHash: string } | undefined = await (async () => {
      for (const item of items) {
        const sourceHash = await hash(`google-photo:${item.id}`);
        if (!existing.has(sourceHash)) return { item, sourceHash };
      }
      return undefined;
    })();
    if (!next) return finishImport(env, job, token, sessionId);

    const current = await env.DB.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS size_bytes
      FROM photo_items`).first<{ count: number; size_bytes: number }>();
    const importUsage = await env.DB.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS size_bytes
      FROM photo_items WHERE import_id = ?`).bind(job.id).first<{ count: number; size_bytes: number }>();
    if ((current?.count || 0) >= MAX_PHOTOS) return error(413, 'photo_count_limit');
    if ((importUsage?.count || 0) >= MAX_IMPORT_PHOTOS) return error(413, 'import_photo_limit');
    if ((importUsage?.size_bytes || 0) >= MAX_IMPORT_BYTES) return error(413, 'import_size_limit');
    const photo = await downloadPhoto(next.item, token);
    if ((current?.size_bytes || 0) + photo.bytes.byteLength > MAX_STORAGE_BYTES) return error(413, 'storage_limit');
    if ((importUsage?.size_bytes || 0) + photo.bytes.byteLength > MAX_IMPORT_BYTES) return error(413, 'import_size_limit');

    const photoId = crypto.randomUUID();
    const position = await env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM photo_items').first<{ position: number }>();
    const objectKey = `photos/${photoId}`;
    await env.PHOTO_BUCKET?.put(objectKey, photo.bytes, {
      httpMetadata: { contentType: photo.contentType, cacheControl: 'private, no-store' },
    });
    try {
      await env.DB.prepare(`INSERT INTO photo_items
        (id, object_key, source_hash, import_id, content_type, size_bytes, position, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(photoId, objectKey, next.sourceHash, job.id, photo.contentType, photo.bytes.byteLength,
          position?.position || 0, now).run();
    } catch (cause) {
      await env.PHOTO_BUCKET?.delete(objectKey).catch(() => undefined);
      throw cause;
    }
    const importedCount = (importUsage?.count || 0) + 1;
    const importedBytes = (importUsage?.size_bytes || 0) + photo.bytes.byteLength;
    await env.DB.prepare("UPDATE photo_imports SET status = 'importing' WHERE id = ?").bind(job.id).run();
    existing.add(next.sourceHash);
    const selectedHashes = await Promise.all(items.map((item) => hash(`google-photo:${item.id}`)));
    if (selectedHashes.every((sourceHash) => existing.has(sourceHash))) return finishImport(env, job, token, sessionId);
    return json({ done: false, importedCount, importedBytes });
  } catch (cause) {
    if (cause instanceof Error && ['too_many_photos', 'unsupported_media', 'no_photos_selected'].includes(cause.message)) {
      return error(cause.message === 'too_many_photos' ? 413 : 415, cause.message);
    }
    return error(502, 'photo_import_failed');
  } finally {
    await env.DB.prepare('UPDATE photo_imports SET locked_until = NULL WHERE id = ?').bind(jobId).run().catch(() => undefined);
  }
}

async function cancelImport(env: Env, jobId: string, now: number): Promise<Response> {
  const job = await env.DB.prepare(`DELETE FROM photo_imports WHERE id = ? AND expires_at > ?
    AND (locked_until IS NULL OR locked_until <= ?)
    RETURNING id, google_session_ciphertext, access_token_ciphertext, picker_uri_ciphertext, status, created_at, expires_at`)
    .bind(jobId, now, now).first<ImportRow>();
  if (!job) {
    const active = await env.DB.prepare('SELECT locked_until FROM photo_imports WHERE id = ? AND expires_at > ?')
      .bind(jobId, now).first<{ locked_until: number | null }>();
    return active?.locked_until && active.locked_until > now ? error(409, 'import_in_progress') : error(404, 'import_not_found');
  }
  try { await googleDelete(await decrypt(env, job.google_session_ciphertext), await decrypt(env, job.access_token_ciphertext)); } catch { /* Expired sessions are deleted by Google. */ }
  return json({ cancelled: true });
}

async function disconnectGoogle(env: Env, now: number): Promise<Response> {
  const connection = await googleConnection(env);
  const job = await env.DB.prepare(`SELECT id, google_session_ciphertext, access_token_ciphertext,
    picker_uri_ciphertext, status, locked_until, created_at, expires_at
    FROM photo_imports WHERE expires_at > ? LIMIT 1`).bind(now).first<ImportRow>();
  if (job?.locked_until && job.locked_until > now) return error(409, 'import_in_progress');

  const batch = await env.DB.batch([
    env.DB.prepare(`DELETE FROM photo_imports WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?)
      RETURNING id, google_session_ciphertext, access_token_ciphertext, picker_uri_ciphertext,
        status, locked_until, created_at, expires_at`).bind(job?.id || '', now),
    env.DB.prepare(`DELETE FROM google_photo_connections WHERE id = 1
      AND NOT EXISTS (SELECT 1 FROM photo_imports WHERE locked_until > ?)
      RETURNING refresh_token_ciphertext`).bind(now),
  ]);
  const removedJob = batch[0]?.results?.[0] as ImportRow | undefined;
  const removedConnection = batch[1]?.results?.[0] as GooglePhotoConnectionRow | undefined;
  if (connection && !removedConnection) return error(409, 'import_in_progress');

  let refreshToken = '';
  try {
    if (removedJob) {
      const accessToken = await decrypt(env, removedJob.access_token_ciphertext);
      const sessionId = await decrypt(env, removedJob.google_session_ciphertext);
      await googleDelete(sessionId, accessToken);
    }
    if (removedConnection) refreshToken = await decrypt(env, removedConnection.refresh_token_ciphertext);
  } catch {
    // Local credentials are removed regardless; a failed Google revoke is reported below.
  }
  const googleRevoked = refreshToken ? await revokeGoogleRefreshToken(refreshToken) : !connection;
  return json({ disconnected: true, googleRevoked });
}

async function removePhoto(env: Env, photoId: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(photoId)) return error(400, 'invalid_request');
  const photo = await env.DB.prepare('SELECT id, object_key FROM photo_items WHERE id = ?').bind(photoId)
    .first<{ id: string; object_key: string }>();
  if (!photo) return error(404, 'photo_not_found');
  if (!env.PHOTO_BUCKET) return error(503, 'photos_not_configured');
  await env.PHOTO_BUCKET.delete(photo.object_key);
  await env.DB.prepare('DELETE FROM photo_items WHERE id = ?').bind(photoId).run();
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

async function reorderPhotos(env: Env, request: Request): Promise<Response> {
  // A full library's 100 UUIDs use about 3.9 KiB in the admin's compact JSON.
  const body = await readBody(request, 4096);
  if (!body || Object.keys(body).length !== 1 || !Array.isArray(body.ids) || body.ids.length > MAX_PHOTOS ||
    body.ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) return error(400, 'invalid_request');
  const photos = await env.DB.prepare('SELECT id FROM photo_items ORDER BY position, created_at LIMIT ?').bind(MAX_PHOTOS).all<{ id: string }>();
  const existing = new Set(photos.results.map((photo) => photo.id));
  const ids = body.ids as string[];
  if (ids.length !== existing.size || new Set(ids).size !== ids.length || ids.some((id) => !existing.has(id))) return error(400, 'invalid_order');
  await env.DB.batch(ids.map((id, position) => env.DB.prepare('UPDATE photo_items SET position = ? WHERE id = ?').bind(position, id)));
  return json({ reordered: true });
}

export async function handlePhotoAdminRequest(request: Request, route: string, rawEnv: Env, now: number): Promise<Response> {
  const env = rawEnv;
  if (route === '/api/admin/photos/callback') return handleOAuthCallback(request, env, now);
  if (route === '/api/admin/photos/connect') return startOAuth(request, env, now);
  if (!configured(env)) return error(503, 'photos_not_configured');

  if (route === '/api/admin/photos') return photosList(env, now);
  if (route === '/api/admin/photos/status') return importStatus(request, env, now);
  if (route === '/api/admin/photos/import') {
    const body = await readBody(request);
    if (!body || Object.keys(body).length !== 1 || typeof body.jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.jobId)) return error(400, 'invalid_request');
    return importNext(env, body.jobId, now);
  }
  if (route === '/api/admin/photos/cancel') {
    const body = await readBody(request);
    if (!body || Object.keys(body).length !== 1 || typeof body.jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.jobId)) return error(400, 'invalid_request');
    return cancelImport(env, body.jobId, now);
  }
  if (route === '/api/admin/photos/disconnect') {
    const body = await readBody(request);
    if (!body || Object.keys(body).length !== 0) return error(400, 'invalid_request');
    return disconnectGoogle(env, now);
  }
  if (route === '/api/admin/photos/delete') {
    const body = await readBody(request);
    if (!body || Object.keys(body).length !== 1 || typeof body.photoId !== 'string') return error(400, 'invalid_request');
    return removePhoto(env, body.photoId);
  }
  if (route === '/api/admin/photos/reorder') return reorderPhotos(env, request);
  return error(404, 'not_found');
}

export async function handleDisplayPhotos(request: Request, rawEnv: Env): Promise<Response> {
  const env = rawEnv;
  if (!env.PHOTO_BUCKET) return error(503, 'photos_not_configured');
  const path = new URL(request.url).pathname;
  if (path === '/api/display/photos') {
    const result = await env.DB.prepare('SELECT id FROM photo_items ORDER BY position, created_at LIMIT ?')
      .bind(MAX_PHOTOS).all<{ id: string }>();
    return json({ photos: result.results.map((photo) => ({ id: photo.id, url: `/api/display/photos/${photo.id}` })) });
  }
  const match = /^\/api\/display\/photos\/([0-9a-f-]{36})$/i.exec(path);
  if (!match) return error(404, 'not_found');
  const photo = await env.DB.prepare('SELECT object_key, content_type FROM photo_items WHERE id = ?').bind(match[1])
    .first<{ object_key: string; content_type: string }>();
  if (!photo || !['image/jpeg', 'image/png', 'image/webp'].includes(photo.content_type)) return error(404, 'photo_not_found');
  const object = await env.PHOTO_BUCKET.get(photo.object_key);
  if (!object) return error(404, 'photo_not_found');
  return new Response(object.body, {
    headers: {
      'Content-Type': photo.content_type,
      'Content-Length': String(object.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline; filename="sabio-photo"',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
