import { defineConfig } from 'wxt';

const googleDriveClientId = process.env.NODE_ENV === 'development'
  ? '963098370504-v24hcfjdfun29r622m2pb0ttec4i7t9r.apps.googleusercontent.com'
  : '963098370504-3a9sk1qoe4uv0jtttvda1r31ftrr066h.apps.googleusercontent.com';

// The Chrome Web Store extension public key keeps unpacked development builds
// on the same extension ID as the published package. This is public key
// material only; signing still happens through Chrome Web Store publishing.
const extensionPublicKey = [
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAy3YL+CHxHX1zFZZTS7VE',
  'sIDjbQUFrl3UT4PB6ratScvkoy/F02RehZjADAJtPq/J+KKZXdv36sgTmno1MqcC',
  'uxlrV2G9sd2SKWi4R0ymflnXEtc1wE6aHnVZ5qucvZ/WIc07/KD60zcefySXja35',
  'Hnwg3rkxVQFEhbDbEJ02RjWUL68q/BX/UKpofxPaM69hj5fekN2WX7SV9ZBie6Zb',
  'WOF02zHUR0vF7b/N/nlphsZaX9bpGU/Iz8ta3CqOrK8A+RCCJEAiu9LiF0iIxW0x',
  'CgsJs7NF8+vQzovJUuVeNRk/ed+iTeyfldCmfzD0lxjNGsM31SjJpGodwwXbtMH5',
  '0QIDAQAB',
].join('');

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    key: extensionPublicKey,
    default_locale: 'zh_CN',
    permissions: ['storage', 'unlimitedStorage', 'search', 'favicon', 'contextMenus', 'geolocation', 'alarms', 'identity'],
    optional_permissions: ['history'],
    icons: {
      16: 'icons/isu-16.png',
      32: 'icons/isu-32.png',
      48: 'icons/isu-48.png',
      128: 'icons/isu-128.png',
    },
    host_permissions: [
      'https://wallhaven.cc/*',
      'https://th.wallhaven.cc/*',
      'https://w.wallhaven.cc/*',
      'https://api.unsplash.com/*',
      'https://images.unsplash.com/*',
      'https://suggestqueries.google.com/*',
      'https://www.google.com/*',
      'https://t0.gstatic.cn/*',
      'https://*.gstatic.com/*',
      'https://a.favicon.im/*',
      'https://icons.duckduckgo.com/*',
      'https://www.bing.com/*',
      'https://v1.hitokoto.cn/*',
      'https://zenquotes.io/*',
      'https://www.googleapis.com/*',
      'https://api.open-meteo.com/*',
      'https://nominatim.openstreetmap.org/*',
    ],
    oauth2: {
      client_id: googleDriveClientId,
      scopes: ['https://www.googleapis.com/auth/drive.appdata'],
    },
    chrome_url_overrides: {
      newtab: 'newtab.html',
    },
  },
});
