import type { DemoDashboard } from '../shared/dashboard';

const POLL_INTERVAL = 60000;
const REQUEST_TIMEOUT = 12000;
const MAX_BACKOFF = 300000;
const statusRegion = document.querySelector<HTMLElement>('.connection-status');
const statusDot = document.getElementById('status-dot');
const eventList = document.getElementById('event-list');
const taskList = document.getElementById('task-list');
const eventEmpty = document.getElementById('agenda-empty');
const taskEmpty = document.getElementById('task-empty');
const retryButton = document.getElementById('retry-button') as HTMLButtonElement | null;
const fullscreenButton = document.getElementById('fullscreen-toggle') as HTMLButtonElement | null;
const fullscreenLabel = document.getElementById('fullscreen-label');
const taskState = new Map<string, boolean>();

let pollTimer: number | null = null;
let inFlight = false;
let hasGoodData = false;
let consecutiveFailures = 0;
let lastSuccessAt = 0;

function setText(id: string, value: string): void {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function updateClock(): void {
  const now = new Date();
  setText('clock', now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  setText('date', now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function isSampleTemperature(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100;
}

function isDemoDashboard(value: unknown): value is DemoDashboard {
  if (!isRecord(value) || value.mode !== 'demo' || !boundedString(value.updatedAt, 80) ||
      !Number.isFinite(Date.parse(value.updatedAt)) || !isRecord(value.weather) ||
      !Array.isArray(value.events) || value.events.length > 8 ||
      !Array.isArray(value.tasks) || value.tasks.length > 12 || !boundedString(value.note, 240)) return false;

  const weather = value.weather;
  if (!isSampleTemperature(weather.temperatureCelsius) || !isSampleTemperature(weather.highCelsius) ||
      !isSampleTemperature(weather.lowCelsius) || !boundedString(weather.condition, 80) ||
      !boundedString(weather.locationLabel, 100)) return false;

  const eventIds = new Set<string>();
  for (const event of value.events) {
    if (!isRecord(event) || !boundedString(event.id, 100) || eventIds.has(event.id) ||
        !boundedString(event.time, 40) || !boundedString(event.title, 120) ||
        !boundedString(event.detail, 180)) return false;
    eventIds.add(event.id);
  }

  const taskIds = new Set<string>();
  for (const task of value.tasks) {
    if (!isRecord(task) || !boundedString(task.id, 100) || taskIds.has(task.id) ||
        !boundedString(task.title, 120) || typeof task.completed !== 'boolean') return false;
    taskIds.add(task.id);
  }
  return true;
}

function renderEvents(events: DemoDashboard['events']): void {
  if (!eventList || !eventEmpty) return;
  eventList.textContent = '';
  eventEmpty.hidden = events.length > 0;
  for (const event of events) {
    const item = document.createElement('li');
    const time = document.createElement('span');
    const content = document.createElement('div');
    const title = document.createElement('p');
    const detail = document.createElement('p');
    item.className = 'event-item';
    time.className = 'event-time';
    content.className = 'event-content';
    title.className = 'event-title';
    detail.className = 'event-detail';
    time.textContent = event.time;
    title.textContent = event.title;
    detail.textContent = event.detail;
    content.appendChild(title);
    content.appendChild(detail);
    item.appendChild(time);
    item.appendChild(content);
    eventList.appendChild(item);
  }
}

function renderTasks(tasks: DemoDashboard['tasks']): void {
  if (!taskList || !taskEmpty) return;
  const currentIds = new Set(tasks.map((task) => task.id));
  for (const id of taskState.keys()) {
    if (!currentIds.has(id)) taskState.delete(id);
  }
  taskList.textContent = '';
  taskEmpty.hidden = tasks.length > 0;
  if (tasks.length === 0) taskEmpty.textContent = 'No sample rituals today.';
  for (const task of tasks) {
    if (!taskState.has(task.id)) taskState.set(task.id, task.completed);
    const item = document.createElement('li');
    const checkbox = document.createElement('input');
    const label = document.createElement('label');
    const inputId = `task-${encodeURIComponent(task.id)}`;
    item.className = 'task-item';
    checkbox.className = 'task-check';
    checkbox.type = 'checkbox';
    checkbox.id = inputId;
    checkbox.checked = taskState.get(task.id) === true;
    checkbox.addEventListener('change', () => taskState.set(task.id, checkbox.checked));
    label.className = 'task-label';
    label.htmlFor = inputId;
    label.textContent = task.title;
    item.appendChild(checkbox);
    item.appendChild(label);
    taskList.appendChild(item);
  }
}

function renderDashboard(data: DemoDashboard): void {
  const weather = data.weather;
  setText('temperature', `${Math.round(weather.temperatureCelsius)}°C`);
  setText('condition', weather.condition);
  setText('weather-range', `H ${Math.round(weather.highCelsius)}° · L ${Math.round(weather.lowCelsius)}°`);
  setText('weather-location', weather.locationLabel);
  setText('demo-note', data.note);
  renderEvents(data.events);
  renderTasks(data.tasks);
}

function setStatus(state: 'waiting' | 'updated' | 'stale' | 'offline', message: string, detail = ''): void {
  if (statusRegion) statusRegion.dataset.state = state;
  if (statusDot) statusDot.setAttribute('aria-hidden', 'true');
  setText('status-text', message);
  setText('status-detail', detail);
}

function cancelPoll(): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(delay: number): void {
  cancelPoll();
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    void poll();
  }, delay);
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Updated just now';
  const minutes = Math.floor(seconds / 60);
  return `Updated ${minutes} min${minutes === 1 ? '' : 's'} ago`;
}

async function fetchDashboard(): Promise<DemoDashboard> {
  if (typeof AbortController === 'undefined') throw new Error('Request cancellation is unavailable');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch('/api/demo', {
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Sample request returned ${response.status}`);
    const payload: unknown = await response.json();
    if (!isDemoDashboard(payload)) throw new Error('Sample response did not match the expected format');
    return payload;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function poll(): Promise<void> {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (inFlight || offline) {
    if (offline) setStatus('offline', 'Offline', hasGoodData ? formatAge(lastSuccessAt) : 'Waiting to reconnect');
    return;
  }
  inFlight = true;
  try {
    const data = await fetchDashboard();
    renderDashboard(data);
    hasGoodData = true;
    lastSuccessAt = Date.now();
    consecutiveFailures = 0;
    setStatus('updated', 'Demo data updated', formatAge(lastSuccessAt));
    schedulePoll(POLL_INTERVAL);
  } catch {
    consecutiveFailures += 1;
    const delay = Math.min(POLL_INTERVAL * Math.pow(2, consecutiveFailures - 1), MAX_BACKOFF);
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    setStatus(offline ? 'offline' : hasGoodData ? 'stale' : 'waiting', offline ? 'Offline' : hasGoodData ? 'Showing last sample' : 'Sample data unavailable', hasGoodData ? formatAge(lastSuccessAt) : `Retrying in ${Math.ceil(delay / 1000)}s`);
    if (!offline) schedulePoll(delay);
  } finally {
    inFlight = false;
  }
}

function fullscreenIsActive(): boolean {
  const doc = document as Document & { mozFullScreenElement?: Element | null; mozFullScreen?: boolean };
  return Boolean(document.fullscreenElement || doc.mozFullScreenElement || doc.mozFullScreen);
}

function updateFullscreenButton(): void {
  const active = fullscreenIsActive();
  if (fullscreenButton) fullscreenButton.setAttribute('aria-pressed', String(active));
  if (fullscreenLabel) fullscreenLabel.textContent = active ? 'Exit fullscreen' : 'Enter fullscreen';
}

function fullscreenError(): void {
  setText('fullscreen-message', 'Fullscreen isn’t available in this browser.');
  updateFullscreenButton();
}

function toggleFullscreen(): void {
  const doc = document as Document & {
    mozFullScreenElement?: Element | null;
    mozCancelFullScreen?: () => void;
  };
  const root = document.documentElement as HTMLElement & { mozRequestFullScreen?: () => void };
  try {
    let result: Promise<void> | void = undefined;
    if (fullscreenIsActive()) {
      if (document.exitFullscreen) result = document.exitFullscreen();
      else if (doc.mozCancelFullScreen) doc.mozCancelFullScreen();
      else {
        fullscreenError();
        return;
      }
    } else if (root.requestFullscreen) result = root.requestFullscreen();
    else if (root.mozRequestFullScreen) root.mozRequestFullScreen();
    else {
      fullscreenError();
      return;
    }
    if (result && typeof result.then === 'function') {
      (result as Promise<void>).then(() => setText('fullscreen-message', '')).catch(fullscreenError);
    } else {
      setText('fullscreen-message', '');
    }
  } catch {
    fullscreenError();
  }
}

updateClock();
window.setInterval(updateClock, 1000);
void poll();
retryButton?.addEventListener('click', () => {
  cancelPoll();
  void poll();
});
window.addEventListener('online', () => {
  cancelPoll();
  void poll();
});
window.addEventListener('offline', () => {
  cancelPoll();
  setStatus('offline', 'Offline', hasGoodData ? formatAge(lastSuccessAt) : 'Waiting to reconnect');
});
fullscreenButton?.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('mozfullscreenchange', updateFullscreenButton as EventListener);
document.addEventListener('fullscreenerror', fullscreenError);
document.addEventListener('mozfullscreenerror', fullscreenError as EventListener);
updateFullscreenButton();
