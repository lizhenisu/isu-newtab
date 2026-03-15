import { expect, test, chromium, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILTIN_WALLPAPERS } from '../../core/wallpaper/builtin';

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

async function setWidgetVisibility(page: Page, id: string, enabled: boolean): Promise<void> {
  await page.evaluate(async ({ id, enabled }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'pieces'], 'readwrite');
    const configStore = transaction.objectStore('config');
    const pieceStore = transaction.objectStore('pieces');
    const configRequest = configStore.get('current');
    const pieceRequest = pieceStore.get(id === 'addShortcut' ? 'piece:add-shortcut' : `piece:widget:${id}`);
    const [config, piece] = await Promise.all([
      new Promise<any>((resolve, reject) => { configRequest.onsuccess = () => resolve(configRequest.result); configRequest.onerror = () => reject(configRequest.error); }),
      new Promise<any>((resolve, reject) => { pieceRequest.onsuccess = () => resolve(pieceRequest.result); pieceRequest.onerror = () => reject(pieceRequest.error); }),
    ]);
    config.appearance.widgetLayout.value.find((item: { id: string }) => item.id === id).enabled = enabled;
    piece.container = { kind: enabled ? 'desktop' : 'hidden' };
    configStore.put(config, 'current');
    pieceStore.put(piece);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }, { id, enabled });
  await page.reload();
}

async function setWidgetsVisibility(page: Page, ids: string[], enabled = true): Promise<void> {
  await page.evaluate(async ({ ids, enabled }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'pieces'], 'readwrite');
    const configStore = transaction.objectStore('config');
    const pieceStore = transaction.objectStore('pieces');
    const configRequest = configStore.get('current');
    const piecesRequest = pieceStore.getAll();
    const [config, pieces] = await Promise.all([
      new Promise<any>((resolve, reject) => { configRequest.onsuccess = () => resolve(configRequest.result); configRequest.onerror = () => reject(configRequest.error); }),
      new Promise<any[]>((resolve, reject) => { piecesRequest.onsuccess = () => resolve(piecesRequest.result); piecesRequest.onerror = () => reject(piecesRequest.error); }),
    ]);
    for (const id of ids) {
      config.appearance.widgetLayout.value.find((item: { id: string }) => item.id === id).enabled = enabled;
      const piece = pieces.find((item) => item.id === (id === 'addShortcut' ? 'piece:add-shortcut' : `piece:widget:${id}`));
      if (piece) piece.container = { kind: enabled ? 'desktop' : 'hidden' };
    }
    configStore.put(config, 'current');
    for (const piece of pieces) pieceStore.put(piece);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }, { ids, enabled });
  await page.reload();
}

async function offsetWidgetRow(page: Page, id: string, rows: number): Promise<void> {
  await page.evaluate(async ({ id, rows }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'pieces'], 'readwrite');
    const configStore = transaction.objectStore('config');
    const pieceStore = transaction.objectStore('pieces');
    const configRequest = configStore.get('current');
    const pieceRequest = pieceStore.get(`piece:widget:${id}`);
    const [config, piece] = await Promise.all([
      new Promise<any>((resolve, reject) => { configRequest.onsuccess = () => resolve(configRequest.result); configRequest.onerror = () => reject(configRequest.error); }),
      new Promise<any>((resolve, reject) => { pieceRequest.onsuccess = () => resolve(pieceRequest.result); pieceRequest.onerror = () => reject(pieceRequest.error); }),
    ]);
    const layout = config.appearance.widgetLayout.value.find((item: { id: string }) => item.id === id);
    layout.position.row += rows;
    piece.position.y += rows;
    configStore.put(config, 'current');
    pieceStore.put(piece);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }, { id, rows });
  await page.reload();
}

async function expectFilledWallpaperPreview(button: Locator): Promise<void> {
  await expect(button).toHaveCSS('padding-top', '0px');
  await expect(button).toHaveCSS('padding-right', '0px');
  const geometry = await button.evaluate((element) => {
    const buttonRect = element.getBoundingClientRect();
    const imageRect = element.querySelector('img')!.getBoundingClientRect();
    return { buttonWidth: buttonRect.width, buttonHeight: buttonRect.height, imageWidth: imageRect.width, imageHeight: imageRect.height };
  });
  expect(geometry.imageWidth).toBeCloseTo(geometry.buttonWidth, 1);
  expect(geometry.imageHeight).toBeCloseTo(geometry.buttonHeight, 1);
}

async function expectStableLiquidGlassHover(page: Page, surface: Locator): Promise<void> {
  const before = await surface.evaluate((element) => {
    const pseudo = getComputedStyle(element, '::before');
    return {
      layout: {
        left: (element as HTMLElement).offsetLeft,
        top: (element as HTMLElement).offsetTop,
        width: (element as HTMLElement).offsetWidth,
        height: (element as HTMLElement).offsetHeight,
      },
      transform: pseudo.transform,
      backgroundPosition: pseudo.backgroundPosition,
      transition: pseudo.transitionProperty,
    };
  });
  expect(before.transform).toBe('none');
  expect(before.transition).toContain('background-position');

  await surface.hover();
  await page.waitForTimeout(350);
  const after = await surface.evaluate((element) => {
    const pseudo = getComputedStyle(element, '::before');
    return {
      layout: {
        left: (element as HTMLElement).offsetLeft,
        top: (element as HTMLElement).offsetTop,
        width: (element as HTMLElement).offsetWidth,
        height: (element as HTMLElement).offsetHeight,
      },
      transform: pseudo.transform,
      backgroundPosition: pseudo.backgroundPosition,
    };
  });
  expect(after.layout).toEqual(before.layout);
  expect(after.transform).toBe('none');
  expect(after.backgroundPosition).not.toBe(before.backgroundPosition);
}

async function expectLiquidGlassForeground(surface: Locator): Promise<void> {
  const layers = await surface.evaluate((element) => ({
    highlight: getComputedStyle(element, '::before').zIndex,
    children: Array.from(element.children).map((child) => getComputedStyle(child).zIndex),
  }));
  expect(layers.highlight).toBe('0');
  expect(layers.children).not.toHaveLength(0);
  expect(layers.children).toEqual(layers.children.map(() => '1'));
}

test('centers the mobile piece board and fills the search piece', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;

  for (const viewport of [
    { width: 375, height: 667 },
    { width: 440, height: 956 },
    { width: 540, height: 720 },
  ]) {
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    await page.route('https://suggestqueries.google.com/**', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(['mobile', ['mobile search suggestion']]),
    }));
    await page.goto(`chrome-extension://${extensionId}/newtab.html`);
    await expect(page.locator('.pieceBoard')).toBeVisible();
    await expect(page.locator('.pieceBoard')).toHaveCSS('min-height', '0px');
    expect(await page.locator('.pieceBoard').evaluate((board) => getComputedStyle(board, '::before').display)).toBe('none');
    const gutters = await page.locator('.pieceBoard').evaluate((board) => {
      const rect = board.getBoundingClientRect();
      return { left: rect.left, right: window.innerWidth - rect.right };
    });
    expect(Math.abs(gutters.left - gutters.right)).toBeLessThanOrEqual(1);
    expect(gutters.left).toBeGreaterThanOrEqual(10);
    const searchPiece = page.locator('.dashboardWidget--search .pieceContent');
    const searchShell = page.locator('.searchWidgetShell');
    const searchForm = page.locator('form.search');
    const [pieceBox, shellBox, formBox] = await Promise.all([searchPiece.boundingBox(), searchShell.boundingBox(), searchForm.boundingBox()]);
    if (!pieceBox || !shellBox || !formBox) throw new Error('Mobile search geometry was not measurable');
    expect(Math.abs(shellBox.width - pieceBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(formBox.width - pieceBox.width)).toBeLessThanOrEqual(1);
    expect(formBox.x).toBeGreaterThanOrEqual(pieceBox.x - 1);
    expect(formBox.x + formBox.width).toBeLessThanOrEqual(pieceBox.x + pieceBox.width + 1);
    const searchInput = page.getByRole('textbox', { name: /Search the web|搜索互联网/, exact: true });
    await searchInput.fill('mobile');
    const suggestionSurfaceBox = await page.locator('.searchSuggestionsSurface').boundingBox();
    if (!suggestionSurfaceBox) throw new Error('Mobile suggestions were not measurable');
    expect(Math.abs(suggestionSurfaceBox.width - formBox.width)).toBeLessThanOrEqual(1);
    await page.close();
  }
});

