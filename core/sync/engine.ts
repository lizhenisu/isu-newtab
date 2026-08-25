import { appConfigSchema } from '../domain/schema';
import { compareRevision, maxRevision, nextRevision } from '../domain/revision';
import {
  DEFAULT_GROUP_ID,
  type AppConfig,
  type DeviceIdentity,
  type Revision,
  type Shortcut,
  type ShortcutGroup,
  type SyncAppConfig,
  type SyncEnvelope,
  type SyncMetadata,
  type Tombstone,
  type VersionedValue,
  type WallpaperSyncProjection,
} from '../domain/types';
import { canonicalStringify } from './codec';
import { compareBySortKey } from '../domain/sort';
import { buildDesktopSnapshot, desktopPlacements, samePosition } from '../domain/desktop';
import { executeDesktopCommand } from '../layout/desktop-lifecycle';
import { PIECE_MAX_X, PIECE_MIN_X, piecePositionsOverlap, type Piece, type PiecePosition } from '../domain/pieces';

export function createSyncProjection(config: AppConfig): SyncAppConfig {
  const { wallpaper, ...appearance } = config.appearance;
  const projected = projectWallpaper(wallpaper.value);
  return {
    ...structuredClone(config),
    appearance: {
      ...appearance,
      ...(projected ? { wallpaper: { value: projected, revision: wallpaper.revision } } : {}),
    },
  };
}

function projectWallpaper(wallpaper: AppConfig['appearance']['wallpaper']['value']): WallpaperSyncProjection | undefined {
  switch (wallpaper.type) {
    case 'solid': return wallpaper;
    case 'builtin': return wallpaper;
    case 'wallhaven': return { type: 'wallhaven', imageUrl: wallpaper.imageUrl };
    case 'wallhaven-random': return wallpaper;
    case 'unsplash': return wallpaper;
    case 'upload': return undefined;
  }
}

export function createEnvelope(
  config: AppConfig,
  metadata: SyncMetadata,
  revision: Revision,
  epoch: number,
  pieces: Piece[] = [],
): SyncEnvelope {
  return {
    schemaVersion: 1,
    datasetId: config.datasetId,
    epoch,
    revision,
    config: createSyncProjection(config),
    pieces: structuredClone(pieces),
    metadata: structuredClone(metadata),
  };
}

export function applySyncProjection(local: AppConfig, synced: SyncAppConfig): AppConfig {
  const wallpaper = local.appearance.wallpaper.value.type === 'upload'
    ? local.appearance.wallpaper
    : synced.appearance.wallpaper
    ? { value: synced.appearance.wallpaper.value, revision: synced.appearance.wallpaper.revision }
    : local.appearance.wallpaper;
  const candidate: AppConfig = {
    ...structuredClone(synced),
    appearance: { ...synced.appearance, wallpaper },
  };
  return appConfigSchema.parse(candidate);
}

export function mergeEnvelopes(
  local: SyncEnvelope,
  remote: SyncEnvelope,
  identity: DeviceIdentity,
): SyncEnvelope {
  return mergeWithBase(undefined, local, remote, identity);
}

/** Merges local and remote envelopes against their last confirmed common base. */
export function mergeThreeWay(
  base: SyncEnvelope,
  local: SyncEnvelope,
  remote: SyncEnvelope,
  identity: DeviceIdentity,
): SyncEnvelope {
  if (base.datasetId !== local.datasetId || base.datasetId !== remote.datasetId) throw new Error('DATASET_MISMATCH');
  return mergeWithBase(base, local, remote, identity);
}

