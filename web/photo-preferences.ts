import type { LocationStorageSource } from './location';

export const PHOTO_STORAGE_KEY = 'sabio.photos.v1';
export const SAMPLE_PHOTOS = [
  'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=1200&q=75&fm=jpg',
  'https://images.unsplash.com/photo-1518837695005-2083093ee35b?auto=format&fit=crop&w=1200&q=75&fm=jpg',
  'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1200&q=75&fm=jpg',
];

export interface PhotoPreferences { version: 1; urls: string[]; holdSeconds: number; }

export function defaultPhotoPreferences(): PhotoPreferences {
  return { version: 1, urls: SAMPLE_PHOTOS.slice(), holdSeconds: 20 };
}

/** Browser image sources only: never pass these URLs to a server-side fetcher. */
export function validatePhotoPreferences(value: unknown): value is PhotoPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || record.version !== 1 || !Array.isArray(record.urls) ||
      record.urls.length < 1 || record.urls.length > 12 || !Number.isInteger(record.holdSeconds) ||
      Number(record.holdSeconds) < 10 || Number(record.holdSeconds) > 3600) return false;
  return record.urls.every((value: unknown) => {
    if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port &&
        url.hostname.includes('.') && !/^[\d.]+$/.test(url.hostname) &&
        !/(^|\.)(localhost|local|internal|home|test|invalid|example)$/.test(url.hostname) && !url.hostname.includes(':');
    } catch {
      return false;
    }
  });
}

export function readPhotoPreferences(source: LocationStorageSource): { preferences: PhotoPreferences; message: string } {
  try {
    const storage = typeof source === 'function' ? source() : source;
    const raw = storage.getItem(PHOTO_STORAGE_KEY);
    if (raw === null) return { preferences: defaultPhotoPreferences(), message: '' };
    if (raw.length <= 26000) {
      const value: unknown = JSON.parse(raw);
      if (validatePhotoPreferences(value)) return { preferences: value, message: '' };
    }
    return { preferences: defaultPhotoPreferences(), message: 'Saved photo settings are invalid. Showing sample photography; save a valid source to replace them.' };
  } catch {
    return { preferences: defaultPhotoPreferences(), message: 'Photo settings could not be read. Showing sample photography; settings may last only for this visit.' };
  }
}

export function savePhotoPreferences(source: LocationStorageSource, value: PhotoPreferences): boolean {
  if (!validatePhotoPreferences(value)) return false;
  try {
    const storage = typeof source === 'function' ? source() : source;
    storage.setItem(PHOTO_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
