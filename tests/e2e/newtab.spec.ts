import { expect, test, chromium, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

declare global {
  interface Window {
    __weatherLocationRequestCalls?: () => number;
  }
}

let context: BrowserContext | undefined;
let profile: string;

test.beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'isu-newtab-'));
  const extensionPath = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  await context.route('https://v1.hitokoto.cn/**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ uuid: 'e2e-hitokoto', hitokoto: '今天也要保持好奇。', from: 'E2E', from_who: null }),
  }));
  await context.route('https://zenquotes.io/**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ q: 'Stay curious.', a: 'E2E' }]),
  }));
});

test.afterEach(async () => {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
});

test('loads the extension, creates a shortcut, and persists it after reload', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).toContain('contextMenus');
  expect(manifest.permissions).toContain('alarms');
  expect(manifest.permissions).not.toContain('history');
  expect(manifest.permissions).toContain('geolocation');
  expect(manifest.optional_permissions).toContain('history');
  expect(manifest.optional_permissions).not.toContain('geolocation');
  expect(manifest.host_permissions).toEqual(expect.arrayContaining(['https://v1.hitokoto.cn/*', 'https://zenquotes.io/*', 'https://www.bing.com/AS/*', 'https://api.open-meteo.com/*', 'https://nominatim.openstreetmap.org/*']));
  expect(JSON.stringify(manifest)).not.toContain('lens.google.com');
  expect(manifest.icons).toMatchObject({ 16: 'icons/isu-16.png', 32: 'icons/isu-32.png', 48: 'icons/isu-48.png', 128: 'icons/isu-128.png' });
  const page = await context.newPage();
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.goto('chrome://newtab/');
  await expect.poll(() => page.url()).toContain(`chrome-extension://${extensionId}/newtab.html`);
  await expect(page).toHaveTitle(/New Tab|新标签页/);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/chrome-newtab.svg');
  await expect(page.getByRole('textbox', { name: /Search the web|搜索互联网/, exact: true })).toBeVisible();
  await expect(page.locator('#quick-note')).toHaveCSS('min-height', '132px');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /Add shortcut|添加快捷方式/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveClass(/modal--editor/);
  await expect(dialog).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const editorMetrics = await dialog.evaluate((element) => ({ width: element.getBoundingClientRect().width, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(editorMetrics.width).toBeLessThanOrEqual(520);
  expect(editorMetrics.scrollHeight).toBeLessThanOrEqual(editorMetrics.clientHeight + 1);
  const closeAlignment = await dialog.getByRole('button', { name: /Close|关闭/ }).evaluate((button) => {
    const buttonRect = button.getBoundingClientRect();
    const iconRect = button.querySelector('svg')!.getBoundingClientRect();
    return {
      x: Math.abs(buttonRect.left + buttonRect.width / 2 - iconRect.left - iconRect.width / 2),
      y: Math.abs(buttonRect.top + buttonRect.height / 2 - iconRect.top - iconRect.height / 2),
    };
  });
  expect(closeAlignment.x).toBeLessThan(.5);
  expect(closeAlignment.y).toBeLessThan(.5);
  await dialog.getByLabel(/Name|名称/).fill('OpenAI');
  await dialog.getByLabel(/URL|网址/).fill('openai.com');
  await dialog.getByRole('button', { name: /Save|保存/ }).click();
  await expect(page.getByText('OpenAI', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<number>((resolve, reject) => {
      const request = database.transaction('outbox').objectStore('outbox').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }), { timeout: 12_000 }).toBe(0);

  await page.reload();
  await expect(page.getByText('OpenAI', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('uses the selected engine for text and visual search in the current tab', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);

  await context.route('https://images.google.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<title>Google Images</title>',
  }));
  await page.getByRole('button', { name: /Open Google Images|打开 Google 图片搜索/ }).click();
  await expect(page).toHaveURL(/https:\/\/images\.google\.com\/\?hl=/);

  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByLabel(/Settings|设置/).click();
  const engine = page.getByLabel(/Search engine|搜索引擎/);
  await expect(engine).toHaveValue('google');
  await engine.selectOption('bing');
  await expect(engine).toHaveValue('bing');
  await page.getByRole('button', { name: /Close|关闭/ }).click();
  await expect(page.getByRole('button', { name: /Open Bing Images|打开 Bing 图片搜索/ })).toBeVisible();

  await context.route('https://www.bing.com/search**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Bing Search</title>' }));
  await page.getByRole('textbox', { name: /Search the web|搜索互联网/ }).fill('Isu NewTab');
  await page.getByRole('search').press('Enter');
  await expect(page).toHaveURL(/https:\/\/www\.bing\.com\/search\?q=Isu\+NewTab&setlang=/);

  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await expect(page.getByLabel(/Search engine|搜索引擎/)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /Search the web|搜索互联网/ })).toHaveAttribute('placeholder', /Search Bing|在 Bing/);
  await context.route('https://www.bing.com/images**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Bing Images</title>' }));
  await page.getByRole('button', { name: /Open Bing Images|打开 Bing 图片搜索/ }).click();
  await expect(page).toHaveURL(/https:\/\/www\.bing\.com\/images\?setlang=/);
});

test('keeps weather hidden until enabled, then requests local location and loads Open-Meteo weather', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  await context.addInitScript(() => {
    let calls = 0;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success: PositionCallback) {
          calls += 1;
          success({ coords: { latitude: 31.23, longitude: 121.47 } } as GeolocationPosition);
        },
      },
    });
    Object.defineProperty(window, '__weatherLocationRequestCalls', { configurable: true, value: () => calls });
  });
  const page = await context.newPage();
  let forecastRequests = 0;
  let cityRequests = 0;
  await context.route('https://api.open-meteo.com/**', (route) => {
    forecastRequests += 1;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ current: { temperature_2m: 28, apparent_temperature: 30, weather_code: 2, is_day: 1 }, daily: { temperature_2m_max: [32], temperature_2m_min: [24], precipitation_probability_max: [40] } }) });
  });
  await context.route('https://nominatim.openstreetmap.org/**', (route) => {
    cityRequests += 1;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ address: { city: 'Shanghai' } }) });
  });
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await expect(page.locator('[data-widget-id="weather"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__weatherLocationRequestCalls?.())).toBe(0);
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  const thirdPartyServices = page.getByRole('heading', { name: /Third-party services & attribution|第三方服务与署名/ });
  await expect(thirdPartyServices).toBeVisible();
  const thirdPartyServicesSection = thirdPartyServices.locator('..');
  await expect(thirdPartyServicesSection.getByRole('heading', { name: /^Weather$|^天气$/ })).toBeVisible();
  await expect(page.locator('.settings > section').last()).toHaveClass(/thirdPartyServicesSettings/);
  for (const [name, href] of [
    ['Open-Meteo', 'https://open-meteo.com/'],
    ['Nominatim / OpenStreetMap', 'https://nominatim.openstreetmap.org/'],
    ['OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright'],
  ] as const) {
    const link = thirdPartyServicesSection.getByRole('link', { name });
    await expect(link).toHaveAttribute('href', href);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noreferrer');
  }
  const weatherToggle = page.getByRole('checkbox', { name: /^Weather$|^天气$/ });
  await expect(weatherToggle).not.toBeChecked();
  await weatherToggle.check();
  await expect.poll(() => page.evaluate(() => window.__weatherLocationRequestCalls?.())).toBe(1);
  await expect(page.locator('[data-widget-id="weather"]')).toBeVisible();
  await expect(page.locator('[data-widget-id="weather"]')).toHaveCSS('grid-column', '20 / span 10');
  await expect(page.locator('[data-widget-id="weather"]')).toHaveCSS('grid-row', '27 / span 3');
  await expect(page.getByText(/Partly cloudy|少云/)).toBeVisible();
  await expect(page.getByText('Shanghai', { exact: true })).toBeVisible();
  await expect.poll(() => cityRequests).toBe(1);
  expect(forecastRequests).toBe(1);
  const weatherCard = page.locator('.weatherWidget').filter({ hasText: 'Shanghai' });
  const weatherRects = await weatherCard.evaluate((element) => {
    const rect = (selector: string) => (element.querySelector(selector) as HTMLElement).getBoundingClientRect();
    const location = rect('.weatherLocationName');
    const temperature = rect('.weatherTemperature');
    const details = rect('.weatherDetails');
    return { location, temperature, details, hasAttribution: Boolean(element.querySelector('.weatherAttribution')) };
  });
  expect(weatherRects.location.bottom).toBeLessThanOrEqual(weatherRects.temperature.top);
  expect(weatherRects.temperature.bottom).toBeLessThanOrEqual(weatherRects.details.top);
  expect(weatherRects.hasAttribution).toBe(false);
  const secondPage = await context.newPage();
  await secondPage.goto(`chrome-extension://${extensionId}/newtab.html`);
  await expect(secondPage.getByText('Shanghai', { exact: true })).toBeVisible();
  expect(forecastRequests).toBe(1);
  expect(cityRequests).toBe(1);
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction('settings').objectStore('settings').get('weatherPreferences');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  })).toMatchObject({ units: 'auto', location: { latitude: 31.23, longitude: 121.47 } });
});

