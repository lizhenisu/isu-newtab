import { z } from 'zod';
import { createDefaultWidgetLayout, WIDGET_IDS } from './widgets';
import { DEFAULT_SEARCH_PREFERENCES } from './defaults';
import { isPiecePositionValid } from './pieces';

export const revisionSchema = z.object({
  counter: z.number().int().nonnegative(),
  deviceId: z.string().min(1),
});

const piecePositionSchema = z.object({
  x: z.number().int().min(-24).max(23),
  y: z.number().int().min(0).max(10000),
  width: z.number().int().positive().max(48).refine((value) => value % 2 === 0, 'PIECE_WIDTH_MUST_BE_EVEN'),
  height: z.number().int().positive().max(40),
}).refine((value) => isPiecePositionValid(value), 'PIECE_OUTSIDE_BOARD');
const pieceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['system-widget', 'shortcut', 'folder', 'add-shortcut']),
  payloadRef: z.string().min(1),
  container: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('desktop') }),
    z.object({ kind: z.literal('folder'), folderPieceId: z.string().min(1) }),
    z.object({ kind: z.literal('hidden') }),
  ]),
  position: piecePositionSchema.optional(),
  sizePreset: z.enum(['small', 'medium', 'large']).optional(),
  revision: revisionSchema,
}).superRefine((piece, context) => {
  if (piece.container.kind === 'desktop' && !piece.position) context.addIssue({ code: 'custom', message: 'DESKTOP_PIECE_POSITION_REQUIRED', path: ['position'] });
  if (piece.container.kind === 'folder' && piece.position) context.addIssue({ code: 'custom', message: 'FOLDER_CHILD_POSITION_FORBIDDEN', path: ['position'] });
  if (piece.kind === 'add-shortcut' && (piece.id !== 'piece:add-shortcut' || piece.container.kind !== 'desktop')) context.addIssue({ code: 'custom', message: 'ADD_SHORTCUT_PIECE_INVALID' });
});

const versioned = <T extends z.ZodType>(value: T) => z.object({ value, revision: revisionSchema });

const widgetLayoutSchema = z.array(z.object({
  id: z.enum(WIDGET_IDS),
  enabled: z.boolean(),
  sizePreset: z.enum(['small', 'medium', 'large']).optional(),
  position: z.object({
    column: z.number().int().min(0).max(47),
    row: z.number().int().min(0).max(10000),
    width: z.number().int().min(1).max(48),
    height: z.number().int().min(1).max(40),
    gridVersion: z.union([z.literal(2), z.literal(3)]).optional(),
  }).refine((position) => position.column + position.width <= (position.gridVersion === 3 ? 48 : position.gridVersion === 2 ? 24 : 12), 'WIDGET_OUTSIDE_BOARD').optional(),
})).max(WIDGET_IDS.length).superRefine((layout, context) => {
  if (new Set(layout.map((item) => item.id)).size !== layout.length) {
    context.addIssue({ code: 'custom', message: 'DUPLICATE_WIDGET_ID' });
  }
});

const desktopPositionSchema = z.object({
  column: z.number().int().min(0).max(47),
  row: z.number().int().min(0).max(10000),
  width: z.literal(4),
  height: z.literal(3),
  gridVersion: z.literal(3),
}).refine((position) => position.column + position.width <= 48, 'DESKTOP_ITEM_OUTSIDE_BOARD');

const legacyWidgetLayout = () => ({
  value: createDefaultWidgetLayout(),
  revision: { counter: 0, deviceId: 'legacy-widget-layout' },
});

const searchPreferencesSchema = z.object({
  engine: z.enum(['google', 'bing']).default('google'),
  widthPercent: z.number().int().min(25).max(100),
  backgroundOpacity: z.number().int().min(0).max(100),
  historyEnabled: z.boolean(),
  suggestionsEnabled: z.boolean(),
});

const legacySearchPreferences = () => ({
  value: { ...DEFAULT_SEARCH_PREFERENCES },
  revision: { counter: 0, deviceId: 'legacy-search-preferences' },
});

export const wallpaperSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('solid'), color: z.string().regex(/^#[0-9a-f]{6}$/i) }),
  z.object({ type: z.literal('builtin'), assetId: z.string().min(1) }),
  z.object({ type: z.literal('upload'), assetKey: z.string().min(1) }),
  z.object({
    type: z.literal('wallhaven'),
    imageUrl: z.string().url().refine((url) => url.startsWith('https://w.wallhaven.cc/')),
    sourceUrl: z.string().url().optional(),
    wallpaperId: z.string().optional(),
  }),
  z.object({
    type: z.literal('unsplash'),
    imageUrl: z.string().url().refine((url) => url.startsWith('https://images.unsplash.com/')),
    sourceUrl: z.string().url().refine((url) => url.startsWith('https://unsplash.com/')),
    photoId: z.string().min(1),
    photographerName: z.string().min(1),
    photographerUrl: z.string().url().refine((url) => url.startsWith('https://unsplash.com/')),
  }),
]);

