import type { TemperatureUnit, WeatherForecast } from './forecast';
import type { WeatherLocation } from './preferences';
import { getDatabase } from '../storage/database';

export type WeatherCache = {
  key: string;
  unit: TemperatureUnit;
  fetchedAt: string;
  forecast: WeatherForecast;
};

export const WEATHER_CACHE_TTL_MS = 60 * 60_000;

const SETTINGS_KEY = 'weatherCache';

export function weatherCacheKey(location: WeatherLocation, unit: TemperatureUnit): string {
  return `${location.latitude.toFixed(4)}:${location.longitude.toFixed(4)}:${unit}`;
}

export async function getCachedWeatherForecast(location: WeatherLocation, unit: TemperatureUnit, now = Date.now()): Promise<WeatherForecast | undefined> {
  const value = await (await getDatabase()).get('settings', SETTINGS_KEY);
  if (!isWeatherCache(value)) return undefined;
  if (value.key !== weatherCacheKey(location, unit) || value.unit !== unit) return undefined;
  const fetchedAt = Date.parse(value.fetchedAt);
  if (Number.isNaN(fetchedAt) || now - fetchedAt >= WEATHER_CACHE_TTL_MS) return undefined;
  return value.forecast;
}

export async function cacheWeatherForecast(location: WeatherLocation, unit: TemperatureUnit, forecast: WeatherForecast, fetchedAt = new Date().toISOString()): Promise<void> {
  const cache: WeatherCache = { key: weatherCacheKey(location, unit), unit, forecast, fetchedAt };
  await (await getDatabase()).put('settings', cache, SETTINGS_KEY);
}

function isWeatherCache(value: unknown): value is WeatherCache {
  if (!value || typeof value !== 'object') return false;
  const cache = value as Partial<WeatherCache>;
  const forecast = cache.forecast as Partial<WeatherForecast> | undefined;
  return typeof cache.key === 'string'
    && (cache.unit === 'celsius' || cache.unit === 'fahrenheit')
    && typeof cache.fetchedAt === 'string'
    && !!forecast
    && typeof forecast.condition === 'string'
    && typeof forecast.isDay === 'boolean'
    && [forecast.temperature, forecast.apparentTemperature, forecast.high, forecast.low, forecast.precipitationProbability].every((value) => typeof value === 'number' && Number.isFinite(value))
    && (forecast.unit === 'celsius' || forecast.unit === 'fahrenheit');
}