test('uses Bing suggestions without requesting Google and preserves local history on failure', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  let googleSuggestionRequests = 0;
  await context.route('https://suggestqueries.google.com/**', async (route) => {
    googleSuggestionRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(['unexpected', []]) });
  });
  await context.route('https://www.bing.com/AS/Suggestions**', (route) => route.fulfill({
    contentType: 'application/json',
    body: '<ul><li query="Bing online suggestion"></li></ul>',
  }));
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByLabel(/Settings|设置/).click();
  await page.getByLabel(/Search engine|搜索引擎/).selectOption('bing');
  await page.getByRole('button', { name: /Close|关闭/ }).click();

  const input = page.getByRole('textbox', { name: /Search the web|搜索互联网/ });
  await input.fill('bing');
  await expect(page.getByRole('option', { name: 'Bing online suggestion' })).toBeVisible();
  expect(googleSuggestionRequests).toBe(0);

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('settings', 'readwrite');
      transaction.objectStore('settings').put([{ query: 'bing local history', searchedAt: new Date().toISOString() }], 'searchHistory');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await context.unroute('https://www.bing.com/AS/Suggestions**');
  await context.route('https://www.bing.com/AS/Suggestions**', (route) => route.fulfill({ status: 503 }));
  await input.evaluate((element: HTMLInputElement) => element.blur());
  await input.focus();
  await input.fill('bing local');
  await expect(page.getByRole('option', { name: 'bing local history' })).toBeVisible();
  expect(googleSuggestionRequests).toBe(0);
});

