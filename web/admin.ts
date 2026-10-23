import { displayDetails } from './display-details';

const status = document.getElementById('admin-status');
const list = document.getElementById('admin-displays');
const revokedList = document.getElementById('revoked-displays');
const revokedHistory = document.getElementById('revoked-history') as HTMLDetailsElement | null;
const revokedSummary = document.getElementById('revoked-summary');
const pairingForm = document.getElementById('pairing-form');
const pairingCode = document.getElementById('pairing-code');
const pairingButton = document.getElementById('pairing-generate') as HTMLButtonElement | null;
const say = (message: string): void => { if (status) status.textContent = message; };
let busy = false;

async function api(path: string, body?: object): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: controller.signal,
    });
    if (!response.ok) throw new Error('admin_request_failed');
    return response.status === 204 ? null : await response.json();
  } finally { window.clearTimeout(timeout); }
}

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

export {};
