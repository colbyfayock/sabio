/** Keep postal codes as text; syntax validation does not establish a real postal area. */
export function normalizeZipCode(value: unknown): string | null {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  const zipCode = value.trim();
  return /^[0-9]{5}(?:-[0-9]{4})?$/.test(zipCode) ? zipCode : null;
}