test('places shortcuts at the add tile and supports a single-level desktop folder', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  const addTile = page.locator('[data-desktop-key="add-shortcut"]');
  const originalSlot = await addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }));
  await addTile.scrollIntoViewIfNeeded();
  const addBox = await addTile.boundingBox();
  if (!addBox) throw new Error('Add shortcut tile was not measurable');
  await page.mouse.move(addBox.x + addBox.width / 2, addBox.y + addBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(addBox.x + addBox.width / 2, addBox.y + addBox.height / 2 + 120, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }))).not.toEqual(originalSlot);
  const firstMovedSlot = await addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }));
  // Release immediately after the final movement. The release event may be
  // delivered before React has processed the last drag-move candidate; an
  // empty target must still be committed instead of reverting to firstMovedSlot.
  const movedBox = await addTile.boundingBox();
  if (!movedBox) throw new Error('Moved add shortcut tile was not measurable');
  await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2 + 61, { steps: 1 });
  await page.mouse.up();
  await expect.poll(() => addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }))).not.toEqual(firstMovedSlot);
  const initialSlot = await addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }));
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<string>((resolve, reject) => {
      const request = database.transaction('config').objectStore('config').get('current');
      request.onsuccess = () => {
        const item = request.result.appearance.widgetLayout.value.find((candidate: { id: string }) => candidate.id === 'addShortcut');
        resolve(`${item.position.column + 1} / span ${item.position.width}|${item.position.row + 1} / span ${item.position.height}`);
      };
      request.onerror = () => reject(request.error);
    });
  })).toBe(`${initialSlot.column}|${initialSlot.row}`);
  await page.reload();
  await expect.poll(() => addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }))).toEqual(initialSlot);
  await addTile.getByRole('button', { name: /Add shortcut|添加快捷方式/ }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel(/Name|名称/).fill('Docs');
  await editor.getByLabel(/URL|网址/).fill('https://example.com/docs');
  await editor.getByRole('button', { name: /Save|保存/ }).click();
  const shortcut = page.locator('.desktopItem--shortcut').filter({ hasText: 'Docs' });
  await expect(shortcut).toBeVisible();
  await expect(shortcut.getByRole('link')).toHaveAttribute('href', 'https://example.com/docs');
  await expect.poll(() => shortcut.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }))).toEqual(initialSlot);
  await expect.poll(() => addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }))).not.toEqual(initialSlot);
  await shortcut.scrollIntoViewIfNeeded();
  const shortcutBox = await shortcut.boundingBox();
  if (!shortcutBox) throw new Error('Shortcut was not measurable');
  const extensionUrl = page.url();
  await page.mouse.move(shortcutBox.x + shortcutBox.width / 2, shortcutBox.y + shortcutBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(shortcutBox.x + shortcutBox.width / 2 + 110, shortcutBox.y + shortcutBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(page.url()).toBe(extensionUrl);
  await expect(shortcut).toBeVisible();

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('config', 'readwrite');
      const store = transaction.objectStore('config');
      const request = store.get('current');
      request.onsuccess = () => {
        const config = request.result;
        const revision = { counter: 500, deviceId: 'e2e' };
        const docs = config.shortcuts.find((item: { name: string }) => item.name === 'Docs');
        const occupied = [
          ...config.appearance.widgetLayout.value.map((item: { position: object }) => item.position),
          ...config.shortcuts.filter((item: { position?: object }) => item.position).map((item: { position: object }) => item.position),
          ...config.groups.filter((item: { position?: object }) => item.position).map((item: { position: object }) => item.position),
        ] as Array<{ column: number; row: number; width: number; height: number }>;
        const candidates = Array.from({ length: 12 }, (_, rowOffset) => rowOffset).flatMap((rowOffset) =>
          Array.from({ length: 45 }, (_, column) => ({ column, row: Math.max(0, docs.position.row + rowOffset - 2), width: 4, height: 3, gridVersion: 3 })),
        );
        const position = candidates.find((candidate) => !occupied.some((item) =>
          candidate.column < item.column + item.width && candidate.column + candidate.width > item.column
          && candidate.row < item.row + item.height && candidate.row + candidate.height > item.row,
        ));
        if (!position) throw new Error('Could not find a nearby folder position');
        config.groups.push({ id: 'work', name: 'Work', collapsed: false, sortKey: 'z0', revision, position });
        store.put(config, 'current');
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await page.reload();
  const folder = page.locator('.desktopItem--folder').filter({ hasText: 'Work' });
  await expect(folder).toBeVisible();
  await folder.scrollIntoViewIfNeeded();
  const desktopShortcut = page.locator('.desktopItem--shortcut').filter({ hasText: 'Docs' });
  const folderSlot = await folder.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }));
  const desktopShortcutBox = await desktopShortcut.boundingBox();
  const folderBox = await folder.boundingBox();
  const shortcutIconBox = await desktopShortcut.locator('.desktopIcon').boundingBox();
  const folderPreviewBox = await folder.locator('.folderPreview').boundingBox();
  if (!desktopShortcutBox || !folderBox || !shortcutIconBox || !folderPreviewBox) throw new Error('Desktop folder drop was not measurable');
  const pointerStart = { x: desktopShortcutBox.x + desktopShortcutBox.width / 2, y: desktopShortcutBox.y + desktopShortcutBox.height / 2 };
  const shortcutIconCenter = { x: shortcutIconBox.x + shortcutIconBox.width / 2, y: shortcutIconBox.y + shortcutIconBox.height / 2 };
  await page.mouse.move(pointerStart.x, pointerStart.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(
    pointerStart.x + folderPreviewBox.x + 1 - shortcutIconCenter.x,
    pointerStart.y + folderPreviewBox.y + folderPreviewBox.height / 2 - shortcutIconCenter.y,
    { steps: 8 },
  );
  await page.waitForTimeout(450);
  await expect(folder).not.toHaveClass(/isFolderTarget/);
  await expect(page.locator('.dashboardBoard')).toHaveClass(/reflowPreview/);
  await expect.poll(() => folder.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }))).not.toEqual(folderSlot);
  await page.waitForTimeout(520);
  const shiftedFolderBox = await folder.boundingBox();
  if (!shiftedFolderBox) throw new Error('Displaced folder was not measurable');
  await page.mouse.move(
    shiftedFolderBox.x + shiftedFolderBox.width / 2,
    shiftedFolderBox.y + shiftedFolderBox.height / 2,
    { steps: 8 },
  );
  await expect(folder).toHaveClass(/isFolderTarget/);
  await expect.poll(() => folder.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }))).toEqual(folderSlot);
  await page.mouse.up();
  await expect(desktopShortcut).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<{ groupId?: string; hasPosition: boolean }>((resolve, reject) => {
      const request = database.transaction('config').objectStore('config').get('current');
      request.onsuccess = () => {
        const item = request.result.shortcuts.find((candidate: { name: string }) => candidate.name === 'Docs');
        resolve({ groupId: item.groupId, hasPosition: Object.hasOwn(item, 'position') });
      };
      request.onerror = () => reject(request.error);
    });
  })).toEqual({ groupId: 'work', hasPosition: false });
  await expect(folder.locator('.folderPreview')).toHaveCSS('border-radius', '25px');
  await expect(folder.locator('.folderPreview')).toHaveCSS('grid-template-rows', '18px 18px 18px');
  await expect(folder.locator('.folderPreview > span')).toHaveCSS('height', '18px');
  await folder.locator('.desktopFolder').click();
  const folderDialog = page.getByRole('dialog', { name: 'Work' });
  await expect(folderDialog.locator('.folderSurface')).toBeVisible();
  await expect(folderDialog.locator('.folderSurface')).not.toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(folderDialog.getByRole('button', { name: /Close|关闭/, exact: true })).toHaveCount(0);
  const folderMember = folderDialog.getByRole('link', { name: 'Docs' });
  await expect(folderMember).toBeVisible();
  await expect(folderDialog.locator('.folderItemActions')).toHaveCount(0);
  const memberBox = await folderMember.boundingBox();
  const surfaceBox = await folderDialog.locator('.folderSurface').boundingBox();
  if (!memberBox || !surfaceBox) throw new Error('Folder member was not measurable');
  await page.mouse.move(memberBox.x + memberBox.width / 2, memberBox.y + memberBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(surfaceBox.x + surfaceBox.width - 24, surfaceBox.y + surfaceBox.height - 24, { steps: 6 });
  await page.mouse.up();
  await expect(folderDialog.getByRole('link', { name: 'Docs' })).toBeVisible();
  await expect(page.locator('.desktopItem--shortcut').filter({ hasText: 'Docs' })).toHaveCount(0);

  const boardBox = await page.locator('.dashboardBoard').boundingBox();
  const refreshedMemberBox = await folderDialog.getByRole('link', { name: 'Docs' }).boundingBox();
  if (!boardBox || !refreshedMemberBox) throw new Error('Folder drag target was not measurable');
  await page.mouse.move(refreshedMemberBox.x + refreshedMemberBox.width / 2, refreshedMemberBox.y + refreshedMemberBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(boardBox.x + 24, boardBox.y + 24, { steps: 8 });
  await page.waitForTimeout(450);
  await page.mouse.up();
  await expect(page.locator('.desktopItem--shortcut').filter({ hasText: 'Docs' })).toBeVisible();
  await expect(folder.locator('.folderPreview.empty')).toBeEmpty();
});

test('converts an uploaded wallpaper to local WebP without putting it in Chrome Sync', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  const pngBase64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#336699';
    context.fillRect(0, 0, 4, 4);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: 'wallpaper.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngBase64, 'base64'),
  });

  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'assets']);
    const config = await new Promise<unknown>((resolve, reject) => {
      const request = transaction.objectStore('config').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }) as { appearance?: { wallpaper?: { value?: { type?: string } } } };
    const asset = await new Promise<unknown>((resolve, reject) => {
      const request = transaction.objectStore('assets').get('wallpaper/upload');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }) as { blob?: Blob } | undefined;
    return { wallpaperType: config.appearance?.wallpaper?.value?.type, blobType: asset?.blob?.type, errors: [...document.querySelectorAll('.errorText')].map((element) => element.textContent) };
  })).toEqual({ wallpaperType: 'upload', blobType: 'image/webp', errors: [] });

  await expect.poll(() => page.evaluate(() => {
    const preview = JSON.parse(localStorage.getItem('isu:wallpaper-bootstrap-preview') ?? 'null') as { identity?: string; background?: string } | null;
    return { identity: preview?.identity, isTinyWebp: preview?.background?.startsWith('data:image/webp;base64,') ?? false, bytes: preview?.background?.length ?? 0 };
  })).toEqual(expect.objectContaining({ identity: 'upload:wallpaper/upload', isTinyWebp: true }));
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('isu:wallpaper-bootstrap-preview')!).background.length)).toBeLessThan(64 * 1024);

  const remoteText = await page.evaluate(async () => JSON.stringify(await chrome.storage.sync.get(null)));
  expect(remoteText).not.toContain('wallpaper/upload');
});

