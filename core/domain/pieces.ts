import type { Revision, Shortcut, ShortcutGroup } from './types';
import { createDefaultWidgetLayout, type SystemWidgetId, type WidgetSizePreset } from './widgets';

/** The only entities that participate in desktop placement. */
export type PieceKind = 'system-widget' | 'shortcut' | 'folder' | 'add-shortcut';

export type PieceContainer =
  | { kind: 'desktop' }
  | { kind: 'folder'; folderPieceId: string }
  | { kind: 'hidden' };

export type PiecePosition = {
  /** Left edge in the centered coordinate system (-24..24). */
  x: number;
  /** Top edge in grid rows. */
  y: number;
  /** Occupied columns. Piece widths are always even. */
  width: number;
  /** Occupied rows. */
  height: number;
};

export type PiecePayload =
  | { kind: 'system-widget'; widgetId: SystemWidgetId }
  | { kind: 'shortcut'; shortcutId: string }
  | { kind: 'folder'; groupId: string }
  | { kind: 'add-shortcut' };

export type Piece = {
  id: string;
  kind: PieceKind;
  payloadRef: string;
  container: PieceContainer;
  position?: PiecePosition;
  sizePreset?: WidgetSizePreset;
  revision: Revision;
};

export type PieceSnapshot = {
  columns: 48;
  rowHeight: 40;
  pieces: Piece[];
  fingerprint: string;
};

export type PiecePlacement = { id: string; position?: PiecePosition; container?: PieceContainer };

export const PIECE_COLUMNS = 48 as const;
export const PIECE_MIN_X = -24 as const;
export const PIECE_MAX_X = 24 as const;
export const PIECE_ROW_HEIGHT = 40 as const;

export const PIECE_SIZE_PRESETS: Record<SystemWidgetId | Exclude<PieceKind, 'system-widget'>, Record<WidgetSizePreset, Pick<PiecePosition, 'width' | 'height'>>> = {
  clock: { small: { width: 8, height: 3 }, medium: { width: 10, height: 4 }, large: { width: 12, height: 5 } },
  greeting: { small: { width: 6, height: 2 }, medium: { width: 8, height: 2 }, large: { width: 10, height: 3 } },
  focusTimer: { small: { width: 10, height: 5 }, medium: { width: 14, height: 6 }, large: { width: 18, height: 7 } },
  search: { small: { width: 24, height: 2 }, medium: { width: 24, height: 2 }, large: { width: 24, height: 2 } },
  quickNote: { small: { width: 16, height: 5 }, medium: { width: 28, height: 7 }, large: { width: 36, height: 9 } },
  weather: { small: { width: 6, height: 2 }, medium: { width: 10, height: 3 }, large: { width: 14, height: 4 } },
  dailyQuote: { small: { width: 12, height: 2 }, medium: { width: 16, height: 2 }, large: { width: 20, height: 3 } },
  'shortcut': { small: { width: 4, height: 3 }, medium: { width: 4, height: 3 }, large: { width: 4, height: 3 } },
  'folder': { small: { width: 4, height: 3 }, medium: { width: 4, height: 3 }, large: { width: 4, height: 3 } },
  'add-shortcut': { small: { width: 4, height: 3 }, medium: { width: 4, height: 3 }, large: { width: 4, height: 3 } },
};

export function searchPercentToPieceWidth(percent: number): number {
  const clamped = Math.max(25, Math.min(100, Math.round(percent)));
  const raw = Math.round((clamped / 100) * PIECE_COLUMNS);
  const even = raw % 2 === 0 ? raw : raw + 1;
  return Math.max(12, Math.min(PIECE_COLUMNS, even));
}

export function piecePositionForWidget(widgetId: SystemWidgetId, sizePreset: WidgetSizePreset = 'medium', searchPercent = 50): PiecePosition {
  const size = widgetId === 'search' ? { width: searchPercentToPieceWidth(searchPercent), height: 2 } : PIECE_SIZE_PRESETS[widgetId][sizePreset];
  const defaults: Record<SystemWidgetId, { x: number; y: number }> = {
    clock: { x: -size.width / 2, y: 0 },
    greeting: { x: -size.width / 2, y: 4 },
    focusTimer: { x: -size.width / 2, y: 6 },
    search: { x: -size.width / 2, y: 0 },
    quickNote: { x: -size.width / 2, y: 14 },
    weather: { x: -size.width / 2, y: 26 },
    dailyQuote: { x: -size.width / 2, y: 24 },
  };
  return { ...defaults[widgetId], ...size };
}

export function pieceCells(position: PiecePosition): string[] {
  const cells: string[] = [];
  for (let y = position.y; y < position.y + position.height; y += 1) {
    for (let x = position.x; x < position.x + position.width; x += 1) cells.push(`${x}:${y}`);
  }
  return cells;
}

export function piecePositionsOverlap(left: PiecePosition, right: PiecePosition): boolean {
  return left.x < right.x + right.width && right.x < left.x + left.width
    && left.y < right.y + right.height && right.y < left.y + left.height;
}

export function isPiecePositionValid(position: PiecePosition): boolean {
  return Number.isInteger(position.x) && Number.isInteger(position.y)
    && Number.isInteger(position.width) && Number.isInteger(position.height)
    && position.width > 0 && position.width % 2 === 0 && position.height > 0
    && position.x >= PIECE_MIN_X && position.x + position.width <= PIECE_MAX_X && position.y >= 0;
}

export function pieceGridStyle(position: PiecePosition): { gridColumn: string; gridRow: string } {
  return { gridColumn: `${position.x + 25} / span ${position.width}`, gridRow: `${position.y + 1} / span ${position.height}` };
}

export function pieceFingerprint(pieces: Piece[]): string {
  return pieces.slice().sort((a, b) => a.id.localeCompare(b.id)).map((piece) => `${piece.id}:${piece.container.kind}:${piece.position?.x ?? ''},${piece.position?.y ?? ''},${piece.position?.width ?? ''},${piece.position?.height ?? ''}:${piece.revision.counter}:${piece.revision.deviceId}`).join('|');
}

export function createDefaultPieces(identity: Revision, searchPercent = 50): Piece[] {
  const layout = createDefaultWidgetLayout();
  const system: SystemWidgetId[] = ['clock', 'greeting', 'focusTimer', 'search', 'quickNote', 'dailyQuote', 'weather'];
  const pieces: Piece[] = system.map((widgetId) => {
    const sizePreset: WidgetSizePreset = 'medium';
    return { id: `piece:widget:${widgetId}`, kind: 'system-widget', payloadRef: widgetId, container: layout.find((item) => item.id === widgetId)?.enabled ? { kind: 'desktop' } : { kind: 'hidden' }, position: piecePositionForWidget(widgetId, sizePreset, searchPercent), sizePreset, revision: identity };
  });
  pieces.push({ id: 'piece:add-shortcut', kind: 'add-shortcut', payloadRef: 'add-shortcut', container: { kind: 'hidden' }, position: { x: 10, y: 24, width: 4, height: 3 }, revision: identity });
  return pieces;
}

export function piecesForConfig(pieces: Piece[], _shortcuts: Shortcut[], _groups: ShortcutGroup[]): PieceSnapshot {
  const sorted = pieces.slice().sort((a, b) => a.id.localeCompare(b.id));
  return { columns: 48, rowHeight: 40, pieces: sorted, fingerprint: pieceFingerprint(sorted) };
}
