import { setWeatherPreferences, type WeatherLocation } from './preferences';
import { resolveWeatherCity } from './location-name';

export type WeatherLocationError = 'UNSUPPORTED' | 'DENIED' | 'UNAVAILABLE' | 'TIMEOUT';

const LOCATION_PERMISSION_DENIED = 1;
const LOCATION_TIMEOUT = 3;

let requestPending = false;
let lastError: WeatherLocationError | undefined;
const eventName = 'isu-weather-location-request';

export function weatherLocationRequestPending(): boolean {
  return requestPending;
}

export function latestWeatherLocationError(): WeatherLocationError | undefined {
  return lastError;
}

export function subscribeToWeatherLocationRequest(listener: () => void): () => void {
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}

/** Starts browser geolocation from a direct user gesture and saves only the resulting coordinates locally. */
export function requestWeatherLocation(languageTag = navigator.language): Promise<WeatherLocation> {
  if (!navigator.geolocation) return Promise.reject<WeatherLocation>('UNSUPPORTED');
  requestPending = true;
  lastError = undefined;
  emitChange();
  return new Promise<WeatherLocation>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location: WeatherLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          locatedAt: new Date().toISOString(),
        };
        void setWeatherPreferences({ location }).then(() => {
          resolve(location);
          void resolveWeatherCity(location, languageTag).then((city) => {
            if (city) return setWeatherPreferences({ location: { ...location, city } });
            return undefined;
          }).catch(() => undefined);
        }, reject).finally(finishRequest);
      },
      (error) => {
        lastError = weatherLocationErrorFor(error);
        finishRequest();
        reject(lastError);
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 15 * 60_000 },
    );
  });
}

export function weatherLocationErrorFor(error: Pick<GeolocationPositionError, 'code'>): WeatherLocationError {
  if (error.code === LOCATION_PERMISSION_DENIED) return 'DENIED';
  if (error.code === LOCATION_TIMEOUT) return 'TIMEOUT';
  return 'UNAVAILABLE';
}

function finishRequest(): void {
  requestPending = false;
  emitChange();
}

function emitChange(): void {
  window.dispatchEvent(new Event(eventName));
}
