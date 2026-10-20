import { normalizeZipCode } from '../shared/zip';
import type { WeatherForecast } from '../shared/weather';

const PROVIDER_TIMEOUT = 5000;
const MAX_PROVIDER_BYTES = 65536;
const CACHE_SECONDS = 600;

export class WeatherError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

function temperature(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -150 && value <= 160;
}

/** Bound both request and upstream bodies before decoding/parsing any JSON. */
export async function boundedJson(message: Request | Response, maximum: number): Promise<unknown> {
  if (Number(message.headers.get('Content-Length')) > maximum) {
    await message.body?.cancel().catch(() => undefined);
    throw new Error('body_too_large');
  }
  if (!message.body) throw new Error('missing_body');
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new Error('body_too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
}

async function providerJson(url: URL, fetcher: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT);
  try {
    // Manual mode works in workerd; the status check below rejects every redirect.
    const response = await fetcher(url.toString(), {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      throw new WeatherError('provider_busy', 429);
    }
    if (!response.ok || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel().catch(() => undefined);
      throw new WeatherError('weather_unavailable', 502);
    }
    return await boundedJson(response, MAX_PROVIDER_BYTES);
  } catch (error) {
    if (error instanceof WeatherError) throw error;
    throw new WeatherError(controller.signal.aborted ? 'weather_timeout' : 'weather_unavailable', controller.signal.aborted ? 504 : 502);
  } finally {
    clearTimeout(timeout);
  }
}

const CONDITIONS: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Heavy freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Heavy freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow grains', 80: 'Light rain showers', 81: 'Rain showers', 82: 'Heavy rain showers',
  85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail',
  97: 'Heavy thunderstorm', 99: 'Heavy thunderstorm with hail',
};

function validForecast(value: unknown, now: Date): value is WeatherForecast {
  if (!record(value) || Object.keys(value).length !== 9 || value.mode !== 'live' || value.unit !== 'fahrenheit' ||
      !text(value.locationLabel, 160) || !text(value.condition, 80) ||
      !temperature(value.temperatureFahrenheit) || !temperature(value.highFahrenheit) ||
      !temperature(value.lowFahrenheit) || value.highFahrenheit < value.lowFahrenheit ||
      !text(value.observedAt, 40) || !text(value.fetchedAt, 40)) return false;
  const observed = Date.parse(value.observedAt);
  const fetched = Date.parse(value.fetchedAt);
  return Number.isFinite(observed) && Number.isFinite(fetched) &&
    now.getTime() - observed <= 3 * 3600000 && observed <= now.getTime() + 3600000 &&
    now.getTime() - fetched < CACHE_SECONDS * 1000 && fetched <= now.getTime() + 60000;
}

interface WeatherDependencies {
  fetcher?: typeof fetch;
  cache?: Pick<Cache, 'match' | 'put'>;
  origin?: string;
  now?: Date;
}

