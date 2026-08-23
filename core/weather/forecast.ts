import type { TemperatureUnitPreference, WeatherLocation } from './preferences';
import { cacheWeatherForecast, getCachedWeatherForecast } from './cache';

export type TemperatureUnit = 'celsius' | 'fahrenheit';
export type WeatherCondition = 'clear' | 'partly-cloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'showers' | 'thunderstorm';

export type WeatherForecast = {
  condition: WeatherCondition;
  isDay: boolean;
  temperature: number;
  apparentTemperature: number;
  high: number;
  low: number;
  precipitationProbability: number;
  unit: TemperatureUnit;
};

export function resolveTemperatureUnit(preference: TemperatureUnitPreference, languageTag: string): TemperatureUnit {
  if (preference === 'celsius' || preference === 'fahrenheit') return preference;
  return languageTag.toLocaleLowerCase().startsWith('zh') ? 'celsius' : 'fahrenheit';
}

export function buildWeatherForecastUrl(location: WeatherLocation, unit: TemperatureUnit): string {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(location.latitude));
  url.searchParams.set('longitude', String(location.longitude));
  url.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code,is_day');
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  url.searchParams.set('temperature_unit', unit);
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '1');
  return url.toString();
}

export async function getWeatherForecast(location: WeatherLocation, unit: TemperatureUnit, signal?: AbortSignal): Promise<WeatherForecast> {
  const cached = await getCachedWeatherForecast(location, unit);
  if (cached) return cached;
  const response = await fetch(buildWeatherForecastUrl(location, unit), { signal });
  if (!response.ok) throw new Error('WEATHER_REQUEST_FAILED');
  const forecast = parseWeatherForecast(await response.json(), unit);
  await cacheWeatherForecast(location, unit, forecast);
  return forecast;
}

export function parseWeatherForecast(value: unknown, unit: TemperatureUnit): WeatherForecast {
  if (!value || typeof value !== 'object') throw new Error('WEATHER_RESPONSE_INVALID');
  const data = value as { current?: Record<string, unknown>; daily?: Record<string, unknown> };
  const current = data.current;
  const daily = data.daily;
  const temperature = numberAt(current?.temperature_2m);
  const apparentTemperature = numberAt(current?.apparent_temperature);
  const code = numberAt(current?.weather_code);
  const isDay = numberAt(current?.is_day) === 1;
  const high = firstNumber(daily?.temperature_2m_max);
  const low = firstNumber(daily?.temperature_2m_min);
  const precipitationProbability = firstNumber(daily?.precipitation_probability_max);
  if ([temperature, apparentTemperature, code, high, low, precipitationProbability].some((item) => item === undefined)) throw new Error('WEATHER_RESPONSE_INVALID');
  return { condition: weatherConditionForCode(code!), isDay, temperature: temperature!, apparentTemperature: apparentTemperature!, high: high!, low: low!, precipitationProbability: precipitationProbability!, unit };
}

export function weatherConditionForCode(code: number): WeatherCondition {
  if (code === 0) return 'clear';
  if ([1, 2].includes(code)) return 'partly-cloudy';
  if (code === 3) return 'cloudy';
  if ([45, 48].includes(code)) return 'fog';
  if ([51, 53, 55, 56, 57].includes(code)) return 'drizzle';
  if ([61, 63, 65, 66, 67].includes(code)) return 'rain';
  if ([71, 73, 75, 77].includes(code)) return 'snow';
  if ([80, 81, 82, 85, 86].includes(code)) return 'showers';
  if ([95, 96, 99].includes(code)) return 'thunderstorm';
  return 'cloudy';
}

function numberAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstNumber(value: unknown): number | undefined {
  return Array.isArray(value) ? numberAt(value[0]) : undefined;
}
