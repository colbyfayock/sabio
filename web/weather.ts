import type { WeatherForecast } from '../shared/weather';
import { normalizeZipCode } from '../shared/zip';
import { isTimeZone } from '../shared/timezone';

const REFRESH_INTERVAL = 600000;
const REQUEST_TIMEOUT = 12000;
const INITIAL_BACKOFF = 60000;
const MAX_BACKOFF = 1800000;

export interface WeatherController {
  setZipCode(zipCode: string | null): void;
  refresh(): void;
}

export type WeatherIconName = 'clear' | 'moon' | 'partly' | 'partly-night' | 'cloud' | 'fog' | 'rain' | 'snow' | 'storm';

export function weatherIconForCondition(condition: string, isNight = false): WeatherIconName {
  const value = condition.toLowerCase();
  if (value.includes('thunder') || value.includes('hail')) return 'storm';
  if (value.includes('snow') || value.includes('sleet')) return 'snow';
  if (value.includes('rain') || value.includes('drizzle')) return 'rain';
  if (value.includes('fog')) return 'fog';
  if (value.includes('partly')) return isNight ? 'partly-night' : 'partly';
  if (value.includes('clear') || value.includes('sun')) return isNight ? 'moon' : 'clear';
  return 'cloud';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function sensibleTimestamp(value: unknown): value is string {
  if (!boundedString(value, 40)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= Date.UTC(2000, 0, 1) && timestamp <= Date.now() + 86400000;
}

function isTemperature(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -150 && value <= 160;
}

function isWeatherForecast(value: unknown): value is WeatherForecast {
  if (!isRecord(value) || value.mode !== 'live' || value.unit !== 'fahrenheit' ||
      !boundedString(value.locationLabel, 160) || !boundedString(value.condition, 80) || !isTimeZone(value.timeZone) ||
      !sensibleTimestamp(value.observedAt) || !sensibleTimestamp(value.fetchedAt)) return false;
  const temperature = value.temperatureFahrenheit;
  const high = value.highFahrenheit;
  const low = value.lowFahrenheit;
  return isTemperature(temperature) && isTemperature(high) && isTemperature(low) && high >= low;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'time unavailable' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function errorMessage(error: unknown): string {
  if (!isRecord(error) || typeof error.error !== 'string') return 'Weather is temporarily unavailable.';
  switch (error.error) {
    case 'invalid_request':
    case 'invalid_zip': return 'That ZIP code could not be used for weather.';
    case 'zip_not_found': return 'No weather location was found for this ZIP code.';
    case 'provider_busy': return 'The weather service is busy. Sabio will try again.';
    case 'weather_timeout': return 'The weather request timed out. Sabio will try again.';
    case 'weather_unavailable': return 'The weather service is temporarily unavailable.';
    default: return 'Weather is temporarily unavailable.';
  }
}

export function initializeWeatherController(getSelectedZipCode: () => string | null, onTimeZone?: (value: string | null) => void, credentials: RequestCredentials = 'omit'): WeatherController {
  const temperatureNode = document.getElementById('temperature');
  const conditionNode = document.getElementById('condition');
  const highNode = document.getElementById('weather-high');
  const lowNode = document.getElementById('weather-low');
  const weatherIcon = document.getElementById('weather-icon');
  const weatherIcons: Record<WeatherIconName, HTMLElement | null> = {
    clear: document.getElementById('weather-icon-clear'),
    moon: document.getElementById('weather-icon-moon'),
    partly: document.getElementById('weather-icon-partly'),
    'partly-night': document.getElementById('weather-icon-partly-night'),
    cloud: document.getElementById('weather-icon-cloud'),
    fog: document.getElementById('weather-icon-fog'),
    rain: document.getElementById('weather-icon-rain'),
    snow: document.getElementById('weather-icon-snow'),
    storm: document.getElementById('weather-icon-storm'),
  };
  const statusNode = document.getElementById('weather-status');
  const refreshButton = document.getElementById('weather-refresh') as HTMLButtonElement | null;
  let zipCode = normalizeZipCode(getSelectedZipCode());
  let forecast: WeatherForecast | null = null;
  let request: AbortController | null = null;
  let timer: number | null = null;
  let failures = 0;
  let generation = 0;

  const setText = (node: HTMLElement | null, value: string): void => {
    if (node) node.textContent = value;
  };
  const cancelTimer = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const schedule = (delay: number): void => {
    cancelTimer();
    timer = window.setTimeout(() => {
      timer = null;
      void load();
    }, delay);
  };
  const displayPlaceholder = (): void => {
    setText(temperatureNode, '—°F');
    setText(conditionNode, zipCode ? 'Waiting for live weather' : 'Set ZIP to load weather');
    setText(highNode, 'H —°F');
    setText(lowNode, 'L —°F');
    if (conditionNode) conditionNode.hidden = false;
    if (weatherIcon) weatherIcon.hidden = true;
    Object.values(weatherIcons).forEach((icon) => { if (icon) icon.hidden = true; });
  };
  const showConditionIcon = (condition: string): void => {
    if (weatherIcon) {
      weatherIcon.hidden = false;
      weatherIcon.setAttribute('aria-label', condition);
    }
    const isNight = document.documentElement.getAttribute('data-theme') === 'dark';
    const selectedIcon = weatherIconForCondition(condition, isNight);
    (Object.keys(weatherIcons) as WeatherIconName[]).forEach((name) => {
      const icon = weatherIcons[name];
      if (icon) icon.hidden = name !== selectedIcon;
    });
  };
  const showForecast = (value: WeatherForecast): void => {
    setText(temperatureNode, `${Math.round(value.temperatureFahrenheit)}°F`);
    setText(highNode, `H ${Math.round(value.highFahrenheit)}°F`);
    setText(lowNode, `L ${Math.round(value.lowFahrenheit)}°F`);
    if (conditionNode) conditionNode.hidden = true;
    showConditionIcon(value.condition);
  };
  const lastForecastDetail = (): string => forecast ? `Showing forecast fetched ${formatTimestamp(forecast.fetchedAt)}.` : '';
  const setWaiting = (): void => {
    if (!zipCode) {
      setText(statusNode, 'No ZIP selected.');
      return;
    }
    setText(statusNode, forecast ? `Refreshing weather. ${lastForecastDetail()}` : 'Waiting for live weather.');
  };

  async function load(): Promise<void> {
    if (!zipCode || request || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setText(statusNode, forecast ? `Offline · stale. ${lastForecastDetail()}` : 'Offline · waiting to reconnect.');
      }
      return;
    }
    if (typeof AbortController === 'undefined') {
      failures += 1;
      setText(statusNode, forecast ? `Weather stale. ${lastForecastDetail()}` : 'Weather requests are unavailable in this browser.');
      schedule(Math.min(INITIAL_BACKOFF * Math.pow(2, failures - 1), MAX_BACKOFF));
      return;
    }

    const currentZip = zipCode;
    const currentGeneration = generation;
    const controller = new AbortController();
    request = controller;
    setWaiting();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await fetch('/api/weather', {
        method: 'POST',
        credentials,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ zipCode: currentZip.slice(0, 5) }),
        signal: controller.signal,
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error('The weather response could not be read.');
      }
      if (!response.ok) throw new Error(errorMessage(payload));
      if (!isWeatherForecast(payload)) throw new Error('The weather response did not match the expected format.');
      if (generation !== currentGeneration || zipCode !== currentZip) return;
      forecast = payload;
      showForecast(payload);
      onTimeZone?.(payload.timeZone);
      failures = 0;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setText(statusNode, `Offline · ${lastForecastDetail()}`);
      } else {
        setText(statusNode, `Updated · ${formatTimestamp(payload.fetchedAt)}`);
        schedule(REFRESH_INTERVAL);
      }
    } catch (error) {
      if (generation !== currentGeneration || zipCode !== currentZip) return;
      failures += 1;
      const delay = Math.min(INITIAL_BACKOFF * Math.pow(2, failures - 1), MAX_BACKOFF);
      const message = controller.signal.aborted ? 'The weather request timed out.' :
        error instanceof Error ? error.message : 'Weather is temporarily unavailable.';
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setText(statusNode, forecast ? `Offline · stale. ${lastForecastDetail()}` : 'Offline · waiting to reconnect.');
      } else {
        setText(statusNode, forecast
          ? `Weather stale · ${message} ${lastForecastDetail()}`
          : `Weather unavailable · ${message} Retrying in ${Math.ceil(delay / 1000)}s.`);
        schedule(delay);
      }
    } finally {
      window.clearTimeout(timeout);
      if (request === controller) {
        request = null;
      }
    }
  }

  const setZipCode = (value: string | null): void => {
    const normalized = normalizeZipCode(value);
    if (normalized === zipCode) {
      if (normalized) refresh();
      return;
    }
    generation += 1;
    cancelTimer();
    request?.abort();
    request = null;
    zipCode = normalized;
    forecast = null;
    onTimeZone?.(null);
    failures = 0;
    displayPlaceholder();
    setText(statusNode, zipCode ? 'Waiting for live weather.' : 'No ZIP selected.');
    if (zipCode) void load();
  };

  const refresh = (): void => {
    cancelTimer();
    if (!request) void load();
  };

  refreshButton?.addEventListener('click', refresh);
  document.addEventListener('sabio:themechange', () => {
    if (forecast) showConditionIcon(forecast.condition);
  });
  window.addEventListener('online', refresh);
  window.addEventListener('offline', () => {
    cancelTimer();
    setText(statusNode, forecast ? `Offline · stale. ${lastForecastDetail()}` : 'Offline · waiting to reconnect.');
  });
  displayPlaceholder();
  if (zipCode) void load();
  else setText(statusNode, 'No ZIP selected.');

  return { setZipCode, refresh };
}
