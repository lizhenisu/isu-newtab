import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { appConfigSchema } from '../domain/schema';
import { migrateAppConfig } from '../domain/migration';
import { z } from 'zod';
import { nextRevision } from '../domain/revision';
import { DEFAULT_GROUP_ID, type AppConfig, type DeviceIdentity } from '../domain/types';
import { hasWebpSignature } from '../wallpaper/image';
import { migrateDesktopPositions } from '../domain/desktop';
import { DEFAULT_SOLID_WALLPAPER_COLOR } from '../domain/defaults';

const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const MAX_CONFIG_BYTES = 10 * 1024 * 1024;
const MAX_WALLPAPER_BYTES = 30 * 1024 * 1024;
const ALLOWED_FILES = new Set(['config.json', 'wallpaper.webp']);
const exportEnvelopeSchema = z.object({
  exportVersion: z.literal(1),
  exportedAt: z.string().datetime(),
  config: z.unknown(),
});

export function createBackup(config: AppConfig, wallpaper?: Blob): Promise<Blob> {
  return createBackupBytes(config, wallpaper).then((bytes) => new Blob([bytes as BlobPart], { type: 'application/zip' }));
}

async function createBackupBytes(config: AppConfig, wallpaper?: Blob): Promise<Uint8Array> {
  const configBytes = strToU8(JSON.stringify({ exportVersion: 1, exportedAt: new Date().toISOString(), config }));
  if (configBytes.byteLength > MAX_CONFIG_BYTES) throw new Error('EXPORT_CONFIG_TOO_LARGE');
  const files: Record<string, Uint8Array> = { 'config.json': configBytes };
  if (wallpaper) {
    const bytes = new Uint8Array(await wallpaper.arrayBuffer());
    if (bytes.byteLength > MAX_WALLPAPER_BYTES) throw new Error('EXPORT_WALLPAPER_TOO_LARGE');
    files['wallpaper.webp'] = bytes;
  }
  const archive = zipSync(files, { level: 6 });
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('EXPORT_ARCHIVE_TOO_LARGE');
  return archive;
}

/** Validates a bounded two-file ZIP before producing an importable configuration. */
export async function readBackup(
  archive: Blob,
  currentConfig: AppConfig,
  identity: DeviceIdentity,
): Promise<{ config: AppConfig; wallpaper?: Blob }> {
  if (archive.size > MAX_ARCHIVE_BYTES) throw new Error('IMPORT_ARCHIVE_TOO_LARGE');
  const bytes = new Uint8Array(await archive.arrayBuffer());
  rejectSymlinks(bytes);
  const names = new Set<string>();
  let originalBytes = 0;
  let entries = 0;
  const files = unzipSync(bytes, {
    filter(info) {
      entries += 1;
      if (entries > 2) throw new Error('IMPORT_TOO_MANY_ENTRIES');
      validateEntryName(info.name, names);
      originalBytes += info.originalSize;
      if (originalBytes > MAX_ARCHIVE_BYTES) throw new Error('IMPORT_EXPANDED_TOO_LARGE');
      if (info.name === 'config.json' && info.originalSize > MAX_CONFIG_BYTES) throw new Error('IMPORT_CONFIG_TOO_LARGE');
      if (info.name === 'wallpaper.webp' && info.originalSize > MAX_WALLPAPER_BYTES) throw new Error('IMPORT_WALLPAPER_TOO_LARGE');
      return true;
    },
  });
  const actualBytes = Object.values(files).reduce((total, file) => total + file.byteLength, 0);
  if (actualBytes > MAX_ARCHIVE_BYTES) throw new Error('IMPORT_EXPANDED_TOO_LARGE');
  const configBytes = files['config.json'];
  if (!configBytes) throw new Error('IMPORT_CONFIG_MISSING');
  if (configBytes.byteLength > MAX_CONFIG_BYTES) throw new Error('IMPORT_CONFIG_TOO_LARGE');
  const parsed = exportEnvelopeSchema.parse(JSON.parse(strFromU8(configBytes)));
  const wallpaperBytes = files['wallpaper.webp'];
  if (wallpaperBytes && wallpaperBytes.byteLength > MAX_WALLPAPER_BYTES) throw new Error('IMPORT_WALLPAPER_TOO_LARGE');
  if (wallpaperBytes && !hasWebpSignature(wallpaperBytes)) throw new Error('IMPORT_WALLPAPER_INVALID');
  const migrated = migrateAppConfig(parsed.config);
  if (wallpaperBytes && migrated.appearance.wallpaper.value.type !== 'upload') throw new Error('IMPORT_WALLPAPER_UNEXPECTED');
  const config = remapImportedConfig(migrateDesktopPositions(migrated).config, currentConfig.datasetId, identity, Boolean(wallpaperBytes));
  return {
    config: appConfigSchema.parse(config),
    ...(wallpaperBytes ? { wallpaper: new Blob([wallpaperBytes as BlobPart], { type: 'image/webp' }) } : {}),
  };
}

