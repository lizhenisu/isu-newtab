import {
  desktopItems,
  desktopFingerprint,
  overlaps,
  snapshotWithDesktopItems,
  type DesktopItem,
  type DesktopNode,
  type DesktopSnapshot,
} from '../domain/desktop';
import type { WidgetPosition } from '../domain/widgets';
import type { Piece, PiecePosition } from '../domain/pieces';
import {
  PieceLayoutEngine,
  type PieceDragDirection,
  type PieceLayoutOptions,
  type PieceLayoutResult,
} from './piece-layout-engine';
import type { DesktopCollisionGeometry } from '../domain/desktop-collision';
import { collisionRectFor, collisionRectsOverlap } from './desktop-collision';

/**
 * Adapter for legacy config projections. The layout algorithm itself operates
 * only on Piece snapshots; this module translates the persisted config shape
 * at the boundary and never performs a second placement algorithm.
 */
export type PieceDesktopLayoutResult = {
  success: true;
  snapshot: DesktopSnapshot;
  items: DesktopItem[];
  movedKeys: string[];
};

export type PieceDesktopLayoutCommand =
  | { type: 'move'; key: string; target: WidgetPosition; direction?: PieceDragDirection; geometry?: DesktopCollisionGeometry }
  | { type: 'insert'; node: DesktopNode & { container: { kind: 'desktop' }; position: WidgetPosition }; target?: WidgetPosition; direction?: PieceDragDirection; geometry?: DesktopCollisionGeometry }
  | { type: 'repair'; geometry?: DesktopCollisionGeometry };

/** Coordinate-boundary aliases retained for migration callers. They all
 * delegate to the Piece solver below and do not implement placement logic. */
export type DragDirection = PieceDragDirection;
export type DesktopLayoutResult = PieceDesktopLayoutResult;

export function executePieceDesktopCommand(snapshot: DesktopSnapshot, command: PieceDesktopLayoutCommand): PieceDesktopLayoutResult {
  const engine = new PieceLayoutEngine();
  const options = layoutOptions(command.geometry);
  if (command.type === 'insert') {
    const withNode = appendNode(snapshot, command.node);
    const result = engine.execute(desktopSnapshotToPieces(withNode), { type: 'insert', piece: desktopNodeToPiece(command.node), target: command.target ? widgetToPiece(command.target) : undefined, direction: command.direction, options });
    return toDesktopResult(withNode, result);
  }
  if (command.type === 'move') {
    const active = snapshot.nodes.find((node) => node.key === command.key);
    if (!active?.position) throw new Error('DESKTOP_ITEM_NOT_FOUND');
    const pieces = desktopSnapshotToPieces(snapshot);
    const activePiece = pieces.find((piece) => piece.id === desktopKeyToPieceId(command.key));
    if (!activePiece) throw new Error('DESKTOP_ITEM_NOT_FOUND');
    const result = engine.execute(pieces, { type: 'move', activeId: activePiece.id, target: widgetToPiece(command.target), direction: command.direction, options });
    return toDesktopResult(snapshot, result);
  }
  return toDesktopResult(snapshot, engine.execute(desktopSnapshotToPieces(snapshot), { type: 'repair', options }));
}

export function nearestPieceDesktopVacancy(snapshot: DesktopSnapshot, origin: WidgetPosition, size = origin): WidgetPosition {
  const pieces = desktopSnapshotToPieces(snapshot);
  const vacancy = new PieceLayoutEngine().nearestVacancy(pieces, widgetToPiece(origin), widgetToPiece(size));
  return pieceToWidget(vacancy);
}

export function placeDesktopNode(snapshot: DesktopSnapshot, activeKey: string, target: WidgetPosition, direction: DragDirection = { x: 0, y: 1 }, geometry?: DesktopCollisionGeometry): PieceDesktopLayoutResult {
  return executePieceDesktopCommand(snapshot, { type: 'move', key: activeKey, target, direction, geometry });
}

export function placeNewDesktopNode(snapshot: DesktopSnapshot, node: DesktopNode & { container: { kind: 'desktop' }; position: WidgetPosition }, target = node.position, direction: DragDirection = { x: 0, y: 1 }, geometry?: DesktopCollisionGeometry): PieceDesktopLayoutResult {
  return executePieceDesktopCommand(snapshot, { type: 'insert', node, target, direction, geometry });
}

export function repairDesktopSnapshot(snapshot: DesktopSnapshot): PieceDesktopLayoutResult {
  return executePieceDesktopCommand(snapshot, { type: 'repair' });
}