test('extends the desktop grid to the viewport or the lowest piece', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  const board = page.locator('.pieceBoard');
  await expect(board).toBeVisible();

  const initial = await board.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const grid = getComputedStyle(element, '::before');
    return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight, backgroundSize: grid.backgroundSize };
  });
  expect(initial.bottom).toBeGreaterThanOrEqual(initial.viewport - .5);
  expect(initial.backgroundSize).toContain('40px');

  const placements = async () => page.locator('[data-piece-id]').evaluateAll((elements) => Object.fromEntries(elements.map((element) => [
    (element as HTMLElement).dataset.pieceId,
    { column: getComputedStyle(element).gridColumnStart, row: getComputedStyle(element).gridRowStart },
  ])));
  const beforeResize = await placements();
  await page.setViewportSize({ width: 1280, height: 1120 });
  await expect.poll(() => board.evaluate((element) => element.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(1119.5);
  expect(await placements()).toEqual(beforeResize);

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('pieces', 'readwrite');
    const store = transaction.objectStore('pieces');
    const request = store.get('piece:add-shortcut');
    const piece = await new Promise<any>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    piece.container = { kind: 'desktop' };
    piece.position = { x: 0, y: 30, width: 4, height: 3 };
    store.put(piece);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await page.reload();
  await expect(page.locator('[data-piece-id="piece:add-shortcut"]')).toHaveCSS('grid-row-start', '31');
  await expect.poll(() => board.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(1400);
});

test('keeps large displaced widgets visually continuous during bottom auto-scroll', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  const viewport = { width: 1778, height: 634 };
  await page.setViewportSize(viewport);
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'pieces'], 'readwrite');
    const configStore = transaction.objectStore('config');
    const configRequest = configStore.get('current');
    const config = await new Promise<any>((resolve, reject) => {
      configRequest.onsuccess = () => resolve(configRequest.result);
      configRequest.onerror = () => reject(configRequest.error);
    });
    const revision = { counter: 9_000, deviceId: 'large-bottom-scroll-e2e' };
    const widgetPositions = {
      focusTimer: { column: 17, row: 12, width: 14, height: 6, gridVersion: 3 },
      quickNote: { column: 10, row: 19, width: 28, height: 7, gridVersion: 3 },
    };
    config.appearance.widgetLayout.value.forEach((item: { id: string; enabled: boolean; position?: unknown; sizePreset?: string }) => {
      item.enabled = item.id === 'focusTimer' || item.id === 'quickNote';
      if (item.id === 'focusTimer' || item.id === 'quickNote') {
        item.sizePreset = 'medium';
        item.position = widgetPositions[item.id as keyof typeof widgetPositions];
      }
    });
    config.shortcuts = [];
    const pieceStore = transaction.objectStore('pieces');
    pieceStore.clear();
    pieceStore.put({ id: 'piece:widget:focusTimer', kind: 'system-widget', payloadRef: 'focusTimer', container: { kind: 'desktop' }, position: { x: -7, y: 12, width: 14, height: 6 }, revision });
    pieceStore.put({ id: 'piece:widget:quickNote', kind: 'system-widget', payloadRef: 'quickNote', container: { kind: 'desktop' }, position: { x: -14, y: 19, width: 28, height: 7 }, revision });
    configStore.put(config, 'current');
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await page.reload();

  const focusTimer = page.locator('[data-piece-id="piece:widget:focusTimer"]');
  const quickNote = page.locator('[data-piece-id="piece:widget:quickNote"]');
  const quickNoteBox = await quickNote.boundingBox();
  if (!quickNoteBox) throw new Error('Bottom-edge quick note was not measurable');
  await page.evaluate(({ noteTop, viewportHeight }) => {
    window.scrollTo(0, Math.max(0, noteTop - (viewportHeight - 80)));
  }, { noteTop: quickNoteBox.y, viewportHeight: viewport.height });
  await expect.poll(() => quickNote.evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBe(viewport.height - 80);

  const activeBox = await focusTimer.boundingBox();
  if (!activeBox) throw new Error('Bottom-edge focus timer was not measurable');
  await page.mouse.move(activeBox.x + activeBox.width / 2, activeBox.y + activeBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await expect(page.locator('.pieceBoard')).toHaveCSS('overflow-anchor', 'none');
  await page.evaluate(() => {
    const recordedWindow = window as typeof window & {
      __bottomScrollFrame?: number;
      __bottomScrollSamples?: Array<{ blockerRow: number; boardRows: number; scrollY: number; top: number }>;
    };
    recordedWindow.__bottomScrollSamples = [];
    const record = () => {
      const blocker = document.querySelector<HTMLElement>('[data-piece-id="piece:widget:quickNote"]');
      const board = document.querySelector<HTMLElement>('.pieceBoard');
      if (blocker && board) {
        recordedWindow.__bottomScrollSamples!.push({
          blockerRow: Number.parseInt(getComputedStyle(blocker).gridRowStart, 10) - 1,
          boardRows: Number(board.style.getPropertyValue('--piece-rows')),
          scrollY: window.scrollY,
          top: blocker.getBoundingClientRect().top,
        });
      }
      recordedWindow.__bottomScrollFrame = requestAnimationFrame(record);
    };
    record();
  });

  for (let step = 1; step <= 40; step += 1) {
    await page.mouse.move(activeBox.x + activeBox.width / 2, activeBox.y + activeBox.height / 2 + step * 2);
    await page.waitForTimeout(30);
  }
  await expect(quickNote).toHaveClass(/isDisplaced/);
  await page.waitForTimeout(1_000);
  const samples = await page.evaluate(() => {
    const recordedWindow = window as typeof window & {
      __bottomScrollFrame?: number;
      __bottomScrollSamples?: Array<{ blockerRow: number; boardRows: number; scrollY: number; top: number }>;
    };
    if (recordedWindow.__bottomScrollFrame !== undefined) cancelAnimationFrame(recordedWindow.__bottomScrollFrame);
    return recordedWindow.__bottomScrollSamples ?? [];
  });
  const neverDecreases = (values: number[], tolerance = 0) => values.every((value, index) => index === 0 || value + tolerance >= values[index - 1]!);
  expect(neverDecreases(samples.map((sample) => sample.blockerRow))).toBe(true);
  expect(neverDecreases(samples.map((sample) => sample.boardRows))).toBe(true);
  expect(neverDecreases(samples.map((sample) => sample.scrollY), 1)).toBe(true);
  expect(samples.at(-1)!.blockerRow).toBeGreaterThan(19);

  const rowTransitionJumps = samples.slice(1).flatMap((sample, index) => (
    sample.blockerRow === samples[index]!.blockerRow
      ? []
      : [Math.abs(sample.top - samples[index]!.top)]
  ));
  expect(rowTransitionJumps.length).toBeGreaterThan(0);
  expect(Math.max(...rowTransitionJumps)).toBeLessThan(20);

  await page.mouse.up();
  await expect(page.locator('.pieceBoard')).not.toHaveClass(/pieceBoard--dragging/);
  await expect(page.locator('.pieceBoard')).not.toHaveCSS('overflow-anchor', 'none');
});

test('keeps an adjacent piece fixed while dragging its neighbor across it', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'pieces'], 'readwrite');
    const configStore = transaction.objectStore('config');
    const configRequest = configStore.get('current');
    const config = await new Promise<any>((resolve, reject) => {
      configRequest.onsuccess = () => resolve(configRequest.result);
      configRequest.onerror = () => reject(configRequest.error);
    });
    const revision = { counter: 9_100, deviceId: 'adjacent-pass-through-e2e' };
    config.appearance.widgetLayout.value.forEach((item: { enabled: boolean }) => { item.enabled = false; });
    config.shortcuts = [
      { id: 'cross-active', groupId: 'default', name: 'Cross active', url: 'https://example.com/active', sortKey: 'a0', revision, position: { column: 24, row: 5, width: 4, height: 3, gridVersion: 3 } },
      { id: 'cross-blocker', groupId: 'default', name: 'Cross blocker', url: 'https://example.com/blocker', sortKey: 'a1', revision, position: { column: 24, row: 8, width: 4, height: 3, gridVersion: 3 } },
    ];
    const pieceStore = transaction.objectStore('pieces');
    pieceStore.clear();
    pieceStore.put({ id: 'piece:shortcut:cross-active', kind: 'shortcut', payloadRef: 'cross-active', container: { kind: 'desktop' }, position: { x: 0, y: 5, width: 4, height: 3 }, revision });
    pieceStore.put({ id: 'piece:shortcut:cross-blocker', kind: 'shortcut', payloadRef: 'cross-blocker', container: { kind: 'desktop' }, position: { x: 0, y: 8, width: 4, height: 3 }, revision });
    configStore.put(config, 'current');
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await page.reload();

  const active = page.locator('[data-piece-id="piece:shortcut:cross-active"]');
  const blocker = page.locator('[data-piece-id="piece:shortcut:cross-blocker"]');
  const activeBox = await active.boundingBox();
  if (!activeBox) throw new Error('Adjacent active piece was not measurable');
  const blockerBefore = await blocker.evaluate((element) => ({
    row: getComputedStyle(element).gridRowStart,
    top: element.getBoundingClientRect().top,
  }));
  await page.mouse.move(activeBox.x + activeBox.width / 2, activeBox.y + activeBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);

  const samples: Array<{ row: string; top: number; displaced: boolean; motion: string | null }> = [];
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(activeBox.x + activeBox.width / 2, activeBox.y + activeBox.height / 2 + step * 40);
    await page.waitForTimeout(400);
    samples.push(await blocker.evaluate((element) => ({
      row: getComputedStyle(element).gridRowStart,
      top: element.getBoundingClientRect().top,
      displaced: element.classList.contains('isDisplaced'),
      motion: element.getAttribute('data-layout-motion'),
    })));
  }
  expect(samples.every((sample) => sample.row === blockerBefore.row)).toBe(true);
  expect(samples.every((sample) => Math.abs(sample.top - blockerBefore.top) < .5)).toBe(true);
  expect(samples.every((sample) => !sample.displaced && sample.motion === null)).toBe(true);

  await page.mouse.up();
  await expect(active).toHaveCSS('grid-row-start', '12');
  await expect(blocker).toHaveCSS('grid-row-start', '9');
  await expect(blocker).not.toHaveClass(/isDisplaced/);
  await expect(blocker).not.toHaveAttribute('data-layout-motion', /.+/);
  await page.reload();
  await expect(active).toHaveCSS('grid-row-start', '12');
  await expect(blocker).toHaveCSS('grid-row-start', '9');

  const restoredActiveBox = await active.boundingBox();
  if (!restoredActiveBox) throw new Error('Passed-through active piece was not measurable');
  await page.mouse.move(restoredActiveBox.x + restoredActiveBox.width / 2, restoredActiveBox.y + restoredActiveBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(restoredActiveBox.x + restoredActiveBox.width / 2, restoredActiveBox.y + restoredActiveBox.height / 2 - 40);
  await page.waitForTimeout(400);
  await expect(blocker).toHaveCSS('grid-row-start', '9');
  await expect(blocker).not.toHaveClass(/isDisplaced/);
  await page.mouse.up();
  await expect(active).toHaveCSS('grid-row-start', '12');
  await expect(blocker).toHaveCSS('grid-row-start', '9');

  const dwellActiveBox = await active.boundingBox();
  if (!dwellActiveBox) throw new Error('Restored active piece was not measurable for dwell displacement');
  await page.mouse.move(dwellActiveBox.x + dwellActiveBox.width / 2, dwellActiveBox.y + dwellActiveBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(dwellActiveBox.x + dwellActiveBox.width / 2, dwellActiveBox.y + dwellActiveBox.height / 2 - 40);
  await page.waitForTimeout(450);
  await expect(blocker).not.toHaveClass(/isDisplaced/);
  await page.waitForTimeout(250);
  await expect(blocker).toHaveClass(/isDisplaced/);
  await page.mouse.move(dwellActiveBox.x + dwellActiveBox.width / 2 + 160, dwellActiveBox.y + dwellActiveBox.height / 2 - 40);
  await expect(blocker).not.toHaveClass(/isDisplaced/);
  await page.mouse.move(dwellActiveBox.x + dwellActiveBox.width / 2, dwellActiveBox.y + dwellActiveBox.height / 2 - 40);
  await page.waitForTimeout(450);
  await expect(blocker).not.toHaveClass(/isDisplaced/);
  await page.waitForTimeout(250);
  await expect(blocker).toHaveClass(/isDisplaced/);
  await page.mouse.up();
});

