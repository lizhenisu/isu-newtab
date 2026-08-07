import type { Revision, SyncEnvelope } from '../domain/types';

export type RemoteMetadata = {
  datasetId: string;
  revision: SyncEnvelope['revision'];
  hash: string;
  epoch: number;
  version: string;
};

export type AdapterStatus = {
  state: 'idle' | 'syncing' | 'warning' | 'error' | 'disabled' | 'auth-required';
  message?: string;
  usedBytes?: number;
};

export type DeviceAck = {
  revision: Revision;
  lastSeen: string;
  epoch: number;
};

/**
 * Provider-neutral transport for complete sync envelopes. Provider-specific
 * storage layout and quota handling remain behind this boundary.
 */
export interface SyncAdapter {
  readonly providerId: string;
  readonly capabilities: {
    maxPayloadBytes?: number;
    maxItemBytes?: number;
    conditionalWrite: boolean;
    incremental: boolean;
  };
  enable(): Promise<void>;
  disable(): Promise<void>;
  getRemoteMetadata(): Promise<RemoteMetadata | null>;
  pull(): Promise<SyncEnvelope | null>;
  push(envelope: SyncEnvelope): Promise<RemoteMetadata>;
  remove(): Promise<void>;
  getStatus(): AdapterStatus;
  writeAck?(deviceId: string, revision: Revision, epoch: number): Promise<void>;
  getAcks?(): Promise<Record<string, DeviceAck>>;
  removeExpiredAcks?(now?: number): Promise<string[]>;
}