/** Fixed providers only; ZIP+4 must already have been reduced to its five-digit area. */
export async function getWeatherForZip(zipCode: string, dependencies: WeatherDependencies = {}): Promise<WeatherForecast> {
  if (normalizeZipCode(zipCode) !== zipCode || zipCode.length !== 5) throw new WeatherError('invalid_zip', 400);
  const fetcher = dependencies.fetcher || fetch.bind(globalThis);
  const now = dependencies.now || new Date();
  // This avoids plaintext ZIPs in cache paths, not enumeration or location inference.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`fahrenheit-v1:${zipCode}`));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const cacheKey = new Request(new URL(`/.weather-cache/v1/${hash}`, dependencies.origin || 'https://example.com').toString());
  if (dependencies.cache) {
    try {
      const cached = await dependencies.cache.match(cacheKey);
      if (cached) {
        const value = await boundedJson(cached, MAX_PROVIDER_BYTES);
        if (validForecast(value, now)) return value;
      }
    } catch {
      // Cache availability is optional; never log keys, locations, or provider exceptions.
    }
  }

  const geocodeUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geocodeUrl.search = new URLSearchParams({ name: zipCode, countryCode: 'US', count: '5', language: 'en', format: 'json' }).toString();
  const geocode = await providerJson(geocodeUrl, fetcher);
  if (!record(geocode) || geocode.error || (geocode.results !== undefined && !Array.isArray(geocode.results))) {
    throw new WeatherError('weather_unavailable', 502);
  }
  const places = Array.isArray(geocode.results) ? geocode.results.slice(0, 5) : [];
  const place = places.find((item: unknown) => record(item) && item.country_code === 'US' &&
    Array.isArray(item.postcodes) && item.postcodes.includes(zipCode));
  if (!record(place)) throw new WeatherError('zip_not_found', 404);
  if (!text(place.name, 80) || typeof place.latitude !== 'number' || !Number.isFinite(place.latitude) ||
      Math.abs(place.latitude) > 90 || typeof place.longitude !== 'number' ||
      !Number.isFinite(place.longitude) || Math.abs(place.longitude) > 180 ||
      (place.admin1 !== undefined && !text(place.admin1, 60))) throw new WeatherError('weather_unavailable', 502);
  const locationLabel = place.admin1 && place.admin1 !== place.name ? `${place.name}, ${place.admin1}` : place.name;

  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
  forecastUrl.search = new URLSearchParams({
    latitude: String(place.latitude), longitude: String(place.longitude),
    current: 'temperature_2m,weather_code', daily: 'temperature_2m_max,temperature_2m_min',
    temperature_unit: 'fahrenheit', timezone: 'auto', timeformat: 'unixtime', forecast_days: '1',
  }).toString();
  const forecast = await providerJson(forecastUrl, fetcher);
  if (!record(forecast) || !record(forecast.current) || !record(forecast.current_units) ||
      !record(forecast.daily) || !record(forecast.daily_units) ||
      forecast.current_units.temperature_2m !== '°F' || forecast.daily_units.temperature_2m_max !== '°F' ||
      forecast.daily_units.temperature_2m_min !== '°F' || !Array.isArray(forecast.daily.temperature_2m_max) ||
      !Array.isArray(forecast.daily.temperature_2m_min) || typeof forecast.current.time !== 'number' ||
      !Number.isSafeInteger(forecast.current.time) || !Number.isInteger(forecast.current.weather_code)) {
    throw new WeatherError('weather_unavailable', 502);
  }
  const observed = new Date(forecast.current.time * 1000);
  if (!Number.isFinite(observed.getTime())) throw new WeatherError('weather_unavailable', 502);
  const value = {
    mode: 'live', unit: 'fahrenheit', locationLabel,
    temperatureFahrenheit: forecast.current.temperature_2m,
    highFahrenheit: forecast.daily.temperature_2m_max[0],
    lowFahrenheit: forecast.daily.temperature_2m_min[0],
    condition: CONDITIONS[forecast.current.weather_code as number] || 'Conditions unavailable',
    observedAt: observed.toISOString(), fetchedAt: now.toISOString(),
  };
  if (!validForecast(value, now)) throw new WeatherError('weather_unavailable', 502);
  if (dependencies.cache) {
    try {
      await dependencies.cache.put(cacheKey, new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
      }));
    } catch {
      // Cache failure does not turn a successfully fetched public forecast into an error.
    }
  }
  return value;
}

export async function requestZip(request: Request): Promise<string> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new WeatherError('invalid_request', 415);
  try {
    const value = await boundedJson(request, 256);
    if (!record(value) || Object.keys(value).length !== 1 || typeof value.zipCode !== 'string') throw new Error('invalid_request');
    const zipCode = normalizeZipCode(value.zipCode);
    if (zipCode === null || zipCode.length !== 5) throw new WeatherError('invalid_zip', 400);
    return zipCode;
  } catch (error) {
    if (error instanceof WeatherError) throw error;
    throw new WeatherError('invalid_request', 400);
  }
}
