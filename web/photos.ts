import { defaultPhotoPreferences, readPhotoPreferences, savePhotoPreferences, validatePhotoPreferences } from './photo-preferences';

const LOAD_TIMEOUT = 15000;

export function initializePhotos(): void {
  const storage = () => window.localStorage;
  const saved = readPhotoPreferences(storage);
  let notice = saved.message;
  let preferences = saved.preferences;
  const frames = [document.getElementById('photoA'), document.getElementById('photoB')] as HTMLImageElement[];
  if (frames.some((frame) => !frame)) return;
  const status = document.getElementById('photo-status');
  const fallback = document.getElementById('photo-fallback');
  const pause = document.getElementById('pause-photos');
  const next = document.getElementById('next-photo');
  const sourceLabel = document.getElementById('photo-credit');
  let active = -1;
  let index = -1;
  let paused = false;
  let loading = false;
  let token = 0;
  let timer: number | null = null;
  let loadTimer: number | null = null;
  let fadeTimer: number | null = null;
  const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const say = (message: string): void => { if (status) status.textContent = message; };
  const clearTimer = (): void => { if (timer !== null) window.clearTimeout(timer); timer = null; };
  const schedule = (delay = preferences.holdSeconds * 1000): void => {
    clearTimer();
    if (!paused && preferences.urls.length > 1 && !document.hidden) timer = window.setTimeout(() => show((index + 1) % preferences.urls.length), delay);
  };

  // Each load and fade belongs to one generation; late events cannot replace a newer source.
  function show(target: number, attempts = 0): void {
    if (loading) return;
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
      if (attempts + 1 < preferences.urls.length) {
        show((target + 1) % preferences.urls.length, attempts + 1);
        return;
      }
      say(`Photos unavailable. Check your connection or choose another source.${paused ? '' : ' Retrying in one minute.'}`);
      if (active < 0 && fallback) fallback.textContent = 'Photographs unavailable. Choose another source or check your connection.';
      if (fallback) fallback.hidden = active >= 0;
      if (!paused && !document.hidden) timer = window.setTimeout(() => show(target), 60000);
    };
    image.onerror = failed;
    image.onload = () => {
      if (generation !== token) return;
      if (!image.naturalWidth) { failed(); return; }
      cleanupLoad();
      const previous = active;
      if (fadeTimer !== null) window.clearTimeout(fadeTimer);
      frames.forEach((frame) => { frame.className = 'photo'; });
      if (previous >= 0 && previous !== slot) frames[previous].className = 'photo previous';
      // Flush the hidden frame before adding the fade class, including cached images.
      void image.offsetWidth;
      image.className = 'photo active';
      active = slot;
      index = target;
      if (fallback) fallback.hidden = true;
      say(notice);
      fadeTimer = window.setTimeout(() => {
        if (generation !== token) return;
        if (previous >= 0 && previous !== active) frames[previous].className = 'photo';
        fadeTimer = null;
      }, reducedMotion ? 0 : 1250);
      schedule(preferences.holdSeconds * 1000 + (reducedMotion ? 0 : 1200));
    };
    loadTimer = window.setTimeout(failed, LOAD_TIMEOUT);
    image.src = preferences.urls[target];
  }

  pause?.addEventListener('click', () => {
    paused = !paused;
    pause.textContent = paused ? 'Play' : 'Pause';
    pause.setAttribute('aria-pressed', String(paused));
    if (paused) clearTimer();
    else if (active < 0) show(0);
    else schedule();
  });
  next?.addEventListener('click', () => show((index + 1) % preferences.urls.length));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimer();
    else if (!paused && !loading && active < 0) show(0);
    else if (!loading) schedule();
  });
  window.addEventListener('online', () => { if (!loading && active < 0) show(0); });

  const dialog = document.getElementById('photo-dialog');
  const form = document.getElementById('photo-form');
  const trigger = document.getElementById('photo-open');
  const input = document.getElementById('photo-urls') as HTMLTextAreaElement | null;
  const hold = document.getElementById('photo-hold') as HTMLInputElement | null;
  const error = document.getElementById('photo-error');
  const page = document.querySelector<HTMLElement>('.page-shell');
  const stops = new Map<HTMLElement, string | null>();
  const close = (): void => {
    if (dialog) dialog.hidden = true;
    page?.removeAttribute('aria-hidden');
    for (const [element, value] of stops) {
      if (value === null) element.removeAttribute('tabindex');
      else element.setAttribute('tabindex', value);
    }
    stops.clear();
    trigger?.focus();
  };
  trigger?.addEventListener('click', () => {
    if (!dialog || !input || !hold || !dialog.hidden) return;
    input.value = preferences.urls.join('\n');
    hold.value = String(preferences.holdSeconds);
    if (error) error.textContent = '';
    dialog.hidden = false;
    input.focus();
    page?.setAttribute('aria-hidden', 'true');
    page?.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]').forEach((element) => {
      stops.set(element, element.getAttribute('tabindex'));
      element.setAttribute('tabindex', '-1');
    });
  });
  const credit = (): void => {
    if (sourceLabel) sourceLabel.textContent = preferences.urls.every((url) => defaultPhotoPreferences().urls.includes(url)) ? 'Sample photography via Unsplash' : 'Configured public photo sources';
  };
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!input || !hold) return;
    const candidate = { version: 1 as const, urls: input.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), holdSeconds: Number(hold.value) };
    if (!validatePhotoPreferences(candidate)) {
      if (error) error.textContent = 'Use 1–12 public HTTPS image URLs (one per line, no logins/fragments or local addresses), and a whole-number hold of 10–3600 seconds.';
      input.focus();
      return;
    }
    preferences = candidate;
    const persisted = savePhotoPreferences(storage, preferences);
    token += 1;
    clearTimer();
    if (loadTimer !== null) window.clearTimeout(loadTimer);
    if (fadeTimer !== null) window.clearTimeout(fadeTimer);
    frames.forEach((frame) => { frame.onload = null; frame.onerror = null; frame.removeAttribute('src'); frame.className = 'photo'; });
    loading = false;
    active = -1;
    index = -1;
    if (fallback) fallback.hidden = false;
    notice = persisted ? 'Photo settings saved in this browser.' : 'Photos set for this visit only; browser storage is unavailable.';
    say(notice);
    credit();
    close();
    show(0);
  });
  document.getElementById('photo-samples')?.addEventListener('click', () => {
    if (input && hold) { input.value = defaultPhotoPreferences().urls.join('\n'); hold.value = '20'; }
  });
  document.getElementById('photo-cancel')?.addEventListener('click', close);
  dialog?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, textarea'));
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.addEventListener('focusin', (event) => {
    if (dialog && !dialog.hidden && !dialog.contains(event.target as Node)) input?.focus();
  });
  credit();
  say(saved.message);
  show(0);
}
