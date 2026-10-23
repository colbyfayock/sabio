function text(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit &&
    !/[<>\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function date(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 946684800 || value > 4102444800) return null;
  return new Date(value * 1000).toLocaleString();
}

/** Descriptions are untrusted display text; caller must use textContent, never markup. */
export function displayDetails(value: unknown): { title: string; platform: string; seen: string; location: string } {
  const display = record(value);
  const device = record(display.device);
  const area = record(display.weatherArea);
  const kind = device.type === 'desktop' ? 'Desktop-like' : device.type === 'tablet' ? 'Tablet-like' : device.type === 'phone' ? 'Mobile / phone-like' : 'Unknown device';
  const browser = text(device.browser, 48);
  const nickname = text(display.name, 80);
  const location = text(area.label, 160);
  const timeZone = text(area.timeZone, 64);
  const seen = date(display.lastSeenAt);
  const resolved = date(area.updatedAt);
  return {
    title: `${nickname ? `${nickname} · ` : ''}${browser ? `${kind} · ${browser}` : kind}`,
    platform: text(device.os, 64) || 'Operating system not reported yet',
    seen: seen ? `Last check-in: ${seen} (updated at most every 5 minutes)` : 'Waiting for first display check-in',
    location: location ? `Last weather area: ${location}${timeZone ? ' · ' + timeZone : ''}${resolved ? ' · resolved ' + resolved : ''}` : 'Last weather area: not reported yet',
  };
}
