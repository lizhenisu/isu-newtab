import type { SyncMode } from '../domain/types';
import type { SyncRepository } from '../storage/ports';
import type { SyncCoordinator } from './coordinator';
import type { SyncStatusStore } from './status-store';

type RemoteMode = Exclude<SyncMode, 'local'>;

/** Selects exactly one remote provider while preserving each provider's replica. */
export class SyncProviderManager {
  constructor(
    private readonly repository: Pick<SyncRepository, 'getSyncMode'>,
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
      await currentCoordinator.run();
      const status = await this.statusStore.get();
      if (status && ['error', 'conflict', 'auth-required'].includes(status.state) && !(target === 'local' && force)) throw new Error('FINAL_SYNC_REQUIRED');
    }
    if (target === 'local') {
      if (!currentCoordinator) return;
      await currentCoordinator.setMode('local', force);
      return;
    }
    await this.coordinators[target].setMode(target);
  }

  async resolveConflict(choice: 'local-overwrite' | 'remote-replace' | 'external-import'): Promise<void> {
    const mode = await this.repository.getSyncMode();
    if (mode === 'local') throw new Error('SYNC_DISABLED');
    await this.coordinators[mode].resolveConflict(choice);
  }
}