function mergeWithBase(
  base: SyncEnvelope | undefined,
  local: SyncEnvelope,
  remote: SyncEnvelope,
  identity: DeviceIdentity,
): SyncEnvelope {
  if (local.datasetId !== remote.datasetId) throw new Error('DATASET_MISMATCH');
  if (local.epoch !== remote.epoch) throw new Error('EPOCH_MISMATCH');
  identity.counter = Math.max(identity.counter, local.revision.counter, remote.revision.counter);

  const groupMerge = mergeEntityStates(base?.config.groups ?? [], local.config.groups, remote.config.groups, base?.metadata.tombstones ?? [], local.metadata.tombstones, remote.metadata.tombstones, 'group');
  const shortcutMerge = mergeEntityStates(base?.config.shortcuts ?? [], local.config.shortcuts, remote.config.shortcuts, base?.metadata.tombstones ?? [], local.metadata.tombstones, remote.metadata.tombstones, 'shortcut');
  const tombstones = [...groupMerge.tombstones, ...shortcutMerge.tombstones];
  const revision = nextRevision(identity, maxRevision(local.revision, remote.revision));
  const repaired = repairInvariants(groupMerge.entities, shortcutMerge.entities, revision);
  const wallpaper = mergeOptionalThreeWay(base?.config.appearance.wallpaper, local.config.appearance.wallpaper, remote.config.appearance.wallpaper);
  const widgetLayout = mergeVersionedThreeWay(base?.config.appearance.widgetLayout, local.config.appearance.widgetLayout, remote.config.appearance.widgetLayout);
  const theme = mergeVersionedThreeWay(base?.config.appearance.theme, local.config.appearance.theme, remote.config.appearance.theme);
  const blur = mergeVersionedThreeWay(base?.config.appearance.blur, local.config.appearance.blur, remote.config.appearance.blur);
  const solidColor = mergeVersionedThreeWay(base?.config.appearance.solidColor, local.config.appearance.solidColor, remote.config.appearance.solidColor);
  const search = mergeVersionedThreeWay(base?.config.appearance.search, local.config.appearance.search, remote.config.appearance.search);
  const mergedConfig: SyncEnvelope['config'] = {
    schemaVersion: 1,
    datasetId: local.datasetId,
    updatedAt: new Date().toISOString(),
    groups: repaired.groups,
    shortcuts: repaired.shortcuts,
    appearance: { theme, blur, solidColor, widgetLayout, search, ...(wallpaper ? { wallpaper } : {}) },
  };
  // A piece is a placement projection of a business entity.  Its bucket is
  // merged independently for fine-grained sync, but a deleted shortcut or
  // folder must never be resurrected by a stale piece from another device.
  const pieces = repairMergedPieces(filterPiecesToConfig(
    mergePieces(base?.pieces ?? [], local.pieces ?? [], remote.pieces ?? []),
    mergedConfig,
  ), revision);
  const desktopRepair = executeDesktopCommand(buildDesktopSnapshot(mergedConfig as AppConfig), { type: 'repair' });
  let widgetLayoutRepaired = false;
  for (const placement of desktopPlacements(desktopRepair.items)) {
    if (placement.kind === 'shortcut') {
      const shortcut = mergedConfig.shortcuts.find((item) => item.id === placement.id)!;
      if (!samePosition(shortcut.position, placement.position)) { shortcut.position = placement.position; shortcut.revision = revision; }
    } else if (placement.kind === 'folder') {
      const group = mergedConfig.groups.find((item) => item.id === placement.id)!;
      if (!samePosition(group.position, placement.position)) { group.position = placement.position; group.revision = revision; }
    } else {
      const widget = widgetLayout.value.find((item) => item.id === placement.id);
      if (widget && !samePosition(widget.position, placement.position)) { widget.position = placement.position; widgetLayoutRepaired = true; }
    }
  }
  if (widgetLayoutRepaired) widgetLayout.revision = revision;

  return {
    schemaVersion: 1,
    datasetId: local.datasetId,
    epoch: local.epoch,
    revision,
    config: mergedConfig,
    pieces,
    metadata: { tombstones },
  };
}

function filterPiecesToConfig(pieces: Piece[], config: SyncEnvelope['config']): Piece[] {
  const widgetIds = new Set<string>(config.appearance.widgetLayout.value.map((widget) => widget.id));
  const shortcutIds = new Set(config.shortcuts.map((shortcut) => shortcut.id));
  const groupIds = new Set(config.groups.map((group) => group.id));
  return pieces.filter((piece) => {
    if (piece.kind === 'add-shortcut') return piece.id === 'piece:add-shortcut';
    if (piece.kind === 'system-widget') return widgetIds.has(piece.payloadRef);
    if (piece.kind === 'shortcut') return shortcutIds.has(piece.payloadRef);
    return groupIds.has(piece.payloadRef);
  });
}

