import { browser } from 'wxt/browser';

export type SyncStatusRecord = {
  state: 'idle' | 'syncing' | 'warning' | 'error' | 'conflict' | 'disabled' | 'auth-required';
  message?: string;
  usedBytes?: number;
  updatedAt: string;
};

export interface SyncStatusStore {
  get(): Promise<SyncStatusRecord | undefined>;
  set(status: Omit<SyncStatusRecord, 'updatedAt'>): Promise<void>;
  setConflict(conflict: unknown): Promise<void>;
  clearConflict(): Promise<void>;
}

export class BrowserSyncStatusStore implements SyncStatusStore {
  async get(): Promise<SyncStatusRecord | undefined> {
    const { syncStatus } = await browser.storage.local.get('syncStatus') as { syncStatus?: SyncStatusRecord };
    return syncStatus;
  }

  async set(status: Omit<SyncStatusRecord, 'updatedAt'>): Promise<void> {
    await browser.storage.local.set({ syncStatus: { ...status, updatedAt: new Date().toISOString() } satisfies SyncStatusRecord });
  }

  async setConflict(conflict: unknown): Promise<void> {
    await browser.storage.local.set({ syncConflict: conflict });
  }

  async clearConflict(): Promise<void> {
    await browser.storage.local.remove('syncConflict');
  }
}