export const groupSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  sortKey: z.string().min(1),
  collapsed: z.boolean(),
  position: desktopPositionSchema.optional(),
  revision: revisionSchema,
});

export const shortcutSchema = z.object({
  id: z.string().min(1),
  groupId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  url: z.string().url().refine((url) => /^https?:/.test(url)),
  icon: z.string().max(2048).optional(),
  sortKey: z.string().min(1),
  position: desktopPositionSchema.optional(),
  revision: revisionSchema,
});

export const appConfigSchema = z.object({
  schemaVersion: z.literal(1),
  datasetId: z.string().min(1),
  updatedAt: z.string().datetime(),
  groups: z.array(groupSchema),
  shortcuts: z.array(shortcutSchema),
  appearance: z.object({
    theme: versioned(z.enum(['light', 'dark', 'system'])),
    blur: versioned(z.number().min(0).max(40)),
    cardSize: versioned(z.enum(['small', 'medium', 'large'])),
    wallpaper: versioned(wallpaperSchema),
    widgetLayout: versioned(widgetLayoutSchema).default(legacyWidgetLayout),
    search: versioned(searchPreferencesSchema).default(legacySearchPreferences),
  }),
}).superRefine((config, context) => {
  const groupIds = new Set(config.groups.map((group) => group.id));
  if (groupIds.size !== config.groups.length) context.addIssue({ code: 'custom', message: 'DUPLICATE_GROUP_ID', path: ['groups'] });
  const shortcutIds = new Set(config.shortcuts.map((shortcut) => shortcut.id));
  if (shortcutIds.size !== config.shortcuts.length) context.addIssue({ code: 'custom', message: 'DUPLICATE_SHORTCUT_ID', path: ['shortcuts'] });
  if (!groupIds.has('default')) context.addIssue({ code: 'custom', message: 'DEFAULT_GROUP_MISSING', path: ['groups'] });
  for (const [index, shortcut] of config.shortcuts.entries()) {
    if (!groupIds.has(shortcut.groupId)) context.addIssue({ code: 'custom', message: 'SHORTCUT_GROUP_MISSING', path: ['shortcuts', index, 'groupId'] });
  }
});

const wallpaperSyncProjectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('solid'), color: z.string().regex(/^#[0-9a-f]{6}$/i) }),
  z.object({ type: z.literal('builtin'), assetId: z.string().min(1) }),
  z.object({ type: z.literal('wallhaven'), imageUrl: z.string().url().refine((url) => url.startsWith('https://w.wallhaven.cc/')) }),
  z.object({
    type: z.literal('unsplash'),
    imageUrl: z.string().url().refine((url) => url.startsWith('https://images.unsplash.com/')),
    sourceUrl: z.string().url().refine((url) => url.startsWith('https://unsplash.com/')),
    photoId: z.string().min(1),
    photographerName: z.string().min(1),
    photographerUrl: z.string().url().refine((url) => url.startsWith('https://unsplash.com/')),
  }),
]);

export const syncEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  datasetId: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  revision: revisionSchema,
  config: z.object({
    schemaVersion: z.literal(1),
    datasetId: z.string().min(1),
    updatedAt: z.string().datetime(),
    groups: z.array(groupSchema),
    shortcuts: z.array(shortcutSchema),
    appearance: z.object({
      theme: versioned(z.enum(['light', 'dark', 'system'])),
      blur: versioned(z.number().min(0).max(40)),
      cardSize: versioned(z.enum(['small', 'medium', 'large'])),
      wallpaper: versioned(wallpaperSyncProjectionSchema).optional(),
      widgetLayout: versioned(widgetLayoutSchema).default(legacyWidgetLayout),
      search: versioned(searchPreferencesSchema).default(legacySearchPreferences),
    }),
  }),
  pieces: z.array(pieceSchema).default([]),
  metadata: z.object({
    tombstones: z.array(z.object({
      entityType: z.enum(['group', 'shortcut']),
      entityId: z.string().min(1),
      revision: revisionSchema,
    })),
  }),
}).superRefine((envelope, context) => {
  if (envelope.datasetId !== envelope.config.datasetId) context.addIssue({ code: 'custom', message: 'DATASET_ID_MISMATCH' });
});

export const exportConfigSchema = z.object({
  exportVersion: z.literal(1),
  exportedAt: z.string().datetime(),
  config: appConfigSchema,
});
