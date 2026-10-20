export const LOCATION_STORAGE_KEY = 'sabio.location.v1';

const LOCATION_RECORD_VERSION = 2;
const MAX_STORAGE_JSON_LENGTH = 512;

export interface LocationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type LocationStorageSource = LocationStorage | (() => LocationStorage);

export interface StoredLocationResult {
  zipCode: string | null;
  available: boolean;
  hasStoredPreference: boolean;
}

function getStorage(source: LocationStorageSource): LocationStorage {
  const storage = typeof source === 'function' ? source() : source;
  if (!storage || typeof storage.getItem !== 'function' ||
      typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
    throw new Error('Location storage is unavailable');
  }
  return storage;
}

export function normalizeZipCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || (codePoint >= 0 && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
  }

  const zipCode = value.trim();
  return /^[0-9]{5}(?:-[0-9]{4})?$/.test(zipCode) ? zipCode : null;
}

export function readLocationPreference(source: LocationStorageSource): StoredLocationResult {
  let stored: string | null;
  try {
    stored = getStorage(source).getItem(LOCATION_STORAGE_KEY);
  } catch {
    return { zipCode: null, available: false, hasStoredPreference: false };
  }
  if (stored === null) return { zipCode: null, available: true, hasStoredPreference: false };
  if (typeof stored !== 'string' || stored.length > MAX_STORAGE_JSON_LENGTH) {
    return { zipCode: null, available: true, hasStoredPreference: true };
  }

  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { zipCode: null, available: true, hasStoredPreference: true };
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.version !== LOCATION_RECORD_VERSION) {
      return { zipCode: null, available: true, hasStoredPreference: true };
    }
    const zipCode = normalizeZipCode(record.zipCode);
    return { zipCode, available: true, hasStoredPreference: true };
  } catch {
    return { zipCode: null, available: true, hasStoredPreference: true };
  }
}

export function writeLocationPreference(source: LocationStorageSource, value: unknown): boolean {
  const zipCode = normalizeZipCode(value);
  if (zipCode === null) return false;
  try {
    getStorage(source).setItem(LOCATION_STORAGE_KEY, JSON.stringify({
      version: LOCATION_RECORD_VERSION,
      zipCode,
    }));
    return true;
  } catch {
    return false;
  }
}