test('lets a horizontally adjacent piece cross to a free vertical side', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'pieces'], 'readwrite');
    const configStore = transaction.objectStore('config');
    const request = configStore.get('current');
    const config = await new Promise<any>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const revision = { counter: 9_101, deviceId: 'side-cross-e2e' };
    config.appearance.widgetLayout.value.forEach((item: { enabled: boolean }) => { item.enabled = false; });
    config.shortcuts = [
      { id: 'side-active', groupId: 'default', name: 'Side active', url: 'https://example.com/side-active', sortKey: 'a0', revision, position: { column: 20, row: 8, width: 4, height: 3, gridVersion: 3 } },
      { id: 'side-blocker', groupId: 'default', name: 'Side blocker', url: 'https://example.com/side-blocker', sortKey: 'a1', revision, position: { column: 24, row: 8, width: 4, height: 3, gridVersion: 3 } },
    ];
    const pieceStore = transaction.objectStore('pieces');
    pieceStore.clear();
    pieceStore.put({ id: 'piece:shortcut:side-active', kind: 'shortcut', payloadRef: 'side-active', container: { kind: 'desktop' }, position: { x: -4, y: 8, width: 4, height: 3 }, revision });
    pieceStore.put({ id: 'piece:shortcut:side-blocker', kind: 'shortcut', payloadRef: 'side-blocker', container: { kind: 'desktop' }, position: { x: 0, y: 8, width: 4, height: 3 }, revision });
    configStore.put(config, 'current');
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await page.reload();

  const active = page.locator('[data-piece-id="piece:shortcut:side-active"]');
  const blocker = page.locator('[data-piece-id="piece:shortcut:side-blocker"]');
  const [activeBox, blockerBox] = await Promise.all([active.boundingBox(), blocker.boundingBox()]);
  if (!activeBox || !blockerBox) throw new Error('Horizontal crossing pieces were not measurable');
  const blockerPlacement = await blocker.evaluate((element) => ({
    column: getComputedStyle(element).gridColumnStart,
    row: getComputedStyle(element).gridRowStart,
  }));
  await page.mouse.move(activeBox.x + activeBox.width / 2, activeBox.y + activeBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(blockerBox.x + blockerBox.width / 2, blockerBox.y + blockerBox.height / 2);
  await page.waitForTimeout(400);
  await expect(blocker).not.toHaveClass(/isDisplaced/);
  await page.mouse.move(blockerBox.x + blockerBox.width / 2, blockerBox.y - activeBox.height / 2);
  await page.mouse.up();

  await expect(blocker).toHaveCSS('grid-column-start', blockerPlacement.column);
  await expect(blocker).toHaveCSS('grid-row-start', blockerPlacement.row);
  await expect(active).toHaveCSS('grid-column-start', blockerPlacement.column);
  await expect(active).toHaveCSS('grid-row-start', String(Number(blockerPlacement.row) - 3));
  await page.reload();
  await expect(active).toHaveCSS('grid-column-start', blockerPlacement.column);
  await expect(active).toHaveCSS('grid-row-start', String(Number(blockerPlacement.row) - 3));
  await expect(blocker).toHaveCSS('grid-column-start', blockerPlacement.column);
  await expect(blocker).toHaveCSS('grid-row-start', blockerPlacement.row);
});

test('fits adjacent icon pieces inside their grid cells on medium narrow screens', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 703, height: 935 });
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await expect(page.locator('.pieceBoard')).toBeVisible();

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'pieces'], 'readwrite');
    const configRequest = transaction.objectStore('config').get('current');
    const addPieceRequest = transaction.objectStore('pieces').get('piece:add-shortcut');
    const [config, addPiece] = await Promise.all([
      new Promise<any>((resolve, reject) => { configRequest.onsuccess = () => resolve(configRequest.result); configRequest.onerror = () => reject(configRequest.error); }),
      new Promise<any>((resolve, reject) => { addPieceRequest.onsuccess = () => resolve(addPieceRequest.result); addPieceRequest.onerror = () => reject(addPieceRequest.error); }),
    ]);
    const revision = { counter: 900, deviceId: 'e2e' };
    config.groups = config.groups.filter((group: { id: string }) => group.id !== 'narrow-folder');
    config.shortcuts = config.shortcuts.filter((shortcut: { id: string }) => shortcut.id !== 'narrow-folder-shortcut');
    config.groups.push({ id: 'narrow-folder', name: 'Narrow folder', collapsed: false, sortKey: 'z0', revision, position: { column: 20, row: 4, width: 4, height: 3, gridVersion: 3 } });
    config.shortcuts.push({ id: 'narrow-folder-shortcut', groupId: 'narrow-folder', name: 'Narrow icon', url: 'https://example.com/narrow', sortKey: 'a0', revision });
    const addLayout = config.appearance.widgetLayout.value.find((item: { id: string }) => item.id === 'addShortcut');
    addLayout.enabled = true;
    addLayout.position = { column: 24, row: 4, width: 4, height: 3, gridVersion: 3 };
    addPiece.container = { kind: 'desktop' };
    addPiece.position = { x: 0, y: 4, width: 4, height: 3 };
    transaction.objectStore('config').put(config, 'current');
    transaction.objectStore('pieces').put(addPiece);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await page.reload();

  const folder = page.locator('[data-desktop-key="folder:narrow-folder"]');
  const addTile = page.locator('[data-desktop-key="add-shortcut"]');
  const folderPreview = folder.locator('.folderPreview');
  const addIcon = addTile.locator('.pieceAdd > span');
  await expect(folder).toBeVisible();
  await expect(addTile).toBeVisible();
  const [folderRect, addRect, folderPreviewRect, addIconRect] = await Promise.all([
    folder.boundingBox(), addTile.boundingBox(), folderPreview.boundingBox(), addIcon.boundingBox(),
  ]);
  if (!folderRect || !addRect || !folderPreviewRect || !addIconRect) throw new Error('Narrow icon pieces were not measurable');
  expect(folderPreviewRect.width).toBeLessThanOrEqual(folderRect.width + .5);
  expect(addIconRect.width).toBeLessThanOrEqual(addRect.width + .5);
  expect(folderPreviewRect.x + folderPreviewRect.width).toBeLessThanOrEqual(addIconRect.x + .5);
  await expect(folderPreview.locator('> span')).toHaveCount(1);
  await expect(folderPreview.locator('> span').first()).toHaveCSS('width', /px$/);

  await page.setViewportSize({ width: 1280, height: 935 });
  await expect(folderPreview).toHaveCSS('width', '82px');
  await expect(addIcon).toHaveCSS('width', '58px');
  await page.setViewportSize({ width: 640, height: 935 });
  await expect(page.locator('.pieceBoard')).toHaveCSS('display', 'flex');
});