test('keeps online random wallpaper images local while syncing its interval setting', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  await context.route('https://wallhaven.cc/api/v1/search**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: [{ id: 'random-e2e', url: 'https://wallhaven.cc/w/random-e2e', thumbs: { large: 'https://th.wallhaven.cc/lg/ra/random-e2e.jpg' }, path: 'https://w.wallhaven.cc/full/ra/wallhaven-random-e2e.jpg' }], meta: { current_page: 1, last_page: 1 } }),
  }));
  await context.route('https://w.wallhaven.cc/full/ra/wallhaven-random-e2e.jpg', (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JqJkAAAAASUVORK5CYII=', 'base64'),
  }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  await page.getByRole('button', { name: /Online random|在线随机/ }).click();
  const frequency = page.getByLabel(/Change frequency|切换频率/, { exact: true });
  await expect(frequency).toHaveValue('1d');
  await frequency.selectOption('5h');

  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'settings', 'assets']);
    const get = <T,>(store: string, key: string) => new Promise<T>((resolve, reject) => {
      const request = transaction.objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
    const [config, state, asset] = await Promise.all([
      get<{ appearance: { wallpaper: { value: { type: string; interval?: string } } } }>('config', 'current'),
      get<{ imageUrl?: string; interval?: string }>('settings', 'randomWallpaper'),
      get<{ blob?: Blob }>('assets', 'wallpaper/random-current'),
    ]);
    return { wallpaper: config.appearance.wallpaper.value, state, hasImage: asset?.blob instanceof Blob };
  })).toEqual({
    wallpaper: { type: 'wallhaven-random', interval: '5h' },
    state: expect.objectContaining({ imageUrl: 'https://w.wallhaven.cc/full/ra/wallhaven-random-e2e.jpg', interval: '5h' }),
    hasImage: true,
  });

  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<number>((resolve, reject) => {
      const request = database.transaction('outbox').objectStore('outbox').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }), { timeout: 12_000 }).toBe(0);
  const remote = await page.evaluate(async () => JSON.stringify(await chrome.storage.sync.get(null)));
  expect(remote).not.toContain('random-e2e.jpg');
});

test('keeps the final wallpaper selection when builtin choices change in sequence', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  const backdrop = page.locator('.wallpaperBackdrop');

  for (const [label, identity] of [
    [/Aurora|极光/, 'builtin:aurora'],
    [/Dusk|暮色/, 'builtin:dusk'],
    [/Ocean|海洋/, 'builtin:ocean'],
  ] as const) {
    await page.getByRole('button', { name: label }).click();
    await expect(backdrop).toHaveAttribute('data-wallpaper-incoming', identity);
    await expect.poll(() => backdrop.getAttribute('data-wallpaper-incoming'), { timeout: 3_000 }).toBeNull();
    await expect(backdrop).toHaveAttribute('data-wallpaper-current', identity);
    await expect(backdrop).not.toHaveAttribute('data-wallpaper-current', /fallback|pending/);
  }
});

test('restores the remembered custom solid color after selecting another wallpaper', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  await page.locator('.colorChoice input[type="color"]').evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '#4a7098');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<{ color: string; solidColor: string }>((resolve, reject) => {
      const request = database.transaction('config').objectStore('config').get('current');
      request.onsuccess = () => resolve({
        color: request.result.appearance.wallpaper.value.color,
        solidColor: request.result.appearance.solidColor.value,
      });
      request.onerror = () => reject(request.error);
    });
  })).toEqual({ color: '#4a7098', solidColor: '#4a7098' });

  await page.getByRole('button', { name: /Ocean|海洋/ }).click();
  await page.locator('.colorChoice').click({ position: { x: 20, y: 20 } });
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<unknown>((resolve, reject) => {
      const request = database.transaction('config').objectStore('config').get('current');
      request.onsuccess = () => resolve(request.result.appearance.wallpaper.value);
      request.onerror = () => reject(request.error);
    });
  })).toEqual({ type: 'solid', color: '#4a7098' });
});

test('dissolves the incoming wallpaper across the full viewport', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  const backdrop = page.locator('.wallpaperBackdrop');
  await page.getByRole('button', { name: /Dusk|暮色/ }).click();
  await expect.poll(() => backdrop.getAttribute('data-wallpaper-current'), { timeout: 3_000 }).toBe('builtin:dusk');
  await page.getByRole('button', { name: /Aurora|极光/ }).click();

  await expect(backdrop).toHaveAttribute('data-wallpaper-incoming', 'builtin:aurora');
  await page.waitForTimeout(80);
  const opacities = await backdrop.evaluate((element) => {
    const previous = element.querySelector<HTMLElement>('.wallpaperLayer--frozen');
    const incoming = element.querySelector<HTMLElement>('.wallpaperLayer--current');
    return {
      previous: previous ? Number.parseFloat(getComputedStyle(previous).opacity) : undefined,
      incoming: incoming ? Number.parseFloat(getComputedStyle(incoming).opacity) : undefined,
      maskImage: incoming ? getComputedStyle(incoming).getPropertyValue('mask-image') : undefined,
      animationName: incoming ? getComputedStyle(incoming).animationName : undefined,
    };
  });
  expect(opacities.previous).toBe(1);
  expect(opacities.incoming).toBeGreaterThan(0);
  expect(opacities.incoming).toBeLessThan(1);
  expect(opacities.maskImage).toBe('none');
  expect(opacities.animationName).toBe('wallpaper-dissolve');
});

test('keeps the visible composition and restarts the full dissolve for rapid wallpaper changes', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  const backdrop = page.locator('.wallpaperBackdrop');

  await page.getByRole('button', { name: /Dusk|暮色/ }).click();
  await expect(backdrop).toHaveAttribute('data-wallpaper-incoming', 'builtin:dusk');
  await expect.poll(() => backdrop.getAttribute('data-wallpaper-incoming'), { timeout: 3_000 }).toBeNull();
  await page.getByRole('button', { name: /Aurora|极光/ }).click();
  await expect(backdrop).toHaveAttribute('data-wallpaper-incoming', 'builtin:aurora');
  await page.waitForTimeout(500);

  await page.getByRole('button', { name: /Ocean|海洋/ }).click();
  await expect(backdrop).toHaveAttribute('data-wallpaper-incoming', 'builtin:ocean');
  const interrupted = await backdrop.evaluate((element) => {
    const aurora = element.querySelector<HTMLElement>('[data-wallpaper-layer="builtin:aurora"]');
    const ocean = element.querySelector<HTMLElement>('[data-wallpaper-layer="builtin:ocean"]');
    return {
      auroraOpacity: aurora ? Number.parseFloat(getComputedStyle(aurora).opacity) : undefined,
      oceanOpacity: ocean ? Number.parseFloat(getComputedStyle(ocean).opacity) : undefined,
      oceanAnimation: ocean ? getComputedStyle(ocean).animationName : undefined,
      layers: element.querySelectorAll('.wallpaperLayer').length,
    };
  });
  expect(interrupted.auroraOpacity).toBeGreaterThan(0);
  expect(interrupted.auroraOpacity).toBeLessThan(1);
  expect(interrupted.oceanOpacity).toBeLessThan(0.1);
  expect(interrupted.oceanAnimation).toBe('wallpaper-dissolve');
  expect(interrupted.layers).toBe(3);

  await page.waitForTimeout(120);
  const oceanOpacity = await page.locator('[data-wallpaper-layer="builtin:ocean"]').evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity));
  expect(oceanOpacity).toBeGreaterThan(0);
  expect(oceanOpacity).toBeLessThan(1);
  await expect.poll(() => backdrop.getAttribute('data-wallpaper-incoming'), { timeout: 3_000 }).toBeNull();
  await expect(backdrop).toHaveAttribute('data-wallpaper-current', 'builtin:ocean');
  await expect(backdrop.locator('.wallpaperLayer')).toHaveCount(1);
});

