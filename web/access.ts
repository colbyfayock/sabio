/** A public shell is not authorization. Start display data loads only after bootstrap. */
export async function initializeAccess(): Promise<'preview' | 'managed' | null> {
  const dialog = document.getElementById('access-dialog');
  const status = document.getElementById('access-status');
  const form = document.getElementById('access-pair-form') as HTMLFormElement | null;
  const input = document.getElementById('access-pair-code') as HTMLInputElement | null;
  const pairButton = document.getElementById('access-pair-submit') as HTMLButtonElement | null;
  const retry = document.getElementById('access-retry') as HTMLButtonElement | null;
  const page = document.querySelector<HTMLElement>('.page-shell');
  let busy = false;
  let bootstrapFailed = false;
  const say = (message: string): void => { if (status) status.textContent = message; };

  const focusDialog = (): void => {
    if (!dialog) return;
    dialog.setAttribute('tabindex', '-1');
    dialog.focus();
  };
  const reveal = (): void => {
    if (dialog) dialog.hidden = true;
    if (form) form.hidden = true;
    if (retry) retry.hidden = true;
    if (page) {
      page.hidden = false;
      page.removeAttribute('aria-hidden');
      page.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex="-1"]')
        .forEach((element) => element.removeAttribute('tabindex'));
    }
  };
  const isolatePage = (): void => {
    if (dialog) dialog.hidden = false;
    if (!page) return;
    page.hidden = true;
    page.setAttribute('aria-hidden', 'true');
    page.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')
      .forEach((element) => element.setAttribute('tabindex', '-1'));
  };
  const showPairing = (): void => {
    isolatePage();
    if (form) form.hidden = false;
    if (retry) retry.hidden = true;
    if (input) input.focus();
    else focusDialog();
  };
  const showFailure = (): void => {
    isolatePage();
    if (form) form.hidden = true;
    if (retry) {
      retry.hidden = false;
      retry.focus();
    } else {
      focusDialog();
    }
  };
  const focusGate = (): void => {
    if (form && !form.hidden && input) input.focus();
    else if (retry && !retry.hidden) retry.focus();
    else focusDialog();
  };
  const request = async (path: string, body?: object): Promise<Response> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      return await fetch(path, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: controller.signal,
      });
    } finally { window.clearTimeout(timeout); }
  };

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!input || busy) return;
    const code = input.value.replace(/[\s-]+/g, '').toUpperCase();
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/.test(code)) {
      say('Enter the 10-character pairing code from /admin.');
      input.focus();
      return;
    }
    busy = true;
    if (pairButton) pairButton.disabled = true;
    input.disabled = true;
    say('Pairing this display…');
    void (async () => {
      try {
        const response = await request('/api/enrollment/claim', { code });
        if (response.status === 200) {
          window.location.reload();
          return;
        }
        if (response.status === 429) {
          say('Too many pairing attempts. Wait a minute, then try again.');
        } else if (response.status === 401) {
          say('That code is invalid or expired. Generate a new code from /admin.');
        } else {
          say('Could not pair this display. Check the connection and service configuration, then try again.');
        }
      } catch {
        say('Could not pair this display. Check the connection and service configuration, then try again.');
      } finally {
        busy = false;
        if (pairButton) pairButton.disabled = false;
        input.disabled = false;
        input.focus();
      }
    })();
  });
  retry?.addEventListener('click', () => { window.location.reload(); });
  document.addEventListener('focusin', (event) => {
    if (dialog && !dialog.hidden && !dialog.contains(event.target as Node)) focusGate();
  });
  window.addEventListener('online', () => { if (bootstrapFailed) window.location.reload(); });

  try {
    const response = await request('/api/bootstrap');
    const value: unknown = await response.json();
    if (!response.ok || !value || typeof value !== 'object' || !('mode' in value)) throw new Error('bootstrap_failed');
    if (value.mode === 'preview') { reveal(); return 'preview'; }
    if (value.mode !== 'managed' || !('enrolled' in value)) throw new Error('bootstrap_failed');
    if (value.enrolled === true) {
      reveal();
      // Re-check the session periodically even if weather is offline or has not been configured.
      window.setInterval(() => {
        void request('/api/bootstrap').then(async (result) => {
          // A rate-limited bootstrap is transient, not evidence of revocation.
          if (result.status === 429) return;
          if (!result.ok || (await result.json()).enrolled !== true) window.location.reload();
        }).catch(() => { /* A transport outage is not evidence of revocation; protected APIs still fail closed. */ });
      }, 60000);
      return 'managed';
    }
    showPairing();
    say('Enter the one-time pairing code from /admin to pair this browser.');
  } catch {
    showFailure();
    bootstrapFailed = true;
    say('Cannot verify display access. Check the connection, then reload.');
  }
  return null;
}
