import { describe, expect, it, vi } from 'vitest';
import type { SyncMode } from '../../core/domain/types';
import type { SyncCoordinator } from '../../core/sync/coordinator';
import { SyncProviderManager } from '../../core/sync/provider-manager';
import type { SyncStatusRecord, SyncStatusStore } from '../../core/sync/status-store';

function coordinator() {
  return {
    run: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn(),
    setMode: vi.fn().mockResolvedValue(undefined),
    resolveConflict: vi.fn().mockResolvedValue(undefined),
  } as unknown as SyncCoordinator;
}

describe('SyncProviderManager', () => {
  it('flushes the active provider before binding Google Drive', async () => {
    let mode: SyncMode = 'chrome';
    const chrome = coordinator();
    const drive = coordinator();
    const status: SyncStatusStore = {
      get: vi.fn().mockResolvedValue({ state: 'idle', updatedAt: new Date().toISOString() } satisfies SyncStatusRecord),
      set: vi.fn(), setConflict: vi.fn(), clearConflict: vi.fn(),
    };
    const manager = new SyncProviderManager({ getSyncMode: vi.fn(async () => mode) }, { chrome, 'google-drive': drive }, status);

    await manager.setMode('google-drive');

    expect(chrome.run).toHaveBeenCalledOnce();
    expect(drive.setMode).toHaveBeenCalledWith('google-drive');
  });

  it('does not leave the active provider when its final sync fails', async () => {
    const chrome = coordinator();
    const drive = coordinator();
    const status: SyncStatusStore = {
      get: vi.fn().mockResolvedValue({ state: 'error', updatedAt: new Date().toISOString() } satisfies SyncStatusRecord),
      set: vi.fn(), setConflict: vi.fn(), clearConflict: vi.fn(),
    };
    const manager = new SyncProviderManager({ getSyncMode: vi.fn().mockResolvedValue('chrome') }, { chrome, 'google-drive': drive }, status);

    await expect(manager.setMode('google-drive')).rejects.toThrow('FINAL_SYNC_REQUIRED');
    expect(drive.setMode).not.toHaveBeenCalled();
  });
});
