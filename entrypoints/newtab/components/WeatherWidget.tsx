import { useEffect, useMemo, useState } from 'react';
import { currentLanguageTag, t } from '../../../core/browser/i18n';
import { getWeatherForecast, resolveTemperatureUnit, type WeatherCondition, type WeatherForecast } from '../../../core/weather/forecast';
import { latestWeatherLocationError, requestWeatherLocation, subscribeToWeatherLocationRequest, weatherLocationRequestPending, type WeatherLocationError } from '../../../core/weather/location';
import { getWeatherPreferences, subscribeToWeatherPreferences, type WeatherPreferences } from '../../../core/weather/preferences';

type WeatherState =
  | { kind: 'loading-location' }
  | { kind: 'needs-location' }
  | { kind: 'location-error'; error: WeatherLocationError }
  | { kind: 'loading-weather' }
  | { kind: 'weather-error' }
  | { kind: 'ready'; forecast: WeatherForecast };

export function WeatherWidget() {
  const [preferences, setPreferences] = useState<WeatherPreferences>();
  const [locationError, setLocationError] = useState<WeatherLocationError>();
  const [forecast, setForecast] = useState<WeatherForecast>();
  const [weatherError, setWeatherError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const unit = resolveTemperatureUnit(preferences?.units ?? 'auto', currentLanguageTag());

  useEffect(() => {
    let active = true;
    const load = () => {
      void getWeatherPreferences().then((next) => {
        if (active) setPreferences(next);
      }).catch(() => undefined);
    };
    const locationRequestChanged = () => {
      if (!active) return;
      setLocationError(latestWeatherLocationError());
    };
    load();
    const unsubscribe = subscribeToWeatherPreferences(load);
    const unsubscribeLocation = subscribeToWeatherLocationRequest(locationRequestChanged);
    return () => { active = false; unsubscribe(); unsubscribeLocation(); };
  }, []);

  useEffect(() => {
    if (!preferences?.location) return;
    let active = true;
    const controller = new AbortController();
    setForecast(undefined);
    setWeatherError(false);
    void getWeatherForecast(preferences.location, unit, controller.signal).then((next) => {
      if (active) setForecast(next);
    }).catch((error) => {
      if (active && !(error instanceof DOMException && error.name === 'AbortError')) setWeatherError(true);
    });
    return () => { active = false; controller.abort(); };
  }, [preferences?.location?.latitude, preferences?.location?.longitude, preferences?.location?.locatedAt, refreshKey, unit]);

  const state = useMemo<WeatherState>(() => {
    if (!preferences) return { kind: 'loading-location' };
    if (weatherLocationRequestPending()) return { kind: 'loading-location' };
    if (locationError) return { kind: 'location-error', error: locationError };
    if (!preferences.location) return { kind: 'needs-location' };
    if (weatherError) return { kind: 'weather-error' };
    if (!forecast) return { kind: 'loading-weather' };
    return { kind: 'ready', forecast };
  }, [forecast, locationError, preferences, weatherError]);

  const requestLocation = () => {
    setLocationError(undefined);
    void requestWeatherLocation(currentLanguageTag()).catch((error: WeatherLocationError) => setLocationError(error));
  };

  if (state.kind === 'ready') return <WeatherCard forecast={state.forecast} city={preferences?.location?.city} />;
  const locationIssue = state.kind === 'location-error';
  return <div className="weatherWidget weatherWidget--status">
    <WeatherIcon condition="partly-cloudy" isDay />
    <div>
      <strong>{t('weather')}</strong>
      <p>{state.kind === 'loading-location' ? t('weatherLocating') : state.kind === 'loading-weather' ? t('weatherLoading') : locationIssue ? t(`weatherLocation${state.error}`) : state.kind === 'weather-error' ? t('weatherUnavailable') : t('weatherLocationNeeded')}</p>
    </div>
    {(state.kind === 'needs-location' || locationIssue || state.kind === 'weather-error') && <button type="button" className="weatherAction" onClick={state.kind === 'weather-error' ? () => setRefreshKey((value) => value + 1) : requestLocation}>{t(state.kind === 'weather-error' ? 'retry' : 'weatherUseCurrentLocation')}</button>}
  </div>;
}

function WeatherCard({ forecast, city }: { forecast: WeatherForecast; city?: string }) {
  const degree = forecast.unit === 'celsius' ? '°C' : '°F';
  return <div className="weatherWidget">
    <div className="weatherHeader"><span className="weatherLocationName" title={city}>{city ?? t('weatherCurrentLocation')}</span></div>
    <div className="weatherCurrent"><WeatherIcon condition={forecast.condition} isDay={forecast.isDay} /><span className="weatherTemperature"><strong>{formatTemperature(forecast.temperature)}°</strong><span>{degree}</span></span><span>{t(`weather${conditionKey(forecast.condition)}`)}</span></div>
    <div className="weatherDetails"><span>{t('weatherFeelsLike')} {formatTemperature(forecast.apparentTemperature)}°</span><span>{t('weatherHighLow')} {formatTemperature(forecast.high)}° / {formatTemperature(forecast.low)}°</span><span>{t('weatherPrecipitation')} {Math.round(forecast.precipitationProbability)}%</span></div>
  </div>;
}

function formatTemperature(value: number): string {
  return String(Math.round(value));
}

function conditionKey(condition: WeatherCondition): string {
  return condition.split('-').map((part) => part[0]!.toUpperCase() + part.slice(1)).join('');
}

function WeatherIcon({ condition, isDay }: { condition: WeatherCondition; isDay: boolean }) {
  const cloud = condition !== 'clear';
  const precipitation = ['drizzle', 'rain', 'showers', 'snow', 'thunderstorm'].includes(condition);
  return <svg className="weatherIcon" viewBox="0 0 48 48" aria-hidden="true">
    {!cloud && (isDay ? <circle cx="24" cy="24" r="9" /> : <path d="M29 9a15 15 0 1 0 10 25A16 16 0 1 1 29 9Z" />)}
    {cloud && <><path d="M15 31h20a8 8 0 0 0 .4-16A11 11 0 0 0 15 20a6 6 0 0 0 0 11Z" />{condition === 'partly-cloudy' && <circle cx="18" cy="16" r="6" />}</>}
    {condition === 'fog' && <path d="M11 31h26M15 36h18" />}
    {precipitation && <path d={condition === 'snow' ? 'M17 35l2 3m0-3-2 3m10-3 2 3m0-3-2 3' : 'M18 35l-2 5m10-5-2 5m10-5-2 5'} />}
    {condition === 'thunderstorm' && <path d="m25 30-4 8h5l-2 6 7-10h-5l3-4Z" />}
  </svg>;
}