test('keeps liquid-glass hover highlights inside stable desktop components', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await setWidgetsVisibility(page, ['addShortcut', 'weather', 'quickNote', 'focusTimer']);

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'pieces'], 'readwrite');
    const configRequest = transaction.objectStore('config').get('current');
    const config = await new Promise<any>((resolve, reject) => {
      configRequest.onsuccess = () => resolve(configRequest.result);
      configRequest.onerror = () => reject(configRequest.error);
    });
    const revision = { counter: 901, deviceId: 'e2e' };
    config.groups.push({ id: 'glass-folder', name: 'Glass folder', collapsed: false, sortKey: 'glass', revision });
    config.shortcuts.push({ id: 'glass-folder-shortcut', groupId: 'glass-folder', name: 'Glass icon', url: 'https://example.com/glass', sortKey: 'glass', revision });
    transaction.objectStore('config').put(config, 'current');
    transaction.objectStore('pieces').put({ id: 'piece:folder:glass-folder', kind: 'folder', payloadRef: 'glass-folder', container: { kind: 'desktop' }, position: { x: -20, y: 25, width: 4, height: 3 }, revision });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await page.reload();

  const surfaces = [
    page.locator('form.search'),
    page.locator('.weatherWidget'),
    page.locator('.quickNote'),
    page.locator('.timerModes'),
    page.locator('.roundControl').first(),
    page.locator('.focusState'),
  ];
  for (const surface of surfaces) {
    await expect(surface).toBeVisible();
    await expectStableLiquidGlassHover(page, surface);
    await expectLiquidGlassForeground(surface);
  }
  const folderPreview = page.locator('.folderPreview');
  const restingFolderStyle = await folderPreview.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
  await folderPreview.hover();
  await page.waitForTimeout(250);
  const hoveredFolderStyle = await folderPreview.evaluate((element) => {
    const style = getComputedStyle(element);
    return { transform: style.transform, borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
  expect(hoveredFolderStyle.transform).toMatch(/^matrix\(1\.08,/);
  expect(hoveredFolderStyle.borderColor).toBe(restingFolderStyle.borderColor);
  expect(hoveredFolderStyle.boxShadow).toBe(restingFolderStyle.boxShadow);
  await expectLiquidGlassForeground(folderPreview);
  await page.locator('[data-desktop-key="folder:glass-folder"] .pieceFolder').click();
  await expectLiquidGlassForeground(page.locator('.folderSurface'));
});

test('renders the settings control as a water surface while retaining its gear rotation', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);

  const settings = page.locator('.settingsButton');
  await expect(settings).toHaveClass(/shortcutWaterShell/);
  await expect(settings).not.toHaveClass(/liquidGlassSurface/);
  await expect(settings).toHaveCSS('backdrop-filter', 'none');
  await expect(settings.locator('> span')).toHaveCSS('z-index', '3');
  await settings.hover();
  await expect.poll(() => settings.evaluate((element) => getComputedStyle(element, '::before').animationName)).toBe('shortcut-water-bubble-hover');
  await expect.poll(() => settings.evaluate((element) => getComputedStyle(element).transform)).not.toBe('none');
  await settings.click();
  await expect(page.getByRole('dialog', { name: /Settings|设置/ })).toBeVisible();
});

test('renders the add-shortcut icon as the water surface', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await setWidgetVisibility(page, 'addShortcut', true);

  const addIcon = page.locator('.pieceAdd > .shortcutWaterShell');
  await expect(addIcon).toBeVisible();
  await expect(addIcon).not.toHaveClass(/liquidGlassSurface/);
  await expect(addIcon.locator('svg.shortcutWaterShell__plus path')).toHaveAttribute('d', 'M12 5v14M5 12h14');
  await expect(addIcon).toHaveCSS('border-style', 'solid');
  await expect(addIcon).toHaveCSS('backdrop-filter', 'none');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await addIcon.hover();
  const animationName = await addIcon.evaluate((element) => getComputedStyle(element, '::before').animationName);
  expect(animationName).toBe('none');
});

test('freezes liquid-glass flow when reduced motion is requested', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  const settings = page.locator('.settingsButton');
  const before = await settings.evaluate((element) => {
    const pseudo = getComputedStyle(element, '::before');
    return { backgroundPosition: pseudo.backgroundPosition, opacity: pseudo.opacity, transition: pseudo.transitionProperty };
  });
  await settings.hover();
  await page.waitForTimeout(350);
  const after = await settings.evaluate((element) => {
    const pseudo = getComputedStyle(element, '::before');
    return { backgroundPosition: pseudo.backgroundPosition, opacity: pseudo.opacity, transition: pseudo.transitionProperty };
  });
  expect(before.transition).toBe('none');
  expect(after).toEqual(before);
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
  expect(manifest.host_permissions).toEqual(expect.arrayContaining(['https://v1.hitokoto.cn/*', 'https://zenquotes.io/*', 'https://www.bing.com/*', 'https://*.gstatic.com/*', 'https://api.open-meteo.com/*', 'https://nominatim.openstreetmap.org/*']));
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
  await expect(page.locator('#quick-note')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  const addShortcutComponent = page.getByRole('checkbox', { name: /Add shortcut|添加快捷方式/, exact: true });
  await expect(addShortcutComponent).not.toBeChecked();
  await addShortcutComponent.check();
  await page.getByRole('button', { name: /Close|关闭/ }).click();
  await expect(page.getByRole('button', { name: /Add shortcut|添加快捷方式/ })).toBeVisible();
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
  const iconInput = dialog.getByLabel(/Choose local image|选择本机图片/, { exact: true });
  await iconInput.setInputFiles({
    name: 'centered-icon.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a73e8"/></svg>'),
  });
  await expect(dialog.getByTitle('centered-icon.svg')).toBeVisible();
  const clearIcon = dialog.getByRole('button', { name: /Clear icon|清除图标/, exact: true });
  await expect(clearIcon).toHaveCSS('display', 'grid');
  await expect(clearIcon).toHaveCSS('padding-top', '0px');
  await clearIcon.hover();
  await expect(clearIcon).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const clearAlignment = await clearIcon.evaluate((button) => {
    const buttonRect = button.getBoundingClientRect();
    const iconRect = button.querySelector('svg')!.getBoundingClientRect();
    return {
      x: Math.abs(buttonRect.left + buttonRect.width / 2 - iconRect.left - iconRect.width / 2),
      y: Math.abs(buttonRect.top + buttonRect.height / 2 - iconRect.top - iconRect.height / 2),
    };
  });
  expect(clearAlignment.x).toBeLessThanOrEqual(1);
  expect(clearAlignment.y).toBeLessThanOrEqual(1);
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
  const googleVisualSearch = page.getByRole('button', { name: /Open Google Images|打开 Google 图片搜索/ });
  await expect(googleVisualSearch.locator('.googleLensIcon')).toBeVisible();
  await googleVisualSearch.click();
  await expect(page).toHaveURL(/https:\/\/images\.google\.com\/\?hl=/);

  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByLabel(/Settings|设置/).click();
  const engine = page.getByLabel(/Search engine|搜索引擎/);
  await expect(engine).toHaveValue('google');
  await engine.selectOption('bing');
  await expect(engine).toHaveValue('bing');
  await page.getByRole('button', { name: /Close|关闭/ }).click();
  const bingVisualSearch = page.getByRole('button', { name: /Open Bing Images|打开 Bing 图片搜索/ });
  await expect(bingVisualSearch.locator('.googleLensIcon')).toBeVisible();

  await context.route('https://www.bing.com/search**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Bing Search</title>' }));
  await page.getByRole('textbox', { name: /Search the web|搜索互联网/ }).fill('Isu NewTab');
  await page.getByRole('search').press('Enter');
  await expect(page).toHaveURL(/https:\/\/www\.bing\.com\/search\?q=Isu\+NewTab&setlang=/);

  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await expect(page.getByLabel(/Search engine|搜索引擎/)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /Search the web|搜索互联网/ })).toHaveAttribute('placeholder', /Search Bing|在 Bing/);
  await context.route('https://www.bing.com/images**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Bing Images</title>' }));
  await bingVisualSearch.click();
  await expect(page).toHaveURL(/https:\/\/www\.bing\.com\/images\?setlang=/);
});

