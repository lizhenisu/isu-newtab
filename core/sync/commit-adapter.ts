import type { SyncEnvelope } from '../domain/types';
import type { AdapterStatus } from './adapter';
import type { RemoteReplicaGraph, SyncCommit } from './commit-graph';

export type PublishCommitInput = {
  envelope: SyncEnvelope;
  parents: string[];
  deviceId: string;
};

export type PublishReceipt = {
  commit: SyncCommit;
};

/** Small remote version probe used by providers that cannot push change events. */
export type RemoteHeadSummary = {
  commitIds: string[];
  datasetId?: string;
  generation?: number;
};

/** Provider-neutral immutable-commit transport used by SyncCoordinator V2. */
export interface CommitSyncAdapter {
  readonly providerId: string;
  enable(): Promise<void>;
  disable(): Promise<void>;
  /** Avoids downloading a complete commit graph when visible heads are unchanged. */
  probeHeads?(): Promise<RemoteHeadSummary>;
  discover(): Promise<RemoteReplicaGraph | null>;
  readSnapshot(commitId: string): Promise<SyncEnvelope>;
  publish(input: PublishCommitInput): Promise<PublishReceipt>;
  acknowledge(deviceId: string, commitId: string, generation: number): Promise<void>;
  removeV2(): Promise<void>;
  /** Explicit user-approved recovery for a remote replica that cannot be read. */
  resetRemoteForRecovery?(): Promise<void>;
  /** Read-only compatibility bridge while V1 Chrome Sync data still exists. */
  readLegacy?(): Promise<SyncEnvelope | null>;
  getStatus(): AdapterStatus;
}
