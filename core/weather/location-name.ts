import type { WeatherLocation } from './preferences';

type NominatimResponse = {
  address?: Record<string, unknown>;
};

export function buildWeatherCityUrl(location: WeatherLocation, languageTag: string): string {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(location.latitude));
  url.searchParams.set('lon', String(location.longitude));
  url.searchParams.set('zoom', '10');
  url.searchParams.set('layer', 'address');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', languageTag);
  return url.toString();
}

export async function resolveWeatherCity(location: WeatherLocation, languageTag: string, signal?: AbortSignal): Promise<string | undefined> {
  const response = await fetch(buildWeatherCityUrl(location, languageTag), { signal });
  if (!response.ok) throw new Error('WEATHER_CITY_REQUEST_FAILED');
  return parseWeatherCity(await response.json());
}

export function parseWeatherCity(value: unknown): string | undefined {
  const address = (value as NominatimResponse | undefined)?.address;
  if (!address) return undefined;
  for (const field of ['city', 'town', 'village', 'municipality', 'county', 'state', 'country']) {
    const value = address[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