test('scrolls keyboard-selected search suggestions without moving the page', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.route('https://www.google.com/search**', (route) => route.fulfill({
    contentType: 'text/html', body: '<title>Keyboard history result</title>',
  }));
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('settings', 'readwrite');
    transaction.objectStore('settings').put(Array.from({ length: 8 }, (_, index) => ({
      query: `keyboard history ${index + 1}`,
      searchedAt: new Date(Date.now() - index * 1_000).toISOString(),
    })), 'searchHistory');
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await page.addStyleTag({ content: '.searchSuggestions { max-height: 132px !important; }' });
  const input = page.getByRole('textbox', { name: /Search the web|搜索互联网/ });
  await input.focus();
  const list = page.getByRole('listbox');
  await expect(page.getByRole('option')).toHaveCount(8);
  const pageScrollBefore = await page.evaluate(() => window.scrollY);

  for (let index = 0; index < 6; index += 1) await input.press('ArrowDown');

  const selected = page.getByRole('option').filter({ has: page.locator('button.active') });
  await expect(selected).toHaveCount(1);
  const visibility = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.searchSuggestions');
    const option = document.querySelector<HTMLElement>('.searchSuggestions [aria-selected="true"]');
    if (!list || !option) throw new Error('Selected search suggestion was not measurable');
    const listRect = list.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    return {
      listScrollTop: list.scrollTop,
      fullyVisible: optionRect.top >= listRect.top - .5 && optionRect.bottom <= listRect.bottom + .5,
      pageScroll: window.scrollY,
    };
  });
  expect(visibility.listScrollTop).toBeGreaterThan(0);
  expect(visibility.fullyVisible).toBe(true);
  expect(visibility.pageScroll).toBe(pageScrollBefore);

  for (let index = 0; index < 5; index += 1) await input.press('ArrowUp');
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(8);
  await input.press('ArrowUp');
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await input.press('ArrowDown');
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(8);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBefore);
  await expect(input).toHaveValue('');
  await expect(page.getByRole('option', { name: 'keyboard history 1', exact: true })).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(page).toHaveURL(/https:\/\/www\.google\.com\/search\?q=keyboard\+history\+1&hl=/);
});

test('keeps the submitted suggestion order and highlight frozen when navigation is cancelled', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  const suggestions = ['frozen one', 'frozen two', 'frozen three', 'frozen four', 'frozen five'];
  await page.route('https://suggestqueries.google.com/**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(['frozen', suggestions]),
  }));
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  let navigationDialogSeen = false;
  page.once('dialog', async (dialog) => {
    navigationDialogSeen = true;
    await dialog.dismiss();
  });
  await page.evaluate(() => window.addEventListener('beforeunload', (event) => {
    event.preventDefault();
    event.returnValue = '';
  }));
  const input = page.getByRole('textbox', { name: /Search the web|搜索互联网/ });
  await input.fill('frozen');
  await expect(page.getByRole('option', { name: 'frozen five' })).toBeVisible();
  for (let index = 0; index < 5; index += 1) await input.press('ArrowDown');
  const before = await page.getByRole('option').allTextContents();
  await expect(page.getByRole('option', { name: 'frozen five' })).toHaveAttribute('aria-selected', 'true');

  await input.press('Enter');
  await expect.poll(() => navigationDialogSeen).toBe(true);
  await expect(page).toHaveURL(`chrome-extension://${extensionId}/newtab.html`);
  expect(await page.getByRole('option').allTextContents()).toEqual(before);
  await expect(page.getByRole('option', { name: 'frozen five' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('option', { name: 'frozen four' })).toHaveAttribute('aria-selected', 'false');
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
  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 820, height: 1180 },
    { width: 912, height: 1368 },
  ]) {
    await page.setViewportSize(viewport);
    const weatherGeometry = await weatherCard.evaluate((element) => {
      const toBox = (node: Element) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      };
      const piece = element.closest<HTMLElement>('[data-widget-id="weather"]')!;
      const content = piece.querySelector<HTMLElement>('.pieceContent')!;
      return {
        card: toBox(element),
        content: toBox(content),
        children: [
          ...Array.from(element.querySelectorAll('.weatherLocationName, .weatherIcon, .weatherTemperature, .weatherCurrent > span:last-child, .weatherDetails span')),
        ].map(toBox),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    });
    const contains = (outer: typeof weatherGeometry.card, inner: typeof weatherGeometry.card) =>
      inner.left >= outer.left - 1 && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
    expect(contains(weatherGeometry.content, weatherGeometry.card)).toBe(true);
    expect(weatherGeometry.scrollWidth).toBeLessThanOrEqual(weatherGeometry.clientWidth + 1);
    expect(weatherGeometry.scrollHeight).toBeLessThanOrEqual(weatherGeometry.clientHeight + 1);
    for (const child of weatherGeometry.children) expect(contains(weatherGeometry.card, child)).toBe(true);
  }
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

  await expect(page.locator('.wallpaperBackdrop')).toHaveAttribute('data-wallpaper-current', 'upload:wallpaper/upload');

  const remoteText = await page.evaluate(async () => JSON.stringify(await chrome.storage.sync.get(null)));
  expect(remoteText).not.toContain('wallpaper/upload');
});

test('fills Wallhaven and Unsplash preview buttons with their images', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const thumbnail = 'https://th.wallhaven.cc/lg/pr/preview-e2e.jpg';
  await context.route('https://wallhaven.cc/api/v1/search**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: [{ id: 'preview-e2e', url: 'https://wallhaven.cc/w/preview-e2e', thumbs: { large: thumbnail }, path: 'https://w.wallhaven.cc/full/pr/preview-e2e.jpg' }], meta: { current_page: 1, last_page: 1 } }),
  }));
  await context.route('https://api.unsplash.com/**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ id: 'unsplash-preview-e2e', urls: { raw: 'https://images.unsplash.com/preview-raw', small: 'https://images.unsplash.com/preview-small' }, links: { html: 'https://unsplash.com/photos/preview-e2e', download_location: 'https://api.unsplash.com/photos/preview-e2e/download' }, user: { name: 'E2E', links: { html: 'https://unsplash.com/@e2e' } } }]),
  }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByRole('button', { name: /Settings|设置/ }).click();

  await page.getByPlaceholder(/Online search|在线搜索/).fill('aurora');
  const wallhavenButton = page.locator('.wallhavenGrid:not(.unsplashGrid) button').first();
  await expect(wallhavenButton).toBeVisible();
  await expectFilledWallpaperPreview(wallhavenButton);

  const onlineSource = page.locator('select').filter({ has: page.locator('option[value="unsplash"]') });
  await onlineSource.selectOption('unsplash');
  await page.getByPlaceholder(/Unsplash Access Key|Unsplash Access Key/).fill('e2e-key');
  await page.getByRole('button', { name: /Save key|保存 Key/ }).click();
  const unsplashButton = page.locator('.unsplashGrid button').first();
  await expect(unsplashButton).toBeVisible();
  await expectFilledWallpaperPreview(unsplashButton);
});

test('caches fixed and daily Bing wallpapers locally', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const imageUrl = 'https://www.bing.com/th?id=OHR.BingE2E_ZH-CN123_1920x1080.jpg&pid=hp';
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JqJkAAAAASUVORK5CYII=', 'base64');
  await context.route('https://www.bing.com/HPImageArchive.aspx**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ images: [{ startdate: '20260826', url: '/th?id=OHR.BingE2E_ZH-CN123_1920x1080.jpg&pid=hp', copyrightlink: '/search?q=bing-e2e' }] }),
  }));
  await context.route('https://www.bing.com/th**', (route) => route.fulfill({ contentType: 'image/png', body: image }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByRole('button', { name: /Settings|设置/ }).click();

  const onlineSource = page.getByLabel(/Online wallpaper source|在线壁纸来源/);
  await onlineSource.selectOption('bing');
  await page.getByLabel(/Bing wallpaper quality|Bing 壁纸清晰度/).selectOption('4k');
  await page.getByRole('button', { name: /Close|关闭/ }).click();
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  await page.getByLabel(/Online wallpaper source|在线壁纸来源/).selectOption('bing');
  await expect(page.getByLabel(/Bing wallpaper quality|Bing 壁纸清晰度/)).toHaveValue('4k');
  const bingPreview = page.locator('.bingGrid button').first();
  await expect(bingPreview).toBeVisible();
  await bingPreview.evaluate((element) => (element as HTMLButtonElement).click());
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'assets']);
    const configRequest = transaction.objectStore('config').get('current');
    const assetRequest = transaction.objectStore('assets').get('wallpaper/bing-current');
    const [config, asset] = await Promise.all([
      new Promise<any>((resolve, reject) => { configRequest.onsuccess = () => resolve(configRequest.result); configRequest.onerror = () => reject(configRequest.error); }),
      new Promise<any>((resolve, reject) => { assetRequest.onsuccess = () => resolve(assetRequest.result); assetRequest.onerror = () => reject(assetRequest.error); }),
    ]);
    return { wallpaper: config.appearance.wallpaper.value, hasImage: asset?.blob instanceof Blob };
  })).toEqual({ wallpaper: { type: 'bing', imageUrl: `${imageUrl}&w=3840&h=2160&rs=1&c=4`, sourceUrl: 'https://www.bing.com/search?q=bing-e2e', date: '20260826', quality: '4k' }, hasImage: true });

  await page.locator('.wallpaperBingDailyChoice').evaluate((element) => (element as HTMLButtonElement).click());
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'settings', 'assets']);
    const configRequest = transaction.objectStore('config').get('current');
    const stateRequest = transaction.objectStore('settings').get('bingDailyWallpaper');
    const assetRequest = transaction.objectStore('assets').get('wallpaper/bing-daily-current');
    const [config, state, asset] = await Promise.all([
      new Promise<any>((resolve, reject) => { configRequest.onsuccess = () => resolve(configRequest.result); configRequest.onerror = () => reject(configRequest.error); }),
      new Promise<any>((resolve, reject) => { stateRequest.onsuccess = () => resolve(stateRequest.result); stateRequest.onerror = () => reject(stateRequest.error); }),
      new Promise<any>((resolve, reject) => { assetRequest.onsuccess = () => resolve(assetRequest.result); assetRequest.onerror = () => reject(assetRequest.error); }),
    ]);
    return { wallpaper: config.appearance.wallpaper.value, imageUrl: state?.imageUrl, market: state?.market, hasImage: asset?.blob instanceof Blob };
  })).toEqual({ wallpaper: { type: 'bing-daily', quality: '4k' }, imageUrl: `${imageUrl}&w=3840&h=2160&rs=1&c=4`, market: 'en-US', hasImage: true });
  await expect(page.locator('.wallpaperBackdrop')).toHaveAttribute('data-wallpaper-current', `bing-daily:${imageUrl}&w=3840&h=2160&rs=1&c=4`);

  await page.getByLabel(/Bing wallpaper quality|Bing 壁纸清晰度/).selectOption('1440p');
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<any>((resolve, reject) => {
      const request = database.transaction('settings').objectStore('settings').get('bingDailyWallpaper');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  })).toEqual(expect.objectContaining({ quality: '1440p', imageUrl: `${imageUrl}&w=2560&h=1440&rs=1&c=4` }));
  await expect(page.locator('.wallpaperBackdrop')).toHaveAttribute('data-wallpaper-incoming', `bing-daily:${imageUrl}&w=2560&h=1440&rs=1&c=4`);
  await expect.poll(() => page.locator('.wallpaperBackdrop').getAttribute('data-wallpaper-current'), { timeout: 3_000 }).toBe(`bing-daily:${imageUrl}&w=2560&h=1440&rs=1&c=4`);
});

