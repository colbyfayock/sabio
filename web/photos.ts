import { readPhotoPreferences, SAMPLE_PHOTOS } from './photo-preferences';

const LOAD_TIMEOUT = 15000;

export function initializePhotos(mode: 'preview' | 'managed' = 'preview'): void {
  const storage = () => window.localStorage;
  const saved = readPhotoPreferences(storage);
  const preferences = saved.preferences;
  let notice = mode === 'managed' ? '' : saved.message;
  let urls = mode === 'managed' ? SAMPLE_PHOTOS.slice() : preferences.urls;
  const frames = [document.getElementById('photoA'), document.getElementById('photoB')] as HTMLImageElement[];
  if (frames.some((frame) => !frame)) return;
  const status = document.getElementById('photo-status');
  const fallback = document.getElementById('photo-fallback');
  const previous = document.getElementById('photo-previous');
  const next = document.getElementById('photo-next');
  let active = -1;
  let index = -1;
  let loading = false;
  let token = 0;
  let timer: number | null = null;
  let loadTimer: number | null = null;
  let fadeTimer: number | null = null;
  let pendingDirection: -1 | 1 | null = null;
  const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const say = (message: string): void => { if (status) status.textContent = message; };
  const clearTimer = (): void => { if (timer !== null) window.clearTimeout(timer); timer = null; };
  const schedule = (delay = preferences.holdSeconds * 1000): void => {
    clearTimer();
    if (urls.length > 1 && !document.hidden) timer = window.setTimeout(() => show((index + 1) % urls.length), delay);
  };

  // Each load and fade belongs to one generation; late events cannot replace a newer source.
  function show(target: number, attempts = 0): void {
    if (loading || fadeTimer !== null) return;
    clearTimer();
    loading = true;
    const generation = ++token;
    const slot = active === 0 ? 1 : 0;
    const image = frames[slot];
    image.className = 'photo';
    const cleanupLoad = (): void => {
      image.onload = null;
      image.onerror = null;
      if (loadTimer !== null) window.clearTimeout(loadTimer);
      loadTimer = null;
      loading = false;
    };
    const failed = (): void => {
      if (generation !== token) return;
      cleanupLoad();
      if (attempts + 1 < urls.length) {
        show((target + 1) % urls.length, attempts + 1);
        return;
      }
      say('Photos unavailable. Check the connection. Retrying in one minute.');
      if (active < 0 && fallback) fallback.textContent = 'Photographs unavailable. Check the connection.';
      if (fallback) fallback.hidden = active >= 0;
      if (!document.hidden) timer = window.setTimeout(() => show(target), 60000);
    };
    image.onerror = failed;
    image.onload = () => {
      if (generation !== token) return;
      if (!image.naturalWidth) { failed(); return; }
      cleanupLoad();
      const previous = active;
      frames.forEach((frame) => { frame.className = 'photo'; });
      if (previous >= 0 && previous !== slot) frames[previous].className = 'photo previous';
      // Flush the hidden frame before adding the fade class, including cached images.
      void image.offsetWidth;
      image.className = 'photo active';
      active = slot;
      index = target;
      if (fallback) fallback.hidden = true;
      say(notice);
      const finishFade = (): void => {
        if (previous >= 0) frames[previous].className = 'photo';
        fadeTimer = null;
        const direction = pendingDirection;
        pendingDirection = null;
        if (direction !== null && !document.hidden) movePhoto(direction);
      };
      // Keep both image sources intact until the incoming layer is opaque.
      if (previous >= 0 && !reducedMotion) fadeTimer = window.setTimeout(finishFade, 1250);
      else finishFade();
      schedule(preferences.holdSeconds * 1000 + (reducedMotion ? 0 : 1200));
    };
    loadTimer = window.setTimeout(failed, LOAD_TIMEOUT);
    image.src = urls[target];
  }

  const movePhoto = (direction: -1 | 1): void => {
    if (loading || index < 0 || urls.length < 2) return;
    if (fadeTimer !== null) {
      pendingDirection = direction;
      return;
    }
    show((index + direction + urls.length) % urls.length);
  };
  previous?.addEventListener('click', () => movePhoto(-1));
  next?.addEventListener('click', () => movePhoto(1));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimer();
    else if (!loading && active < 0) show(0);
    else if (!loading) schedule();
  });
  window.addEventListener('online', () => { if (!loading && active < 0) show(0); });
  say(notice);
  void (async () => {
    if (mode === 'managed') {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('/api/display/photos', {
          method: 'GET', credentials: 'same-origin', cache: 'no-store',
          headers: { Accept: 'application/json' }, signal: controller.signal,
        });
        if (!response.ok) throw new Error('photos_unavailable');
        const text = await response.text();
        if (text.length > 30000) throw new Error('photos_response_too_large');
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== 'object' || !('photos' in value) || !Array.isArray(value.photos) || value.photos.length > 100) {
          throw new Error('invalid_photos_response');
        }
        const privateUrls = value.photos.map((photo: unknown) => {
          if (!photo || typeof photo !== 'object' || !('url' in photo) || typeof photo.url !== 'string' ||
            !/^\/api\/display\/photos\/[0-9a-f-]{36}$/i.test(photo.url)) throw new Error('invalid_photo');
          return photo.url;
        });
        if (privateUrls.length > 0) urls = privateUrls;
        else notice = 'No imported photos yet. Showing sample photographs.';
      } catch {
        notice = 'Private photos are unavailable. Showing sample photographs.';
      } finally { window.clearTimeout(timeout); }
    }
    say(notice);
    show(0);
  })();
}
