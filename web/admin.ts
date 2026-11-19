import { displayDetails } from './display-details';

const status = document.getElementById('admin-status');
const list = document.getElementById('admin-displays');
const revokedList = document.getElementById('revoked-displays');
const revokedHistory = document.getElementById('revoked-history') as HTMLDetailsElement | null;
const revokedSummary = document.getElementById('revoked-summary');
const pairingForm = document.getElementById('pairing-form');
const pairingCode = document.getElementById('pairing-code');
const pairingButton = document.getElementById('pairing-generate') as HTMLButtonElement | null;
const photosConnect = document.getElementById('photos-connect') as HTMLButtonElement | null;
const photosDisconnect = document.getElementById('photos-disconnect') as HTMLButtonElement | null;
const photosImportPanel = document.getElementById('photos-import-panel');
const photosPickerLink = document.getElementById('photos-picker-link') as HTMLAnchorElement | null;
const photosImportButton = document.getElementById('photos-import') as HTMLButtonElement | null;
const photosCancelButton = document.getElementById('photos-cancel') as HTMLButtonElement | null;
const photosStatus = document.getElementById('photos-status');
const photosList = document.getElementById('photos-list');
const photosCallbackResult = new URLSearchParams(window.location.search || '').get('photos');
const say = (message: string): void => { if (status) status.textContent = message; };
const sayPhotos = (message: string): void => { if (photosStatus) photosStatus.textContent = message; };
let busy = false;
let photosBusy = false;
let activeImportId: string | null = null;
let reauthorizeGoogle = false;

async function api(path: string, body?: object): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: controller.signal,
    });
    if (!response.ok) {
      let code = 'admin_request_failed';
      try {
        const value: unknown = await response.json();
        if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') code = value.error;
      } catch { /* Keep the generic failure when the response is not valid JSON. */ }
      throw new Error(code);
    }
    return response.status === 204 ? null : await response.json();
  } finally { window.clearTimeout(timeout); }
}

function photoError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'photos_not_configured') return 'Google Photos or private storage is not configured for this deployment.';
  if (code === 'active_import') return 'Finish or cancel the current Google Photos selection before starting another.';
  if (code === 'import_in_progress') return 'An import is already running. Wait a moment and refresh the photo library.';
  if (code === 'google_reconnect_required') return 'Google authorization expired or was revoked. Reconnect Google Photos to continue.';
  if (code === 'google_connection_unavailable') return 'Sabio could not read the saved Google connection. Reconnect Google Photos.';
  if (code === 'google_refresh_unavailable') return 'Google could not refresh access right now. Retry in a moment; reconnect only if Google reports the grant is invalid.';
  if (code === 'google_photos_api_unavailable') return 'Google Photos rejected the Picker request. Confirm the Photos Picker API is enabled in the same Cloud project as this OAuth client and that the read-only Picker scope is configured.';
  if (code === 'google_photos_account_unavailable') return 'This Google account does not have an active Google Photos account for Picker access.';
  if (code === 'picker_rate_limited') return 'Google Photos is limiting Picker sessions. Wait before trying again.';
  if (code === 'google_picker_response_invalid') return 'Google Photos returned an unexpected Picker response. Confirm the correct Photos Picker API is enabled for this OAuth project.';
  if (code === 'google_picker_network_unavailable') return 'Sabio could not reach Google Photos to create a Picker session. Check the connection and retry.';
  if (code === 'picker_session_storage_failed') return 'Google created a Picker session, but Sabio could not save it. Refresh the library and retry.';
  const pickerHttpError = /^google_picker_http_(\d{3})$/.exec(code);
  if (pickerHttpError) return `Google Photos rejected the Picker session request (HTTP ${pickerHttpError[1]}). Check the API and OAuth project settings.`;
  if (code === 'picker_session_unavailable') return 'Google authorization worked, but Google Photos could not create a Picker session. Retry; if it continues, check the Photos Picker API configuration.';
  if (code === 'too_many_photos' || code === 'import_photo_limit') return 'Select no more than 12 photos in one import.';
  if (code === 'unsupported_media') return 'The selection includes a video or unsupported image. Select still photos only.';
  if (code === 'photo_count_limit') return 'The private library has reached its photo limit. Remove photos before importing more.';
  if (code === 'storage_limit' || code === 'import_size_limit') return 'The configured private storage limit would be exceeded.';
  if (code === 'selection_pending') return 'Finish selecting photos in Google Photos, then try again.';
  if (code === 'import_not_found') return 'This selection expired. Start a new Google Photos selection.';
  return 'The private photo request failed. Check the connection and retry.';
}