test('uses one outlined style for local, random, and Bing wallpaper actions', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  await context.route('https://wallhaven.cc/api/v1/search**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: [{ id: 'random-style-e2e', url: 'https://wallhaven.cc/w/random-style-e2e', thumbs: { large: 'https://th.wallhaven.cc/lg/ra/random-style-e2e.jpg' }, path: 'https://w.wallhaven.cc/full/ra/random-style-e2e.jpg' }], meta: { current_page: 1, last_page: 1 } }),
  }));
  await context.route('https://w.wallhaven.cc/full/ra/random-style-e2e.jpg', (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JqJkAAAAASUVORK5CYII=', 'base64'),
  }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByRole('button', { name: /Settings|设置/ }).click();

  const actions = page.locator('.wallpaperUploadChoice, .wallpaperRandomChoice, .wallpaperBingDailyChoice');
  await expect(actions).toHaveCount(3);
  const initialStyles = await actions.evaluateAll((buttons) => buttons.map((button) => {
    const style = getComputedStyle(button);
    return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, borderColor: style.borderTopColor, color: style.color };
  }));
  expect(new Set(initialStyles.map((style) => JSON.stringify(style))).size).toBe(1);

  const randomButton = page.locator('.wallpaperRandomChoice');
  await randomButton.click();
  await expect(randomButton).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(0, 0);
  await expect(randomButton).toHaveCSS('border-top-color', 'rgb(26, 115, 232)');
  await expect(randomButton).toHaveCSS('background-image', 'none');
});

test('uses one outlined style for backup and restore actions', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByRole('button', { name: /Settings|设置/ }).click();

  const actions = page.locator('.backupActionGrid button');
  await expect(actions).toHaveCount(3);
  const readStyles = () => actions.evaluateAll((buttons) => buttons.map((button) => {
    const style = getComputedStyle(button);
    return { backgroundColor: style.backgroundColor, borderColor: style.borderTopColor, color: style.color };
  }));
  expect(new Set((await readStyles()).map((style) => JSON.stringify(style))).size).toBe(1);

  await page.getByLabel(/Theme|主题/, { exact: true }).selectOption('dark');
  expect(new Set((await readStyles()).map((style) => JSON.stringify(style))).size).toBe(1);
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

test('keeps an expired cached random wallpaper visible until its replacement is ready', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const oldImageUrl = 'https://w.wallhaven.cc/full/ol/wallhaven-old-startup.jpg';
  const newImageUrl = 'https://w.wallhaven.cc/full/ne/wallhaven-new-startup.jpg';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JqJkAAAAASUVORK5CYII=', 'base64');
  let releaseRandomResponse!: () => void;
  const randomResponse = new Promise<void>((resolve) => { releaseRandomResponse = resolve; });
  let randomRequests = 0;
  await context.route('https://wallhaven.cc/api/v1/search**', async (route) => {
    randomRequests += 1;
    await randomResponse;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'new-startup', url: 'https://wallhaven.cc/w/new-startup', thumbs: { large: 'https://th.wallhaven.cc/lg/ne/new-startup.jpg' }, path: newImageUrl }], meta: { current_page: 1, last_page: 1 } }),
    });
  });
  await context.route(newImageUrl, (route) => route.fulfill({ contentType: 'image/png', body: png }));

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.evaluate(async ({ oldImageUrl, pngBytes }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isu-newtab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['config', 'settings', 'assets'], 'readwrite');
    const config = await new Promise<any>((resolve, reject) => {
      const request = transaction.objectStore('config').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    config.appearance.wallpaper.value = { type: 'wallhaven-random', interval: '1h' };
    config.updatedAt = new Date().toISOString();
    transaction.objectStore('config').put(config, 'current');
    transaction.objectStore('settings').put({
      imageUrl: oldImageUrl,
      sourceUrl: 'https://wallhaven.cc/w/old-startup',
      wallpaperId: 'old-startup',
      interval: '1h',
      updatedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      nextRefreshAt: new Date(Date.now() - 60_000).toISOString(),
    }, 'randomWallpaper');
    transaction.objectStore('assets').put({
      key: 'wallpaper/random-current',
      blob: new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }),
      updatedAt: new Date().toISOString(),
      sourceUrl: oldImageUrl,
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }, { oldImageUrl, pngBytes: [...png] });
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'wallpaper:random:reconcile' }));
  await page.reload();

  const backdrop = page.locator('.wallpaperBackdrop');
  await expect(backdrop).toHaveAttribute('data-wallpaper-current', `wallhaven-random:${oldImageUrl}`);
  await expect(backdrop).toHaveAttribute('data-wallpaper-source', 'asset');
  await expect.poll(() => randomRequests).toBe(1);
  await expect(backdrop).not.toHaveAttribute('data-wallpaper-current', /initial-white|pending|fallback/);
  await expect(backdrop.locator('[data-wallpaper-layer]')).toHaveCount(1);
  await expect(backdrop.locator('[data-wallpaper-layer]')).toHaveAttribute('data-wallpaper-layer', `wallhaven-random:${oldImageUrl}`);

  releaseRandomResponse();
  await expect(backdrop).toHaveAttribute('data-wallpaper-incoming', `wallhaven-random:${newImageUrl}`);
  await expect.poll(() => backdrop.getAttribute('data-wallpaper-incoming'), { timeout: 3_500 }).toBeNull();
  await expect(backdrop).toHaveAttribute('data-wallpaper-current', `wallhaven-random:${newImageUrl}`);
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
  const auroraPreview = page.getByRole('button', { name: /Aurora|极光/ });
  await expect(auroraPreview).toHaveCSS('--builtin-wallpaper', BUILTIN_WALLPAPERS.aurora);

  for (const [label, identity] of [
    [/Dusk|暮色/, 'builtin:dusk'],
    [/Aurora|极光/, 'builtin:aurora'],
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
  await expect.poll(() => backdrop.getAttribute('data-wallpaper-incoming'), { timeout: 3_000 }).toBeNull();
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

test('starts from a black document without a wallpaper bootstrap script', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await expect(page.locator('script[src="/wallpaper-bootstrap.js"]')).toHaveCount(0);
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
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
  await mode.selectOption('google-drive');
  await expect(page.getByRole('button', { name: /Connect Google Drive|连接 Google Drive/ })).toBeVisible();
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
  await setWidgetsVisibility(page, ['greeting', 'dailyQuote', 'quickNote']);
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
  await setWidgetsVisibility(page, ['clock', 'dailyQuote', 'addShortcut']);
  await setWidgetVisibility(page, 'search', false);
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
  await setWidgetsVisibility(page, ['greeting', 'focusTimer']);
  await offsetWidgetRow(page, 'focusTimer', 1);
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

test('keeps the desktop drag overlay aligned after leaving the browser window', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 500 });
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await setWidgetVisibility(page, 'addShortcut', true);
  const addTile = page.locator('[data-desktop-key="add-shortcut"]');
  await expect(addTile).toBeVisible();
  await addTile.scrollIntoViewIfNeeded();
  const originalSlot = await addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }));
  const addBox = await addTile.boundingBox();
  if (!addBox) throw new Error('Add shortcut tile was not measurable');
  const start = { x: addBox.x + addBox.width / 2, y: addBox.y + addBox.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  const overlay = page.locator('[data-desktop-drag-overlay]');
  const overlayOutline = overlay.locator('.desktopPieceDragOverlay__gridOutline');
  await expect(overlay).toBeVisible();
  await expect(overlayOutline).toBeVisible();
  await expect(addTile.locator('.pieceContent')).toHaveCSS('visibility', 'hidden');
  await page.mouse.move(start.x, 1, { steps: 6 });
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null })));
  const scrollAtExit = await page.evaluate(() => window.scrollY);
  await page.waitForTimeout(250);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollAtExit)).toBeLessThanOrEqual(1);

  const pointer = { x: start.x, y: 250 };
  await page.mouse.move(pointer.x, pointer.y, { steps: 6 });
  const overlayBox = await overlay.boundingBox();
  const overlayOutlineBox = await overlayOutline.boundingBox();
  if (!overlayBox || !overlayOutlineBox) throw new Error('Desktop drag overlay was not measurable');
  expect(Math.abs(overlayOutlineBox.width - overlayBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(overlayOutlineBox.height - overlayBox.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(overlayBox.x + overlayBox.width / 2 - pointer.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(overlayBox.y + overlayBox.height / 2 - pointer.y)).toBeLessThanOrEqual(2);

  await page.mouse.move(pointer.x, 499, { steps: 6 });
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null })));
  const downScrollAtExit = await page.evaluate(() => window.scrollY);
  await page.waitForTimeout(250);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - downScrollAtExit)).toBeLessThanOrEqual(1);
  await page.mouse.move(pointer.x, pointer.y, { steps: 6 });
  const downOverlayBox = await overlay.boundingBox();
  const downOutlineBox = await overlayOutline.boundingBox();
  if (!downOverlayBox || !downOutlineBox) throw new Error('Desktop drag overlay was not measurable after downward return');
  expect(Math.abs(downOutlineBox.width - downOverlayBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(downOutlineBox.height - downOverlayBox.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(downOverlayBox.x + downOverlayBox.width / 2 - pointer.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(downOverlayBox.y + downOverlayBox.height / 2 - pointer.y)).toBeLessThanOrEqual(2);

  await page.mouse.up();
  await expect.poll(() => addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }))).not.toEqual(originalSlot);
  const droppedSlot = await addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }));
  await page.reload();
  await expect.poll(() => addTile.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }))).toEqual(droppedSlot);
});

