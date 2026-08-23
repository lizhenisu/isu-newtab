import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    default_locale: 'zh_CN',
    permissions: ['storage', 'unlimitedStorage', 'search', 'favicon', 'contextMenus'],
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
      'https://www.bing.com/AS/*',
      'https://v1.hitokoto.cn/*',
      'https://zenquotes.io/*',
    ],
    chrome_url_overrides: {
      newtab: 'newtab.html',
    },
  },
});
