import type { DesktopPlacement } from '../domain/desktop';
import type { Piece, PiecePosition } from '../domain/pieces';

export function desktopPlacementToPiecePosition(position: DesktopPlacement['position']): PiecePosition {
  return { x: position.column - 24, y: position.row, width: position.width, height: position.height };
}

/** Projects the shared desktop placement result onto the pieces rendered by the board. */
export function applyDesktopPlacementsToPieces(
  pieces: readonly Piece[],
  placements: readonly DesktopPlacement[],
): Piece[] {
  const byKey = new Map(placements.map((placement) => [placementKey(placement), placement]));
  return pieces.map((piece) => {
    const placement = byKey.get(pieceKey(piece));
    const nextPosition = placement ? desktopPlacementToPiecePosition(placement.position) : piece.position;
    if (samePosition(piece.position, nextPosition)) return piece;
    return { ...piece, ...(nextPosition ? { position: nextPosition } : {}) };
  });
}

function placementKey(placement: DesktopPlacement): string {
  if (placement.kind === 'system-widget') return `widget:${placement.id}`;
  if (placement.kind === 'add-shortcut') return 'add-shortcut';
  return `${placement.kind}:${placement.id}`;
}

function pieceKey(piece: Piece): string {
  if (piece.kind === 'system-widget') return `widget:${piece.payloadRef}`;
  if (piece.kind === 'add-shortcut') return 'add-shortcut';
  return `${piece.kind}:${piece.payloadRef}`;
}

function samePosition(left: PiecePosition | undefined, right: PiecePosition | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