test('hides, drags, and persists dashboard components on the board', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await setWidgetVisibility(page, 'greeting', true);
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
  await expect(page.locator('[data-widget-id="greeting"]')).toHaveCount(0);
  await setWidgetsVisibility(page, ['clock', 'greeting', 'focusTimer', 'quickNote', 'dailyQuote']);
  await offsetWidgetRow(page, 'focusTimer', 1);
  await expect(page.locator('[data-widget-id="search"]')).toBeVisible();
  const restoredGreeting = page.locator('[data-widget-id="greeting"]');
  await expect.poll(() => restoredGreeting.evaluate((element) => {
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
  await expect(page.locator('.dashboardBoard')).toHaveClass(/reflowPreview/);
  await expect(centeredGreeting).toHaveCSS('grid-row-start', originalGreetingRow);
  const displacedWidget = page.locator('.dashboardWidget.isDisplaced').first();
  await expect(displacedWidget).toBeVisible();
  const displacedKey = await displacedWidget.getAttribute('data-desktop-key');
  if (!displacedKey) throw new Error('Displaced widget had no stable desktop key');
  const animatedWidget = page.locator(`[data-desktop-key="${displacedKey}"]`);
  await expect(animatedWidget).toHaveAttribute('data-layout-motion', 'damped-quartic');
  const layerOrder = await page.evaluate(({ activeSelector, displacedSelector }) => {
    const active = document.querySelector<HTMLElement>(activeSelector);
    const displaced = document.querySelector<HTMLElement>(displacedSelector);
    if (!active || !displaced) throw new Error('Drag layer nodes were not found');
    return {
      active: Number.parseInt(getComputedStyle(active).zIndex, 10),
      displaced: Number.parseInt(getComputedStyle(displaced).zIndex, 10),
    };
  }, {
    activeSelector: '[data-widget-id="greeting"]',
    displacedSelector: `[data-desktop-key="${displacedKey}"]`,
  });
  expect(layerOrder.active).toBeGreaterThan(layerOrder.displaced);
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

test('enabling a component through settings uses a vacant slot without moving existing pieces', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);

  const search = page.locator('[data-widget-id="search"]');
  const searchSlot = await search.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }));
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  await page.getByRole('checkbox', { name: /Clock and date|时间与日期/, exact: true }).check();
  await page.getByRole('button', { name: /Close|关闭/ }).click();

  const clock = page.locator('[data-widget-id="clock"]');
  await expect(clock).toBeVisible();
  const [searchBox, clockBox] = await Promise.all([search.boundingBox(), clock.boundingBox()]);
  if (!searchBox || !clockBox) throw new Error('Enabled components were not measurable');
  expect(searchBox.x + searchBox.width <= clockBox.x || clockBox.x + clockBox.width <= searchBox.x || searchBox.y + searchBox.height <= clockBox.y || clockBox.y + clockBox.height <= searchBox.y).toBe(true);
  expect(await search.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }))).toEqual(searchSlot);

  const clockSlot = await clock.evaluate((element) => ({ column: (element as HTMLElement).style.gridColumn, row: (element as HTMLElement).style.gridRow }));
  await page.reload();
  await expect(page.locator('[data-widget-id="clock"]')).toHaveCSS('grid-column', clockSlot.column);
  await expect(page.locator('[data-widget-id="clock"]')).toHaveCSS('grid-row', clockSlot.row);
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
  await setWidgetVisibility(page, 'clock', true);

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
  const onlineRandomChoice = page.getByRole('button', { name: /Online random|在线随机/, exact: true });
  const assertActiveWallpaperHover = async (choice: typeof solidChoice, contentSelector?: string) => {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    const beforeHover = await choice.evaluate((element, selector) => {
      const card = element.getBoundingClientRect();
      const content = selector ? element.querySelector(selector)?.getBoundingClientRect() : undefined;
      const style = getComputedStyle(element);
      return { border: { color: style.borderTopColor, width: style.borderTopWidth }, card: card.toJSON(), content: content?.toJSON() };
    }, contentSelector);
    expect(beforeHover.border).toEqual({ color: 'rgb(26, 115, 232)', width: '2px' });
    await choice.hover();
    await page.waitForTimeout(200);
    const afterHover = await choice.evaluate((element, selector) => {
      const card = element.getBoundingClientRect();
      const content = selector ? element.querySelector(selector)?.getBoundingClientRect() : undefined;
      const style = getComputedStyle(element);
      return {
        card: card.toJSON(),
        content: content?.toJSON(),
        border: { color: style.borderTopColor, width: style.borderTopWidth },
      };
    }, contentSelector);
    expect(afterHover.card).toEqual(beforeHover.card);
    expect(afterHover.content).toEqual(beforeHover.content);
    expect(afterHover.border).toEqual({ color: 'rgb(210, 227, 252)', width: '2px' });
  };
  await presetButtons[1]!.click();
  await expect(solidChoice).not.toHaveClass(/active/);
  await solidChoice.locator('span').click();
  await expect(solidChoice).toHaveClass(/active/);
  await assertActiveWallpaperHover(solidChoice, 'span');
  await presetButtons[0]!.click();
  await expect(presetButtons[0]!).toHaveClass(/active/);
  await assertActiveWallpaperHover(presetButtons[0]!);
  await onlineRandomChoice.click();
  await expect(onlineRandomChoice).toHaveClass(/active/);
  await assertActiveWallpaperHover(onlineRandomChoice);
  await solidChoice.locator('span').click();
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
  const searchPiece = page.locator('[data-widget-id="search"]');
  const searchContent = searchPiece.locator('.pieceContent--search');
  const [searchPieceBox, searchContentBox, searchFormBoxBeforeOpen] = await Promise.all([searchPiece.boundingBox(), searchContent.boundingBox(), searchForm.boundingBox()]);
  if (!searchPieceBox || !searchContentBox || !searchFormBoxBeforeOpen) throw new Error('Search piece geometry was not measurable');
  expect(Math.abs(searchContentBox.height - searchPieceBox.height)).toBeLessThanOrEqual(1);
  expect(searchFormBoxBeforeOpen.y + searchFormBoxBeforeOpen.height).toBeLessThanOrEqual(searchPieceBox.y + searchPieceBox.height + 1);
  await expect(searchContent).toHaveCSS('overflow', 'visible');
  await expect(page.locator('[data-widget-id="clock"] .pieceContent')).toHaveCSS('overflow', 'hidden');
  await expect(shell).toHaveCSS('--search-background-alpha', '0.4');
  await expect(searchForm).toHaveCSS('--search-surface-radius', '28px');
  await expect(searchForm).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.4)');
  await expect(searchForm).toHaveCSS('box-shadow', 'rgba(32, 33, 36, 0.24) 0px 4px 7px 0px');
  expect(await searchForm.evaluate((element) => {
    const transitions = getComputedStyle(element).transitionProperty.split(', ');
    return {
      hasBackgroundColor: transitions.includes('background-color'),
      hasBorderColor: transitions.includes('border-color'),
      hasBoxShadow: transitions.includes('box-shadow'),
    };
  })).toEqual({ hasBackgroundColor: false, hasBorderColor: false, hasBoxShadow: false });
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
  const suggestionSurface = page.locator('.searchSuggestionsSurface');
  await expect(suggestionSurface).toBeVisible();
  const expandedFrameStyles = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const search = getComputedStyle(document.querySelector('form.search')!);
    const surface = getComputedStyle(document.querySelector('.searchSuggestionsSurface')!);
    return {
      searchBackground: search.backgroundColor,
      searchBorder: search.borderBottomColor,
      searchShadow: search.boxShadow,
      surfaceBackground: surface.backgroundColor,
      surfaceShadow: surface.boxShadow,
    };
  });
  expect(expandedFrameStyles.searchBackground).toBe('rgba(0, 0, 0, 0)');
  expect(expandedFrameStyles.searchBorder).toBe('rgba(0, 0, 0, 0)');
  expect(expandedFrameStyles.searchShadow).toBe('none');
  expect(expandedFrameStyles.surfaceBackground).toBe('rgba(255, 255, 255, 0.4)');
  expect(expandedFrameStyles.surfaceShadow).toBe('rgba(32, 33, 36, 0.24) 0px 4px 7px 0px');
  const searchFormBox = await searchForm.boundingBox();
  const suggestionBox = await suggestionList.boundingBox();
  const suggestionSurfaceBox = await suggestionSurface.boundingBox();
  if (!searchFormBox || !suggestionBox || !suggestionSurfaceBox) throw new Error('Search suggestion geometry was not measurable');
  await expect(suggestionSurface).toHaveCSS('position', 'absolute');
  expect(Math.abs(searchFormBox.y - searchFormBoxBeforeOpen.y)).toBeLessThanOrEqual(1);
  expect(suggestionBox.y).toBeGreaterThanOrEqual(searchFormBox.y + searchFormBox.height - .5);
  expect(Math.abs(suggestionSurfaceBox.x - searchFormBox.x)).toBeLessThan(1);
  expect(Math.abs(suggestionSurfaceBox.y - searchFormBox.y)).toBeLessThan(1);
  expect(Math.abs(suggestionSurfaceBox.width - searchFormBox.width)).toBeLessThan(1);
  expect(Math.abs((suggestionSurfaceBox.y + suggestionSurfaceBox.height) - (suggestionBox.y + suggestionBox.height))).toBeLessThanOrEqual(1);
  await expect(suggestionSurface).toHaveCSS('pointer-events', 'auto');
  await page.waitForTimeout(250);
  const searchSurfaceStyles = await page.evaluate(() => {
    const search = getComputedStyle(document.querySelector('form.search')!);
    const suggestions = getComputedStyle(document.querySelector('.searchSuggestions')!);
    const surface = getComputedStyle(document.querySelector('.searchSuggestionsSurface')!);
    return {
    background: { search: search.backgroundColor, suggestions: suggestions.backgroundColor, surface: surface.backgroundColor },
    border: surface.borderLeftColor,
    radius: { search: search.borderTopLeftRadius, surfaceTop: surface.borderTopLeftRadius, surfaceBottom: surface.borderBottomLeftRadius },
    shadows: { search: search.boxShadow, suggestions: suggestions.boxShadow, surface: surface.boxShadow },
    };
  });
  expect(searchSurfaceStyles.background.search).toBe('rgba(0, 0, 0, 0)');
  expect(searchSurfaceStyles.background.suggestions).toBe('rgba(0, 0, 0, 0)');
  expect(searchSurfaceStyles.background.surface).toBe('rgba(255, 255, 255, 0.4)');
  expect(searchSurfaceStyles.border).toBe('rgba(223, 225, 229, 0.88)');
  expect(searchSurfaceStyles.radius.surfaceTop).toBe(searchSurfaceStyles.radius.search);
  expect(searchSurfaceStyles.radius.surfaceBottom).toBe(searchSurfaceStyles.radius.search);
  expect(searchSurfaceStyles.shadows.search).toBe('none');
  expect(searchSurfaceStyles.shadows.suggestions).toBe('none');
  expect(searchSurfaceStyles.shadows.surface).toBe('rgba(32, 33, 36, 0.24) 0px 4px 7px 0px');
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
  await expect(suggestionSurface).toHaveCount(0);
  await expect(searchForm).toHaveCSS('border-bottom-color', 'rgba(223, 225, 229, 0.88)');
  await expect(searchForm).toHaveCSS('box-shadow', 'rgba(32, 33, 36, 0.24) 0px 4px 7px 0px');
  await context.unroute('https://suggestqueries.google.com/**');
});