function validateEntryName(name: string, seen: Set<string>): void {
  if (!ALLOWED_FILES.has(name) || name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('/')) {
    throw new Error('IMPORT_ENTRY_NOT_ALLOWED');
  }
  if (seen.has(name)) throw new Error('IMPORT_DUPLICATE_ENTRY');
  seen.add(name);
}

/** Rejects Unix symlink entries by inspecting ZIP central-directory attributes. */
function rejectSymlinks(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 46 <= bytes.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const externalAttributes = view.getUint32(offset + 38, true);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new Error('IMPORT_SYMLINK_NOT_ALLOWED');
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 45 + nameLength + extraLength + commentLength;
  }
}

function remapImportedConfig(
  imported: AppConfig,
  datasetId: string,
  identity: DeviceIdentity,
  hasWallpaper: boolean,
): AppConfig {
  const groupIds = new Map<string, string>();
  for (const group of imported.groups) {
    groupIds.set(group.id, group.id === DEFAULT_GROUP_ID ? DEFAULT_GROUP_ID : crypto.randomUUID());
  }
  if (!groupIds.has(DEFAULT_GROUP_ID)) groupIds.set(DEFAULT_GROUP_ID, DEFAULT_GROUP_ID);
  const groups = imported.groups.map((group) => ({
    ...group,
    id: groupIds.get(group.id)!,
    revision: nextRevision(identity),
  }));
  if (!groups.some((group) => group.id === DEFAULT_GROUP_ID)) {
    groups.unshift({ id: DEFAULT_GROUP_ID, name: 'Default', collapsed: false, sortKey: 'a0', revision: nextRevision(identity) });
  }
  const shortcuts = imported.shortcuts.map((shortcut) => ({
    ...shortcut,
    id: crypto.randomUUID(),
    groupId: groupIds.get(shortcut.groupId) ?? DEFAULT_GROUP_ID,
    revision: nextRevision(identity),
  }));
  const wallpaper = imported.appearance.wallpaper.value.type === 'upload'
    ? hasWallpaper
      ? { type: 'upload' as const, assetKey: 'wallpaper/upload' }
      : { type: 'solid' as const, color: DEFAULT_SOLID_WALLPAPER_COLOR }
    : imported.appearance.wallpaper.value;
  return {
    ...structuredClone(imported),
    datasetId,
    updatedAt: new Date().toISOString(),
    groups,
    shortcuts,
    appearance: {
      theme: { value: imported.appearance.theme.value, revision: nextRevision(identity) },
      blur: { value: imported.appearance.blur.value, revision: nextRevision(identity) },
      solidColor: { value: imported.appearance.solidColor.value, revision: nextRevision(identity) },
      wallpaper: { value: wallpaper, revision: nextRevision(identity) },
      widgetLayout: { value: structuredClone(imported.appearance.widgetLayout.value), revision: nextRevision(identity) },
      search: { value: structuredClone(imported.appearance.search.value), revision: nextRevision(identity) },
    },
  };
}