test('paints the saved wallpaper preview before application hydration', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.addInitScript(() => {
    localStorage.setItem('isu:wallpaper-bootstrap-preview', JSON.stringify({ identity: 'test:preview', background: '#123456' }));
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-wallpaper-bootstrap', '#123456');
  await expect(page.locator('script[src="/wallpaper-bootstrap.js"]')).toHaveCount(1);
});

test('switches between Chrome Sync and local mode through the background coordinator', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  const mode = page.getByLabel(/Sync|同步/);
  await mode.selectOption('local');
  await expect.poll(() => readSetting(page, 'syncMode')).toBe('local');
  await mode.selectOption('chrome');
  await expect.poll(() => readSetting(page, 'syncMode')).toBe('chrome');
});

test('keeps logical widget footprints stable across content and viewport changes', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const longQuote = 'Curiosity gives us the courage to question familiar answers, examine every assumption, listen carefully, and keep learning when a simple explanation would be easier. Thoughtful work grows through patience and honest observation—what already appears complete.';
  const page = await context.newPage();
  await page.route('https://zenquotes.io/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ q: longQuote, a: 'E2E' }]) }));
  await page.route('https://v1.hitokoto.cn/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ uuid: 'long-e2e', hitokoto: longQuote, from: 'E2E', from_who: null }) }));
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  const quote = page.locator('.dailyQuote blockquote');
  await expect(quote).toContainText('Curiosity');
  await expect(quote).toContainText('what already appears complete.');
  await expect(quote).toHaveCSS('white-space', 'normal');
  await expect(quote).toHaveCSS('text-overflow', 'clip');
  await expect(quote).toHaveCSS('overflow', 'visible');
  const quoteWidget = page.locator('[data-widget-id="dailyQuote"]');
  await expect.poll(() => quoteWidget.evaluate((element) => Number(/span (\d+)/.exec((element as HTMLElement).style.gridRow)?.[1] ?? 0))).toBe(2);
  const quoteCoverage = await quoteWidget.evaluate((element) => {
    const section = element.getBoundingClientRect();
    const content = element.firstElementChild!.getBoundingClientRect();
    return {
      horizontal: section.left <= content.left + .5 && section.right >= content.right - .5,
      vertical: section.top <= content.top + .5 && section.bottom >= content.bottom - .5,
    };
  });
  expect(quoteCoverage).toEqual({ horizontal: true, vertical: true });
  const collisionGrid = await page.locator('.dashboardBoard').evaluate((board) => {
    const boardRect = board.getBoundingClientRect();
    const columnWidth = boardRect.width / 48;
    return [...board.querySelectorAll<HTMLElement>('.dashboardWidget')].map((section) => {
      const rect = section.getBoundingClientRect();
      const content = section.firstElementChild?.getBoundingClientRect();
      const columnSpan = Number(/span (\d+)/.exec(section.style.gridColumn)?.[1] ?? 1);
      const rowSpan = Number(/span (\d+)/.exec(section.style.gridRow)?.[1] ?? 1);
      return {
        key: section.dataset.desktopKey,
        widthDifference: Math.abs(rect.width - columnWidth * columnSpan),
        heightDifference: Math.abs(rect.height - 40 * rowSpan),
        centerDelta: content ? Math.max(Math.abs((rect.left + rect.right) / 2 - (content.left + content.right) / 2), Math.abs((rect.top + rect.bottom) / 2 - (content.top + content.bottom) / 2)) : 0,
        columnWidth,
      };
    });
  });
  expect(collisionGrid).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'widget:greeting' }),
    expect.objectContaining({ key: 'widget:dailyQuote' }),
  ]));
  for (const item of collisionGrid) {
    expect(item.widthDifference, `${item.key} piece width must follow grid`).toBeLessThan(1);
    expect(item.heightDifference, `${item.key} piece height must follow grid`).toBeLessThan(1);
    expect(item.centerDelta, `${item.key} content must remain centered`).toBeLessThan(1);
  }
  const overlaps = await page.locator('.dashboardWidget').evaluateAll((elements) => elements.flatMap((element, index) => {
    const left = element.getBoundingClientRect();
    return elements.slice(index + 1).filter((candidate) => {
      const right = candidate.getBoundingClientRect();
      return left.left < right.right - .5 && left.right > right.left + .5 && left.top < right.bottom - .5 && left.bottom > right.top + .5;
    }).map((candidate) => `${(element as HTMLElement).dataset.desktopKey}|${(candidate as HTMLElement).dataset.desktopKey}`);
  }));
  expect(overlaps).toEqual([]);

  const noteCell = page.locator('[data-widget-id="quickNote"]');
  await setQuickNotePreset(page, 'small');
  await expect.poll(() => gridSpan(noteCell, 'gridColumn')).toBe(16);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(() => gridSpan(noteCell, 'gridColumn')).toBe(16);
  await expect.poll(() => readWidgetSizePreset(page, 'quickNote')).toBe('small');

  const widths: number[] = [];
  for (const [preset, expectedSpan] of [['small', 16], ['medium', 28], ['large', 36]] as const) {
    await setQuickNotePreset(page, preset);
    await expect.poll(() => gridSpan(noteCell, 'gridColumn')).toBe(expectedSpan);
    widths.push((await noteCell.boundingBox())!.width);
  }
  expect(widths[1]!).toBeGreaterThan(widths[0]! + 300);
  expect(widths[2]!).toBeGreaterThan(widths[1]! + 200);
});

