import { useEffect, useState } from 'react';
import { t } from '../../../../core/browser/i18n';
import { getWeatherPreferences, setWeatherPreferences, subscribeToWeatherPreferences, type TemperatureUnitPreference } from '../../../../core/weather/preferences';

export function WeatherSettings() {
  const [units, setUnits] = useState<TemperatureUnitPreference>('auto');

  useEffect(() => {
    let active = true;
    const load = () => {
      void getWeatherPreferences().then((preferences) => {
        if (active) setUnits(preferences.units);
      }).catch(() => undefined);
    };
    load();
    const unsubscribe = subscribeToWeatherPreferences(load);
    return () => { active = false; unsubscribe(); };
  }, []);

  const updateUnits = (next: TemperatureUnitPreference) => {
    setUnits(next);
    void setWeatherPreferences({ units: next });
  };

  return (
    <section>
      <div className="settingsSectionHeader"><div><h3>{t('weather')}</h3><p>{t('weatherSettingsDescription')}</p></div></div>
      <label>{t('weatherTemperatureUnit')}<select value={units} onChange={(event) => updateUnits(event.target.value as TemperatureUnitPreference)}>
        <option value="auto">{t('weatherUnitAuto')}</option>
        <option value="celsius">{t('weatherUnitCelsius')}</option>
        <option value="fahrenheit">{t('weatherUnitFahrenheit')}</option>
      </select></label>
      <p className="settingsHint">{t('weatherPrivacy')}</p>
    </section>
  );
}