export function hasDesktopCollisions(snapshot: DesktopSnapshot): boolean {
  const items = desktopItems(snapshot);
  return items.some((left, index) => items.slice(index + 1).some((right) => overlaps(left.position, right.position)));
}

export function desktopItemsIntersect(leftKey: string, leftPosition: WidgetPosition, rightKey: string, rightPosition: WidgetPosition, geometry?: DesktopCollisionGeometry): boolean {
  if (!geometry) return overlaps(leftPosition, rightPosition);
  const left = collisionRectFor(leftKey, leftPosition, geometry);
  const right = collisionRectFor(rightKey, rightPosition, geometry);
  return left && right ? collisionRectsOverlap(left, right) : overlaps(leftPosition, rightPosition);
}

export function desktopSnapshotToPieces(snapshot: DesktopSnapshot): Piece[] {
  return snapshot.nodes.map(desktopNodeToPiece);
}

export function desktopNodeToPiece(node: DesktopNode): Piece {
  const container = node.container.kind === 'desktop'
    ? { kind: 'desktop' as const }
    : node.container.kind === 'folder'
      ? { kind: 'folder' as const, folderPieceId: `piece:folder:${node.container.folderId}` }
      : { kind: 'hidden' as const };
  return {
    id: desktopKeyToPieceId(node.key),
    kind: node.kind,
    payloadRef: node.kind === 'system-widget' ? node.id : node.kind === 'add-shortcut' ? 'add-shortcut' : node.entity.id,
    container,
    ...(node.position ? { position: widgetToPiece(node.position) } : {}),
    ...(node.kind === 'system-widget' ? { sizePreset: node.sizePreset } : {}),
    revision: node.revision,
  };
}

function toDesktopResult(snapshot: DesktopSnapshot, result: PieceLayoutResult): PieceDesktopLayoutResult {
  const desktopByKey = new Map(result.pieces.filter((piece) => piece.container.kind === 'desktop' && piece.position).map((piece) => [pieceKey(piece), piece]));
  const before = new Map(desktopItems(snapshot).map((item) => [item.key, item.position]));
  const items = desktopItems(snapshot).map((item) => {
    const piece = desktopByKey.get(item.key);
    return piece?.position ? { ...item, position: pieceToWidget(piece.position) } : item;
  });
  const nextSnapshot = snapshotWithDesktopItems(snapshot, items);
  return {
    success: true,
    snapshot: nextSnapshot,
    items,
    movedKeys: items.filter((item) => !sameWidgetPosition(before.get(item.key), item.position)).map((item) => item.key),
  };
}

function appendNode(snapshot: DesktopSnapshot, node: DesktopNode): DesktopSnapshot {
  const nodes = [...snapshot.nodes.filter((item) => item.key !== node.key), node];
  return { ...snapshot, nodes, fingerprint: desktopFingerprint(nodes) };
}

function layoutOptions(geometry?: DesktopCollisionGeometry): PieceLayoutOptions {
  if (!geometry) return {};
  return {
    overlaps(leftId, left, rightId, right) {
      const leftRect = collisionRectFor(pieceIdToDesktopKey(leftId), pieceToWidget(left), geometry);
      const rightRect = collisionRectFor(pieceIdToDesktopKey(rightId), pieceToWidget(right), geometry);
      return leftRect && rightRect ? collisionRectsOverlap(leftRect, rightRect) : left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height;
    },
  };
}

function desktopKeyToPieceId(key: string): string {
  if (key === 'add-shortcut') return 'piece:add-shortcut';
  const [kind, ...rest] = key.split(':');
  return `piece:${kind}:${rest.join(':')}`;
}

function pieceIdToDesktopKey(id: string): string {
  if (id === 'piece:add-shortcut') return 'add-shortcut';
  return id.slice('piece:'.length);
}

function pieceKey(piece: Piece): string {
  return pieceIdToDesktopKey(piece.id);
}

function widgetToPiece(position: WidgetPosition): PiecePosition {
  return { x: position.column - 24, y: position.row, width: position.width, height: position.height };
}

function pieceToWidget(position: PiecePosition): WidgetPosition {
  return { column: position.x + 24, row: position.y, width: position.width, height: position.height, gridVersion: 3 };
}

function sameWidgetPosition(left: WidgetPosition | undefined, right: WidgetPosition): boolean {
  return Boolean(left && left.column === right.column && left.row === right.row && left.width === right.width && left.height === right.height);
}
