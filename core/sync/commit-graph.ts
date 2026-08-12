import type { Revision, SyncEnvelope } from '../domain/types';

export type SyncCommit = {
  protocolVersion: 2;
  id: string;
  datasetId: string;
  generation: number;
  parents: string[];
  rootManifestId: string;
  rootHash: string;
  revision: Revision;
  authorDeviceId: string;
  createdAt: string;
};

export type DeviceHead = {
  protocolVersion: 2;
  datasetId: string;
  generation: number;
  deviceId: string;
  commitId: string;
  updatedAt: string;
};

export type RemoteReplicaGraph = {
  datasetId: string;
  generation: number;
  heads: SyncCommit[];
  commits: Record<string, SyncCommit>;
};

export type CommitSnapshot = { commit: SyncCommit; envelope: SyncEnvelope };

export function compareCommit(left: SyncCommit, right: SyncCommit): number {
  if (left.revision.counter !== right.revision.counter) return left.revision.counter - right.revision.counter;
  const device = left.revision.deviceId.localeCompare(right.revision.deviceId);
  return device || left.id.localeCompare(right.id);
}

export function hasAncestor(commits: Record<string, SyncCommit>, descendantId: string, ancestorId: string): boolean {
  if (descendantId === ancestorId) return true;
  const pending = [...(commits[descendantId]?.parents ?? [])];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === ancestorId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(commits[current]?.parents ?? []));
  }
  return false;
}

export function maximalHeads(commits: Record<string, SyncCommit>, heads: SyncCommit[]): SyncCommit[] {
  return heads
    .filter((head) => !heads.some((candidate) => candidate.id !== head.id && hasAncestor(commits, candidate.id, head.id)))
    .sort(compareCommit);
}

export function findLowestCommonAncestor(
  commits: Record<string, SyncCommit>,
  leftId: string,
  rightId: string,
): string | undefined {
  const leftAncestors = ancestorDistances(commits, leftId);
  const rightAncestors = ancestorDistances(commits, rightId);
  const common = [...leftAncestors.keys()].filter((id) => rightAncestors.has(id));
  common.sort((left, right) => {
    const leftDistance = Math.max(leftAncestors.get(left)!, rightAncestors.get(left)!);
    const rightDistance = Math.max(leftAncestors.get(right)!, rightAncestors.get(right)!);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return left.localeCompare(right);
  });
  return common[0];
}

function ancestorDistances(commits: Record<string, SyncCommit>, startId: string): Map<string, number> {
  const result = new Map<string, number>([[startId, 0]]);
  const pending = [startId];
  while (pending.length) {
    const current = pending.shift()!;
    const nextDistance = result.get(current)! + 1;
    for (const parent of commits[current]?.parents ?? []) {
      const known = result.get(parent);
      if (known !== undefined && known <= nextDistance) continue;
      result.set(parent, nextDistance);
      pending.push(parent);
    }
  }
  return result;
}
