import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase } from '../../core/storage/database';
import { AppRepository } from '../../core/storage/repository';
import { SyncCoordinator } from '../../core/sync/coordinator';
import type { SyncStatusRecord, SyncStatusStore } from '../../core/sync/status-store';
import { LegacyMemoryCommitSyncAdapter, MemoryCommitSyncAdapter } from '../support/memory-sync-adapter';
import { createInitialConfig } from '../../core/domain/defaults';
import { createEnvelope } from '../../core/sync/engine';

class MemoryStatusStore implements SyncStatusStore {
  status?: SyncStatusRecord;
  conflict?: unknown;

  async get() { return this.status; }
  async set(status: Omit<SyncStatusRecord, 'updatedAt'>) { this.status = { ...status, updatedAt: new Date().toISOString() }; }
  async setConflict(conflict: unknown) { this.conflict = conflict; }
  async clearConflict() { this.conflict = undefined; }
}

async function resetDatabase() {
  await closeDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('isu-newtab');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe('SyncCoordinator', () => {
  beforeEach(resetDatabase);
  afterEach(resetDatabase);

  it('coordinates an injected provider without depending on Chrome storage', async () => {
    const repository = new AppRepository();
    const adapter = new MemoryCommitSyncAdapter('provider-test');
    const statusStore = new MemoryStatusStore();
    await adapter.enable();
    const coordinator = new SyncCoordinator({
      adapter,
      repository,
      statusStore,
      providerMode: 'chrome',
      refreshWallpaper: vi.fn(),
    });

    await coordinator.run();

    expect(await adapter.discover()).not.toBeNull();
    expect(await repository.getCursor('provider-test')).toBeDefined();
    expect(statusStore.status?.state).toBe('idle');
  });

  it('adopts an existing remote dataset on a pristine first install', async () => {
    const adapter = new MemoryCommitSyncAdapter('provider-test');
    await adapter.enable();

    const first = new AppRepository();
    const firstCoordinator = new SyncCoordinator({
      adapter,
      repository: first,
      statusStore: new MemoryStatusStore(),
      providerMode: 'chrome',
      refreshWallpaper: vi.fn(),
    });
    await firstCoordinator.run();
    await first.addShortcut({ name: 'Shared shortcut', url: 'https://example.com/', groupId: 'default' });
    await firstCoordinator.run();

    await resetDatabase();
    const second = new AppRepository();
    const secondStatus = new MemoryStatusStore();
    const secondCoordinator = new SyncCoordinator({
      adapter,
      repository: second,
      statusStore: secondStatus,
      providerMode: 'chrome',
      refreshWallpaper: vi.fn(),
    });
    await secondCoordinator.run();

    expect((await second.getConfig()).shortcuts.map((item) => item.name)).toEqual(['Shared shortcut']);
    expect((await second.getSyncReplica('provider-test'))?.state).toBe('bound');
    expect(secondStatus.status?.state).toBe('idle');
  });

  it('uses a matching head probe to skip the graph on idle checks and publish local edits directly', async () => {
    const repository = new AppRepository();
    const adapter = new MemoryCommitSyncAdapter('provider-test');
    await adapter.enable();
    const coordinator = new SyncCoordinator({ adapter, repository, statusStore: new MemoryStatusStore(), providerMode: 'chrome', refreshWallpaper: vi.fn() });

    await coordinator.run();
    adapter.probeCalls = 0;
    adapter.discoverCalls = 0;
    adapter.readSnapshotCalls = 0;
    adapter.publishCalls = 0;
    await coordinator.run();

    expect(adapter.probeCalls).toBe(1);
    expect(adapter.discoverCalls).toBe(0);
    expect(adapter.readSnapshotCalls).toBe(0);
    expect(adapter.publishCalls).toBe(0);

    await repository.addShortcut({ name: 'One more', url: 'https://example.com/', groupId: 'default' });
    await coordinator.run();

    expect(adapter.probeCalls).toBe(3); // pre-publish probe plus post-publish observed-head cache
    expect(adapter.discoverCalls).toBe(0);
    expect(adapter.readSnapshotCalls).toBe(0);
    expect(adapter.publishCalls).toBe(1);
  });

  it('falls back to full graph discovery when another device advances a head', async () => {
    const repository = new AppRepository();
    const adapter = new MemoryCommitSyncAdapter('provider-test');
    await adapter.enable();
    const coordinator = new SyncCoordinator({ adapter, repository, statusStore: new MemoryStatusStore(), providerMode: 'chrome', refreshWallpaper: vi.fn() });
    await coordinator.run();
    const graph = await adapter.discover();
    const base = await adapter.readSnapshot(graph!.heads[0]!.id);
    base.revision = { counter: base.revision.counter + 1, deviceId: 'other-device' };
    await adapter.publish({ envelope: base, parents: [graph!.heads[0]!.id], deviceId: 'other-device' });
    adapter.probeCalls = 0;
    adapter.discoverCalls = 0;
    adapter.readSnapshotCalls = 0;

    await coordinator.run();

    expect(adapter.probeCalls).toBe(2); // mismatch plus post-merge observed-head cache
    expect(adapter.discoverCalls).toBe(1);
    expect(adapter.readSnapshotCalls).toBeGreaterThan(0);

    adapter.probeCalls = 0;
    adapter.discoverCalls = 0;
    adapter.readSnapshotCalls = 0;
    await coordinator.run();

    expect(adapter.probeCalls).toBe(1);
    expect(adapter.discoverCalls).toBe(0);
    expect(adapter.readSnapshotCalls).toBe(0);
  });

  it('adopts V1 remote data once and republishes it as V2 without deletion', async () => {
    const legacyIdentity = { deviceId: 'legacy-device', counter: 0, epoch: 0 };
    const legacyConfig = createInitialConfig(legacyIdentity);
    legacyConfig.shortcuts.push({ id: 'legacy-shortcut', groupId: 'default', name: 'Legacy shortcut', url: 'https://example.com/', sortKey: 'a0', revision: { counter: 2, deviceId: 'legacy-device' } });
    const adapter = new LegacyMemoryCommitSyncAdapter('provider-test', createEnvelope(legacyConfig, { tombstones: [] }, { counter: 2, deviceId: 'legacy-device' }, 0));
    await adapter.enable();
    const repository = new AppRepository();
    const coordinator = new SyncCoordinator({ adapter, repository, statusStore: new MemoryStatusStore(), providerMode: 'chrome', refreshWallpaper: vi.fn() });

    await coordinator.run();

    expect((await repository.getConfig()).shortcuts.map((item) => item.name)).toEqual(['Legacy shortcut']);
    expect(await adapter.discover()).not.toBeNull();
    expect((await repository.getSyncReplica('provider-test'))?.state).toBe('bound');
  });

  it('bootstraps a non-pristine installation without deleting either side', async () => {
    const adapter = new MemoryCommitSyncAdapter('provider-test');
    await adapter.enable();
    const first = new AppRepository();
    const firstCoordinator = new SyncCoordinator({ adapter, repository: first, statusStore: new MemoryStatusStore(), providerMode: 'chrome', refreshWallpaper: vi.fn() });
    await firstCoordinator.run();
    await first.addShortcut({ name: 'Remote shortcut', url: 'https://remote.example/', groupId: 'default' });
    await firstCoordinator.run();

    await resetDatabase();
    const second = new AppRepository();
    await second.initialize();
    await second.addShortcut({ name: 'Local shortcut', url: 'https://local.example/', groupId: 'default' });
    const secondCoordinator = new SyncCoordinator({ adapter, repository: second, statusStore: new MemoryStatusStore(), providerMode: 'chrome', refreshWallpaper: vi.fn() });
    await secondCoordinator.run();

    expect((await second.getConfig()).shortcuts.map((item) => item.name).sort()).toEqual(['Local shortcut', 'Remote shortcut']);
  });
});
