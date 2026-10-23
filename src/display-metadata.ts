import { isTimeZone } from '../shared/timezone';

export interface BrowserDescription {
  type: 'unknown' | 'desktop' | 'tablet' | 'phone';
  browser: string | null;
  os: string | null;
}

/** Heuristics only. Never save raw UA/model strings or use these fields for authorization. */
export function describeBrowser(userAgent: string | null): BrowserDescription {
  const unknown: BrowserDescription = { type: 'unknown', browser: null, os: null };
  if (!userAgent || userAgent.length > 512 || /[\u0000-\u001f\u007f]/.test(userAgent)) return unknown;
  const version = '(\\d{1,3}(?:[._]\\d{1,3}){0,2})';
  const match = (pattern: string): string | null => userAgent.match(new RegExp(pattern + version, 'i'))?.[1].replace(/_/g, '.') || null;
  let browser: string | null = null;
  for (const [pattern, name] of [['(?:Edg|EdgA|EdgiOS)/', 'Edge'], ['(?:OPR|Opera)/', 'Opera'], ['(?:Firefox|FxiOS)/', 'Firefox'], ['(?:Chrome|CriOS)/', 'Chrome']]) {
    const found = match(pattern);
    if (found) { browser = `${name} ${found}`; break; }
  }
  if (!browser && /Safari\//i.test(userAgent)) {
    const found = match('Version/');
    browser = found ? `Safari ${found}` : 'Safari';
  }
  const android = match('Android[ /]');
  const ios = match('(?:CPU(?: iPhone)? OS|iPhone OS) ');
  const mac = match('Mac OS X ');
  const windows = match('Windows NT ');
  let os: string | null = null;
  let type: BrowserDescription['type'] = 'unknown';
  if (android) { os = `Android ${android}`; type = /Mobile/i.test(userAgent) ? 'phone' : 'tablet'; }
  else if (ios || /iPhone|iPad|iPod/i.test(userAgent)) { os = ios ? `iOS ${ios}` : 'iOS'; type = /iPad/i.test(userAgent) ? 'tablet' : 'phone'; }
  else if (mac && /Mobile/i.test(userAgent)) { os = 'iPadOS (reported as macOS)'; type = 'tablet'; }
  else if (windows) { os = windows === '10.0' ? 'Windows 10 or later' : `Windows NT ${windows}`; type = 'desktop'; }
  else if (mac) { os = `macOS ${mac}`; type = 'desktop'; }
  else if (/Linux/i.test(userAgent)) { os = 'Linux'; type = 'desktop'; }
  return { type, browser, os };
}

/** Existing sessions fill in details on bootstrap; throttle writes to once per five minutes. */
export async function recordDisplayCheckIn(request: Request, db: D1Database, displayId: string): Promise<void> {
  const description = describeBrowser(request.headers.get('User-Agent'));
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`UPDATE access_displays SET
    device_type = CASE WHEN ? = 'unknown' THEN device_type ELSE ? END,
    browser_label = COALESCE(?, browser_label),
    os_label = COALESCE(?, os_label),
    last_seen_at = ?
    WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
      AND (last_seen_at IS NULL OR last_seen_at <= ?)`)
    .bind(description.type, description.type, description.browser, description.os, now, displayId, now, now - 300).run();
}

/** Save only the last successfully resolved weather area, never ZIP/coordinates/IP location. */
export async function recordDisplayWeatherArea(db: D1Database, displayId: string, label: string, timeZone: string): Promise<void> {
  if (label.length > 160 || !label.trim() || /[\u0000-\u001f\u007f]/.test(label) || !isTimeZone(timeZone)) return;
  const cleanLabel = label.trim();
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`UPDATE access_displays SET weather_location = ?, weather_time_zone = ?, weather_location_at = ?
    WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
      AND (weather_location IS NULL OR weather_location != ? OR weather_time_zone != ? OR weather_location_at <= ?)`)
    .bind(cleanLabel, timeZone, now, displayId, now, cleanLabel, timeZone, now - 600).run();
}
