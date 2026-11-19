import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';

const preferencesBuild = await build({
  entryPoints: ['web/photo-preferences.ts'], bundle: true, format: 'esm', target: 'firefox68', write: false,
});
const preferencesUrl = `data:text/javascript;base64,${Buffer.from(preferencesBuild.outputFiles[0].text).toString('base64')}`;
const {
  PHOTO_STORAGE_KEY,
  defaultPhotoPreferences,
  readPhotoPreferences,
  savePhotoPreferences,
  validatePhotoPreferences,
} = await import(preferencesUrl);

const photosBuild = await build({
  entryPoints: ['web/photos.ts'], bundle: true, format: 'iife', globalName: 'PhotosModule', target: 'firefox68', write: false,
});
const photosSource = photosBuild.outputFiles[0].text;

function photoPreferences(urls = ['https://photos.example.org/one.jpg', 'https://photos.example.org/two.jpg'], holdSeconds = 10) {
  return { version: 1, urls, holdSeconds };
}

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem(key) { return entries.has(key) ? entries.get(key) : null; },
    setItem(key, value) { entries.set(key, value); },
  };
}

class Element {
  constructor() {
    this.textContent = '';
    this.hidden = false;
    this.value = '';
    this.attributes = {};
    this.listeners = new Map();
  }
  addEventListener(name, callback) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), callback]);
  }
  fire(name, event = { preventDefault() {} }) {
    for (const callback of this.listeners.get(name) || []) callback(event);
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() {}
}

class ImageElement extends Element {
  constructor() {
    super();
    this.naturalWidth = 0;
    this.offsetWidth = 0;
    this.onload = null;
    this.onerror = null;
    this.src = '';
    this.className = '';
  }
  removeAttribute(name) {
    super.removeAttribute(name);
    if (name === 'src') this.src = '';
  }
}

function browser({ preferences = photoPreferences(), storage = memoryStorage(), hidden = false, storageBlocked = false, mode = 'preview', fetcher } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, id === 'photoA' || id === 'photoB' ? new ImageElement() : new Element());
    return elements.get(id);
  };
  const documentListeners = new Map();
  const document = {
    hidden,
    getElementById: element,
    addEventListener(name, callback) {
      documentListeners.set(name, [...(documentListeners.get(name) || []), callback]);
    },
    fire(name, event = {}) {
      for (const callback of documentListeners.get(name) || []) callback(event);
    },
  };
  const timers = new Map();
  const windowListeners = new Map();
  let nextTimer = 0;
  const window = {
    get localStorage() {
      if (storageBlocked) throw new Error('Storage blocked');
      return storage;
    },
    matchMedia() { return { matches: false }; },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
  };
  const context = { PhotosModule: undefined, document, window, URL, Map, Array, String, Number, Boolean, AbortController, fetch: fetcher };
  vm.runInNewContext(photosSource, context);
  context.PhotosModule.initializePhotos(mode);

  return {
    document, elements, timers, window,
    element,
    image(id) { return element(id); },
    runTimer(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay}ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
    complete(image) {
      image.naturalWidth = 1200;
      image.onload?.();
    },
    fail(image) { image.onerror?.(); },
  };
}

test('photo preferences enforce URL, count, and hold-time bounds', () => {
  assert.equal(validatePhotoPreferences(photoPreferences(['https://photos.example.org/one.jpg'], 10)), true);
  assert.equal(validatePhotoPreferences(photoPreferences(Array.from({ length: 12 }, (_, index) => `https://photos.example.org/${index}.jpg`), 3600)), true);
  for (const invalid of [
    photoPreferences([], 10),
    photoPreferences(Array.from({ length: 13 }, (_, index) => `https://photos.example.org/${index}.jpg`), 10),
    photoPreferences(['https://photos.example.org/one.jpg'], 9),
    photoPreferences(['https://photos.example.org/one.jpg'], 3601),
    photoPreferences(['https://photos.example.org/one.jpg'], 10.5),
  ]) {
    assert.equal(validatePhotoPreferences(invalid), false);
  }
});

