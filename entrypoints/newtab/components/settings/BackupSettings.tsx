import { useRef, useState, type ChangeEvent } from 'react';
import { browser } from 'wxt/browser';
import { t } from '../../../../core/browser/i18n';
import { createBackup, readBackup } from '../../../../core/import-export/backup';
import { useAppStore } from '../../../../core/state/store';
import { appRepositories } from '../../../../core/storage/repository';
import { errorMessage } from './error-message';

export function BackupSettings() {
  const config = useAppStore((state) => state.config)!;
  const refresh = useAppStore((state) => state.refresh);
  const importInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  const exportBackup = async () => {
    try {
      const wallpaper = config.appearance.wallpaper.value.type === 'upload' && window.confirm(t('includeWallpaper'))
        ? await appRepositories.assets.getAsset(config.appearance.wallpaper.value.assetKey)
        : undefined;
      const blob = await createBackup(config, wallpaper);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `isu-newtab-${new Date().toISOString().slice(0, 10)}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await appRepositories.backup.createCheckpoint();
      const imported = await readBackup(file, config, await appRepositories.backup.getDeviceIdentity());
      await appRepositories.backup.replaceFromImport(imported.config, imported.wallpaper);
      await refresh();
      if (imported.config.appearance.wallpaper.value.type === 'wallhaven') {
        await browser.runtime.sendMessage({ type: 'wallpaper:cache', url: imported.config.appearance.wallpaper.value.imageUrl }).catch(() => undefined);
      }
      if (imported.config.appearance.wallpaper.value.type === 'bing') {
        await browser.runtime.sendMessage({ type: 'wallpaper:bing:cache', url: imported.config.appearance.wallpaper.value.imageUrl }).catch(() => undefined);
      }
      await browser.runtime.sendMessage({ type: 'sync:schedule' }).catch(() => undefined);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      event.target.value = '';
    }
  };

  const restoreCheckpoint = async () => {
    if (!window.confirm(t('confirmRestore'))) return;
    if (!await appRepositories.backup.restoreLatestCheckpoint()) {
      setError(t('noCheckpoint'));
      return;
    }
    await refresh();
    await browser.runtime.sendMessage({ type: 'sync:schedule' }).catch(() => undefined);
  };

  return (
    <section className="backupActions">
      <h3>{t('backupAndRestore')}</h3>
      <div className="backupActionGrid">
        <button type="button" onClick={exportBackup}>{t('exportBackup')}</button>
        <button type="button" className="secondary" onClick={() => importInput.current?.click()}>{t('importBackup')}</button>
        <button type="button" className="secondary" onClick={restoreCheckpoint}>{t('restoreCheckpoint')}</button>
      </div>
      <input ref={importInput} type="file" accept=".zip,application/zip" hidden onChange={importBackup} />
      {error && <p className="errorText" role="alert">{error}</p>}
    </section>
  );
}
