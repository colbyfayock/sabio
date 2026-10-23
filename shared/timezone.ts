/**
 * Check bounded IANA-style identifiers using only the Intl API available in
 * Firefox Android 68. The character allowlist keeps provider text out of any
 * future formatting/options contexts without relying on newer Intl features.
 */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 ||
      !/^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/.test(value) ||
      value.split('/').some((part) => part === '.' || part === '..')) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
