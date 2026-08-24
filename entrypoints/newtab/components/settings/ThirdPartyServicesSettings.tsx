import { t } from '../../../../core/browser/i18n';

type ServiceAttributionGroup = {
  title: 'thirdPartyServiceWeather';
  sources: readonly {
    label: 'weatherSourceForecast' | 'weatherSourceLocation' | 'weatherSourceAttribution';
    name: string;
    url: string;
  }[];
};

const ATTRIBUTION_GROUPS: readonly ServiceAttributionGroup[] = [
  {
    title: 'thirdPartyServiceWeather',
    sources: [
      { label: 'weatherSourceForecast', name: 'Open-Meteo', url: 'https://open-meteo.com/' },
      { label: 'weatherSourceLocation', name: 'Nominatim / OpenStreetMap', url: 'https://nominatim.openstreetmap.org/' },
      { label: 'weatherSourceAttribution', name: 'OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
    ],
  },
];

export function ThirdPartyServicesSettings() {
  return (
    <section className="thirdPartyServicesSettings">
      <h3>{t('thirdPartyServices')}</h3>
      {ATTRIBUTION_GROUPS.map((group) => <div className="thirdPartyServiceGroup" key={group.title}>
        <h4>{t(group.title)}</h4>
        <dl className="thirdPartyServiceList">
          {group.sources.map((source) => <div key={source.url}>
            <dt>{t(source.label)}</dt>
            <dd><a href={source.url} target="_blank" rel="noreferrer">{source.name}</a></dd>
          </div>)}
        </dl>
      </div>)}
    </section>
  );
}
