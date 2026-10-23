export type ThemeMode = 'auto' | 'light' | 'dark';
export const THEME_STORAGE_NAME = 'sabio.appearance.v1';

export function themeForHour(mode: ThemeMode, hour: number): 'light' | 'dark' {
  return mode === 'auto' ? hour >= 7 && hour < 19 ? 'light' : 'dark' : mode;
}

/** Resolve all display fields from the same instant and timezone, including DST. */
export function displayTime(now: Date, timeZone?: string): { clock: string; meridiem: string; date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(now);
  const part = (type: string): string => parts.find((item) => item.type === type)?.value || '';
  const meridiem = part('dayPeriod');
  return {
    clock: `${part('hour')}:${part('minute')}`,
    meridiem,
    date: new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(now),
    hour: Number(part('hour')) % 12 + (meridiem === 'PM' ? 12 : 0),
  };
}

export function initializeDisplayTime(): { setTimeZone(value: string | null, zipSelected: boolean): void } {
  const select = document.getElementById('themeMode') as HTMLSelectElement | null;
  const status = document.getElementById('appearance-status');
  let mode: ThemeMode = 'auto';
  let timeZone: string | undefined;
  let zipSelected = false;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_NAME);
    if (stored === 'auto' || stored === 'light' || stored === 'dark') mode = stored;
  } catch {
    if (status) status.textContent = 'Appearance lasts for this visit; browser storage is unavailable.';
  }
  if (select) select.value = mode;
  const update = (): void => {
    const fields = displayTime(new Date(), timeZone);
    for (const [id, value] of [['clock', fields.clock], ['meridiem', fields.meridiem], ['date', fields.date]]) {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    }
    const label = document.getElementById('time-zone');
    if (label) label.textContent = timeZone ? timeZone.replace(/_/g, ' ') : zipSelected ? 'Browser time · ZIP timezone pending' : 'Browser local time · set a ZIP';
    document.documentElement.setAttribute('data-theme', themeForHour(mode, fields.hour));
  };
  select?.addEventListener('change', () => {
    const value = select.value;
    if (value !== 'auto' && value !== 'light' && value !== 'dark') return;
    mode = value;
    try {
      window.localStorage.setItem(THEME_STORAGE_NAME, mode);
      if (status) status.textContent = '';
    } catch {
      if (status) status.textContent = 'Appearance lasts for this visit; browser storage is unavailable.';
    }
    update();
  });
  update();
  window.setInterval(update, 1000);
  document.addEventListener('visibilitychange', update);
  return {
    setTimeZone(value, selected): void {
      timeZone = value || undefined;
      zipSelected = selected;
      update();
    },
  };
}
