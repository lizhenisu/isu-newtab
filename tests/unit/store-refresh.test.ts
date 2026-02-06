import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialConfig } from '../../core/domain/defaults';
import { appRepositories } from '../../core/storage/repository';
import { useAppStore } from '../../core/state/store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const originalState = useAppStore.getState();

afterEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState(originalState, true);
});

describe('application state refresh', () => {
  it('keeps the newest atomic snapshot when an older refresh finishes later', async () => {
    const oldSnapshot = deferred<Awaited<ReturnType<typeof appRepositories.config.getAppStateSnapshot>>>();
    const newSnapshot = deferred<Awaited<ReturnType<typeof appRepositories.config.getAppStateSnapshot>>>();
    const oldConfig = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
    oldConfig.datasetId = 'old';
    const nextConfig = structuredClone(oldConfig);
    nextConfig.datasetId = 'new';
    vi.spyOn(appRepositories.config, 'getAppStateSnapshot')
      .mockImplementationOnce(() => oldSnapshot.promise)
      .mockImplementationOnce(() => newSnapshot.promise);

    const olderRefresh = useAppStore.getState().refresh();
    const newerRefresh = useAppStore.getState().refresh();
    newSnapshot.resolve({ config: nextConfig, pieces: [], syncMode: 'google-drive' });
    await newerRefresh;
    oldSnapshot.resolve({ config: oldConfig, pieces: [], syncMode: 'chrome' });
    await olderRefresh;

    expect(useAppStore.getState()).toMatchObject({ config: { datasetId: 'new' }, syncMode: 'google-drive' });
  });

  it('applies the move command snapshot before resolving and invalidates older refreshes', async () => {
    const oldSnapshot = deferred<Awaited<ReturnType<typeof appRepositories.config.getAppStateSnapshot>>>();
    const oldConfig = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
    oldConfig.datasetId = 'old-refresh';
    const committedConfig = structuredClone(oldConfig);
    committedConfig.datasetId = 'desktop-drop';
    vi.spyOn(appRepositories.config, 'getAppStateSnapshot').mockImplementationOnce(() => oldSnapshot.promise);
    vi.spyOn(appRepositories.config, 'moveShortcut').mockResolvedValue({ config: committedConfig, pieces: [], syncMode: 'chrome' });

    const staleRefresh = useAppStore.getState().refresh();
    await useAppStore.getState().moveShortcut('member', 'default', undefined, undefined, { column: 0, row: 0, width: 4, height: 3, gridVersion: 3 });
    expect(useAppStore.getState().config?.datasetId).toBe('desktop-drop');

    oldSnapshot.resolve({ config: oldConfig, pieces: [], syncMode: 'google-drive' });
    await staleRefresh;
    expect(useAppStore.getState()).toMatchObject({ config: { datasetId: 'desktop-drop' }, syncMode: 'chrome' });
  });
});