test('keeps the add tile fixed when a quote is moved around the clock', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('config', 'readwrite');
      const store = transaction.objectStore('config');
      const request = store.get('current');
      request.onsuccess = () => {
        const config = request.result;
        const setPosition = (id: string, position: { column: number; row: number; width: number; height: number }) => {
          const item = config.appearance.widgetLayout.value.find((candidate: { id: string }) => candidate.id === id);
          item.position = { ...position, gridVersion: 3 };
        };
        setPosition('dailyQuote', { column: 16, row: 8, width: 16, height: 2 });
        setPosition('clock', { column: 19, row: 0, width: 10, height: 4 });
        setPosition('addShortcut', { column: 34, row: 0, width: 4, height: 3 });
        store.put(config, 'current');
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await page.reload();
  const quote = page.locator('[data-widget-id="dailyQuote"]');
  const clock = page.locator('[data-widget-id="clock"]');
  const addTile = page.locator('[data-desktop-key="add-shortcut"]');
  const quoteBox = await quote.boundingBox();
  const clockBox = await clock.boundingBox();
  if (!quoteBox || !clockBox) throw new Error('Quote and clock were not measurable');
  const addSlot = await addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }));
  await page.mouse.move(quoteBox.x + quoteBox.width / 2, quoteBox.y + quoteBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(clockBox.x + clockBox.width / 2, clockBox.y + clockBox.height / 2, { steps: 8 });
  await page.waitForTimeout(500);
  await expect(page.locator('.dashboardWidget').first()).toHaveCSS('outline-style', 'none');
  await page.mouse.up();
  await expect.poll(() => addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }))).toEqual(addSlot);
  await expect(page.locator('.dashboardWidget[data-layout-motion]')).toHaveCount(0);
  const overlaps = await page.locator('.dashboardWidget').evaluateAll((elements) => elements.flatMap((element, index) => {
    const left = element.getBoundingClientRect();
    return elements.slice(index + 1).filter((candidate) => {
      const right = candidate.getBoundingClientRect();
      return left.left < right.right - .5 && left.right > right.left + .5 && left.top < right.bottom - .5 && left.bottom > right.top + .5;
    }).map((candidate) => `${(element as HTMLElement).dataset.desktopKey}|${(candidate as HTMLElement).dataset.desktopKey}`);
  }));
  expect(overlaps).toEqual([]);
  await page.reload();
  await expect(addTile).toHaveCSS('grid-column', addSlot.column);
  await expect(addTile).toHaveCSS('grid-row', addSlot.row);
});

test('waits for actual collision boxes before displacing a neighboring widget', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 667, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  const greeting = page.locator('[data-widget-id="greeting"]');
  const box = await greeting.boundingBox();
  if (!box) throw new Error('Greeting was not measurable');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 15, { steps: 6 });
  await page.waitForTimeout(500);
  await expect(page.locator('.dashboardBoard')).not.toHaveClass(/reflowPreview/);
  await expect(page.locator('.dashboardWidget.isDisplaced')).toHaveCount(0);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 70, { steps: 6 });
  await page.waitForTimeout(500);
  await expect(page.locator('.dashboardBoard')).toHaveClass(/reflowPreview/);
  await expect(page.locator('.dashboardWidget.isDisplaced')).toHaveCount(1);
  await page.mouse.up();
});

