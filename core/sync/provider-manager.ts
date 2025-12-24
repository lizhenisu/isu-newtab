import type { SyncMode } from '../domain/types';
import type { SyncRepository } from '../storage/ports';
import type { SyncCoordinator } from './coordinator';
import type { SyncStatusStore } from './status-store';

type RemoteMode = Exclude<SyncMode, 'local'>;

/** Selects exactly one remote provider while preserving each provider's replica. */
export class SyncProviderManager {
  constructor(
    private readonly repository: Pick<SyncRepository, 'getSyncMode'> & Partial<Pick<SyncRepository, 'setSyncMode'>>,
    private readonly coordinators: Record<RemoteMode, SyncCoordinator>,
    private readonly statusStore: SyncStatusStore,
  ) {}

  async runActive(): Promise<void> {
    const mode = await this.repository.getSyncMode();
    if (mode !== 'local') await this.coordinators[mode].run();
  }

  async schedule(): Promise<void> {
    const mode = await this.repository.getSyncMode();
    if (mode !== 'local') this.coordinators[mode].schedule();
  }

  async setMode(target: SyncMode, force = false): Promise<void> {
    const current = await this.repository.getSyncMode();
    if (current === target) return;
    const currentCoordinator = current === 'local' ? undefined : this.coordinators[current];
    if (currentCoordinator) {
      if ('deactivate' in currentCoordinator && typeof currentCoordinator.deactivate === 'function') await currentCoordinator.deactivate();
      else await currentCoordinator.run();
    }
    if (target === 'local') {
      await this.repository.setSyncMode?.('local');
      await this.statusStore.set({ state: 'disabled' });
      return;
    }
    // Compatibility path is retained for lightweight test doubles and older
    // embedders; production coordinators use the immediate-selection path.
    if (!('activateSelected' in this.coordinators[target]) || typeof this.coordinators[target].activateSelected !== 'function') {
      await this.coordinators[target].setMode(target, force);
      return;
    }
    // The user's selection is authoritative even when authorization or the
    // first sync fails; the selected provider owns subsequent retries.
    await this.repository.setSyncMode?.(target);
    try {
      await this.coordinators[target].activateSelected();
    } catch (error) {
      throw error;
    }
  }

  async rebuildRemoteFromLocal(): Promise<void> {
    const mode = await this.repository.getSyncMode();
    if (mode === 'local') throw new Error('SYNC_DISABLED');
    await this.coordinators[mode].rebuildRemoteFromLocal();
  }

  async resolveConflict(choice: 'local-overwrite' | 'remote-replace' | 'external-import'): Promise<void> {
    const mode = await this.repository.getSyncMode();
    if (mode === 'local') throw new Error('SYNC_DISABLED');
    await this.coordinators[mode].resolveConflict(choice);
  }
}