function mergePieces(base: Piece[], local: Piece[], remote: Piece[]): Piece[] {
  const byId = (items: Piece[]) => new Map(items.map((piece) => [piece.id, piece]));
  const baseMap = byId(base);
  const localMap = byId(local);
  const remoteMap = byId(remote);
  const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const merged: Piece[] = [];
  for (const id of [...ids].sort()) {
    const before = baseMap.get(id);
    const left = localMap.get(id);
    const right = remoteMap.get(id);
    const changedLeft = JSON.stringify(left) !== JSON.stringify(before);
    const changedRight = JSON.stringify(right) !== JSON.stringify(before);
    const chosen = before && !changedLeft && changedRight ? right
      : before && changedLeft && !changedRight ? left
        : !left ? right
          : !right ? left
            : compareRevision(left.revision, right.revision) >= 0 ? left : right;
    if (chosen) merged.push(structuredClone(chosen));
  }
  return merged;
}

function repairMergedPieces(pieces: Piece[], repairRevision: Revision): Piece[] {
  const result = pieces.map((piece) => structuredClone(piece));
  const priority = (piece: Piece): string => `${piece.kind === 'system-widget' ? '0' : piece.kind === 'folder' ? '1' : piece.kind === 'shortcut' ? '2' : '3'}:${piece.id}`;
  const active = result.filter((piece) => piece.container.kind === 'desktop' && piece.position).sort((left, right) => {
    const revisionOrder = compareRevision(right.revision, left.revision);
    return revisionOrder || priority(left).localeCompare(priority(right));
  });
  const placed: Piece[] = [];
  for (const piece of active) {
    const original = piece.position!;
    if (!placed.some((other) => piecePositionsOverlap(other.position!, original))) {
      placed.push(piece);
      continue;
    }
    const next = nearestPieceVacancy(original, placed);
    piece.position = next;
    piece.revision = repairRevision;
    placed.push(piece);
  }
  return result;
}

function nearestPieceVacancy(original: PiecePosition, placed: Piece[]): PiecePosition {
  const maxY = Math.max(original.y + 1, ...placed.map((piece) => (piece.position?.y ?? 0) + (piece.position?.height ?? 1))) + 1000;
  const candidates: PiecePosition[] = [];
  for (let y = 0; y <= maxY; y += 1) {
    for (let x = PIECE_MIN_X; x <= PIECE_MAX_X - original.width; x += 1) {
      const candidate = { ...original, x, y };
      if (!placed.some((piece) => piece.position && piecePositionsOverlap(piece.position, candidate))) candidates.push(candidate);
    }
  }
  candidates.sort((left, right) => {
    const distance = Math.abs(left.x - original.x) + Math.abs(left.y - original.y) - Math.abs(right.x - original.x) - Math.abs(right.y - original.y);
    return distance || left.y - right.y || left.x - right.x;
  });
  return candidates[0] ?? { ...original, x: PIECE_MIN_X, y: maxY };
}

function mergeEntityStates<T extends { id: string; revision: Revision }>(
  base: T[],
  local: T[],
  remote: T[],
  baseTombstones: Tombstone[],
  localTombstones: Tombstone[],
  remoteTombstones: Tombstone[],
  entityType: Tombstone['entityType'],
): { entities: T[]; tombstones: Tombstone[] } {
  type State = { kind: 'entity'; value: T; revision: Revision } | { kind: 'tombstone'; value: Tombstone; revision: Revision };
  const stateMap = (entities: T[], tombstones: Tombstone[]) => {
    const states = new Map<string, State>();
    for (const entity of entities) states.set(entity.id, { kind: 'entity', value: entity, revision: entity.revision });
    for (const tombstone of tombstones.filter((item) => item.entityType === entityType)) {
      states.set(tombstone.entityId, { kind: 'tombstone', value: tombstone, revision: tombstone.revision });
    }
    return states;
  };
  const baseStates = stateMap(base, baseTombstones);
  const localStates = stateMap(local, localTombstones);
  const remoteStates = stateMap(remote, remoteTombstones);
  const ids = new Set([...baseStates.keys(), ...localStates.keys(), ...remoteStates.keys()]);
  const entities: T[] = [];
  const tombstones: Tombstone[] = [];
  for (const id of ids) {
    const baseState = baseStates.get(id);
    const localState = localStates.get(id);
    const remoteState = remoteStates.get(id);
    const localChanged = !sameState(localState, baseState);
    const remoteChanged = !sameState(remoteState, baseState);
    let chosen: State | undefined;
    if (baseState && !localChanged && remoteChanged) chosen = remoteState;
    else if (baseState && localChanged && !remoteChanged) chosen = localState;
    else if (!localChanged && !remoteChanged) chosen = localState ?? remoteState ?? baseState;
    else if (!localState) chosen = remoteState;
    else if (!remoteState) chosen = localState;
    else if (localState.kind === 'tombstone' || remoteState.kind === 'tombstone') {
      if (localState.kind === 'tombstone' && remoteState.kind === 'tombstone') chosen = compareRevision(localState.revision, remoteState.revision) >= 0 ? localState : remoteState;
      else chosen = localState.kind === 'tombstone' ? localState : remoteState;
    } else chosen = compareRevision(localState.revision, remoteState.revision) >= 0 ? localState : remoteState;
    if (chosen?.kind === 'entity') entities.push(structuredClone(chosen.value));
    if (chosen?.kind === 'tombstone') tombstones.push(structuredClone(chosen.value));
  }
  return { entities, tombstones };
}