test('hides, drags, and persists dashboard components on the board', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  const searchComponent = page.getByRole('checkbox', { name: /Search|搜索/, exact: true });
  await searchComponent.uncheck();
  await page.getByRole('button', { name: /Close|关闭/ }).click();
  await expect(page.getByRole('textbox', { name: /Search the web|搜索互联网/, exact: true })).toHaveCount(0);
  const board = await page.locator('.dashboardBoard').boundingBox();
  const greeting = await page.locator('[data-widget-id="greeting"]').boundingBox();
  if (!board || !greeting) throw new Error('Dashboard board was not measurable');
  const initialGreetingColumn = await page.locator('[data-widget-id="greeting"]').evaluate((element) => Number(getComputedStyle(element).gridColumnStart) - 1);
  await page.mouse.move(greeting.x + greeting.width / 2, greeting.y + greeting.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(greeting.x + greeting.width / 2 - board.width / 6, greeting.y + greeting.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[data-widget-id="greeting"]')).not.toHaveAttribute('data-layout-motion', 'damped-quartic');
  await expect.poll(() => page.locator('[data-widget-id="greeting"]').evaluate((element) => (element as HTMLElement).style.translate)).toBe('');
  await expect.poll(() => page.locator('[data-widget-id="greeting"]').evaluate((element) => Number(getComputedStyle(element).gridColumnStart) - 1)).toBeLessThan(initialGreetingColumn);
  const movedGreetingColumn = await page.locator('[data-widget-id="greeting"]').evaluate((element) => Number(getComputedStyle(element).gridColumnStart) - 1);
  await expect.poll(() => readWidgetColumn(page, 'greeting')).toBe(movedGreetingColumn);

  await page.reload();
  await expect(page.getByRole('textbox', { name: /Search the web|搜索互联网/, exact: true })).toHaveCount(0);
  await expect(page.locator('[data-widget-id="search"]')).toHaveCount(0);
  const greetingWidget = page.locator('[data-widget-id="greeting"]');
  await expect(greetingWidget).toHaveCSS('grid-column-start', String(movedGreetingColumn + 1));
  expect(await greetingWidget.evaluate((element) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(false);
  await expect(page.locator('.desktopContextMenu')).toHaveCount(0);
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  await page.getByRole('button', { name: /Restore default|恢复默认/, exact: true }).click();
  await page.getByRole('button', { name: /Close|关闭/ }).click();
  await expect.poll(() => greetingWidget.evaluate((element) => {
    const boardRect = element.parentElement!.getBoundingClientRect();
    const widgetRect = element.getBoundingClientRect();
    const contentRect = element.firstElementChild!.getBoundingClientRect();
    return Math.max(
      Math.abs((contentRect.left + contentRect.width / 2) - (boardRect.left + boardRect.width / 2)),
      Math.abs((contentRect.left + contentRect.width / 2) - (widgetRect.left + widgetRect.width / 2)),
    );
  })).toBeLessThan(1);
  await expect.poll(() => readWidgetColumn(page, 'greeting')).toBe(20);
  await page.reload();
  const centeredGreeting = page.locator('[data-widget-id="greeting"]');
  await expect.poll(() => centeredGreeting.evaluate((element) => {
    const boardRect = element.parentElement!.getBoundingClientRect();
    const widgetRect = element.getBoundingClientRect();
    const contentRect = element.firstElementChild!.getBoundingClientRect();
    return Math.max(
      Math.abs((contentRect.left + contentRect.width / 2) - (boardRect.left + boardRect.width / 2)),
      Math.abs((contentRect.left + contentRect.width / 2) - (widgetRect.left + widgetRect.width / 2)),
    );
  })).toBeLessThan(1);
  const greetingContent = centeredGreeting.locator('.greeting');
  await expect(greetingContent).toHaveCSS('white-space', 'nowrap');
  expect(await greetingContent.evaluate((element) => element.getClientRects().length)).toBe(1);
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  await page.getByRole('checkbox', { name: /Search|搜索/, exact: true }).check();
  await page.getByRole('button', { name: /Restore default|恢复默认/, exact: true }).click();
  await page.getByRole('button', { name: /Close|关闭/ }).click();
  await expect(page.locator('[data-widget-id="search"]')).toHaveCSS('grid-column-start', '13');
  for (const widgetId of ['clock', 'greeting', 'focusTimer', 'search', 'quickNote', 'dailyQuote']) {
    await expect.poll(() => page.locator(`[data-widget-id="${widgetId}"]`).evaluate((element) => {
      const board = element.parentElement!.getBoundingClientRect();
      const content = element.firstElementChild!.getBoundingClientRect();
      return Math.abs((content.left + content.width / 2) - (board.left + board.width / 2));
    })).toBeLessThan(1);
  }
  for (const [widgetId, contentSelector] of [['focusTimer', '.focusTimer'], ['search', '.search']] as const) {
    const centers = await page.locator(`[data-widget-id="${widgetId}"]`).evaluate((element, selector) => {
      const outer = element.getBoundingClientRect();
      const inner = element.querySelector(selector)!.getBoundingClientRect();
      return { outer: outer.left + outer.width / 2, inner: inner.left + inner.width / 2 };
    }, contentSelector);
    expect(Math.abs(centers.outer - centers.inner)).toBeLessThan(1);
  }
  const measuredFootprints = await page.locator('[data-widget-id]').evaluateAll((elements) => {
    const boardWidth = document.querySelector('.dashboardBoard')!.getBoundingClientRect().width;
    return elements.map((element) => {
      const section = element.getBoundingClientRect();
      const content = element.firstElementChild!.getBoundingClientRect();
      const columnSpan = Number(/span (\d+)/.exec((element as HTMLElement).style.gridColumn)?.[1] ?? 1);
      const rowSpan = Number(/span (\d+)/.exec((element as HTMLElement).style.gridRow)?.[1] ?? 1);
      return {
        id: (element as HTMLElement).dataset.widgetId,
        difference: section.width - (boardWidth / 48) * columnSpan,
        heightDifference: section.height - 40 * rowSpan,
        centerDifference: Math.abs(section.left + section.width / 2 - content.left - content.width / 2),
        columnWidth: boardWidth / 48,
      };
    });
  });
  for (const footprint of measuredFootprints) {
    expect(footprint.difference, `${footprint.id} footprint must cover its content`).toBeGreaterThanOrEqual(-0.5);
    expect(footprint.centerDifference, `${footprint.id} content must be visually centered`).toBeLessThan(1);
    expect(footprint.heightDifference, `${footprint.id} section must remain intrinsic`).toBeLessThan(1);
  }
  const centeredBox = await centeredGreeting.boundingBox();
  if (!centeredBox) throw new Error('Centered greeting was not measurable');
  const originalGreetingRow = await centeredGreeting.evaluate((element) => getComputedStyle(element).gridRowStart);
  const originalFocusRow = await page.locator('[data-widget-id="focusTimer"]').evaluate((element) => getComputedStyle(element).gridRowStart);
  await page.mouse.move(centeredBox.x + centeredBox.width / 2, centeredBox.y + centeredBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(centeredBox.x + centeredBox.width / 2, centeredBox.y + centeredBox.height / 2 + 80, { steps: 6 });
  await page.waitForTimeout(450);
  await expect(page.locator('.dashboardBoard')).toHaveClass(/reflowPreview/);
  await expect(centeredGreeting).toHaveCSS('grid-row-start', originalGreetingRow);
  const displacedWidget = page.locator('.dashboardWidget.isDisplaced').first();
  await expect(displacedWidget).toBeVisible();
  const displacedKey = await displacedWidget.getAttribute('data-desktop-key');
  if (!displacedKey) throw new Error('Displaced widget had no stable desktop key');
  const animatedWidget = page.locator(`[data-desktop-key="${displacedKey}"]`);
  await expect(animatedWidget).toHaveAttribute('data-layout-motion', 'damped-quartic');
  await page.mouse.move(centeredBox.x + centeredBox.width / 2, centeredBox.y + centeredBox.height / 2, { steps: 6 });
  await expect(centeredGreeting).toHaveCSS('grid-row-start', originalGreetingRow);
  await expect(animatedWidget).not.toHaveClass(/isDisplaced/);
  await expect(animatedWidget).toHaveAttribute('data-layout-motion', 'damped-quartic');
  await page.mouse.up();
  await expect(page.locator('.dashboardBoard')).not.toHaveClass(/reflowPreview/);
  await expect(centeredGreeting).toHaveCSS('grid-row-start', originalGreetingRow);
  await expect(page.locator('[data-widget-id="focusTimer"]')).toHaveCSS('grid-row-start', originalFocusRow);
  const committedRows = await page.locator('[data-widget-id]').evaluateAll((elements) => Object.fromEntries(elements.map((element) => [element.getAttribute('data-widget-id'), getComputedStyle(element).gridRowStart])));
  const committedGreetingRow = Number(committedRows.greeting) - 1;
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<number>((resolve, reject) => {
      const request = database.transaction('config').objectStore('config').get('current');
      request.onsuccess = () => resolve(request.result.appearance.widgetLayout.value.find((item: { id: string }) => item.id === 'greeting').position.row);
      request.onerror = () => reject(request.error);
    });
  })).toBe(committedGreetingRow);
  await page.reload();
  await expect.poll(() => page.locator('[data-widget-id]').evaluateAll((elements) => Object.fromEntries(elements.map((element) => [element.getAttribute('data-widget-id'), getComputedStyle(element).gridRowStart])))).toEqual(committedRows);
});

test('customizes the search box and shows local history and online suggestions', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await context.route('https://suggestqueries.google.com/**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(['codex live', ['codex live search', 'codex live extension']]),
  }));
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);

  await page.getByRole('button', { name: /Settings|设置/ }).click();
  await page.waitForTimeout(300);
  const settingsDrawer = page.getByRole('dialog', { name: /Settings|设置/ });
  const drawerBox = await settingsDrawer.boundingBox();
  await expect(page.locator('.modalBackdrop--drawer')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(settingsDrawer).toHaveCSS('background-color', 'rgb(248, 250, 253)');
  await expect(settingsDrawer).toHaveCSS('color', 'rgb(32, 33, 36)');
  await expect(settingsDrawer.locator('.settings > section').first()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(settingsDrawer.locator('.settings > section').first()).toHaveCSS('border-radius', '16px');
  await expect(page.getByLabel(/Theme|主题/, { exact: true })).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const historyToggle = page.getByRole('checkbox', { name: /Save search history|记录搜索历史/ });
  await expect(historyToggle).toHaveCSS('appearance', 'none');
  await expect(historyToggle).toHaveCSS('background-color', 'rgb(26, 115, 232)');
  const viewport = page.viewportSize();
  if (!drawerBox || !viewport) throw new Error('Settings drawer was not measurable');
  expect(Math.abs(drawerBox.x + drawerBox.width - viewport.width)).toBeLessThan(1);
  expect(drawerBox.y).toBe(0);
  expect(Math.abs(drawerBox.height - viewport.height)).toBeLessThan(1);
  expect(drawerBox.width).toBeLessThanOrEqual(480);
  const blur = page.getByLabel(/Blur|模糊强度/, { exact: true });
  const width = page.getByLabel(/Width|宽度/, { exact: true });
  const background = page.getByLabel(/White background intensity|背景白色强度/, { exact: true });
  await expect(page.getByRole('button', { name: /Local history|本地历史/, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Authorize and enable Chrome history|授权并启用 Chrome 历史/, exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Restore default|恢复默认/, exact: true })).toHaveCSS('white-space', 'nowrap');
  await expect(page.getByRole('button', { name: /Export backup|导出备份/, exact: true })).toHaveCSS('white-space', 'nowrap');
  await expect(page.getByRole('button', { name: /Import backup|导入备份/, exact: true })).toHaveCSS('white-space', 'nowrap');
  const solidChoice = page.locator('.colorChoice');
  const colorClickCount = await solidChoice.evaluate((element) => {
    const input = element.querySelector('input')!;
    let clicks = 0;
    input.addEventListener('click', () => { clicks += 1; });
    (element.querySelector('span') as HTMLElement).click();
    return clicks;
  });
  expect(colorClickCount).toBe(0);
  const presetButtons = [
    page.getByRole('button', { name: /Aurora|极光/, exact: true }),
    page.getByRole('button', { name: /Dusk|暮色/, exact: true }),
    page.getByRole('button', { name: /Ocean|海洋/, exact: true }),
  ];
  const presetBackgrounds = await Promise.all(presetButtons.map((button) => button.evaluate((element) => getComputedStyle(element).backgroundImage)));
  expect(new Set(presetBackgrounds).size).toBe(3);
  for (const preset of presetButtons) {
    await preset.hover();
    await expect(preset).not.toHaveCSS('background-color', 'rgb(248, 250, 253)');
    await expect(preset).toHaveCSS('background-image', /gradient/);
  }
  await presetButtons[1]!.click();
  await expect(solidChoice).not.toHaveClass(/active/);
  await solidChoice.locator('span').click();
  await expect(solidChoice).toHaveClass(/active/);
  const solidWallpaper = page.locator('.colorChoice input[type="color"]');
  await solidWallpaper.evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '#ffffff');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.app')).toHaveAttribute('data-wallpaper-tone', 'light');
  await expect(page.locator('.heroTime')).toHaveCSS('color', 'rgb(23, 32, 51)');
  await blur.evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '0');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await width.evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '100');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await background.evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '100');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(blur).toHaveValue('0');
  await expect(page.locator('.app')).toHaveCSS('--blur', '0px');
  await expect(blur).toHaveCSS('--range-progress', '0%');
  await expect(width).toHaveValue('100');
  await expect(width).toHaveCSS('--range-progress', '100%');
  await expect(background).toHaveValue('100');
  await expect(background).toHaveCSS('--range-progress', '100%');
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<{ blur: number; widthPercent: number; backgroundOpacity: number }>((resolve, reject) => {
      const request = database.transaction('config').objectStore('config').get('current');
      request.onsuccess = () => {
        const value = request.result.appearance.search.value;
        resolve({ blur: request.result.appearance.blur.value, widthPercent: value.widthPercent, backgroundOpacity: value.backgroundOpacity });
      };
      request.onerror = () => reject(request.error);
    });
  })).toEqual({ blur: 0, widthPercent: 100, backgroundOpacity: 100 });
  await background.evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '40');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(background).toHaveValue('40');
  await page.getByRole('button', { name: /Close|关闭/ }).click();

  const shell = page.locator('.searchWidgetShell');
  await expect(shell).toHaveCSS('--search-width', '80vw');
  const shellBox = await shell.boundingBox();
  if (!shellBox) throw new Error('Search box was not measurable');
  expect(Math.abs(shellBox.width - viewport.width * .8)).toBeLessThan(1);
  const searchForm = page.locator('form.search');
  const searchInput = page.getByRole('textbox', { name: /Search the web|搜索互联网/, exact: true });
  const searchSubmit = searchForm.locator('.searchSubmit');
  await expect(shell).toHaveCSS('--search-background-alpha', '0.4');
  await expect(searchForm).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.4)');
  await expect(searchInput).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(searchInput).toHaveCSS('border-top-width', '0px');
  await expect(searchInput).toHaveCSS('box-shadow', 'none');
  const inputBox = await searchInput.boundingBox();
  const submitBox = await searchSubmit.boundingBox();
  if (!inputBox || !submitBox) throw new Error('Search controls were not measurable');
  expect(submitBox.x).toBeLessThan(inputBox.x);
  await searchInput.fill('你好');
  await searchForm.locator('.searchClear').click();
  await expect(searchInput).toHaveValue('');
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('settings', 'readwrite');
      transaction.objectStore('settings').put([{ query: 'local history phrase', searchedAt: new Date().toISOString() }], 'searchHistory');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });

  const input = searchInput;
  await input.evaluate((element: HTMLInputElement) => element.blur());
  await input.focus();
  await expect(page.getByRole('option').filter({ hasText: 'local history phrase' })).toBeVisible();
  const suggestionList = page.getByRole('listbox');
  const searchFormBox = await searchForm.boundingBox();
  const suggestionBox = await suggestionList.boundingBox();
  if (!searchFormBox || !suggestionBox) throw new Error('Search suggestion geometry was not measurable');
  expect(suggestionBox.y).toBeGreaterThanOrEqual(searchFormBox.y + searchFormBox.height - 1.5);
  expect(Math.abs(suggestionBox.x - searchFormBox.x)).toBeLessThan(1);
  expect(Math.abs(suggestionBox.width - searchFormBox.width)).toBeLessThan(1);
  const searchSurfaceColors = await page.evaluate(() => ({
    search: getComputedStyle(document.querySelector('form.search')!).backgroundColor,
    suggestions: getComputedStyle(document.querySelector('.searchSuggestions')!).backgroundColor,
  }));
  expect(searchSurfaceColors.suggestions).toBe(searchSurfaceColors.search);
  await input.fill('codex live');
  await expect(input).toHaveValue('codex live');
  await expect(page.getByRole('option').filter({ hasText: 'codex live search' })).toBeVisible();

  await page.getByRole('button', { name: /Settings|设置/ }).click();
  await page.getByRole('button', { name: /Clear search history|清除搜索历史/ }).click();
  await expect(page.getByText(/Cleared|已清除/, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Close|关闭/ }).click();
  await input.fill('');
  await input.focus();
  await expect(page.getByRole('option').filter({ hasText: 'local history phrase' })).toHaveCount(0);
  await context.unroute('https://suggestqueries.google.com/**');
});

