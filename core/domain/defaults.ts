import { generateKeyBetween } from 'fractional-indexing';
import { DEFAULT_GROUP_ID, type AppConfig, type DeviceIdentity, type Revision, type SearchPreferences } from './types';
import { createDefaultWidgetLayout } from './widgets';

export function createDeviceIdentity(): DeviceIdentity {
  return { deviceId: crypto.randomUUID(), counter: 0, epoch: 0 };
}

export const DEFAULT_SEARCH_PREFERENCES: SearchPreferences = {
  engine: 'google',
  widthPercent: 50,
  backgroundOpacity: 24,
  historyEnabled: true,
  suggestionsEnabled: true,
};

export const DEFAULT_SOLID_WALLPAPER_COLOR = '#ffffff';

export function createInitialConfig(identity: DeviceIdentity): AppConfig {
  const revision: Revision = { counter: ++identity.counter, deviceId: identity.deviceId };
  return {
    schemaVersion: 1,
    datasetId: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
    groups: [{
      id: DEFAULT_GROUP_ID,
      name: 'Default',
      sortKey: generateKeyBetween(null, null),
      collapsed: false,
      revision,
    }],
    shortcuts: [],
    appearance: {
      theme: { value: 'system', revision },
      blur: { value: 18, revision },
      cardSize: { value: 'medium', revision },
      wallpaper: { value: { type: 'solid', color: DEFAULT_SOLID_WALLPAPER_COLOR }, revision },
      widgetLayout: { value: createDefaultWidgetLayout(), revision },
      search: { value: { ...DEFAULT_SEARCH_PREFERENCES }, revision },
    },
  };
}