function repairInvariants(groups: ShortcutGroup[], shortcuts: Shortcut[], revision: Revision): {
  groups: ShortcutGroup[];
  shortcuts: Shortcut[];
} {
  let defaultGroup = groups.find((group) => group.id === DEFAULT_GROUP_ID);
  if (!defaultGroup) {
    defaultGroup = {
      id: DEFAULT_GROUP_ID,
      name: 'Default',
      sortKey: 'a0',
      collapsed: false,
      revision,
    };
    groups.push(defaultGroup);
  }
  const groupIds = new Set(groups.map((group) => group.id));
  for (const shortcut of shortcuts) {
    if (!groupIds.has(shortcut.groupId)) {
      shortcut.groupId = DEFAULT_GROUP_ID;
      shortcut.revision = revision;
    }
    if (shortcut.groupId !== DEFAULT_GROUP_ID && shortcut.position) {
      delete shortcut.position;
      shortcut.revision = revision;
    }
  }
  groups.sort(compareBySortKey);
  shortcuts.sort(compareBySortKey);
  return { groups, shortcuts };
}

function latest<T>(left: VersionedValue<T>, right: VersionedValue<T>): VersionedValue<T> {
  return structuredClone(compareRevision(left.revision, right.revision) >= 0 ? left : right);
}

function mergeVersionedThreeWay<T>(base: VersionedValue<T> | undefined, local: VersionedValue<T>, remote: VersionedValue<T>): VersionedValue<T> {
  if (base && canonicalStringify(local) === canonicalStringify(base)) return structuredClone(remote);
  if (base && canonicalStringify(remote) === canonicalStringify(base)) return structuredClone(local);
  return latest(local, remote);
}

function mergeOptionalVersioned<T>(left?: VersionedValue<T>, right?: VersionedValue<T>): VersionedValue<T> | undefined {
  if (!left) return right ? structuredClone(right) : undefined;
  if (!right) return structuredClone(left);
  return latest(left, right);
}

function mergeOptionalThreeWay<T>(base?: VersionedValue<T>, local?: VersionedValue<T>, remote?: VersionedValue<T>): VersionedValue<T> | undefined {
  if (base && canonicalStringify(local) === canonicalStringify(base)) return remote ? structuredClone(remote) : undefined;
  if (base && canonicalStringify(remote) === canonicalStringify(base)) return local ? structuredClone(local) : undefined;
  return mergeOptionalVersioned(local, remote);
}

function sameState(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

export function envelopeContainsRevision(envelope: SyncEnvelope, entityType: string, entityId: string, revision: Revision): boolean {
  if (entityType === 'envelope') return compareRevision(envelope.revision, revision) >= 0;
  if (entityType === 'appearance') {
    const value = envelope.config.appearance[entityId as keyof SyncAppConfig['appearance']];
    return Boolean(value && 'revision' in value && compareRevision(value.revision, revision) >= 0);
  }
  const collection = entityType === 'group' ? envelope.config.groups : entityType === 'shortcut' ? envelope.config.shortcuts : envelope.pieces ?? [];
  const entity = collection.find((item) => item.id === entityId);
  if (entity && compareRevision(entity.revision, revision) >= 0) return true;
  const tombstone = envelope.metadata.tombstones.find((item) => item.entityType === entityType && item.entityId === entityId);
  return Boolean(tombstone && compareRevision(tombstone.revision, revision) >= 0);
}
