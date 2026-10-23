/** A public shell is not approval. Start display data loads only after bootstrap. */
export async function initializeAccess(): Promise<'preview' | 'managed' | null> {
  const dialog = document.getElementById('access-dialog');
  const status = document.getElementById('access-status');
  const code = document.getElementById('access-code');
  const start = document.getElementById('access-start') as HTMLButtonElement | null;
  const page = document.querySelector<HTMLElement>('.page-shell');
  let pending = false;
  let bootstrapFailed = false;
  let poll: number | null = null;
  const say = (message: string): void => { if (status) status.textContent = message; };
  const show = (): void => {
    if (dialog) dialog.hidden = false;
    start?.focus();
    page?.setAttribute('aria-hidden', 'true');
    page?.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]').forEach((element) => element.setAttribute('tabindex', '-1'));
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
  const checkPending = async (): Promise<void> => {
    try {
      const response = await request('/api/enrollment/complete', {});
      if (response.status === 200) { window.location.reload(); return; }
      if (response.status !== 202) {
        pending = false;
        if (start) { start.disabled = false; start.textContent = 'Request a new code'; }
        say('Pairing expired or unavailable. Request a new code, or ask the owner to check the service.');
        return;
      }
      say('Waiting for the owner to approve this code on a trusted browser.');
    } catch {
      say('Connection interrupted. Waiting to retry pairing.');
    }
    if (pending) poll = window.setTimeout(() => { void checkPending(); }, 10000);
  };
  start?.addEventListener('click', () => {
    if (bootstrapFailed) { window.location.reload(); return; }
    if (pending) return;
    start.disabled = true;
    void (async () => {
      try {
        const response = await request('/api/enrollment', {});
        const value: unknown = await response.json();
        if (!response.ok || !value || typeof value !== 'object' || !('code' in value) || typeof value.code !== 'string' || value.code.length > 32) throw new Error('pairing_unavailable');
        if (code) code.textContent = value.code;
        pending = true;
        say('Approve this code from the owner administration page. Codes expire after ten minutes.');
        poll = window.setTimeout(() => { void checkPending(); }, 10000);
      } catch {
        say('Could not request a code. Check the connection and service configuration, then retry.');
        start.disabled = false;
      }
    })();
  });
  const focusGate = (): void => {
    if (start && !start.disabled) start.focus();
    else if (dialog) { dialog.setAttribute('tabindex', '-1'); dialog.focus(); }
  };
  document.addEventListener('focusin', (event) => {
    if (dialog && !dialog.hidden && !dialog.contains(event.target as Node)) focusGate();
  });
  dialog?.addEventListener('keydown', (event) => { if (event.key === 'Tab') { event.preventDefault(); focusGate(); } });
  window.addEventListener('online', () => { if (bootstrapFailed) window.location.reload(); });
  window.addEventListener('pagehide', () => { if (poll !== null) window.clearTimeout(poll); });
  try {
    const response = await request('/api/bootstrap');
    const value: unknown = await response.json();
    if (!response.ok || !value || typeof value !== 'object' || !('mode' in value)) throw new Error('bootstrap_failed');
    if (value.mode === 'preview') return 'preview';
    if (value.mode !== 'managed' || !('enrolled' in value)) throw new Error('bootstrap_failed');
    if (value.enrolled === true) {
      // Re-check approval periodically even if weather is offline or has not been configured.
      window.setInterval(() => {
        void request('/api/bootstrap').then(async (result) => {
          // A rate-limited bootstrap is transient, not evidence of revocation.
          if (result.status === 429) return;
          if (!result.ok || (await result.json()).enrolled !== true) window.location.reload();
        }).catch(() => { /* A transport outage is not evidence of revocation; protected APIs still fail closed. */ });
      }, 60000);
      return 'managed';
    }
    show();
    say('This browser needs owner approval before it can display the dashboard.');
  } catch {
    show();
    bootstrapFailed = true;
    say('Cannot verify display access. Check the connection and reload.');
    if (start) { start.disabled = false; start.textContent = 'Retry connection'; }
  }
  return null;
}