test('default rotation is ten minutes and only the old built-in default is upgraded', () => {
  assert.equal(defaultPhotoPreferences().holdSeconds, 600);
  const sampleStorage = memoryStorage({
    [PHOTO_STORAGE_KEY]: JSON.stringify({ version: 1, urls: defaultPhotoPreferences().urls, holdSeconds: 20 }),
  });
  assert.equal(readPhotoPreferences(sampleStorage).preferences.holdSeconds, 600);

  const customStorage = memoryStorage({
    [PHOTO_STORAGE_KEY]: JSON.stringify(photoPreferences(['https://photos.example.org/custom.jpg'], 20)),
  });
  assert.equal(readPhotoPreferences(customStorage).preferences.holdSeconds, 20);
});

test('photo preferences reject insecure, credentialed, fragmented, and local URL forms', () => {
  for (const url of [
    'http://photos.example.org/image.jpg',
    'javascript:alert(1)',
    'https://user:password@photos.example.org/image.jpg',
    'https://photos.example.org/image.jpg#private',
    'https://photos.example.org:8443/image.jpg',
    'https://localhost/image.jpg',
    'https://printer.local/image.jpg',
    'https://192.0.2.1/image.jpg',
    '/relative/image.jpg',
  ]) {
    assert.equal(validatePhotoPreferences(photoPreferences([url])), false, `Expected ${url} to be rejected`);
  }
});

test('photo area has only transparent tap zones and no source editor UI', async () => {
  const html = await readFile('web/index.html', 'utf8');
  const css = await readFile('web/styles.css', 'utf8');
  assert.match(html, /id="photo-previous"[^>]*><span class="visually-hidden">Previous photo/);
  assert.match(html, /id="photo-next"[^>]*><span class="visually-hidden">Next photo/);
  assert.doesNotMatch(html, /id="photo-open"|id="photo-dialog"|id="photo-form"|id="pause-photos"|id="next-photo"|id="photo-credit"|class="scene-controls"/);
  assert.match(css, /\.photo-zone:hover, \.photo-zone:focus, \.photo-zone:active \{[^}]*outline: none; background: transparent/);
});

test('photo preference reads use defaults for malformed records and blocked storage', () => {
  const storage = memoryStorage({ [PHOTO_STORAGE_KEY]: JSON.stringify({ version: 2, urls: [] }) });
  const invalid = readPhotoPreferences(storage);
  assert.deepEqual(invalid.preferences, defaultPhotoPreferences());
  assert.match(invalid.message, /invalid/);

  storage.setItem(PHOTO_STORAGE_KEY, '{not json');
  const malformed = readPhotoPreferences(storage);
  assert.deepEqual(malformed.preferences, defaultPhotoPreferences());
  assert.match(malformed.message, /could not be read/);

  storage.setItem(PHOTO_STORAGE_KEY, 'x'.repeat(26001));
  assert.match(readPhotoPreferences(storage).message, /invalid/);
  assert.match(readPhotoPreferences(() => { throw new Error('blocked'); }).message, /could not be read/);
});

test('saving photo preferences validates input and reports blocked persistence', () => {
  const storage = memoryStorage();
  assert.equal(savePhotoPreferences(storage, photoPreferences(['https://photos.example.org/saved.jpg'])), true);
  assert.deepEqual(JSON.parse(storage.getItem(PHOTO_STORAGE_KEY)), photoPreferences(['https://photos.example.org/saved.jpg']));
  assert.equal(savePhotoPreferences(storage, photoPreferences(['http://photos.example.org/no.jpg'])), false);
  assert.equal(savePhotoPreferences({ setItem() { throw new Error('blocked'); } }, photoPreferences()), false);
  assert.equal(savePhotoPreferences(() => { throw new Error('blocked'); }, photoPreferences()), false);
});

test('left/right photo zones navigate and rotation defaults to a ten-minute hold', () => {
  const prefs = photoPreferences(undefined, 600);
  const page = browser({ preferences: prefs, storage: memoryStorage({ [PHOTO_STORAGE_KEY]: JSON.stringify(prefs) }) });
  const first = page.image('photoA');
  assert.equal(first.src, prefs.urls[0]);
  page.complete(first);
  assert.equal(first.className, 'photo active');
  assert.ok([...page.timers.values()].some((timer) => timer.delay === 601200));

  page.element('photo-previous').fire('click');
  const second = page.image('photoB');
  assert.equal(second.src, prefs.urls[1]);
  page.complete(second);
  assert.equal(second.className, 'photo active');
  page.element('photo-next').fire('click');
  assert.equal(page.image('photoA').src, prefs.urls[0]);
});