async function readSetting(page: import('@playwright/test').Page, key: string): Promise<unknown> {
  return page.evaluate(async (settingKey) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<unknown>((resolve, reject) => {
      const request = database.transaction('settings').objectStore('settings').get(settingKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }, key);
}

async function readWidgetColumn(page: import('@playwright/test').Page, widgetId: string): Promise<number | undefined> {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<number | undefined>((resolve, reject) => {
      const request = database.transaction('config').objectStore('config').get('current');
      request.onsuccess = () => resolve(request.result.appearance.widgetLayout.value.find((item: { id: string }) => item.id === id)?.position?.column);
      request.onerror = () => reject(request.error);
    });
  }, widgetId);
}

async function setQuickNotePreset(page: import('@playwright/test').Page, preset: 'small' | 'medium' | 'large'): Promise<void> {
  await page.evaluate(async (nextPreset) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('config', 'readwrite');
      const store = transaction.objectStore('config');
      const request = store.get('current');
      request.onsuccess = () => {
        const config = request.result;
        const item = config.appearance.widgetLayout.value.find((candidate: { id: string }) => candidate.id === 'quickNote');
        item.sizePreset = nextPreset;
        store.put(config, 'current');
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }, preset);
  await page.reload();
}

async function readWidgetSizePreset(page: import('@playwright/test').Page, widgetId: string): Promise<string | undefined> {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<string | undefined>((resolve, reject) => {
      const request = database.transaction('config').objectStore('config').get('current');
      request.onsuccess = () => resolve(request.result.appearance.widgetLayout.value.find((item: { id: string }) => item.id === id)?.sizePreset);
      request.onerror = () => reject(request.error);
    });
  }, widgetId);
}

async function gridSpan(locator: import('@playwright/test').Locator, property: 'gridColumn' | 'gridRow'): Promise<number> {
  return locator.evaluate((element, name) => Number(/span (\d+)/.exec((element as HTMLElement).style[name])?.[1] ?? 0), property);
}
