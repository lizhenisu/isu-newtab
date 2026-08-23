import { beforeEach, describe, expect, it } from 'vitest';
import { buildWeatherForecastUrl, parseWeatherForecast, resolveTemperatureUnit, weatherConditionForCode } from '../../core/weather/forecast';
import { getWeatherPreferences, setWeatherPreferences } from '../../core/weather/preferences';
import { weatherLocationErrorFor } from '../../core/weather/location';
import { cacheWeatherForecast, getCachedWeatherForecast, WEATHER_CACHE_TTL_MS } from '../../core/weather/cache';
import { buildWeatherCityUrl, parseWeatherCity } from '../../core/weather/location-name';
import { getDatabase } from '../../core/storage/database';

describe('weather forecast', () => {
  it('builds an Open-Meteo request with only forecast inputs', () => {
    const url = new URL(buildWeatherForecastUrl({ latitude: 31.23, longitude: 121.47, locatedAt: '2026-08-23T00:00:00.000Z' }, 'celsius'));

    expect(url.origin).toBe('https://api.open-meteo.com');
    expect(url.pathname).toBe('/v1/forecast');
    expect(url.searchParams.get('latitude')).toBe('31.23');
    expect(url.searchParams.get('longitude')).toBe('121.47');
    expect(url.searchParams.get('temperature_unit')).toBe('celsius');
    expect(url.searchParams.get('timezone')).toBe('auto');
    expect(url.searchParams.get('current')).toContain('apparent_temperature');
  });

  it('maps UI language and WMO weather codes deterministically', () => {
    expect(resolveTemperatureUnit('auto', 'zh-CN')).toBe('celsius');
    expect(resolveTemperatureUnit('auto', 'en')).toBe('fahrenheit');
    expect(resolveTemperatureUnit('fahrenheit', 'zh-CN')).toBe('fahrenheit');
    expect(weatherConditionForCode(0)).toBe('clear');
    expect(weatherConditionForCode(63)).toBe('rain');
    expect(weatherConditionForCode(95)).toBe('thunderstorm');
  });

  it('parses the current and daily weather fields required by the widget', () => {
    expect(parseWeatherForecast({
      current: { temperature_2m: 28.4, apparent_temperature: 31.2, weather_code: 2, is_day: 1 },
      daily: { temperature_2m_max: [32.1], temperature_2m_min: [24.7], precipitation_probability_max: [45] },
    }, 'celsius')).toMatchObject({ condition: 'partly-cloudy', isDay: true, temperature: 28.4, apparentTemperature: 31.2, high: 32.1, low: 24.7, precipitationProbability: 45, unit: 'celsius' });
  });
});

describe('weather preferences', () => {
  beforeEach(async () => {
    await (await getDatabase()).delete('settings', 'weatherPreferences');
    await (await getDatabase()).delete('settings', 'weatherCache');
  });

  it('defaults to automatic units and persists only in the local settings store', async () => {
    expect(await getWeatherPreferences()).toEqual({ units: 'auto' });
    await setWeatherPreferences({ units: 'fahrenheit', location: { latitude: 1, longitude: 2, locatedAt: '2026-08-23T00:00:00.000Z' } });
    expect(await getWeatherPreferences()).toEqual({ units: 'fahrenheit', location: { latitude: 1, longitude: 2, locatedAt: '2026-08-23T00:00:00.000Z' } });
  });
});

describe('weather cache', () => {
  const location = { latitude: 31.23, longitude: 121.47, locatedAt: '2026-08-23T00:00:00.000Z' };
  const forecast = { condition: 'clear' as const, isDay: true, temperature: 28, apparentTemperature: 30, high: 32, low: 24, precipitationProbability: 40, unit: 'celsius' as const };

  beforeEach(async () => {
    await (await getDatabase()).delete('settings', 'weatherCache');
  });

  it('persists a local forecast for sixty minutes and invalidates it by unit or location', async () => {
    const fetchedAt = '2026-08-23T00:00:00.000Z';
    await cacheWeatherForecast(location, 'celsius', forecast, fetchedAt);
    const now = Date.parse(fetchedAt);
    await expect(getCachedWeatherForecast(location, 'celsius', now + WEATHER_CACHE_TTL_MS - 1)).resolves.toEqual(forecast);
    await expect(getCachedWeatherForecast(location, 'fahrenheit', now + 1)).resolves.toBeUndefined();
    await expect(getCachedWeatherForecast({ ...location, latitude: 31.24 }, 'celsius', now + 1)).resolves.toBeUndefined();
    await expect(getCachedWeatherForecast(location, 'celsius', now + WEATHER_CACHE_TTL_MS)).resolves.toBeUndefined();
  });
});

describe('weather city resolution', () => {
  it('builds a localized city-level reverse-geocoding request', () => {
    const url = new URL(buildWeatherCityUrl({ latitude: 31.23, longitude: 121.47, locatedAt: '2026-08-23T00:00:00.000Z' }, 'zh-CN'));
    expect(url.origin).toBe('https://nominatim.openstreetmap.org');
    expect(url.pathname).toBe('/reverse');
    expect(url.searchParams.get('zoom')).toBe('10');
    expect(url.searchParams.get('layer')).toBe('address');
    expect(url.searchParams.get('accept-language')).toBe('zh-CN');
  });

  it('selects the most specific available settlement name and safely falls back', () => {
    expect(parseWeatherCity({ address: { city: '上海市', town: '其他城镇' } })).toBe('上海市');
    expect(parseWeatherCity({ address: { village: '乡村' } })).toBe('乡村');
    expect(parseWeatherCity({ address: {} })).toBeUndefined();
  });
});

describe('weather location errors', () => {
  it('distinguishes denied, unavailable, and timed-out location requests', () => {
    expect(weatherLocationErrorFor({ code: 1 })).toBe('DENIED');
    expect(weatherLocationErrorFor({ code: 2 })).toBe('UNAVAILABLE');
    expect(weatherLocationErrorFor({ code: 3 })).toBe('TIMEOUT');
  });
});
