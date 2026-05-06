import type { SyncEnvelope } from '../domain/types';

/**
 * Local binding state for one provider. It deliberately lives outside the
 * synced application model: an installation can be unbound before it joins a
 * shared dataset.
 */
export type ReplicaState = 'unbound' | 'bootstrapping' | 'bound' | 'recovery-required';

export type BootstrapOrigin = 'empty' | 'pristine' | 'local-data';

export type SyncRecoveryCode =
  | 'REMOTE_ENVELOPE_CORRUPT'
  | 'REMOTE_GRAPH_CORRUPT'
  | 'REMOTE_DATASET_CHANGED'
  | 'REMOTE_GENERATION_CHANGED'
  | 'BASELINE_CORRUPT';

export type SyncReplica = {
  providerId: string;
  state: ReplicaState;
  datasetId?: string;
  generation?: number;
  baseCommitId?: string;
  baseSnapshotHash?: string;
  compressedBaseSnapshot?: string;
  lastSeenHeads: string[];
  pendingCommitId?: string;
  bootstrapOrigin?: BootstrapOrigin;
  lastSuccessfulAt?: string;
  recovery?: { code: SyncRecoveryCode; detectedAt: string };
};

export function createUnboundReplica(providerId: string): SyncReplica {
  return { providerId, state: 'unbound', lastSeenHeads: [] };
}

export function replicaFromEnvelope(
  providerId: string,
  commitId: string,
  envelope: SyncEnvelope,
  compressedBaseSnapshot: string,
  baseSnapshotHash: string,
): SyncReplica {
  return {
    providerId,
    state: 'bound',
    datasetId: envelope.datasetId,
    generation: envelope.epoch,
    baseCommitId: commitId,
    baseSnapshotHash,
    compressedBaseSnapshot,
    lastSeenHeads: [commitId],
    lastSuccessfulAt: new Date().toISOString(),
  };
}

export function enterRecovery(replica: SyncReplica, code: SyncRecoveryCode): SyncReplica {
  return {
    ...replica,
    state: 'recovery-required',
    recovery: { code, detectedAt: new Date().toISOString() },
  };
}