export function resetLocationPreference(source: LocationStorageSource): boolean {
  try {
    getStorage(source).removeItem(LOCATION_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export interface LocationControls {
  getCurrentLabel(): string;
  setDefaultLabel(label: string): void;
}

function focusIfAvailable(element: HTMLElement | null): void {
  const focusable = element as (HTMLElement & { focus?: () => void }) | null;
  if (focusable && typeof focusable.focus === 'function') {
    try {
      focusable.focus();
    } catch {
      // Keep the display usable when a minimal browser or test DOM cannot focus.
    }
  }
}

export function initializeLocationControls(defaultLabel = 'Sample location'): LocationControls {
  const storageSource = () => window.localStorage;
  const preference = readLocationPreference(storageSource);
  let selectedZipCode = preference.zipCode;
  let hasStoredPreference = preference.hasStoredPreference;
  let fallbackLabel = defaultLabel;

  const labelNode = document.getElementById('weather-location');
  const statusNode = document.getElementById('location-status');
  const trigger = document.getElementById('location-open') as HTMLButtonElement | null;
  const dialog = document.getElementById('location-dialog') as HTMLDivElement | null;
  const form = document.getElementById('location-form') as HTMLFormElement | null;
  const input = document.getElementById('location-input') as HTMLInputElement | null;
  const errorNode = document.getElementById('location-error');
  const resetButton = document.getElementById('location-reset') as HTMLButtonElement | null;
  const cancelButton = document.getElementById('location-cancel') as HTMLButtonElement | null;
  const saveButton = document.getElementById('location-save') as HTMLButtonElement | null;
  const page = document.querySelector<HTMLElement>('.page-shell');
  let previousPageHidden: string | null = null;
  const backgroundTabStops = new Map<HTMLElement, string | null>();

  const currentLabel = (): string => selectedZipCode === null ? fallbackLabel : `ZIP ${selectedZipCode}`;
  const renderLabel = (): void => {
    if (labelNode) labelNode.textContent = currentLabel();
    if (trigger) trigger.textContent = selectedZipCode === null ? 'Set ZIP code' : 'Change ZIP code';
    if (resetButton) resetButton.hidden = selectedZipCode === null && !hasStoredPreference;
  };
  const announce = (message: string): void => {
    if (statusNode) statusNode.textContent = message;
  };
  const clearError = (): void => {
    if (errorNode) {
      errorNode.textContent = '';
      errorNode.hidden = true;
    }
  };
  const closeDialog = (): void => {
    for (const [element, tabIndex] of backgroundTabStops) {
      if (tabIndex === null) element.removeAttribute('tabindex');
      else element.setAttribute('tabindex', tabIndex);
    }
    backgroundTabStops.clear();
    if (page) {
      if (previousPageHidden === null) page.removeAttribute('aria-hidden');
      else page.setAttribute('aria-hidden', previousPageHidden);
    }
    if (dialog) dialog.hidden = true;
    clearError();
    focusIfAvailable(trigger);
  };

  renderLabel();
  if (!preference.available) {
    announce('ZIP preference storage is unavailable; changes will last for this visit only.');
  } else if (preference.hasStoredPreference && preference.zipCode === null) {
    announce('Set a ZIP code for this browser; saved preferences that are not ZIP codes are not used.');
  }

  if (trigger && dialog && input && form && cancelButton && saveButton) {
    trigger.addEventListener('click', () => {
      if (!dialog.hidden) return;
      input.value = selectedZipCode || '';
      clearError();
      if (dialog) dialog.hidden = false;
      focusIfAvailable(input);
      if (page) {
        previousPageHidden = page.getAttribute('aria-hidden');
        page.setAttribute('aria-hidden', 'true');
        if (typeof page.querySelectorAll === 'function') {
          for (const element of page.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')) {
            backgroundTabStops.set(element, element.getAttribute('tabindex'));
            element.setAttribute('tabindex', '-1');
          }
        }
      }
    });

    const save = (): void => {
      const zipCode = normalizeZipCode(input.value);
      if (zipCode === null) {
        if (errorNode) {
          errorNode.textContent = 'Enter a US ZIP code as 5 digits or ZIP+4 (00000-0000).';
          errorNode.hidden = false;
        }
        focusIfAvailable(input);
        return;
      }

      selectedZipCode = zipCode;
      const persisted = writeLocationPreference(storageSource, zipCode);
      if (persisted) hasStoredPreference = true;
      renderLabel();
      closeDialog();
      announce(persisted
        ? 'ZIP code saved in this browser.'
        : 'ZIP code set for this visit only; browser storage is unavailable.');
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      save();
    });
    cancelButton.addEventListener('click', closeDialog);
    if (resetButton) {
      resetButton.addEventListener('click', () => {
        selectedZipCode = null;
        const removed = resetLocationPreference(storageSource);
        if (removed) hasStoredPreference = false;
        renderLabel();
        closeDialog();
        announce(removed
          ? 'ZIP code reset to the sample default.'
          : 'ZIP code reset for this visit; browser storage could not be cleared.');
      });
    }

    dialog.addEventListener('keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        closeDialog();
        return;
      }
      if (keyboardEvent.key !== 'Tab') return;

      const focusable = [input, resetButton, cancelButton, saveButton]
        .filter((element): element is HTMLButtonElement | HTMLInputElement =>
          Boolean(element && !element.hidden && !element.disabled));
      if (focusable.length === 0) return;
      const activeIndex = focusable.indexOf(document.activeElement as HTMLButtonElement | HTMLInputElement);
      if (keyboardEvent.shiftKey && activeIndex <= 0) {
        keyboardEvent.preventDefault();
        focusIfAvailable(focusable[focusable.length - 1]);
      } else if (!keyboardEvent.shiftKey && activeIndex === focusable.length - 1) {
        keyboardEvent.preventDefault();
        focusIfAvailable(focusable[0]);
      }
    });
    // Also catch focus entering controls recreated by a background data refresh.
    document.addEventListener('focusin', (event) => {
      if (!dialog.hidden && !dialog.contains(event.target as Node)) focusIfAvailable(input);
    });
  }

  return {
    getCurrentLabel: currentLabel,
    setDefaultLabel(label: string): void {
      fallbackLabel = label;
      renderLabel();
    },
  };
}