test('switches the new interface languages without reloading the new tab', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  const drawer = page.getByRole('dialog');
  const languageSelect = drawer.locator('.settings > section').nth(1).locator('select');

  for (const [language, lang, title, settings] of [
    ['zh_HK', 'zh-HK', '新分頁', '設定'],
    ['zh_TW', 'zh-TW', '新分頁', '設定'],
    ['ko', 'ko', '새 탭', '설정'],
    ['ja', 'ja', '新しいタブ', '設定'],
  ] as const) {
    await languageSelect.selectOption(language);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page).toHaveTitle(title);
    await expect(drawer.locator('.modalHeader h2')).toHaveText(settings);
  }
});

test('applies light, dark, and system themes to shared modal variants', async () => {
  if (!context) throw new Error('Browser context was not created');
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);

  await page.getByRole('button', { name: /Settings|设置/ }).click();
  const settingsDrawer = page.getByRole('dialog', { name: /Settings|设置/ });
  const settingsBackdrop = settingsDrawer.locator('..');
  const themeSelect = page.getByLabel(/Theme|主题/, { exact: true });
  await expect(settingsDrawer).toHaveAttribute('data-theme', 'system');
  await expect(settingsDrawer).toHaveCSS('background-color', 'rgb(23, 24, 27)');
  await expect(settingsBackdrop).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(settingsBackdrop).toHaveCSS('backdrop-filter', 'none');

  await themeSelect.selectOption('light');
  await expect(settingsDrawer).toHaveAttribute('data-theme', 'light');
  await expect(settingsDrawer).toHaveCSS('background-color', 'rgb(248, 250, 253)');
  await expect(themeSelect.locator('option').first()).toHaveCSS('color', 'rgb(32, 33, 36)');

  await themeSelect.selectOption('system');
  await expect(settingsDrawer).toHaveAttribute('data-theme', 'system');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(settingsDrawer).toHaveCSS('background-color', 'rgb(248, 250, 253)');
  await expect(themeSelect.locator('option').first()).toHaveCSS('color', 'rgb(32, 33, 36)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(settingsDrawer).toHaveCSS('background-color', 'rgb(23, 24, 27)');
  await expect(settingsBackdrop).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(settingsBackdrop).toHaveCSS('backdrop-filter', 'none');

  await themeSelect.selectOption('dark');
  await expect(settingsDrawer).toHaveAttribute('data-theme', 'dark');
  await expect(settingsDrawer.locator('.settings > section').first()).toHaveCSS('background-color', 'rgb(32, 33, 36)');
  await expect(settingsBackdrop).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(settingsBackdrop).toHaveCSS('backdrop-filter', 'none');
  const settingOptionColors = await settingsDrawer.locator('select option').evaluateAll((options) => [...new Set(options.map((option) => getComputedStyle(option).color))]);
  expect(settingOptionColors).toEqual(['rgb(241, 243, 244)']);
  await page.getByRole('checkbox', { name: /Add shortcut|添加快捷方式/, exact: true }).check();
  await page.getByRole('button', { name: /Close|关闭/ }).click();

  await page.getByRole('button', { name: /Add shortcut|添加快捷方式/, exact: true }).click();
  const editor = page.getByRole('dialog', { name: /Add shortcut|添加快捷方式/ });
  await expect(editor).toHaveAttribute('data-theme', 'dark');
  await expect(editor).toHaveCSS('background-color', 'rgb(32, 33, 36)');
  await expect(editor.locator('..')).toHaveCSS('background-color', 'rgba(32, 33, 36, 0.28)');
  await expect(editor.locator('..')).toHaveCSS('backdrop-filter', 'none');
  await expect(editor.locator('select option').first()).toHaveCSS('color', 'rgb(241, 243, 244)');

  await page.evaluate(() => {
    for (const theme of ['light', 'system', 'dark']) {
      for (const variant of ['editor', 'center']) {
        const backdrop = document.createElement('div');
        backdrop.id = `modal-theme-${variant}-${theme}`;
        backdrop.className = `modalBackdrop modalBackdrop--${variant}`;
        backdrop.dataset.theme = theme;
        document.body.append(backdrop);
      }
    }
  });
  for (const theme of ['light', 'dark', 'system']) {
    for (const variant of ['editor', 'center']) {
      const backdrop = page.locator(`#modal-theme-${variant}-${theme}`);
      await expect(backdrop).toHaveCSS('background-color', 'rgba(32, 33, 36, 0.28)');
      await expect(backdrop).toHaveCSS('backdrop-filter', 'none');
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  for (const variant of ['editor', 'center']) {
    const backdrop = page.locator(`#modal-theme-${variant}-system`);
    await expect(backdrop).toHaveCSS('background-color', 'rgba(32, 33, 36, 0.28)');
    await expect(backdrop).toHaveCSS('backdrop-filter', 'none');
  }
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