interface AdminPhoto { id: string; contentType: string; sizeBytes: number; position: number; createdAt: number; }

async function refreshPhotos(): Promise<void> {
  try {
    const value = await api('/api/admin/photos');
    if (!value || typeof value !== 'object' || !('photos' in value) || !Array.isArray(value.photos) || value.photos.length > 100 ||
        !('googleConnected' in value) || typeof value.googleConnected !== 'boolean') {
      throw new Error('invalid_response');
    }
    if (!photosList) return;
    photosList.textContent = '';
    const photos = value.photos as unknown[];
    const valid = photos.map((photo): AdminPhoto => {
      if (!photo || typeof photo !== 'object' || !('id' in photo) || typeof photo.id !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(photo.id) || !('contentType' in photo) || typeof photo.contentType !== 'string' ||
          !['image/jpeg', 'image/png', 'image/webp'].includes(photo.contentType) || !('sizeBytes' in photo) ||
          typeof photo.sizeBytes !== 'number' || !Number.isSafeInteger(photo.sizeBytes) || photo.sizeBytes <= 0 ||
          !('position' in photo) || typeof photo.position !== 'number' || !Number.isInteger(photo.position) ||
          !('createdAt' in photo) || typeof photo.createdAt !== 'number' || !Number.isFinite(photo.createdAt)) {
        throw new Error('invalid_photo');
      }
      return photo as AdminPhoto;
    });
    if (valid.length === 0) photosList.textContent = 'No imported photos. Built-in sample photos remain available on displays.';
    valid.forEach((photo, index) => {
      const item = document.createElement('li');
      const title = document.createElement('h3');
      title.textContent = `Photo ${index + 1}`;
      const detail = document.createElement('p');
      detail.className = 'small-note';
      detail.textContent = `${photo.contentType} · ${(photo.sizeBytes / 1024 / 1024).toFixed(2)} MB · Added ${new Date(photo.createdAt * 1000).toLocaleDateString()}`;
      item.appendChild(title);
      item.appendChild(detail);
      const actions = document.createElement('div');
      actions.className = 'photo-actions';
      for (const [label, direction] of [['Move earlier', -1], ['Move later', 1]] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'text-button';
        button.textContent = label;
        button.disabled = photosBusy || (direction < 0 ? index === 0 : index === valid.length - 1);
        button.addEventListener('click', () => {
          if (photosBusy) return;
          const reordered = valid.map((entry) => entry.id);
          const target = index + direction;
          [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
          void api('/api/admin/photos/reorder', { ids: reordered }).then(refreshPhotos)
            .catch((failure) => sayPhotos(photoError(failure)));
        });
        actions.appendChild(button);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'text-button';
      remove.textContent = 'Remove photo';
      remove.disabled = photosBusy;
      remove.addEventListener('click', () => {
        if (photosBusy) return;
        photosBusy = true;
        remove.disabled = true;
        void api('/api/admin/photos/delete', { photoId: photo.id }).then(async () => {
          sayPhotos('Photo removed from private storage.');
          await refreshPhotos();
        }).catch((failure) => { sayPhotos(photoError(failure)); remove.disabled = false; })
          .finally(() => { photosBusy = false; });
      });
      actions.appendChild(remove);
      item.appendChild(actions);
      photosList?.appendChild(item);
    });

    const active = 'activeImport' in value ? value.activeImport : null;
    activeImportId = null;
    if (active && typeof active === 'object' && 'id' in active && typeof active.id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(active.id) && 'pickerUri' in active && typeof active.pickerUri === 'string') {
      let picker: URL;
      try { picker = new URL(active.pickerUri); } catch { throw new Error('invalid_picker_url'); }
      if (picker.protocol !== 'https:' || picker.hostname !== 'photos.google.com' || picker.username || picker.password) {
        throw new Error('invalid_picker_url');
      }
      activeImportId = active.id;
      if (photosPickerLink) photosPickerLink.href = picker.href;
      if (photosImportPanel) photosImportPanel.hidden = false;
      if (photosConnect) {
        photosConnect.textContent = 'Picker session active';
        photosConnect.disabled = true;
      }
      sayPhotos('A Google Photos selection is ready. Open the picker, select photos, then import them here.');
    } else {
      if (photosImportPanel) photosImportPanel.hidden = true;
      if (photosConnect) {
        photosConnect.disabled = photosBusy;
        photosConnect.textContent = value.googleConnected
          ? reauthorizeGoogle ? 'Reconnect Google Photos' : 'Open Google Photos Picker'
          : 'Connect Google Photos';
      }
      if (photosDisconnect) {
        photosDisconnect.hidden = !value.googleConnected;
        photosDisconnect.disabled = photosBusy;
      }
      sayPhotos(value.googleConnected
        ? `${valid.length} private photo${valid.length === 1 ? '' : 's'} available. Google Photos is connected.`
        : valid.length > 0
          ? `${valid.length} private photo${valid.length === 1 ? '' : 's'} available to the slideshow.`
          : 'The private library is empty.');
    }
    if (activeImportId && photosDisconnect) {
      photosDisconnect.hidden = !value.googleConnected;
      photosDisconnect.disabled = photosBusy;
    }
    if (!activeImportId && ['picker-failed', 'google_photos_api_unavailable', 'google_photos_account_unavailable',
      'picker_rate_limited', 'google_picker_response_invalid', 'google_picker_network_unavailable',
      'picker_session_storage_failed', 'picker_session_unavailable'].includes(photosCallbackResult || '')) {
      sayPhotos(photoError(new Error(photosCallbackResult && photosCallbackResult !== 'picker-failed'
        ? photosCallbackResult : 'picker_session_unavailable')));
    } else if (!activeImportId && /^google_picker_http_\d{3}$/.test(photosCallbackResult || '')) {
      sayPhotos(photoError(new Error(photosCallbackResult || 'picker_session_unavailable')));
    } else if (!activeImportId && photosCallbackResult === 'failed') {
      sayPhotos('Google authorization returned, but Sabio could not finish setting up the connection. Check the OAuth client and try again.');
    } else if (!activeImportId && photosCallbackResult === 'expired') {
      sayPhotos('That authorization attempt expired. Connect to Google Photos again.');
    } else if (!activeImportId && photosCallbackResult === 'cancelled') {
      sayPhotos('Google Photos authorization was cancelled. Connect when you are ready to continue.');
    }
  } catch (error) {
    sayPhotos(photoError(error));
  }
}

photosConnect?.addEventListener('click', () => {
  if (photosBusy) return;
  photosBusy = true;
  photosConnect.disabled = true;
  sayPhotos(reauthorizeGoogle ? 'Reconnecting to Google Photos…' : 'Opening Google Photos…');
  void api('/api/admin/photos/connect', reauthorizeGoogle ? { reauthorize: true } : {}).then(async (value) => {
    if (!value || typeof value !== 'object') throw new Error('invalid_response');
    if ('authorizationUrl' in value && typeof value.authorizationUrl === 'string') {
      const authorizationUrl = new URL(value.authorizationUrl);
      if (authorizationUrl.protocol !== 'https:' || authorizationUrl.hostname !== 'accounts.google.com' || authorizationUrl.pathname !== '/o/oauth2/v2/auth') {
        throw new Error('invalid_authorization_url');
      }
      window.location.assign(authorizationUrl.href);
      return;
    }
    if ('status' in value && value.status === 'picker_ready') {
      reauthorizeGoogle = false;
      await refreshPhotos();
      sayPhotos('Google Photos is connected. Open the Picker, select photos, then import them here.');
      return;
    }
    throw new Error('invalid_response');
  }).catch((error) => {
    if (error instanceof Error && error.message === 'google_reconnect_required') {
      reauthorizeGoogle = true;
      photosConnect.textContent = 'Reconnect Google Photos';
    }
    sayPhotos(photoError(error));
  }).finally(() => {
    photosBusy = false;
    if (!activeImportId) photosConnect.disabled = false;
    if (photosDisconnect) photosDisconnect.disabled = false;
  });
});

photosDisconnect?.addEventListener('click', () => {
  if (photosBusy) return;
  photosBusy = true;
  photosDisconnect.disabled = true;
  if (photosConnect) photosConnect.disabled = true;
  sayPhotos('Disconnecting Google Photos… Imported photos will remain in Sabio.');
  void api('/api/admin/photos/disconnect', {}).then(async (value) => {
    if (!value || typeof value !== 'object' || !('disconnected' in value) || value.disconnected !== true ||
        !('googleRevoked' in value) || typeof value.googleRevoked !== 'boolean') throw new Error('invalid_response');
    reauthorizeGoogle = false;
    await refreshPhotos();
    sayPhotos(value.googleRevoked
      ? 'Google Photos disconnected. Imported photos remain in Sabio until removed.'
      : 'Disconnected from Sabio, but Google could not confirm revocation. Revoke Sabio in your Google Account security settings; imported photos remain in Sabio.');
  }).catch((error) => sayPhotos(photoError(error))).finally(() => {
    photosBusy = false;
    if (photosConnect) photosConnect.disabled = false;
    if (photosDisconnect) photosDisconnect.disabled = false;
  });
});

photosImportButton?.addEventListener('click', () => {
  if (photosBusy || !activeImportId) return;
  photosBusy = true;
  photosImportButton.disabled = true;
  if (photosCancelButton) photosCancelButton.disabled = true;
  const jobId = activeImportId;
  void (async () => {
    try {
      const statusValue = await api(`/api/admin/photos/status?id=${encodeURIComponent(jobId)}`);
      if (!statusValue || typeof statusValue !== 'object' || !('mediaItemsSet' in statusValue) || typeof statusValue.mediaItemsSet !== 'boolean') {
        throw new Error('invalid_response');
      }
      if (statusValue.mediaItemsSet !== true) {
        sayPhotos('Google Photos has not finished the selection yet. Return to the picker and tap Done.');
        return;
      }
      sayPhotos('Importing selected photos into private storage…');
      for (let attempt = 0; attempt < 13; attempt += 1) {
        const result = await api('/api/admin/photos/import', { jobId });
        if (!result || typeof result !== 'object' || !('done' in result) || typeof result.done !== 'boolean') throw new Error('invalid_response');
        if (result.done) {
          activeImportId = null;
          sayPhotos('Selected photos were copied to private storage.');
          await refreshPhotos();
          return;
        }
        sayPhotos('Importing selected photos…');
      }
      throw new Error('photo_import_failed');
    } catch (error) { sayPhotos(photoError(error)); }
    finally {
      photosBusy = false;
      if (photosImportButton) photosImportButton.disabled = false;
      if (photosCancelButton) photosCancelButton.disabled = false;
    }
  })();
});

photosCancelButton?.addEventListener('click', () => {
  if (photosBusy || !activeImportId) return;
  photosBusy = true;
  photosCancelButton.disabled = true;
  void api('/api/admin/photos/cancel', { jobId: activeImportId }).then(async () => {
    activeImportId = null;
    sayPhotos('Google Photos selection cancelled.');
    await refreshPhotos();
  }).catch((error) => sayPhotos(photoError(error))).finally(() => {
    photosBusy = false;
    if (photosCancelButton) photosCancelButton.disabled = false;
  });
});

document.getElementById('photos-refresh')?.addEventListener('click', () => { void refreshPhotos(); });

async function refresh(): Promise<void> {
  try {
    const value = await api('/api/admin/displays');
    if (!value || typeof value !== 'object' || !('displays' in value) || !Array.isArray(value.displays) || value.displays.length > 100) throw new Error('invalid_response');
    if (!list || !revokedList || !revokedHistory) return;
    const revokedOpen = revokedHistory.open;
    list.textContent = '';
    revokedList.textContent = '';
    const displays = value.displays as unknown[];
    const active = displays.filter((display) => Boolean(display && typeof display === 'object' && !Array.isArray(display) && (display as Record<string, unknown>).revoked !== true));
    const revoked = displays.filter((display) => Boolean(display && typeof display === 'object' && !Array.isArray(display) && (display as Record<string, unknown>).revoked === true));
    revokedHistory.hidden = revoked.length === 0;
    revokedHistory.open = revokedOpen;
    if (revokedSummary) revokedSummary.textContent = `${revokedOpen ? 'Hide' : 'Show'} revoked sessions (${revoked.length})`;
    if (active.length === 0) list.textContent = 'No active browser sessions.';

    const render = (rawDisplay: unknown, isRevoked: boolean, target: HTMLElement): void => {
      if (!rawDisplay || typeof rawDisplay !== 'object' || Array.isArray(rawDisplay)) throw new Error('invalid_response');
      const display = rawDisplay as Record<string, unknown>;
      if (typeof display.id !== 'string' || display.id.length > 128 || typeof display.expiresAt !== 'number' || !Number.isFinite(display.expiresAt) || typeof display.createdAt !== 'number' || !Number.isFinite(display.createdAt) || display.revoked !== isRevoked) throw new Error('invalid_response');
      const displayId = display.id;
      const item = document.createElement('li');
      if (isRevoked) item.className = 'revoked-item';
      const details = displayDetails(display);
      const title = document.createElement('h3');
      title.textContent = details.title;
      item.appendChild(title);
      for (const line of [details.platform, details.seen, details.location]) {
        const paragraph = document.createElement('p');
        paragraph.className = 'small-note';
        paragraph.textContent = line;
        item.appendChild(paragraph);
      }
      const label = document.createElement('p');
      label.className = 'small-note';
      const button = document.createElement('button');
      const nameForm = document.createElement('form');
      const nameLabel = document.createElement('label');
      const nameInput = document.createElement('input');
      const nameSave = document.createElement('button');
      label.textContent = `Browser ID: ${displayId} · Added ${new Date(display.createdAt * 1000).toLocaleString()}${isRevoked ? '' : ' · Renews while active'} · Expires ${new Date(display.expiresAt * 1000).toLocaleString()}`;
      nameLabel.htmlFor = `display-name-${displayId}`;
      nameLabel.textContent = 'Display name';
      nameInput.id = `display-name-${displayId}`;
      nameInput.type = 'text';
      nameInput.maxLength = 80;
      nameInput.autocomplete = 'off';
      nameInput.value = typeof display.name === 'string' && display.name.length <= 80 ? display.name : '';
      nameInput.setAttribute('aria-label', `Display name for ${displayId}`);
      nameSave.type = 'submit';
      nameSave.className = 'text-button';
      nameSave.textContent = 'Save name';
      nameSave.disabled = isRevoked;
      nameForm.appendChild(nameLabel);
      nameForm.appendChild(nameInput);
      nameForm.appendChild(nameSave);
      nameForm.addEventListener('submit', (event) => {
        event.preventDefault();
        if (busy) return;
        busy = true;
        nameSave.disabled = true;
        void api('/api/admin/label', { id: displayId, name: nameInput.value }).then(async () => {
          say('Display name saved.');
          await refresh();
        }).catch(() => { say('Could not save display name. Use up to 80 characters and avoid markup/control characters.'); nameSave.disabled = false; }).finally(() => { busy = false; });
      });
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = 'Revoke browser';
      button.disabled = isRevoked;
      button.addEventListener('click', () => {
        if (busy) return;
        busy = true;
        button.disabled = true;
        void api('/api/admin/revoke', { id: displayId }).then(async () => {
          say('Browser revoked. Protected requests will be denied immediately; an online display checks its session at least once per minute.');
          await refresh();
        }).catch(() => { say('Revocation failed. Check owner access and retry.'); button.disabled = false; }).finally(() => { busy = false; });
      });
      item.appendChild(label);
      if (isRevoked) {
        const revokedLabel = document.createElement('p');
        revokedLabel.className = 'revoked-status';
        revokedLabel.textContent = `Revoked ${typeof display.revokedAt === 'number' && Number.isFinite(display.revokedAt) ? new Date(display.revokedAt * 1000).toLocaleString() : 'at an unknown time'}`;
        item.appendChild(revokedLabel);
        target.appendChild(item);
        return;
      }
      item.appendChild(nameForm);
      item.appendChild(button);
      target.appendChild(item);
    };
    for (const display of active) render(display, false, list);
    for (const display of revoked) render(display, true, revokedList);
  } catch {
    say('Cannot load sessions. Check owner authentication and service configuration, then refresh.');
  }
}

pairingForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  if (pairingButton) pairingButton.disabled = true;
  if (pairingCode) pairingCode.textContent = '';
  void api('/api/admin/pairing', {}).then((value) => {
    if (!value || typeof value !== 'object' || !('code' in value) || typeof value.code !== 'string' ||
        !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/.test(value.code)) throw new Error('invalid_response');
    if (pairingCode) pairingCode.textContent = value.code;
    const expiresAt = 'expiresAt' in value && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
      ? new Date(value.expiresAt * 1000).toLocaleTimeString()
      : 'ten minutes from now';
    say(`Enter this code on the display before ${expiresAt}. It can be used once.`);
  }).catch(() => {
    if (pairingCode) pairingCode.textContent = '';
    say('Could not generate a pairing code. Check owner authentication and service configuration, then retry.');
  }).finally(() => {
    busy = false;
    if (pairingButton) pairingButton.disabled = false;
  });
});
document.getElementById('admin-refresh')?.addEventListener('click', () => { void refresh(); });
revokedHistory?.addEventListener('toggle', () => {
  if (revokedSummary && revokedHistory) revokedSummary.textContent = `${revokedHistory.open ? 'Hide' : 'Show'} revoked sessions (${revokedList?.children.length || 0})`;
});
void refresh();
void refreshPhotos();

export {};
