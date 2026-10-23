import assert from 'node:assert/strict';
import test from 'node:test';
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

function browser({ preferences = photoPreferences(), storage = memoryStorage(), hidden = false, storageBlocked = false } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, id === 'photoA' || id === 'photoB' ? new ImageElement() : new Element());
    return elements.get(id);
  };
  const documentListeners = new Map();
  const document = {
    hidden,
    getElementById: element,
    querySelector(selector) { return selector === '.page-shell' ? element('page-shell') : null; },
    addEventListener(name, callback) {
      documentListeners.set(name, [...(documentListeners.get(name) || []), callback]);
    },
    fire(name, event = {}) {
      for (const callback of documentListeners.get(name) || []) callback(event);
    },
  };
  element('photo-dialog').hidden = true;
  element('photo-dialog').querySelectorAll = () => [element('photo-submit'), element('photo-urls'), element('photo-hold')];
  element('page-shell').querySelectorAll = () => [];

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
  const context = { PhotosModule: undefined, document, window, URL, Map, Array, String, Number, Boolean };
  vm.runInNewContext(photosSource, context);
  context.PhotosModule.initializePhotos();

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
    save(urls, holdSeconds = 10) {
      element('photo-urls').value = urls.join('\n');
      element('photo-hold').value = String(holdSeconds);
      element('photo-form').fire('submit');
    },
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

test('the slideshow loads images, pauses rotation, and advances on demand', () => {
  const prefs = photoPreferences();
  const page = browser({ preferences: prefs, storage: memoryStorage({ [PHOTO_STORAGE_KEY]: JSON.stringify(prefs) }) });
  const first = page.image('photoA');
  assert.equal(first.src, prefs.urls[0]);
  page.complete(first);
  assert.equal(first.className, 'photo active');
  assert.ok([...page.timers.values()].some((timer) => timer.delay === 11200));

  page.element('pause-photos').fire('click');
  assert.equal(page.element('pause-photos').textContent, 'Play');
  assert.equal(page.element('pause-photos').getAttribute('aria-pressed'), 'true');
  assert.equal([...page.timers.values()].some((timer) => timer.delay === 11200), false);

  page.element('next-photo').fire('click');
  const second = page.image('photoB');
  assert.equal(second.src, prefs.urls[1]);
  page.complete(second);
  assert.equal(second.className, 'photo active');
  assert.equal([...page.timers.values()].some((timer) => timer.delay === 11200), false);
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

test('saving changed photo preferences invalidates an old image callback', () => {
  const old = photoPreferences();
  const page = browser({ preferences: old, storage: memoryStorage({ [PHOTO_STORAGE_KEY]: JSON.stringify(old) }) });
  const image = page.image('photoA');
  const staleLoad = image.onload;
  const nextUrl = 'https://photos.example.org/new.jpg';

  page.element('photo-open').fire('click');
  page.save([nextUrl], 15);
  assert.equal(image.src, nextUrl);
  const status = page.element('photo-status').textContent;
  image.naturalWidth = 1200;
  staleLoad();

  assert.equal(image.src, nextUrl);
  assert.equal(image.className, 'photo');
  assert.equal(page.element('photo-status').textContent, status);
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

test('blocked photo storage still applies visit-only settings with a visible notice', () => {
  const page = browser({ storageBlocked: true });
  page.element('photo-open').fire('click');
  const chosen = 'https://photos.example.org/visit.jpg';
  page.save([chosen]);
  assert.equal(page.image('photoA').src, chosen);
  assert.match(page.element('photo-status').textContent, /visit only/);
});