test('photo load failures are bounded and a failed replacement keeps the last good frame', () => {
  const prefs = photoPreferences();
  const page = browser({ preferences: prefs, storage: memoryStorage({ [PHOTO_STORAGE_KEY]: JSON.stringify(prefs) }) });
  const good = page.image('photoA');
  page.complete(good);
  page.runTimer(11200);

  const replacement = page.image('photoB');
  assert.equal(replacement.src, prefs.urls[1]);
  page.fail(replacement);
  assert.equal(replacement.src, prefs.urls[0]);
  page.fail(replacement);

  assert.equal(good.className, 'photo active');
  assert.equal(replacement.className, 'photo');
  assert.match(page.element('photo-status').textContent, /Photos unavailable/);
  assert.ok([...page.timers.values()].some((timer) => timer.delay === 60000));
});

test('photo load timeout retries after a bounded delay instead of looping immediately', () => {
  const prefs = photoPreferences(['https://photos.example.org/only.jpg']);
  const page = browser({ preferences: prefs, storage: memoryStorage({ [PHOTO_STORAGE_KEY]: JSON.stringify(prefs) }) });
  const image = page.image('photoA');
  page.runTimer(15000);
  assert.match(page.element('photo-status').textContent, /Photos unavailable/);
  assert.ok([...page.timers.values()].some((timer) => timer.delay === 60000));

  page.runTimer(60000);
  assert.equal(image.src, prefs.urls[0]);
  assert.ok([...page.timers.values()].some((timer) => timer.delay === 15000));
});

test('existing browser-local sources remain loaded without a source editor', () => {
  const prefs = photoPreferences(['https://photos.example.org/personal.jpg'], 600);
  const page = browser({ preferences: prefs, storage: memoryStorage({ [PHOTO_STORAGE_KEY]: JSON.stringify(prefs) }) });
  assert.equal(page.image('photoA').src, prefs.urls[0]);
});

test('hidden documents do not rotate photos until they become visible', () => {
  const prefs = photoPreferences();
  const page = browser({ preferences: prefs, storage: memoryStorage({ [PHOTO_STORAGE_KEY]: JSON.stringify(prefs) }) });
  const first = page.image('photoA');
  page.complete(first);
  assert.ok([...page.timers.values()].some((timer) => timer.delay === 11200));

  page.document.hidden = true;
  page.document.fire('visibilitychange');
  assert.equal([...page.timers.values()].some((timer) => timer.delay === 11200), false);
  assert.equal(page.image('photoA').src, prefs.urls[0]);

  page.document.hidden = false;
  page.document.fire('visibilitychange');
  assert.ok([...page.timers.values()].some((timer) => timer.delay === 10000));
});

test('blocked photo storage still shows built-in sample photos with a visible notice', () => {
  const page = browser({ storageBlocked: true });
  assert.equal(page.image('photoA').src, defaultPhotoPreferences().urls[0]);
  assert.match(page.element('photo-status').textContent, /could not be read/);
});

test('managed slideshow uses only authenticated private photo paths and falls back to samples on failure', async () => {
  const privatePhoto = '/api/display/photos/123e4567-e89b-12d3-a456-426614174000';
  const managed = browser({
    mode: 'managed',
    fetcher: async (url, options) => {
      assert.equal(url, '/api/display/photos');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.cache, 'no-store');
      return Response.json({ photos: [{ id: '123e4567-e89b-12d3-a456-426614174000', url: privatePhoto }] });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(managed.image('photoA').src, privatePhoto);

  const fallback = browser({ mode: 'managed', fetcher: async () => new Response('{}', { status: 401 }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(fallback.image('photoA').src, /^https:\/\/images\.unsplash\.com\//);
  assert.match(fallback.element('photo-status').textContent, /Private photos are unavailable/);
});
