import { getDatabase } from '../storage/database';

export type TemperatureUnitPreference = 'auto' | 'celsius' | 'fahrenheit';

export type WeatherLocation = {
  latitude: number;
  longitude: number;
  locatedAt: string;
  city?: string;
};

export type WeatherPreferences = {
  units: TemperatureUnitPreference;
  location?: WeatherLocation;
};

const SETTINGS_KEY = 'weatherPreferences';
const DEFAULT_PREFERENCES: WeatherPreferences = { units: 'auto' };
const eventName = 'isu-weather-preferences-changed';

export async function getWeatherPreferences(): Promise<WeatherPreferences> {
  const value = await (await getDatabase()).get('settings', SETTINGS_KEY);
  if (!value || typeof value !== 'object') return { ...DEFAULT_PREFERENCES };
  const preferences = value as Partial<WeatherPreferences>;
  const units = preferences.units === 'celsius' || preferences.units === 'fahrenheit' ? preferences.units : 'auto';
  const location = isWeatherLocation(preferences.location) ? preferences.location : undefined;
  return { units, ...(location ? { location } : {}) };
}

export async function setWeatherPreferences(patch: Partial<WeatherPreferences>): Promise<WeatherPreferences> {
  const next = { ...await getWeatherPreferences(), ...patch };
  await (await getDatabase()).put('settings', next, SETTINGS_KEY);
  emitChange();
  return next;
}

export function subscribeToWeatherPreferences(listener: () => void): () => void {
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}

function emitChange(): void {
  window.dispatchEvent(new Event(eventName));
}

function isWeatherLocation(value: unknown): value is WeatherLocation {
  if (!value || typeof value !== 'object') return false;
  const location = value as Partial<WeatherLocation>;
  return typeof location.latitude === 'number' && Number.isFinite(location.latitude)
    && typeof location.longitude === 'number' && Number.isFinite(location.longitude)
    && typeof location.locatedAt === 'string' && !Number.isNaN(Date.parse(location.locatedAt))
    && (location.city === undefined || (typeof location.city === 'string' && location.city.trim().length > 0));
}
