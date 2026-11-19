export function themeForHour(hour: number): 'light' | 'dark' {
  return hour >= 7 && hour < 19 ? 'light' : 'dark';
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
  let timeZone: string | undefined;
  let zipSelected = false;
  let currentTheme: 'light' | 'dark' | null = null;
  const update = (): void => {
    const fields = displayTime(new Date(), timeZone);
    for (const [id, value] of [['clock', fields.clock], ['meridiem', fields.meridiem], ['date', fields.date]]) {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    }
    const label = document.getElementById('time-zone');
    if (label) label.textContent = timeZone ? timeZone.replace(/_/g, ' ') : zipSelected ? 'Browser time · ZIP timezone pending' : 'Browser local time · set a ZIP';
    const theme = themeForHour(fields.hour);
    document.documentElement.setAttribute('data-theme', theme);
    if (theme !== currentTheme) {
      currentTheme = theme;
      document.dispatchEvent(new Event('sabio:themechange'));
    }
  };
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
